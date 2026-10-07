import { createServer } from "node:http";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  readlinkSync,
  mkdirSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { hostname } from "node:os";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { WebSocket, WebSocketServer } from "ws";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { lcRelayUpgrade } from "./lc-relay.js";
import { registerMovieRelay } from "./movie-relay.js";
import { createRateLimiter } from "./lib/rate-limit.js";
import { downloadPublicImage, resolvePublicUrl } from "./lib/public-network.js";
import { registerImageProxy } from "./lib/image-proxy.js";
import { uniqueOnlineCount } from "./lib/online.js";
import {
  createGeoResolver,
  formattopcountries,
  normalizeip,
  topcountries,
} from "./lib/geo.js";
import { websocketOriginAllowed } from "./lib/ws-origin.js";

// Load local development configuration before any feature reads process.env.
// Values supplied by the host environment keep precedence over .env values.
if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      console.warn("[config] Could not load .env:", error.message);
    }
  }
}

const _require = createRequire(import.meta.url);
const epoxypath = dirname(_require.resolve("@mercuryworkshop/epoxy-transport"));
// libcurl-transport and scramjet-controller don't export a path helper, so
// serve the directory their entry point resolves to.
const libcurlPath = dirname(
  _require.resolve("@mercuryworkshop/libcurl-transport"),
);
const scramjetControllerPath = dirname(
  _require.resolve("@mercuryworkshop/scramjet-controller"),
);
const scryptAsync = promisify(scrypt);

const publicpath = fileURLToPath(new URL("./public/", import.meta.url));

// --- password hashing ---

const KEYLEN = 64;
const SCRYPT_OPTS = { N: 2 ** 15, maxmem: 64 * 1024 * 1024 };

async function hashpw(pw) {
  const salt = randomBytes(16).toString("hex");
  const derived = await scryptAsync(pw, salt, KEYLEN, SCRYPT_OPTS);
  return `scrypt:${salt}:${derived.toString("hex")}`;
}

async function verifypw(pw, stored) {
  if (
    typeof pw !== "string" ||
    typeof stored !== "string" ||
    !/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(stored)
  )
    return false;
  const [, salt, hash] = stored.split(":");
  const expected = Buffer.from(hash, "hex");
  const actual = await scryptAsync(pw, salt, expected.length, SCRYPT_OPTS);
  return timingSafeEqual(expected, actual);
}

// Logins for unknown usernames verify against this so they take as long as a
// wrong password; otherwise response timing reveals which usernames exist.
const DUMMY_HASH = await hashpw("aetheris-login-timing-equalizer");

// --- helpers ---

// req.ip honours X-Forwarded-For only from the local Caddy (see trustProxy).
// Never parse that header by hand: its leftmost entries are client-supplied.
function getclientip(req) {
  return req.ip;
}

function isvaliddeviceid(id) {
  return typeof id === "string" && /^[a-f0-9]{64}$/.test(id);
}

function isvalidusername(value) {
  return (
    typeof value === "string" &&
    /^[a-zA-Z0-9_.-]{2,32}$/.test(value) &&
    !["__proto__", "prototype", "constructor"].includes(value.toLowerCase())
  );
}

function maketoken() {
  return randomBytes(36).toString("base64url");
}

// Sessions are stored under sha256(token) so a leaked user file never
// contains a working bearer token.
function tokenkey(token) {
  return createHash("sha256").update(token).digest("hex");
}

// Stored keys are 64-hex sha256 digests; real tokens are 48-char base64url.
// The legacy raw-key fallback must reject 64-hex input, or a leaked stored key
// would work as a bearer token.
const HASHED_KEY = /^[a-f0-9]{64}$/;

function islegacykey(value) {
  return typeof value === "string" && !HASHED_KEY.test(value);
}

function safefilename(name) {
  return name.toLowerCase().replace(/[^a-z0-9_\-.]/g, "_");
}

function gettoken(req) {
  const header = req.headers.authorization || "";
  return header.replace(/^Bearer\s+/i, "").trim();
}

// --- per-user file database (database/<username>.json) ---

const dbdir = join(process.cwd(), "database");
if (!existsSync(dbdir)) mkdirSync(dbdir, { recursive: true });

function userpath(username) {
  return join(dbdir, safefilename(username) + ".json");
}

function readuser(username) {
  try {
    return JSON.parse(readFileSync(userpath(username), "utf8"));
  } catch {
    return null;
  }
}

// write-then-rename so a crash mid-write can't leave a truncated file
function writeuser(data) {
  const dest = userpath(data.username);
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, dest);
  indexuser(data);
}

function deleteuser(user) {
  if (!user?.username) return;
  const lc = user.username.toLowerCase();

  usernames.delete(lc);
  if (user.deviceId && deviceindex.get(user.deviceId) === lc)
    deviceindex.delete(user.deviceId);

  try {
    unlinkSync(userpath(user.username));
  } catch {
    /* already gone */
  }
}

function allusers() {
  try {
    return readdirSync(dbdir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(dbdir, f), "utf8"));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_SESSIONS = 10;

function finduser(token) {
  const username = tokenlookup(token);
  if (!username) return null;

  const user = readuser(username);
  // raw-token keys only survive if the startup migration failed to write
  const session =
    user?.sessions?.[tokenkey(token)] ??
    (islegacykey(token) ? user?.sessions?.[token] : undefined);
  if (!user || !session) {
    forgettoken(token);
    return null;
  }

  // No write here: this runs outside the user lock. Expired sessions are
  // pruned from disk at the next login.
  if (
    !Number.isFinite(session.createdAt) ||
    Date.now() - session.createdAt > SESSION_TTL
  ) {
    forgettoken(token);
    return null;
  }

  return user;
}

// keep the newest MAX_SESSIONS unexpired sessions
function prunesessions(user, keeptoken) {
  if (!user?.sessions) return;
  const now = Date.now();
  const all = Object.entries(user.sessions);
  const entries = all
    .filter(
      ([t, s]) =>
        t === keeptoken ||
        (typeof s?.createdAt === "number" && now - s.createdAt <= SESSION_TTL),
    )
    .sort(
      (a, b) =>
        (b[1]?.createdAt || 0) - (a[1]?.createdAt || 0) ||
        Number(b[0] === keeptoken) - Number(a[0] === keeptoken),
    )
    .slice(0, MAX_SESSIONS);
  const kept = new Set(entries.map(([t]) => t));
  if (kept.size === all.length) return; // nothing dropped
  user.sessions = Object.fromEntries(entries);
  // these are storage keys, not bearer tokens, so bypass forgettoken()
  for (const [t] of all) if (!kept.has(t)) tokenindex.delete(t);
}

// --- per-user write serialization ---
// User files are read-modify-write, so every mutation runs inside a per-user
// promise chain. Two-user operations lock in sorted order to avoid deadlock.

const userlocks = new Map();
const deletingUsers = new Set();

function withuserlock(lc, fn) {
  const prev = userlocks.get(lc) || Promise.resolve();
  const run = prev.then(() => fn());
  const tail = run.catch(() => {});
  tail.then(() => {
    if (userlocks.get(lc) === tail) userlocks.delete(lc);
  });
  userlocks.set(lc, tail);
  return run;
}

function withuserlocks(a, b, fn) {
  const [first, second] = a < b ? [a, b] : [b, a];
  return withuserlock(first, () => withuserlock(second, fn));
}

// --- in-memory indices (rebuilt on startup, kept in sync on writes) ---

const tokenindex = new Map(); // session storage key -> username (lowercase)
const usernames = new Map(); // lowercase name -> original case
const deviceindex = new Map(); // device fingerprint -> username (lowercase)

function indexuser(u) {
  if (!u?.username) return;
  const lc = u.username.toLowerCase();
  usernames.set(lc, u.username);
  if (u.deviceId) deviceindex.set(u.deviceId, lc);
}

function tokenlookup(token) {
  const hashed = tokenindex.get(tokenkey(token));
  if (hashed) return hashed;
  return islegacykey(token) ? tokenindex.get(token) : undefined;
}

function remembertoken(token, username) {
  tokenindex.set(tokenkey(token), username.toLowerCase());
}

function forgettoken(token) {
  tokenindex.delete(tokenkey(token));
  if (islegacykey(token)) tokenindex.delete(token);
}

function rebuildindices() {
  tokenindex.clear();
  usernames.clear();
  deviceindex.clear();
  let migrated = 0;
  for (const u of allusers()) {
    indexuser(u);
    if (!u.sessions) continue;

    // re-key sessions still stored under the raw token
    let changed = false;
    for (const key of Object.keys(u.sessions)) {
      if (!islegacykey(key)) continue;
      u.sessions[tokenkey(key)] = u.sessions[key];
      delete u.sessions[key];
      changed = true;
      migrated++;
    }
    if (changed) {
      try {
        writeuser(u);
      } catch (err) {
        // finduser's legacy fallback keeps the raw key working meanwhile
        console.error(`could not migrate sessions for ${u.username}:`, err);
      }
    }

    for (const key of Object.keys(u.sessions)) {
      tokenindex.set(key, u.username.toLowerCase());
    }
  }
  console.log(
    `indices loaded: ${usernames.size} users, ${tokenindex.size} sessions, ${deviceindex.size} devices` +
      (migrated ? ` (${migrated} legacy sessions migrated)` : ""),
  );
}
rebuildindices();

// --- play counts (gameplays.json), catalog ids only ---

const gamesfile = join(publicpath, "assets/data/aetheris.json");

function loadids() {
  try {
    const games = JSON.parse(readFileSync(gamesfile, "utf8"));
    return new Set(games.map((g) => String(g.id)));
  } catch (err) {
    console.warn(
      "couldn't load aetheris.json for play filtering:",
      err.message,
    );
    return null;
  }
}

const aetherisids = loadids();
console.log(
  `plays allowlist: ${aetherisids ? aetherisids.size + " games" : "disabled (file missing)"}`,
);

function isgame(id) {
  return aetherisids ? aetherisids.has(String(id)) : false;
}

const playsfile = join(process.cwd(), "gameplays.json");
const FLUSH_DELAY = 5_000;

let playscache = null;
let playsdirty = false;
let flushtimer = null;

function loadplays() {
  if (playscache) return playscache;
  try {
    playscache = JSON.parse(readFileSync(playsfile, "utf8"));
  } catch {
    playscache = {};
  }
  return playscache;
}

function flushplays() {
  if (!playsdirty || !playscache) return;
  try {
    const tmp = `${playsfile}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(playscache));
    renameSync(tmp, playsfile);
    playsdirty = false;
  } catch (err) {
    console.error("failed to flush plays:", err);
  }
}

function scheduleflush() {
  playsdirty = true;
  if (flushtimer) return;
  flushtimer = setTimeout(() => {
    flushtimer = null;
    flushplays();
  }, FLUSH_DELAY);
}

function bumpplay(id) {
  const plays = loadplays();
  plays[id] = (plays[id] || 0) + 1;
  scheduleflush();
}

if (!existsSync(playsfile)) {
  playscache = {};
  playsdirty = true;
  flushplays();
}

// --- wisp / proxy ---

logging.set_level(logging.NONE);
Object.assign(wisp.options, {
  allow_udp_streams: false,
  hostname_blacklist: [
    /(^|\.)pornhub\.com$/i,
    /(^|\.)xvideos\.com$/i,
    /(^|\.)xhamster\.com$/i,
    /(^|\.)xnxx\.com$/i,
    /(^|\.)redtube\.com$/i,
    /(^|\.)youporn\.com$/i,
    /(^|\.)tube8\.com$/i,
    /(^|\.)spankbang\.com$/i,
    /(^|\.)beeg\.com$/i,
    /(^|\.)eporner\.com$/i,
    /(^|\.)porntube\.com$/i,
    /(^|\.)drtuber\.com$/i,
    /(^|\.)txxx\.com$/i,
    /(^|\.)sunporno\.com$/i,
    /(^|\.)bravotube\.com$/i,
    /(^|\.)porntrex\.com$/i,
    /(^|\.)ixxx\.com$/i,
    /(^|\.)nuvid\.com$/i,
    /(^|\.)thumbzilla\.com$/i,
    /(^|\.)wankoz\.com$/i,
    /(^|\.)anysex\.com$/i,
    /(^|\.)pornoxo\.com$/i,
    /(^|\.)mrdeepfakes\.com$/i,
    /(^|\.)fapello\.com$/i,
    /(^|\.)thothub\.tv$/i,
    /(^|\.)coomer\.su$/i,
    /(^|\.)nekohouse\.su$/i,
    /(^|\.)simpcity\.su$/i,
  ],
  port_blacklist: [8080],
  // Per-connection cap; the default (-1) lets one client open unlimited
  // upstream streams through the VPS.
  // stream_limit_per_host must stay -1 on wisp-js 0.4.1: its check iterates
  // a plain object and throws, so no stream ever opens.
  stream_limit_total: 128,
  stream_limit_per_host: -1,
  dns_servers: ["1.1.1.3", "1.0.0.3"],
});

// --- online counter (SSE) ---

const clients = new Set();
const clientids = new Map(); // SSE stream -> per-browser id from ?c=
let broadcastpending = null;

// Every SSE stream holds a socket. The per-IP cap is generous because a whole
// school can share one NAT IP; the total cap is the real protection.
function envcount(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
const MAX_SSE_CLIENTS = envcount("MAX_SSE_CLIENTS", 2000);
const MAX_SSE_PER_IP = envcount("MAX_SSE_PER_IP", 128);
const sseperip = new Map();

function dropclient(res) {
  if (!clients.delete(res)) return;
  clientids.delete(res);
  const ip = res.aetherisip;
  const n = (sseperip.get(ip) || 1) - 1;
  if (n <= 0) sseperip.delete(ip);
  else sseperip.set(ip, n);
}

function onlinecount() {
  return uniqueOnlineCount(clients, clientids);
}

function broadcastcount() {
  if (broadcastpending) return;
  // coalesce rapid connect/disconnect bursts into a single write
  broadcastpending = setTimeout(() => {
    broadcastpending = null;
    const msg = `data: ${onlinecount()}\n\n`;
    for (const res of clients) {
      try {
        res.write(msg);
      } catch {
        dropclient(res);
      }
    }
  }, 50);
}

// keep SSE connections alive through proxies that kill idle streams
setInterval(() => {
  for (const res of clients) {
    try {
      res.write(": heartbeat\n\n");
    } catch {
      dropclient(res);
    }
  }
}, 30_000);

// --- fastify ---

function handleupgrade(req, socket, head) {
  if (req.url.endsWith("/wisp/")) {
    // otherwise any website could use visitors' browsers to drive our TCP relay
    if (!websocketOriginAllowed(req)) {
      console.log(
        `[wisp] rejected cross-origin upgrade origin=${req.headers?.origin} host=${req.headers?.host}`,
      );
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    wisp.routeRequest(req, socket, head);
    return;
  }

  if (req.url.startsWith("/wsproxy/")) {
    proxywsconnection(req, socket, head);
    return;
  }

  // Lethal Company relay; deliberately open to any origin (see lc-relay.js)
  if (req.url === "/lc-relay" || req.url.startsWith("/lc-relay/")) {
    lcRelayUpgrade(req, socket, head);
    return;
  }

  socket.end();
}

// growden.io-only WebSocket proxy for bare /wsproxy/<host> URLs, which the
// Caddyfile's @wsproxy matcher (it needs a path after the host) misses.
// Keep the two in sync.
function proxywsconnection(req, socket, head) {
  const path = req.url.slice("/wsproxy/".length);
  const slash = path.indexOf("/");
  const hostport = slash === -1 ? path : path.slice(0, slash);
  const rest = slash === -1 ? "" : path.slice(slash);

  const host = hostport.split(":")[0];
  if (host !== "growden.io" && !host.endsWith(".growden.io")) {
    socket.end();
    return;
  }

  let upstream;
  try {
    const target = new URL(`wss://${hostport}${rest}`);
    if (
      target.username ||
      target.password ||
      (target.port && target.port !== "443")
    )
      throw new Error("Invalid WebSocket target");
    upstream = new WebSocket(target, {
      headers: { origin: "https://growden.io" },
    });
  } catch {
    socket.destroy();
    return;
  }

  const timeout = setTimeout(() => {
    upstream.terminate();
    socket.end();
  }, 10_000);

  upstream.on("open", () => {
    clearTimeout(timeout);
    const wss = new WebSocketServer({ noServer: true });
    wss.handleUpgrade(req, socket, head, (browser) => {
      browser.on("message", (data, isBinary) => {
        if (upstream.readyState === WebSocket.OPEN)
          upstream.send(data, { binary: isBinary });
      });
      upstream.on("message", (data, isBinary) => {
        if (browser.readyState === WebSocket.OPEN)
          browser.send(data, { binary: isBinary });
      });
      browser.on("close", () => upstream.close());
      upstream.on("close", () => browser.close());
      browser.on("error", () => upstream.close());
      upstream.on("error", () => browser.close());
    });
  });
  socket.once("close", () => {
    clearTimeout(timeout);
    upstream.terminate();
  });

  upstream.on("error", (err) => {
    clearTimeout(timeout);
    console.error("ws proxy error:", err.message);
    socket.end();
  });
}

const fastify = Fastify({
  // only the local Caddy; `true` would let clients spoof req.ip
  trustProxy: ["127.0.0.1", "::1"],
  serverFactory: (handler) =>
    createServer()
      .on("request", (req, res) => {
        // iOS Safari blocks AudioContext.resume() in iframes without this
        res.setHeader("Permissions-Policy", "autoplay=*, fullscreen=*");
        handler(req, res);
      })
      .on("upgrade", handleupgrade),
});

// MOVIE_RELAY_HOST moves the relay to its own origin; see movie-relay.js.
registerMovieRelay(fastify, {
  relayHost: process.env.MOVIE_RELAY_HOST || "",
  embedders: (process.env.MOVIE_RELAY_EMBEDDERS || "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean),
});
registerImageProxy(fastify);

// Returns { group, limit, windowMs, perAccount } for metered requests, or null.
// Relay and image routes fetch upstream per request, and authenticated GETs do
// blocking file I/O, so those are capped alongside the POST APIs.
function ratelimitfor(method, path) {
  if (method === "OPTIONS") return null;
  if (
    path === "/movie-proxy" ||
    path.startsWith("/movie-proxy/") ||
    path === "/hls-resolve" ||
    path === "/api.php"
  )
    // a classroom behind one NAT IP streams a few hundred HLS requests a minute
    return { group: "movie-proxy", limit: 600 };

  if (method === "GET") {
    if (path === "/img") return { group: "img-proxy", limit: 6000 };
    if (path === "/movie-ping") return { group: "movie-ping", limit: 60 };
    if (path.startsWith("/api/tmdb/")) return { group: "tmdb", limit: 120 };
    if (path === "/api/ai/models") return { group: "ai-models", limit: 30 };
    // chat polling is ~40 requests/min per account
    if (path.startsWith("/api/"))
      return { group: "api-get", limit: 300, perAccount: true };
    return null;
  }

  if (method !== "POST") return null;
  if (path === "/api/accounts/register") return { group: path, limit: 30 };
  if (path === "/api/accounts/login") return { group: path, limit: 60 };
  if (path === "/api/report")
    return { group: path, limit: 10, windowMs: 120_000 };
  // schools share one IP, so sends are metered per account; the IP ceiling
  // only stops one client farming many accounts
  if (path.startsWith("/api/dm/"))
    return { group: "dm-send", limit: 60, perAccount: true, ipLimit: 600 };
  if (path.startsWith("/api/dm-inbox/read/"))
    return { group: "dm-read", limit: 300, perAccount: true };
  // per IP, so rotating deviceIds can't inflate play counts
  if (path.startsWith("/api/plays/")) return { group: "plays", limit: 60 };
  if (path === "/api/ai/chat") return { group: path, limit: 30 };
  if (path === "/api/ai/images") return { group: path, limit: 6 };
  return null;
}

const consumeRate = createRateLimiter();
fastify.addHook("onRequest", async (req, reply) => {
  const path = req.url.split("?")[0];
  if (path.startsWith("/api/")) reply.header("Cache-Control", "no-store");
  const rule = ratelimitfor(req.method, path);
  if (!rule) return;

  const ip = getclientip(req);
  const windowms = rule.windowMs || 60_000;
  let ratekey = ip;
  if (rule.perAccount) {
    // key by resolved account, so garbage tokens share the IP bucket instead
    // of minting a limiter entry each
    const token = gettoken(req);
    const account = token ? tokenlookup(token) : null;
    if (account) ratekey = `acct:${account}`;
  }
  let result = consumeRate(`${rule.group}:${ratekey}`, rule.limit, windowms);
  // only allowed requests count toward the IP ceiling, so one noisy account
  // can't use up the budget of everyone else behind the same IP
  if (result.allowed && rule.ipLimit && ratekey !== ip)
    result = consumeRate(`${rule.group}:ip:${ip}`, rule.ipLimit, windowms);
  if (!result.allowed)
    return reply
      .header("Retry-After", result.retryAfter)
      .code(429)
      .send({
        ok: false,
        error: `Too many requests. Try again in ${result.retryAfter}s.`,
      });
});

fastify.get("/online", (req, reply) => {
  const ip = getclientip(req);
  if (
    clients.size >= MAX_SSE_CLIENTS ||
    (sseperip.get(ip) || 0) >= MAX_SSE_PER_IP
  ) {
    return reply
      .code(503)
      .header("Retry-After", "30")
      .send("Too many online-counter connections. Try again shortly.");
  }
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": "*",
  });
  // detect dead peers instead of counting them until the OS TCP timeout
  try {
    req.raw.socket.setKeepAlive(true, 30_000);
  } catch {
    // socket already gone; the close handler below cleans up
  }
  let clientid = "";
  try {
    clientid = String(
      new URL(req.url, "http://localhost").searchParams.get("c") || "",
    ).slice(0, 64);
  } catch {
    // malformed URL counts as an anonymous connection
  }
  clients.add(res);
  res.aetherisip = ip;
  sseperip.set(ip, (sseperip.get(ip) || 0) + 1);
  if (clientid) clientids.set(res, clientid);
  broadcastcount();
  req.raw.on("close", () => {
    dropclient(res);
    broadcastcount();
  });
});

fastify.get("/online-count", (_req, reply) => {
  reply.header("Access-Control-Allow-Origin", "*");
  reply.send({ count: onlinecount() });
});

// top/counts responses are recalculated at most every 10s
let toppopular = null;
let topstale = 0;
let countscache = null;
let countsstale = 0;
const CACHE_TTL = 10_000;

fastify.get("/api/plays/top", (_req, reply) => {
  const now = Date.now();
  if (!toppopular || now - topstale > CACHE_TTL) {
    toppopular = Object.entries(loadplays())
      .filter(([id]) => isgame(id))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id]) => id);
    topstale = now;
  }
  reply.send(toppopular);
});

fastify.get("/api/plays/counts", (_req, reply) => {
  const now = Date.now();
  if (!countscache || now - countsstale > CACHE_TTL) {
    countscache = {};
    for (const [id, count] of Object.entries(loadplays())) {
      if (isgame(id)) countscache[id] = count;
    }
    countsstale = now;
  }
  reply.send(countscache);
});

// one bump per (fingerprint, game) per minute
const BUMP_WINDOW = 60_000;
const playbumps = new Map();

fastify.post("/api/plays/:id", (req, reply) => {
  const { id } = req.params;
  if (!id || id.length > 128) return reply.code(400).send({ ok: false });
  if (!isgame(id))
    return reply.code(400).send({ ok: false, error: "Game not tracked." });

  const deviceid = req.body?.deviceId;
  const fp = isvaliddeviceid(deviceid)
    ? `dev:${deviceid}`
    : `ip:${getclientip(req)}`;
  const key = `${fp}|${id}`;
  const now = Date.now();
  const last = playbumps.get(key) || 0;

  if (now - last < BUMP_WINDOW)
    return reply.send({ ok: true, throttled: true });
  playbumps.set(key, now);

  if (playbumps.size > 20_000) {
    const cutoff = now - BUMP_WINDOW;
    for (const [k, ts] of playbumps) {
      if (ts < cutoff) playbumps.delete(k);
    }
  }

  bumpplay(id);
  reply.send({ ok: true });
});

// --- discord webhooks ---

const REPORT_WEBHOOK_URL = process.env.REPORT_WEBHOOK_URL || "";
const STATS_WEBHOOK_URL = process.env.STATS_WEBHOOK_URL || "";

const STATS_INTERVAL = 5 * 60 * 1000;
const georesolver = createGeoResolver();

// one IP per distinct online person, deduped the same way as onlinecount()
function onlinepeopleips() {
  const people = new Map();
  for (const res of clients) {
    const key = clientids.get(res) || res;
    if (!people.has(key)) people.set(key, res.aetherisip);
  }
  return [...people.values()];
}
const REPORT_COOLDOWN = 2 * 60 * 1000; // 2min between reports per fingerprint
// Login limits are keyed by IP, never by account alone: an account-wide
// limit would let anyone lock a known user out from everywhere.
const LOGIN_WINDOW = 5 * 60 * 1000;
const MAX_LOGIN_PER_IP_USER = 10; // attempts per (IP, username) per window
const MAX_LOGIN_FAILS_PER_IP = 50; // failed attempts per IP per window

const reporttimes = new Map();
const loginattempts = new Map(); // "ip|username" -> attempts
const loginfailsbyip = new Map(); // ip -> failed attempts

fastify.post("/api/report", async (req, reply) => {
  const { game, issue, steps, notes, url, deviceId: deviceid } = req.body || {};

  const ratelimitkey = isvaliddeviceid(deviceid)
    ? `fp:${deviceid}`
    : `ip:${getclientip(req)}`;
  const now = Date.now();
  const remaining =
    REPORT_COOLDOWN - (now - (reporttimes.get(ratelimitkey) || 0));
  if (remaining > 0)
    return reply
      .code(429)
      .send({
        ok: false,
        error: `Too many reports. Try again in ${Math.ceil(remaining / 1000)}s.`,
      });

  if (
    typeof issue !== "string" ||
    typeof steps !== "string" ||
    !issue.trim() ||
    !steps.trim()
  )
    return reply
      .code(400)
      .send({ ok: false, error: "Missing required fields." });
  if (
    steps.length > 2000 ||
    issue.length > 256 ||
    (notes !== undefined &&
      (typeof notes !== "string" || notes.length > 1000)) ||
    (game !== undefined && (typeof game !== "string" || game.length > 256)) ||
    (url !== undefined && (typeof url !== "string" || url.length > 2048))
  )
    return reply
      .code(400)
      .send({ ok: false, error: "Invalid or oversized report fields." });

  if (!REPORT_WEBHOOK_URL)
    return reply
      .code(503)
      .send({
        ok: false,
        error: "Bug reporting is not configured on this server.",
      });

  reporttimes.set(ratelimitkey, now);
  if (reporttimes.size > 5000) {
    const cutoff = now - REPORT_COOLDOWN;
    for (const [k, ts] of reporttimes) {
      if (ts < cutoff) reporttimes.delete(k);
    }
  }

  const fields = [
    {
      name: "🎮 Game",
      value: String(game || "Unknown").slice(0, 256),
      inline: true,
    },
    { name: "❌ Issue", value: String(issue).slice(0, 256), inline: true },
    {
      name: "🔁 How to recreate",
      value: String(steps).slice(0, 1024),
      inline: false,
    },
    {
      name: "🌐 URL",
      value: String(url || "Unknown").slice(0, 512),
      inline: false,
    },
  ];
  if (notes)
    fields.splice(3, 0, {
      name: "📝 Extra notes",
      value: String(notes).slice(0, 1024),
      inline: false,
    });

  const payload = {
    username: "Aetheris Bug Reporter",
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: "🚩 New Game Report",
        color: 0xa855f7,
        fields,
        timestamp: new Date().toISOString(),
        footer: { text: "Aetheris • Game Report" },
      },
    ],
  };

  try {
    const res = await fetch(REPORT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.error("report webhook failed:", res.status);
      return reply
        .code(502)
        .send({ ok: false, error: "Failed to send report." });
    }
    reply.send({ ok: true });
  } catch (e) {
    console.error("report webhook error:", e);
    reply.code(502).send({ ok: false, error: "Failed to send report." });
  }
});

async function poststats() {
  if (!STATS_WEBHOOK_URL) return;

  const plays = loadplays();
  const totalplays = Object.values(plays).reduce((a, b) => a + b, 0);
  const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];
  const top5 = Object.entries(plays)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, count], i) => `${medals[i]} **${id}** — ${count} plays`)
    .join("\n");

  let countriesvalue = "No location data yet";
  try {
    const ips = onlinepeopleips();
    const lookup = await georesolver.resolve(ips);
    const top = topcountries(
      ips.map((ip) => lookup.get(normalizeip(ip))),
      5,
    );
    countriesvalue = formattopcountries(top);
  } catch (e) {
    console.error("stats country lookup error:", e);
  }

  const payload = {
    username: "aetheris stats",
    embeds: [
      {
        title: "📊 Site Stats",
        color: 0xa855f7,
        fields: [
          { name: "👥 Online Now", value: String(onlinecount()), inline: true },
          { name: "🎮 Total Plays", value: String(totalplays), inline: true },
          {
            name: "🌍 Top 5 Countries (online now)",
            value: countriesvalue.slice(0, 1024),
            inline: false,
          },
          {
            name: "🔥 Top 5 Games",
            value: top5 || "No plays yet",
            inline: false,
          },
        ],
        timestamp: new Date().toISOString(),
        footer: { text: "Aetheris • Auto Stats" },
      },
    ],
  };

  try {
    const res = await fetch(STATS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) console.error("stats webhook failed:", res.status);
    else console.log("stats posted to discord");
  } catch (e) {
    console.error("stats webhook error:", e);
  }
}

poststats();
setInterval(poststats, STATS_INTERVAL);

// returns the user object or null (after sending an error response)
function requireauth(req, reply) {
  const token = gettoken(req);
  if (!token) {
    reply.code(401).send({ ok: false, error: "Not authenticated." });
    return null;
  }
  const user = finduser(token);
  if (!user) {
    reply.code(401).send({ ok: false, error: "Invalid or expired session." });
    return null;
  }
  return user;
}

// Removes the account and its conversations from the other side. Takes one
// lock at a time (never nested) so withuserlocks() ordering stays deadlock-free.
async function deleteaccount(lc) {
  const victim = await withuserlock(lc, () => {
    const user = readuser(lc);
    if (!user || deletingUsers.has(lc)) return null;
    deletingUsers.add(lc);
    for (const key of Object.keys(user.sessions || {})) tokenindex.delete(key);
    return user;
  });
  if (!victim) return false;

  try {
    for (const otherlower of Object.keys(victim.dms || {})) {
      await withuserlock(otherlower, () => {
        const other = readuser(otherlower);
        if (other?.dms) {
          delete other.dms[lc];
          if (other.lastRead) delete other.lastRead[lc];
          writeuser(other);
        }
      });
    }

    await withuserlock(lc, () => {
      const fresh = readuser(lc);
      if (!fresh) return;
      for (const key of Object.keys(fresh.sessions || {}))
        tokenindex.delete(key);
      deleteuser(fresh);
    });
    return true;
  } finally {
    deletingUsers.delete(lc);
  }
}

// --- account creation rate limiting (each account is a file on disk) ---
const REGISTER_WINDOW = 60 * 1000;
const MAX_REGISTER_PER_FP = 3;
const registerattempts = new Map();

function registerallowed(req) {
  const { deviceId: deviceid } = req.body || {};
  const fp = isvaliddeviceid(deviceid)
    ? `dev:${deviceid}`
    : `ip:${getclientip(req)}`;
  const now = Date.now();
  const entry = registerattempts.get(fp) || { count: 0, windowstart: now };
  if (now - entry.windowstart > REGISTER_WINDOW) {
    entry.count = 0;
    entry.windowstart = now;
  }
  entry.count++;
  registerattempts.set(fp, entry);
  if (registerattempts.size > 10_000) {
    for (const [k, v] of registerattempts) {
      if (v.windowstart < now - REGISTER_WINDOW) registerattempts.delete(k);
    }
  }
  return entry.count <= MAX_REGISTER_PER_FP;
}

// new passwords only; login still accepts the old 4-character minimum
const MIN_PASSWORD_LENGTH = 6;

fastify.post("/api/accounts/register", async (req, reply) => {
  const ip = getclientip(req);
  const { username, password, deviceId: deviceid } = req.body || {};

  if (!isvalidusername(username) || typeof password !== "string")
    return reply
      .code(400)
      .send({
        ok: false,
        error: "Use a valid 2–32 character username and a text password.",
      });
  if (password.length < MIN_PASSWORD_LENGTH || password.length > 128)
    return reply.code(400).send({
      ok: false,
      error: `Password must be ${MIN_PASSWORD_LENGTH}–128 characters.`,
    });
  if (!isvaliddeviceid(deviceid))
    return reply
      .code(400)
      .send({
        ok: false,
        error:
          "Missing or invalid device fingerprint. Please enable cookies/localStorage.",
      });
  if (!registerallowed(req)) {
    const wait = Math.ceil(REGISTER_WINDOW / 1000);
    return reply
      .code(429)
      .send({
        ok: false,
        error: `Too many accounts created from this device/network. Try again in ${wait}s.`,
      });
  }

  const loweruser = username.toLowerCase();

  const existinglc = deviceindex.get(deviceid);
  if (existinglc) {
    const existing = readuser(existinglc);
    if (existing)
      return reply
        .code(403)
        .send({
          ok: false,
          error: `This device already has an account (${existing.username}). Log in or delete it first.`,
        });
    // stale index entry
    deviceindex.delete(deviceid);
  }

  // re-check and create inside the locks so racing registrations can't both win
  const result = await withuserlock("device:" + deviceid, () =>
    withuserlock(loweruser, async () => {
      if (deviceindex.has(deviceid)) return { deviceConflict: true };
      if (deletingUsers.has(loweruser)) return { conflict: true };
      if (usernames.has(loweruser) || readuser(loweruser))
        return { conflict: true };

      const user = {
        username,
        passwordHash: await hashpw(password),
        ip,
        deviceId: deviceid,
        createdAt: Date.now(),
        sessions: {},
        dms: Object.create(null),
      };
      const token = maketoken();
      user.sessions[tokenkey(token)] = { ip, createdAt: Date.now() };
      writeuser(user);
      remembertoken(token, user.username);
      return { token };
    }),
  );

  if (result.deviceConflict)
    return reply
      .code(403)
      .send({
        ok: false,
        error: "This device already has an account. Log in or delete it first.",
      });
  if (result.conflict)
    return reply
      .code(409)
      .send({ ok: false, error: "Username already taken." });
  reply.send({ ok: true, token: result.token, username });
});

fastify.post("/api/accounts/login", async (req, reply) => {
  const ip = getclientip(req);
  const { username, password } = req.body || {};
  // older accounts may have passwords shorter than MIN_PASSWORD_LENGTH
  if (
    !isvalidusername(username) ||
    typeof password !== "string" ||
    password.length < 4 ||
    password.length > 128
  )
    return reply
      .code(400)
      .send({ ok: false, error: "Invalid username or password format." });

  const userlc = String(username).toLowerCase();
  const pairkey = `${ip}|${userlc}`;

  // returns the live entry for key, starting a new window if it expired
  function loginentry(map, key) {
    const now = Date.now();
    let entry = map.get(key);
    if (!entry || now - entry.windowstart > LOGIN_WINDOW) {
      entry = { count: 0, windowstart: now };
      map.set(key, entry);
      if (map.size > 10_000) {
        for (const [k, v] of map)
          if (now - v.windowstart > LOGIN_WINDOW) map.delete(k);
      }
    }
    return entry;
  }

  const pair = loginentry(loginattempts, pairkey);
  const ipfails = loginentry(loginfailsbyip, ip);
  const blocked =
    pair.count >= MAX_LOGIN_PER_IP_USER
      ? pair
      : ipfails.count >= MAX_LOGIN_FAILS_PER_IP
        ? ipfails
        : null;
  if (blocked) {
    const retryafter = Math.max(
      1,
      Math.ceil((LOGIN_WINDOW - (Date.now() - blocked.windowstart)) / 1000),
    );
    return reply
      .code(429)
      .header("Retry-After", retryafter)
      .send({
        ok: false,
        error: `Too many login attempts. Try again in ${retryafter}s.`,
      });
  }
  pair.count++;

  const user = await withuserlock(userlc, async () => {
    const u = readuser(userlc);
    if (!u || deletingUsers.has(userlc)) {
      // same cost as a wrong password
      await verifypw(password, DUMMY_HASH);
      return null;
    }
    if (!(await verifypw(password, u.passwordHash))) return null;

    const token = maketoken();
    u.sessions ??= {};
    const key = tokenkey(token);
    u.sessions[key] = { ip, createdAt: Date.now() };
    u.ip = ip;
    prunesessions(u, key);
    writeuser(u);
    remembertoken(token, u.username);
    return { user: u, token };
  });

  if (!user) {
    loginentry(loginfailsbyip, ip).count++;
    return reply
      .code(401)
      .send({ ok: false, error: "Invalid username or password." });
  }

  loginattempts.delete(pairkey);
  reply.send({ ok: true, token: user.token, username: user.user.username });
});

fastify.post("/api/accounts/logout", async (req, reply) => {
  const token = gettoken(req);
  if (!token) return reply.code(400).send({ ok: false, error: "No token." });

  const lc = tokenlookup(token);
  if (lc) {
    await withuserlock(lc, () => {
      const user = readuser(lc);
      if (user?.sessions) {
        const key = tokenkey(token);
        if (user.sessions[key] || user.sessions[token]) {
          delete user.sessions[key];
          delete user.sessions[token];
          writeuser(user);
        }
      }
    });
  }
  forgettoken(token);
  reply.send({ ok: true });
});

fastify.delete("/api/accounts/delete", async (req, reply) => {
  const me = requireauth(req, reply);
  if (!me) return;
  await deleteaccount(me.username.toLowerCase());
  reply.send({ ok: true });
});

fastify.delete("/api/accounts/delete-all-mine", async (req, reply) => {
  // The device id alone is not proof of ownership (it is readable from a shared
  // browser and included in settings exports), so require a session too.
  const me = requireauth(req, reply);
  if (!me) return;

  const { deviceId: deviceid } = req.body || {};
  if (!isvaliddeviceid(deviceid))
    return reply
      .code(400)
      .send({ ok: false, error: "Missing device fingerprint." });
  if (me.deviceId !== deviceid)
    return reply
      .code(403)
      .send({
        ok: false,
        error: "This account was not created on that device.",
      });

  await deleteaccount(me.username.toLowerCase());
  reply.send({ ok: true, deleted: 1 });
});

fastify.get("/api/accounts/me", (req, reply) => {
  const user = requireauth(req, reply);
  if (!user) return;
  reply.send({ ok: true, username: user.username });
});

fastify.get("/api/accounts/search", (req, reply) => {
  const me = requireauth(req, reply);
  if (!me) return;

  const q = String(req.query.q || "")
    .trim()
    .toLowerCase();
  if (q.length < 2) return reply.send({ ok: true, users: [] });

  const mylower = me.username.toLowerCase();
  const prefixMatches = [];
  const substringMatches = [];

  for (const [lc, original] of usernames) {
    if (lc === mylower) continue;
    if (lc.startsWith(q)) {
      prefixMatches.push(original);
    } else if (lc.includes(q)) {
      substringMatches.push(original);
    }
    if (prefixMatches.length + substringMatches.length >= 20) break;
  }
  reply.send({
    ok: true,
    users: [...prefixMatches, ...substringMatches].slice(0, 20),
  });
});

const DM_MAX = 500;

fastify.get("/api/dm/:recipient", (req, reply) => {
  const me = requireauth(req, reply);
  if (!me) return;

  const recipientlower = req.params.recipient.toLowerCase();
  if (!usernames.has(recipientlower))
    return reply.code(404).send({ ok: false, error: "User not found." });

  const msgs = (me.dms || {})[recipientlower] || [];
  const after = parseInt(req.query.after || "0", 10);
  reply.send(after ? msgs.filter((m) => m.time > after) : msgs);
});

fastify.post("/api/dm/:recipient", async (req, reply) => {
  const me = requireauth(req, reply);
  if (!me) return;

  const recipientlower = req.params.recipient.toLowerCase();
  const { message } = req.body || {};

  if (typeof message !== "string" || !message.trim())
    return reply
      .code(400)
      .send({ ok: false, error: "Empty or invalid message." });
  if (message.length > 3000)
    return reply
      .code(400)
      .send({ ok: false, error: "Message too long (max 3000 characters)." });

  if (!usernames.has(recipientlower))
    return reply.code(404).send({ ok: false, error: "User not found." });

  const senderlower = me.username.toLowerCase();
  if (senderlower === recipientlower)
    return reply.code(400).send({ ok: false, error: "Cannot DM yourself." });

  const delivered = await withuserlocks(senderlower, recipientlower, () => {
    const sender = readuser(senderlower);
    const recipient = readuser(recipientlower);
    if (
      !sender ||
      !recipient ||
      deletingUsers.has(senderlower) ||
      deletingUsers.has(recipientlower) ||
      !finduser(gettoken(req))
    )
      return false;
    const sent = sender.dms?.[recipientlower];
    const received = recipient.dms?.[senderlower];
    // Strictly increasing per conversation: same-millisecond sends must
    // never disappear behind the client's ?after= timestamp cursor.
    const time = Math.max(
      Date.now(),
      (Array.isArray(sent) ? sent.at(-1)?.time || 0 : 0) + 1,
      (Array.isArray(received) ? received.at(-1)?.time || 0 : 0) + 1,
    );
    const msg = { from: senderlower, message: message.trim(), time };

    sender.dms ??= {};
    sender.dms[recipientlower] ??= [];
    sender.dms[recipientlower].push(msg);
    if (sender.dms[recipientlower].length > DM_MAX) {
      sender.dms[recipientlower] = sender.dms[recipientlower].slice(-DM_MAX);
    }
    writeuser(sender);

    recipient.dms ??= {};
    recipient.dms[senderlower] ??= [];
    recipient.dms[senderlower].push(msg);
    if (recipient.dms[senderlower].length > DM_MAX) {
      recipient.dms[senderlower] = recipient.dms[senderlower].slice(-DM_MAX);
    }
    writeuser(recipient);
    return true;
  });

  if (!delivered)
    return reply
      .code(409)
      .send({
        ok: false,
        error: "The conversation or session is no longer available.",
      });
  reply.send({ ok: true });
});

fastify.get("/api/dm-inbox", (req, reply) => {
  const me = requireauth(req, reply);
  if (!me) return;

  const lastread = me.lastRead || {};
  const conversations = [];

  for (const [otherlower, msgs] of Object.entries(me.dms || {})) {
    if (!msgs.length) continue;
    const last = msgs[msgs.length - 1];
    const readts = lastread[otherlower] || 0;
    const unread = msgs.filter(
      (m) => m.from.toLowerCase() === otherlower && m.time > readts,
    ).length;
    conversations.push({
      with: usernames.get(otherlower) ?? otherlower,
      lastMessage: last.message,
      lastTime: last.time,
      unread,
    });
  }

  conversations.sort((a, b) => b.lastTime - a.lastTime);
  reply.send({ ok: true, conversations });
});

fastify.post("/api/dm-inbox/read/:other", async (req, reply) => {
  const me = requireauth(req, reply);
  if (!me) return;

  const lc = me.username.toLowerCase();
  await withuserlock(lc, () => {
    const fresh = readuser(lc);
    if (!fresh) return;
    const other = req.params.other.toLowerCase();
    if (!isvalidusername(other)) return;
    const messages = fresh.dms?.[other];
    // no conversation: don't let arbitrary names accumulate in lastRead
    if (!Array.isArray(messages) || !messages.length) return;
    const latest = messages.at(-1)?.time || 0;
    const requested = Number(req.body?.through);
    const through =
      Number.isFinite(requested) && requested >= 0
        ? Math.min(requested, latest)
        : latest;
    fresh.lastRead ??= {};
    const next = Math.max(fresh.lastRead[other] || 0, through);
    if (next === fresh.lastRead[other]) return;
    fresh.lastRead[other] = next;
    writeuser(fresh);
  });
  reply.send({ ok: true });
});

// --- crax-gpt AI proxy (keeps the API key server-side) ---

const CRAX_GPT_KEY = process.env.CRAX_GPT_KEY || "";
const CRAX_GPT_BASE = (
  process.env.CRAX_GPT_BASE_URL || "https://gpt.crax.lol/v1"
).replace(/\/+$/, "");
const CRAX_GPT_MODEL = process.env.CRAX_GPT_MODEL || "gpt-5-6-sol";
const CRAX_GPT_IMG_MODEL = process.env.CRAX_GPT_IMAGE_MODEL || "gpt-image-2";
const MAX_GENERATED_IMAGE_BYTES = 20 * 1024 * 1024;
const AI_MODELS_TIMEOUT_MS = 15 * 1000;
const AI_CHAT_TIMEOUT_MS = 5 * 60 * 1000;
const AI_IMAGE_TIMEOUT_MS = 3 * 60 * 1000;
const AI_IMAGE_DOWNLOAD_TIMEOUT_MS = 30 * 1000;

// Anonymous AI is allowed by default (AI_REQUIRE_LOGIN=true opts into a login
// gate). These caps bound what one visitor can spend without an account:
// total prompt text per chat request and concurrent upstream requests.
const AI_MAX_TEXT_CHARS = 200_000;
const AI_MAX_CONCURRENT_PER_IP = 3;
const AI_MAX_CONCURRENT = 24;

const aiactive = new Map(); // client ip -> in-flight upstream requests
let aiactiveTotal = 0;

function acquireAiSlot(ip) {
  if (aiactiveTotal >= AI_MAX_CONCURRENT) return false;
  if ((aiactive.get(ip) || 0) >= AI_MAX_CONCURRENT_PER_IP) return false;
  aiactive.set(ip, (aiactive.get(ip) || 0) + 1);
  aiactiveTotal++;
  return true;
}

function releaseAiSlot(ip) {
  const n = (aiactive.get(ip) || 1) - 1;
  if (n <= 0) aiactive.delete(ip);
  else aiactive.set(ip, n);
  if (aiactiveTotal > 0) aiactiveTotal--;
}

// Characters of user-visible text in a chat request, ignoring base64 image
// parts (those are bounded by the 20 MB body limit and the client trimmer).
function chatTextSize(messages) {
  let total = 0;
  for (const message of messages) {
    if (typeof message.content === "string") {
      total += message.content.length;
      continue;
    }
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (typeof part?.text === "string") total += part.text.length;
      }
    }
  }
  return total;
}

function isTimeoutError(error) {
  return (
    error && (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

async function readAiResponse(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text.slice(0, 500) } };
  }
}

function upstreamerror(data, res) {
  return (
    (data.error && (data.error.message || data.error.code)) ||
    `Upstream ${res.status}`
  );
}

// 401/403/429/5xx from an upstream are our problem, not the caller's
function isupstreamfault(status) {
  return status === 401 || status === 403 || status === 429 || status >= 500;
}

// An upstream 401/403 means the server key or config is wrong. Passing it on
// would look like the user's own session expired, so it becomes a 502.
function sendUpstreamError(reply, res, data, label, service = "AI service") {
  const detail = upstreamerror(data, res);
  if (res.status === 401 || res.status === 403) {
    console.error(
      `[${label}] upstream rejected our credentials (${res.status}):`,
      detail,
    );
    return reply.code(502).send({
      ok: false,
      error: `${service} misconfigured on this server. Please try again later.`,
    });
  }
  if (res.status === 429) {
    const retry = res.headers.get("retry-after");
    if (retry && /^\d+$/.test(retry)) reply.header("Retry-After", retry);
    return reply.code(429).send({
      ok: false,
      error: `${service} is busy right now. Please try again in a moment.`,
    });
  }
  if (res.status >= 500) {
    console.error(`[${label}] upstream ${res.status}:`, detail);
    return reply.code(502).send({
      ok: false,
      error: `${service} had a problem. Please try again.`,
    });
  }
  return reply.code(res.status).send({ ok: false, error: detail });
}

function sendUpstreamFailure(reply, error, label, service = "the AI service") {
  console.error(`[${label}] error:`, error);
  if (isTimeoutError(error))
    return reply.code(504).send({
      ok: false,
      error: `The request to ${service} timed out. Please try again.`,
    });
  return reply.code(502).send({
    ok: false,
    error: `Could not reach ${service}. Please try again.`,
  });
}

// Sends the error and returns false when AI is unavailable to this request.
function aiallowed(req, reply) {
  if (!CRAX_GPT_KEY) {
    reply
      .code(503)
      .send({ ok: false, error: "AI is not configured on this server." });
    return false;
  }
  if (process.env.AI_REQUIRE_LOGIN === "true" && !requireauth(req, reply))
    return false;
  return true;
}

if (!CRAX_GPT_KEY) {
  console.warn(
    "[ai] CRAX_GPT_KEY is not set — /api/ai/* endpoints will return 503. Set it in .env to enable AI.",
  );
}

// Streaming responses are piped straight through.
fastify.post(
  "/api/ai/chat",
  { bodyLimit: 20 * 1024 * 1024 },
  async (req, reply) => {
    if (!aiallowed(req, reply)) return;
    const clientip = getclientip(req);
    if (!acquireAiSlot(clientip))
      return reply.code(429).send({
        ok: false,
        error: "Too many AI requests in flight. Try again in a moment.",
      });
    const abort = new AbortController();
    const stop = () => {
      if (!reply.raw.writableFinished) abort.abort();
    };
    reply.raw.once("close", stop);
    try {
      const { messages, stream, model, include_reasoning } = req.body || {};
      if (
        !Array.isArray(messages) ||
        messages.length === 0 ||
        messages.length > 200 ||
        messages.some(
          (message) =>
            !message ||
            typeof message !== "object" ||
            !["system", "developer", "user", "assistant", "tool"].includes(
              message.role,
            ) ||
            (typeof message.content !== "string" &&
              !Array.isArray(message.content)),
        )
      ) {
        return reply
          .code(400)
          .send({ ok: false, error: "messages must be a non-empty array." });
      }
      if (chatTextSize(messages) > AI_MAX_TEXT_CHARS)
        return reply.code(413).send({
          ok: false,
          error: `Message text is too large (max ${AI_MAX_TEXT_CHARS.toLocaleString("en-US")} characters).`,
        });
      if (
        (model !== undefined &&
          (typeof model !== "string" || model.length > 200)) ||
        (stream !== undefined && typeof stream !== "boolean")
      )
        return reply
          .code(400)
          .send({ ok: false, error: "Invalid model or stream option." });
      const payload = {
        model: String(model || CRAX_GPT_MODEL),
        messages,
        ...(stream === true ? { stream: true } : {}),
        ...(include_reasoning === true ? { include_reasoning: true } : {}),
      };
      const res = await fetch(`${CRAX_GPT_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CRAX_GPT_KEY}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.any([
          abort.signal,
          AbortSignal.timeout(AI_CHAT_TIMEOUT_MS),
        ]),
      });

      if (stream === true) {
        if (!res.ok) {
          const data = await readAiResponse(res);
          return sendUpstreamError(reply, res, data, "ai chat");
        }
        reply.hijack();
        reply.raw.writeHead(res.status, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        if (!res.body) {
          reply.raw.end();
          return;
        }
        try {
          await pipeline(Readable.fromWeb(res.body), reply.raw);
        } catch (error) {
          if (!abort.signal.aborted)
            console.warn("[ai] stream interrupted:", error.message);
        }
        return;
      }

      const data = await readAiResponse(res);
      if (!res.ok) return sendUpstreamError(reply, res, data, "ai chat");
      reply.send(data);
    } catch (e) {
      if (!reply.raw.destroyed && !reply.sent)
        sendUpstreamFailure(reply, e, "ai chat");
    } finally {
      reply.raw.removeListener("close", stop);
      releaseAiSlot(clientip);
    }
  },
);

fastify.get("/api/ai/models", async (req, reply) => {
  if (!aiallowed(req, reply)) return;
  try {
    const res = await fetch(`${CRAX_GPT_BASE}/models`, {
      headers: { Authorization: `Bearer ${CRAX_GPT_KEY}` },
      signal: AbortSignal.timeout(AI_MODELS_TIMEOUT_MS),
    });
    const data = await readAiResponse(res);
    if (!res.ok) return sendUpstreamError(reply, res, data, "ai models");
    reply.send({
      ok: true,
      data: Array.isArray(data.data) ? data.data : [],
      default_model: CRAX_GPT_MODEL,
      default_image_model: CRAX_GPT_IMG_MODEL,
    });
  } catch (e) {
    sendUpstreamFailure(reply, e, "ai models");
  }
});

fastify.post(
  "/api/ai/images",
  { bodyLimit: 24 * 1024 * 1024 },
  async (req, reply) => {
    if (!aiallowed(req, reply)) return;
    const clientip = getclientip(req);
    if (!acquireAiSlot(clientip))
      return reply.code(429).send({
        ok: false,
        error: "Too many AI requests in flight. Try again in a moment.",
      });
    try {
      const { prompt, model, n, size, images } = req.body || {};
      if (
        typeof prompt !== "string" ||
        !prompt.trim() ||
        prompt.length > 4000
      ) {
        return reply
          .code(400)
          .send({
            ok: false,
            error: "prompt must be a non-empty string (max 4000 chars).",
          });
      }
      if (
        (n !== undefined && (!Number.isInteger(n) || n < 1 || n > 4)) ||
        (model !== undefined &&
          (typeof model !== "string" || model.length > 200)) ||
        (size !== undefined &&
          (typeof size !== "string" || !/^(auto|\d{2,4}x\d{2,4})$/.test(size)))
      ) {
        return reply
          .code(400)
          .send({ ok: false, error: "Invalid image options (n must be 1–4)." });
      }
      if (images !== undefined && !Array.isArray(images)) {
        return reply
          .code(400)
          .send({ ok: false, error: "images must be an array." });
      }
      const referenceImages = Array.isArray(images) ? images : [];
      if (referenceImages.length > 4) {
        return reply
          .code(400)
          .send({
            ok: false,
            error: "A maximum of four reference images is allowed.",
          });
      }
      for (const image of referenceImages) {
        const match =
          typeof image === "string" &&
          image.match(
            /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/,
          );
        if (!match)
          return reply
            .code(400)
            .send({
              ok: false,
              error:
                "Every reference must be a PNG, JPG, WebP or GIF data URL.",
            });
        if (Buffer.from(match[2], "base64").length > 4 * 1024 * 1024) {
          return reply
            .code(400)
            .send({
              ok: false,
              error: "Reference images must be 4 MB or smaller.",
            });
        }
      }
      const payload = {
        model: String(model || CRAX_GPT_IMG_MODEL),
        prompt: String(prompt),
        ...(n ? { n } : {}),
        ...(size ? { size } : {}),
        ...(referenceImages.length ? { images: referenceImages } : {}),
      };
      const res = await fetch(`${CRAX_GPT_BASE}/images/generations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CRAX_GPT_KEY}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(AI_IMAGE_TIMEOUT_MS),
      });
      const data = await readAiResponse(res);
      if (!res.ok) return sendUpstreamError(reply, res, data, "ai images");
      // Inline URL results as base64: school filters often block the
      // provider's image CDN while allowing this site.
      if (Array.isArray(data.data)) {
        data.data = await Promise.all(
          data.data.map(async (image) => {
            if (!image || image.b64_json || !image.url) return image;
            try {
              const { bytes, mime: contentType } = await downloadPublicImage(
                image.url,
                {
                  maxBytes: MAX_GENERATED_IMAGE_BYTES,
                  timeoutMs: AI_IMAGE_DOWNLOAD_TIMEOUT_MS,
                },
              );
              const rest = { ...image };
              delete rest.url;
              return {
                ...rest,
                b64_json: bytes.toString("base64"),
                mime_type: contentType,
              };
            } catch (error) {
              // generation succeeded; fall back to the provider URL if it is public
              console.warn(
                "[ai] generated image relay failed; returning provider URL:",
                error.message,
              );
              try {
                await resolvePublicUrl(image.url);
              } catch {
                return { error: "The provider returned an unsafe image URL." };
              }
              return image;
            }
          }),
        );
      }
      reply.send(data);
    } catch (e) {
      sendUpstreamFailure(reply, e, "ai images");
    } finally {
      releaseAiSlot(clientip);
    }
  },
);

// --- tmdb passthrough (GET only, keeps the key out of client code) ---
const TMDB_KEY = process.env.TMDB_API_KEY || "";
const TMDB_BASE = (
  process.env.TMDB_BASE_URL || "https://api.themoviedb.org/3"
).replace(/\/+$/, "");

if (!TMDB_KEY) {
  console.warn(
    "[tmdb] TMDB_API_KEY is not set - /api/tmdb/* will return 503 and movie search is disabled.",
  );
}

fastify.get("/api/tmdb/*", async (req, reply) => {
  if (!TMDB_KEY)
    return reply
      .code(503)
      .send({ ok: false, error: "Movies search not configured." });

  let url;
  try {
    url = new URL(`${TMDB_BASE}/${req.params["*"]}`);
  } catch {
    url = null;
  }
  // ".." segments must not climb out of the API base path
  const basepath = new URL(TMDB_BASE).pathname.replace(/\/+$/, "");
  if (!url || !url.pathname.startsWith(basepath + "/"))
    return reply.code(400).send({ ok: false, error: "Invalid TMDB path." });
  // forward the caller's query, but always with our api_key
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) {
    if (k === "api_key" || typeof v !== "string") continue;
    params.set(k, v);
  }
  params.set("api_key", TMDB_KEY);
  url.search = params.toString();

  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { ok: false, error: text.slice(0, 500) };
    }
    if (isupstreamfault(res.status))
      return sendUpstreamError(reply, res, data, "tmdb", "Movies search");
    // don't let browsers cache upstream errors such as 404s
    if (res.ok) reply.header("Cache-Control", "public, max-age=300");
    return reply.code(res.status).send(data);
  } catch (e) {
    sendUpstreamFailure(reply, e, "tmdb", "TMDB");
  }
});

fastify.get("/recover", (_req, reply) => reply.redirect("/recover.html", 302));
fastify.get("/sw-recover", (_req, reply) =>
  reply.redirect("/recover.html", 302),
);

fastify.addHook("onSend", (req, reply, payload, done) => {
  const path = req.url.split("?")[0];

  if (path === "/sw.js" || path === "/register-sw.js") {
    reply.header("Cache-Control", "no-store");
  } else if (path.startsWith("/assets/games/")) {
    // game builds are large (30MB+ Unity wasm) and rarely change
    if (/\.html?$/i.test(path)) {
      reply.header(
        "Cache-Control",
        "public, max-age=3600, stale-while-revalidate=86400",
      );
    } else {
      reply.header(
        "Cache-Control",
        "public, max-age=86400, stale-while-revalidate=604800",
      );
    }
  } else if (/^\/(scramjet|controller|libcurl|epoxy)\//.test(path)) {
    // version-pinned proxy engine bundles
    reply.header(
      "Cache-Control",
      "public, max-age=600, stale-while-revalidate=604800",
    );
  } else if (
    String(reply.getHeader("content-type") || "").includes("text/html")
  ) {
    reply.header("Cache-Control", "no-cache");
  } else if (path.startsWith("/css/") || path.startsWith("/js/")) {
    reply.header(
      "Cache-Control",
      "public, max-age=600, stale-while-revalidate=604800",
    );
  } else if (path.startsWith("/assets/data/")) {
    reply.header(
      "Cache-Control",
      "public, max-age=300, stale-while-revalidate=86400",
    );
  } else if (
    path.startsWith("/assets/images/") ||
    path.startsWith("/assets/fonts/")
  ) {
    reply.header(
      "Cache-Control",
      "public, max-age=86400, stale-while-revalidate=604800",
    );
  }

  const brotliTypes = {
    ".wasm.br": "application/wasm",
    ".framework.js.br": "application/javascript",
    ".data.br": "application/octet-stream",
  };
  for (const [ext, mime] of Object.entries(brotliTypes)) {
    if (path.endsWith(ext)) {
      reply.header("Content-Type", mime).header("Content-Encoding", "br");
      break;
    }
  }
  if (path.endsWith(".loader.js"))
    reply.header("Content-Type", "application/javascript");
  if (path.endsWith(".wasm")) reply.header("Content-Type", "application/wasm");

  // match the path only, so a query string can't add CORS headers to /api/*
  if (/\/(scramjet|controller|libcurl)\//.test(path)) {
    reply.header("Cross-Origin-Resource-Policy", "cross-origin");
    reply.header("Access-Control-Allow-Origin", "*");
  }

  done(null, payload);
});

// --- serve-time patches for pinned proxy dependencies ---

// Replaces one minified snippet; warns instead of failing if the dependency
// version changed and the snippet is gone.
function patchsource(raw, broken, fixed, label) {
  if (!raw.includes(broken)) {
    console.warn(
      `[scramjet-patch] ${label} pattern not found; shipping it unpatched (did the dependency version change?)`,
    );
    return raw;
  }
  return raw.split(broken).join(fixed);
}

// Epoxy 3.0.1 iterates headers with for..of, but BareHeaders is a plain object.
let patchedepoxy = null;
fastify.get("/epoxy/index.mjs", (_req, reply) => {
  if (!patchedepoxy) {
    const raw = readFileSync(join(epoxypath, "index.mjs"), "utf8");
    patchedepoxy = raw.replace(
      "for (let [key, value] of headers) {",
      'for (let [key, value] of (headers != null && typeof headers[Symbol.iterator] === "function" ? headers : Object.entries(headers || {}))) {',
    );
  }
  reply.type("application/javascript").send(patchedepoxy);
});

// Scramjet 2.0.67-alpha.2 needs Object.hasOwn and BroadcastChannel, which
// Safari only shipped in 15.4. The rest of the bundle runs on iPadOS 14.1+,
// so shim both (no-ops on newer browsers).
const legacybrowsercompat =
  "(()=>{" +
  'if(typeof Object.hasOwn!=="function"){' +
  'Object.defineProperty(Object,"hasOwn",{value:function(o,p){return Object.prototype.hasOwnProperty.call(o,p)},writable:true,configurable:true})}' +
  'if(typeof BroadcastChannel==="undefined"){' +
  "var B=function(){};" +
  "B.prototype.postMessage=function(){};" +
  "B.prototype.close=function(){};" +
  "B.prototype.addEventListener=function(){};" +
  "B.prototype.removeEventListener=function(){};" +
  "globalThis.BroadcastChannel=B}" +
  "})();\n";

let patchedscramjetcore = null;
fastify.get("/scramjet/scramjet.js", (_req, reply) => {
  if (!patchedscramjetcore) {
    let raw = readFileSync(join(scramjetPath, "scramjet.js"), "utf8");

    // history.replaceState(state, title) without a url became a navigation to
    // "/undefined". Fixed upstream in scramjet@98c1864 but never published.
    raw = patchsource(
      raw,
      "s=(0,n.Qf)(t.args[2]);",
      "s=t.args[2]?(0,n.Qf)(t.args[2]):void 0;",
      "history.ts undefined-url",
    );

    // Rewritten resources can never match their original SRI hash, so remove
    // integrity attributes instead of emptying them (an empty attribute still
    // failed on discord.com).
    raw = patchsource(
      raw,
      '{fn:()=>"",integrity:["script","link"]}',
      '{fn:()=>null,integrity:["script","link"]}',
      "htmlRules integrity",
    );

    // Same for fetch(url, { integrity }) calls.
    const fetchrewrite =
      "let r=(0,n.Qf)(t.args[0]);t.args[0]=e.rewriteUrl(r,s(t.args[1]))";
    raw = patchsource(
      raw,
      fetchrewrite,
      fetchrewrite +
        ';if(t.args[1]&&t.args[1].integrity)t.args[1]={...t.args[1],integrity:""}',
      "fetch()/Request() rewrite",
    );

    // And for `Link: <url>; rel=preload; integrity=...` response headers, which
    // is what actually broke discord.com's CSS.
    raw = patchsource(
      raw,
      'A.replace(/<([^>]+)>/gi,(e,t)=>`<${(0,i.Oy)(t,l,c)}>`));s.set("link",t)}',
      'A.replace(/<([^>]+)>/gi,(e,t)=>`<${(0,i.Oy)(t,l,c)}>`).replace(/;\\s*integrity\\s*=\\s*(?:"[^"]*"|\'[^\']*\'|[^;,]*)/gi,""));s.set("link",t)}',
      "Link-header rewrite",
    );

    // Blob/data URLs can arrive percent-encoded (blob%3Ahttps%3A...), miss the
    // literal "blob:" check and 404 against our origin (seen on Bing, GitHub).
    raw = patchsource(
      raw,
      'c=t.rawUrl.pathname.substring(e.context.prefix.pathname.length);c.startsWith("blob:")?(',
      'c=t.rawUrl.pathname.substring(e.context.prefix.pathname.length);if(/^(blob|data)%3a/i.test(c))try{c=decodeURIComponent(c)}catch(_){}c.startsWith("blob:")?(',
      "blob/data path",
    );

    patchedscramjetcore = legacybrowsercompat + raw;
  }
  reply.type("application/javascript").send(patchedscramjetcore);
});

// The controller also gets the compat prefix. "No frame found for request" is
// expected when a frame is torn down with requests in flight, so stop it
// logging a stack trace each time.
let patchedcontrollerapi = null;
fastify.get("/controller/controller.api.js", (_req, reply) => {
  if (!patchedcontrollerapi) {
    let raw = readFileSync(
      join(scramjetControllerPath, "controller.api.js"),
      "utf8",
    );
    raw = patchsource(
      raw,
      't.suppressError||console.error("Error in controller request handler:",o)',
      't.suppressError||/No frame found/.test((o&&o.message)||"")||console.error("Error in controller request handler:",o)',
      "controller error-log",
    );
    // the RPC layer logs the same rejection separately
    raw = patchsource(
      raw,
      ".catch(e=>{console.error(e),this.sendRaw(",
      '.catch(e=>{(e&&e.message==="No frame found for request")||console.error(e),this.sendRaw(',
      "controller RPC log",
    );
    patchedcontrollerapi = legacybrowsercompat + raw;
  }
  reply.type("application/javascript").send(patchedcontrollerapi);
});

fastify.register(fastifyStatic, { root: publicpath, decorateReply: true });
// /scramjet/ and /controller/ are the controller package's default prefixes
fastify.register(fastifyStatic, {
  root: scramjetPath,
  prefix: "/scramjet/",
  decorateReply: false,
});
fastify.register(fastifyStatic, {
  root: scramjetControllerPath,
  prefix: "/controller/",
  decorateReply: false,
});
fastify.register(fastifyStatic, {
  root: libcurlPath,
  prefix: "/libcurl/",
  decorateReply: false,
});
fastify.register(fastifyStatic, {
  root: epoxypath,
  prefix: "/epoxy/",
  decorateReply: false,
});
fastify.setNotFoundHandler((_req, reply) =>
  reply.code(404).type("text/html").sendFile("404.html"),
);

fastify.server.on("listening", () => {
  const a = fastify.server.address();
  const host = a.family === "IPv6" ? `[${a.address}]` : a.address;
  console.log("listening on:");
  console.log(`\thttp://localhost:${a.port}`);
  console.log(`\thttp://${hostname()}:${a.port}`);
  console.log(`\thttp://${host}:${a.port}`);
});

async function shutdown() {
  console.log("shutting down");
  flushplays();
  // open WebSockets can keep close() pending
  setTimeout(() => process.exit(0), 3000).unref();
  await fastify.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// --- port ownership detection + duplicate-instance recovery ---
// On EADDRINUSE, report which process holds the port. With
// RECOVER_DUPLICATE_INSTANCE=true, a stale copy of this app (same cwd, running
// index.js) is terminated; any other owner is never touched.

function findPortOwnerPid(port) {
  try {
    const hexport = port.toString(16).toUpperCase().padStart(4, "0");
    let inode = null;
    for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      let txt;
      try {
        txt = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const line of txt.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 10) continue;
        // /proc/net/tcp* fields are: sl, local_address, rem_address,
        // st, tx_queue:rx_queue, tr:tm->when, retrnsmt, uid,
        // timeout, inode. Keep these explicit so `sl` cannot shift them.
        const local = parts[1],
          st = parts[3],
          socketinode = parts[9];
        if (st === "0A" /* LISTEN */ && local.endsWith(":" + hexport)) {
          inode = socketinode;
          break;
        }
      }
      if (inode) break;
    }
    if (!inode) return null;
    const needle = `socket:[${inode}]`;
    for (const pid of readdirSync("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        for (const fd of readdirSync(`/proc/${pid}/fd`)) {
          try {
            if (readlinkSync(`/proc/${pid}/fd/${fd}`) === needle)
              return parseInt(pid, 10);
          } catch {
            /* fd vanished mid-scan */
          }
        }
      } catch {
        /* process exited mid-scan */
      }
    }
  } catch {
    /* /proc unavailable — caller handles null */
  }
  return null;
}

function isDuplicateOfOurs(pid) {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\0")
      .join(" ")
      .trim();
    const cwd = readlinkSync(`/proc/${pid}/cwd`);
    return cmdline.includes("index.js") && cwd === process.cwd();
  } catch {
    return false;
  }
}

function describeProcess(pid) {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\0")
      .join(" ")
      .trim();
    const cwd = readlinkSync(`/proc/${pid}/cwd`);
    return `PID ${pid} (${cmdline || "unknown cmdline"} — cwd ${cwd})`;
  } catch {
    return `PID ${pid} (gone)`;
  }
}

async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    } // ESRCH — gone
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error("PORT must be an integer from 0 to 65535.");
const MAX_LISTEN_ATTEMPTS = 3;

async function start() {
  for (let attempt = 1; attempt <= MAX_LISTEN_ATTEMPTS; attempt++) {
    try {
      await fastify.listen({ port, host: process.env.HOST || "::" });
      return;
    } catch (err) {
      if (err?.code !== "EADDRINUSE") {
        console.error("STARTUP FAILED:", err);
        process.exit(1);
      }

      const owner = findPortOwnerPid(port);
      if (
        owner &&
        isDuplicateOfOurs(owner) &&
        process.env.RECOVER_DUPLICATE_INSTANCE === "true"
      ) {
        console.error(
          `[port] :::${port} held by a stale duplicate instance — ${describeProcess(owner)}. Terminating it and retrying.`,
        );
        try {
          process.kill(owner, "SIGTERM");
        } catch {
          /* already gone */
        }
        const exited = await waitForPidExit(owner, 4000);
        if (!exited) {
          console.error(`[port] duplicate ignored SIGTERM — sending SIGKILL`);
          try {
            process.kill(owner, "SIGKILL");
          } catch {
            /* already gone */
          }
          await waitForPidExit(owner, 2000);
        }
        continue; // retry the bind
      }

      console.error(
        `STARTUP FAILED: ${process.env.HOST || "::"}:${port} is in use by ${owner ? describeProcess(owner) : "an unknown process (could not read /proc)"}. No eligible duplicate recovery is enabled; the existing process will not be terminated.`,
      );
      if (attempt < MAX_LISTEN_ATTEMPTS) {
        console.error(
          `[port] retrying (attempt ${attempt}/${MAX_LISTEN_ATTEMPTS})…`,
        );
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      process.exit(1);
    }
  }
}

await start();

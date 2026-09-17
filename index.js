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
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
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
// libcurl-transport 2.0.5 dropped the libcurlPath helper entirely — the whole
// package was restructured from "ships a static bundle + a path export" to
// "a single ProxyTransport class" (dist/index.mjs default-exports
// LibcurlClient). The frontend (public/js/scramjet-init.js) only ever
// dynamically imports /libcurl/index.mjs and uses whatever it default-exports,
// so this still works — it just needs the same dirname(require.resolve(...))
// pattern epoxypath already uses one line up, since the package itself no
// longer hands us the path directly.
const libcurlPath = dirname(
  _require.resolve("@mercuryworkshop/libcurl-transport"),
);
// scramjet-controller (v2) doesn't export a path helper either — same
// dirname(require.resolve(...)) trick as libcurl above. require.resolve
// follows the package's "main"/"exports" field to dist/controller-external.mjs,
// so dirname(...) is already the dist/ folder we need to serve statically.
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
  // a malformed/truncated stored hash must fail closed, not throw (scrypt
  // rejects keylen 0 and would turn every login into a 500)
  if (!salt || expected.length === 0) return false;
  const actual = await scryptAsync(pw, salt, expected.length, SCRYPT_OPTS);
  return timingSafeEqual(expected, actual);
}

// --- helpers ---

// req.ip is computed by proxy-addr from X-Forwarded-For, walking right-to-left
// past trusted proxies (trustProxy is pinned to the local Caddy below). NEVER
// parse X-Forwarded-For manually: the leftmost entries are client-supplied and
// spoofable, which used to defeat every IP-based rate limit on this server.
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

function writeuser(data) {
  // write-then-rename so a crash mid-write can't corrupt the file
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
  if (user.deviceId) deviceindex.delete(user.deviceId);

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
  const username = tokenindex.get(token);
  if (!username) return null;

  const user = readuser(username);
  if (!user?.sessions?.[token]) {
    tokenindex.delete(token);
    return null;
  }

  // expired session: treat as invalid. we deliberately don't write the file
  // here — finduser runs on every request outside the per-user locks; the
  // dead session gets pruned from disk at the user's next login instead.
  if (
    !Number.isFinite(user.sessions[token]?.createdAt) ||
    Date.now() - user.sessions[token].createdAt > SESSION_TTL
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
  for (const [t] of all) {
    if (!kept.has(t)) forgettoken(t);
  }
}

// --- per-user write serialization ---
// user files are read-modify-write JSON documents; two concurrent requests for
// the same user (two DMs, a DM + a login) would silently drop whichever write
// lands first. every mutating endpoint runs its read→write inside one of these
// per-user promise chains. two-user operations lock in sorted order so
// concurrent A→B and B→A requests can't deadlock.

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

// --- in-memory indices ---
// rebuilt on startup, kept in sync on writes. saves us from scanning
// every json file on every request.

const tokenindex = new Map(); // token -> username (lowercase)
const usernames = new Map(); // lowercase name -> original case
const deviceindex = new Map(); // device fingerprint -> username (lowercase)

function indexuser(u) {
  if (!u?.username) return;
  const lc = u.username.toLowerCase();
  usernames.set(lc, u.username);
  if (u.deviceId) deviceindex.set(u.deviceId, lc);
}

function remembertoken(token, username) {
  tokenindex.set(token, username.toLowerCase());
}

function forgettoken(token) {
  tokenindex.delete(token);
}

function rebuildindices() {
  tokenindex.clear();
  usernames.clear();
  deviceindex.clear();
  for (const u of allusers()) {
    indexuser(u);
    if (!u.sessions) continue;
    for (const token of Object.keys(u.sessions)) {
      tokenindex.set(token, u.username.toLowerCase());
    }
  }
  console.log(
    `indices loaded: ${usernames.size} users, ${tokenindex.size} sessions, ${deviceindex.size} devices`,
  );
}
rebuildindices();

// --- play counts (gameplays.json) ---
// we only track plays for games in the aetheris catalog, not arbitrary ids.

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
    // yes ik im blocking porn sites but why not
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
  dns_servers: ["1.1.1.3", "1.0.0.3"],
});

// --- online counter (SSE) ---

const clients = new Set();
let broadcastpending = null;

function broadcastcount() {
  if (broadcastpending) return;
  // coalesce rapid connect/disconnect bursts into a single write
  broadcastpending = setTimeout(() => {
    broadcastpending = null;
    const msg = `data: ${clients.size}\n\n`;
    for (const res of clients) {
      try {
        res.write(msg);
      } catch {
        clients.delete(res);
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
      clients.delete(res);
    }
  }
}, 30_000);

// --- fastify ---

function handleupgrade(req, socket, head) {
  if (req.url.endsWith("/wisp/")) {
    wisp.routeRequest(req, socket, head);
    return;
  }

  if (req.url.startsWith("/wsproxy/")) {
    proxywsconnection(req, socket, head);
    return;
  }

  // Lethal Company relay — game's WispRelayTransport dials wss://<origin>/lc-relay
  if (req.url === "/lc-relay" || req.url.startsWith("/lc-relay/")) {
    lcRelayUpgrade(req, socket, head);
    return;
  }

  socket.end();
}

// Fallback ws proxy for growden.io only. Caddy's @wsproxy block handles the
// primary /wsproxy/ traffic, but its regex requires a "/" after the host, so
// bare /wsproxy/<host> (no trailing path) falls through to us. Keep in sync
// with the Caddyfile or remove both if growden's direct ws ever goes away.
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
  // only the local Caddy is a proxy. with `true` here, proxy-addr trusts every
  // X-Forwarded-For entry and req.ip becomes the client-supplied leftmost
  // value — i.e. anyone could spoof their IP past the rate limiters.
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

registerMovieRelay(fastify);

const consumeRate = createRateLimiter();
fastify.addHook("onRequest", async (req, reply) => {
  const path = req.url.split("?")[0];
  if (path.startsWith("/api/")) reply.header("Cache-Control", "no-store");
  if (req.method !== "POST") return;
  let limit = 0,
    windowMs = 60000,
    group = path;
  if (path === "/api/accounts/register") limit = 30;
  else if (path === "/api/accounts/login") limit = 60;
  else if (path === "/api/report") {
    limit = 10;
    windowMs = 120000;
  } else if (path.startsWith("/api/dm/")) {
    limit = 120;
    group = "dm-send";
  } else if (path === "/api/ai/chat") limit = 30;
  else if (path === "/api/ai/images") {
    limit = 6;
    windowMs = 60000;
  }
  if (!limit) return;
  const result = consumeRate(`${group}:${getclientip(req)}`, limit, windowMs);
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
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": "*",
  });
  clients.add(res);
  broadcastcount();
  req.raw.on("close", () => {
    clients.delete(res);
    broadcastcount();
  });
});

fastify.get("/online-count", (_req, reply) => {
  reply.header("Access-Control-Allow-Origin", "*");
  reply.send({ count: clients.size });
});

// cached responses for the top/counts endpoints — recalculated every 10s at most
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

// one bump per (fingerprint, game) per minute — stops trivial loop inflation
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

  // gc: if the map gets big, drop expired entries
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

const STATS_INTERVAL = 2 * 60 * 60 * 1000; // post stats every 2h
const REPORT_COOLDOWN = 2 * 60 * 1000; // 2min between reports per fingerprint
const LOGIN_WINDOW = 30 * 1000; // 30s sliding window for login attempts
const MAX_LOGIN_PER_FP = 5; // per device per window
const MAX_LOGIN_PER_ACCT = 15; // per account per window

const reporttimes = new Map();
const loginattempts = new Map();
const loginbyaccount = new Map();

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

  if (!REPORT_WEBHOOK_URL) {
    console.log("[report] received but no webhook url configured:", {
      game,
      issue,
    });
    return reply.send({ ok: true });
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
    reply.code(500).send({ ok: false, error: "Internal error." });
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

  const payload = {
    username: "aetheris stats",
    embeds: [
      {
        title: "📊 Site Stats",
        color: 0xa855f7,
        fields: [
          { name: "👥 Online Now", value: String(clients.size), inline: true },
          { name: "🎮 Total Plays", value: String(totalplays), inline: true },
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

// full account removal. dm cleanup happens FIRST, each other user under their
// own lock — locks are never nested here, which keeps the sorted-order
// deadlock prevention in withuserlocks() sound (a concurrent A→B DM holds
// locks in sorted order; we only ever take one at a time).
async function deleteaccount(lc) {
  const victim = await withuserlock(lc, () => {
    const user = readuser(lc);
    if (!user || deletingUsers.has(lc)) return null;
    deletingUsers.add(lc);
    for (const token of Object.keys(user.sessions || {})) forgettoken(token);
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
      for (const t of Object.keys(fresh.sessions || {})) forgettoken(t);
      deleteuser(fresh);
    });
    return true;
  } finally {
    deletingUsers.delete(lc);
  }
}

// --- account creation rate limiting ---
// register writes a file per account; without a limiter a trivial script
// could mint unlimited users (and json files) with random device ids.
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
  if (username.length < 2 || username.length > 32)
    return reply
      .code(400)
      .send({ ok: false, error: "Username must be 2–32 characters." });
  if (password.length < 4 || password.length > 128)
    return reply
      .code(400)
      .send({ ok: false, error: "Password must be 4–128 characters." });
  if (!/^[a-zA-Z0-9_.-]+$/.test(username))
    return reply
      .code(400)
      .send({
        ok: false,
        error: "Username may only contain letters, numbers, _, -, .",
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
    // stale index entry — clean up and continue
    deviceindex.delete(deviceid);
  }

  // create + first session inside the lock so a racing duplicate register
  // or login can't interleave with the write
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
      user.sessions[token] = { ip, createdAt: Date.now() };
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
  // hand back a session right away — no second login round trip
  reply.send({ ok: true, token: result.token, username });
});

fastify.post("/api/accounts/login", async (req, reply) => {
  const ip = getclientip(req);
  const { username, password, deviceId: deviceid } = req.body || {};
  if (
    !isvalidusername(username) ||
    typeof password !== "string" ||
    password.length < 4 ||
    password.length > 128
  )
    return reply
      .code(400)
      .send({ ok: false, error: "Invalid username or password format." });

  const now = Date.now();
  const userlc = String(username).toLowerCase();
  const fp = isvaliddeviceid(deviceid) ? `dev:${deviceid}` : `ip:${ip}`;
  const fpkey = `${userlc}|${fp}`;
  const acctkey = userlc;

  function bump(map, key) {
    const entry = map.get(key) || { count: 0, windowstart: now };
    if (now - entry.windowstart > LOGIN_WINDOW) {
      entry.count = 0;
      entry.windowstart = now;
    }
    entry.count++;
    map.set(key, entry);
    return entry;
  }

  function gc(map) {
    if (map.size <= 10_000) return;
    const cutoff = now - LOGIN_WINDOW;
    for (const [k, v] of map) {
      if (v.windowstart < cutoff) map.delete(k);
    }
  }

  const fpattempt = bump(loginattempts, fpkey);
  const acctattempt = bump(loginbyaccount, acctkey);
  gc(loginattempts);
  gc(loginbyaccount);

  const overfp = fpattempt.count > MAX_LOGIN_PER_FP;
  const overacct = acctattempt.count > MAX_LOGIN_PER_ACCT;
  if (overfp || overacct) {
    const worst = overfp ? fpattempt : acctattempt;
    const retryafter = Math.ceil(
      (LOGIN_WINDOW - (now - worst.windowstart)) / 1000,
    );
    return reply
      .code(429)
      .send({
        ok: false,
        error: `Too many login attempts. Try again in ${retryafter}s.`,
      });
  }

  const user = await withuserlock(userlc, async () => {
    const u = readuser(userlc);
    if (
      !u ||
      deletingUsers.has(userlc) ||
      !(await verifypw(password, u.passwordHash))
    )
      return null;

    const token = maketoken();
    u.sessions ??= {};
    u.sessions[token] = { ip, createdAt: Date.now() };
    u.ip = ip;
    prunesessions(u, token);
    writeuser(u);
    remembertoken(token, u.username);
    return { user: u, token };
  });

  if (!user) {
    return reply
      .code(401)
      .send({ ok: false, error: "Invalid username or password." });
  }

  reply.send({ ok: true, token: user.token, username: user.user.username });
});

fastify.post("/api/accounts/logout", async (req, reply) => {
  const token = gettoken(req);
  if (!token) return reply.code(400).send({ ok: false, error: "No token." });

  const lc = tokenindex.get(token);
  if (lc) {
    await withuserlock(lc, () => {
      const user = readuser(lc);
      if (user?.sessions) {
        delete user.sessions[token];
        writeuser(user);
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
  // the device fingerprint alone must NOT be enough to destroy an account —
  // it's readable from any shared browser and rides along in the settings
  // export file. require a valid session AND that it belongs to the same
  // device being wiped.
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

  // both files are read AND written inside the same sorted two-user lock, so
  // concurrent messages in either direction can't drop each other's writes
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
    const latest = Array.isArray(messages) ? messages.at(-1)?.time || 0 : 0;
    const requested = Number(req.body?.through);
    const through =
      Number.isFinite(requested) && requested >= 0
        ? Math.min(requested, latest)
        : latest;
    fresh.lastRead ??= {};
    fresh.lastRead[other] = Math.max(fresh.lastRead[other] || 0, through);
    writeuser(fresh);
  });
  reply.send({ ok: true });
});

// --- crax-gpt AI proxy ---
// The API key lives server-side in env so it's never shipped to the browser.
// CRAX_GPT_BASE_URL defaults to the OpenAI-compatible endpoint at gpt.crax.lol.
// The whole point of proxying is to keep Authorization out of client code;
// the frontend only ever talks to these two same-origin routes.

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

function aiTimeout(ms) {
  return AbortSignal.timeout(ms);
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

function sendAiFailure(reply, error, operation) {
  console.error(`[ai] ${operation} error:`, error);
  if (isTimeoutError(error)) {
    return reply
      .code(504)
      .send({
        ok: false,
        error: "The AI request timed out. Please try again.",
      });
  }
  return reply
    .code(502)
    .send({
      ok: false,
      error: "Could not reach the AI service. Please try again.",
    });
}

if (!CRAX_GPT_KEY) {
  console.warn(
    "[ai] CRAX_GPT_KEY is not set — /api/ai/* endpoints will return 503. Set it in .env to enable AI.",
  );
}

// Chat Completions — proxies to POST {base}/chat/completions. Streaming is
// passed straight through so the client can render tokens as they arrive.
fastify.post(
  "/api/ai/chat",
  { bodyLimit: 20 * 1024 * 1024 },
  async (req, reply) => {
    if (!CRAX_GPT_KEY)
      return reply
        .code(503)
        .send({ ok: false, error: "AI is not configured on this server." });
    if (process.env.AI_REQUIRE_LOGIN === "true" && !requireauth(req, reply))
      return;
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
        signal: AbortSignal.any([abort.signal, aiTimeout(AI_CHAT_TIMEOUT_MS)]),
      });

      if (stream === true) {
        if (!res.ok) {
          const data = await readAiResponse(res);
          const errmsg =
            (data.error && (data.error.message || data.error.code)) ||
            `Upstream ${res.status}`;
          return reply.code(res.status).send({ ok: false, error: errmsg });
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
      if (!res.ok) {
        const errmsg =
          (data.error && (data.error.message || data.error.code)) ||
          `Upstream ${res.status}`;
        return reply.code(res.status).send({ ok: false, error: errmsg });
      }
      reply.send(data);
    } catch (e) {
      if (!reply.raw.destroyed && !reply.sent) sendAiFailure(reply, e, "chat");
    } finally {
      reply.raw.removeListener("close", stop);
    }
  },
);

// Models list — proxied so the client can build a model picker without
// exposing the key.
fastify.get("/api/ai/models", async (_req, reply) => {
  if (!CRAX_GPT_KEY)
    return reply
      .code(503)
      .send({ ok: false, error: "AI is not configured on this server." });
  try {
    const res = await fetch(`${CRAX_GPT_BASE}/models`, {
      headers: { Authorization: `Bearer ${CRAX_GPT_KEY}` },
      signal: aiTimeout(AI_MODELS_TIMEOUT_MS),
    });
    const data = await readAiResponse(res);
    if (!res.ok)
      return reply
        .code(res.status)
        .send({
          ok: false,
          error: (data.error && data.error.message) || `Upstream ${res.status}`,
        });
    // normalize to the site's { ok, data } convention
    reply.send({
      ok: true,
      data: Array.isArray(data.data) ? data.data : [],
      default_model: CRAX_GPT_MODEL,
      default_image_model: CRAX_GPT_IMG_MODEL,
    });
  } catch (e) {
    sendAiFailure(reply, e, "models");
  }
});

// Image generation — proxies to POST {base}/images/generations. Returns the
// standard OpenAI images payload (url or b64_json) to the client.
fastify.post(
  "/api/ai/images",
  { bodyLimit: 24 * 1024 * 1024 },
  async (req, reply) => {
    if (!CRAX_GPT_KEY)
      return reply
        .code(503)
        .send({ ok: false, error: "AI is not configured on this server." });
    if (process.env.AI_REQUIRE_LOGIN === "true" && !requireauth(req, reply))
      return;
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
        signal: aiTimeout(AI_IMAGE_TIMEOUT_MS),
      });
      const data = await readAiResponse(res);
      if (!res.ok) {
        const errmsg =
          (data.error && (data.error.message || data.error.code)) ||
          `Upstream ${res.status}`;
        return reply.code(res.status).send({ ok: false, error: errmsg });
      }
      // Some image backends return a short-lived URL on a separate CDN. School
      // filters commonly allow Aetheris but block that CDN, leaving an empty
      // image on managed iPads. Fetch URL results here and return base64 so the
      // browser never has to contact the third-party image host directly.
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
              // Generation succeeded. Preserve the provider URL instead of turning a
              // secondary CDN relay problem into a failed generation/502 response.
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
      sendAiFailure(reply, e, "images");
    }
  },
);

fastify.get("/recover", (_req, reply) => reply.redirect("/recover.html", 302));
fastify.get("/sw-recover", (_req, reply) =>
  reply.redirect("/recover.html", 302),
);

fastify.addHook("onSend", (req, reply, payload, done) => {
  const path = req.url.split("?")[0];

  if (path === "/sw.js" || path === "/register-sw.js") {
    reply.header("Cache-Control", "no-store");
  } else if (path.startsWith("/assets/games/")) {
    // game bundles are huge (Unity wasm builds run 30MB+) and their
    // filenames are content-hashed; they only change when a game is
    // updated. a day of freshness + background revalidation turns repeat
    // game loads into instant ones (these used to be max-age=0).
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
    // proxy engine bundles — version-pinned in package.json, only change
    // on deploy. same policy as /css/ + /js/: short freshness, long SWR.
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

  if (/\/(scramjet|controller|libcurl)\//.test(req.url)) {
    reply.header("Cross-Origin-Resource-Policy", "cross-origin");
    reply.header("Access-Control-Allow-Origin", "*");
  }

  done(null, payload);
});

// Epoxy 3.0.1 iterates headers with for..of, but BareHeaders is a plain
// object. We patch the one broken line at serve time instead of forking the pkg.
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

// scramjet 2.0.67-alpha.2's History.prototype.pushState/replaceState patch
// does `String(ctx.args[2])` unconditionally — when a router omits the url
// arg (very common: `history.replaceState(state, title)`), that's
// `String(undefined)`, the literal three-letter string "undefined", which
// then gets treated as a real relative URL and rewritten onto the proxied
// site's origin (e.g. https://example.com/undefined). Every SPA whose router
// makes that call renders its own "page not found" for a route literally
// named "undefined". Fixed upstream the day after this alpha was published
// (MercuryWorkshop/scramjet@98c1864, "[core] fix undefined popping up in
// history") but never republished to npm — patch the one-line regression at
// serve time the same way the epoxy fix above does, instead of forking the
// package or waiting on a new alpha release.
// scramjet's htmlRules strips `integrity` from <script>/<link> tags by
// setting the attribute to "" instead of removing it outright (unlike the
// adjacent nonce/csp rule right next to it in the same array, which does
// `fn: () => null` and gets fully removed). An empty-but-present `integrity`
// attribute is supposed to mean "no SRI check" per spec, and a synthetic
// same-shape test confirms Chromium treats it that way — but real sites
// (confirmed on discord.com, a Webflow-hosted page with 2MB+ stylesheets)
// still get their CSS/JS blocked with a computed-hash mismatch. Since we
// necessarily rewrite url()/@import references inside CSS (and JS bodies),
// any original integrity hash can never validate again regardless — so
// match the nonce/csp rule's approach and remove the attribute entirely
// instead of leaving an empty one behind.
let patchedscramjetcore = null;
fastify.get("/scramjet/scramjet.js", (_req, reply) => {
  if (!patchedscramjetcore) {
    let raw = readFileSync(join(scramjetPath, "scramjet.js"), "utf8");

    const undefinedhistorybroken = "s=(0,n.Qf)(t.args[2]);";
    if (!raw.includes(undefinedhistorybroken)) {
      console.warn(
        "[scramjet-patch] expected minified history.ts pattern not found — shipping that part unpatched (did the alpha version change?)",
      );
    } else {
      raw = raw.replace(
        undefinedhistorybroken,
        "s=t.args[2]?(0,n.Qf)(t.args[2]):void 0;",
      );
    }

    const integritybroken = '{fn:()=>"",integrity:["script","link"]}';
    if (!raw.includes(integritybroken)) {
      console.warn(
        "[scramjet-patch] expected minified htmlRules integrity pattern not found — shipping that part unpatched (did the alpha version change?)",
      );
    } else {
      raw = raw.replace(
        integritybroken,
        '{fn:()=>null,integrity:["script","link"]}',
      );
    }

    // The htmlRules fix above only covers *declarative* <script>/<link
    // integrity="...">. Scramjet's fetch()/Request() proxies rewrite the
    // URL argument to point at our (necessarily modified — url()/@import
    // references get rewritten) proxied content, but never touch a
    // caller-supplied `integrity` option in the init object. Any site
    // calling fetch(url, { integrity: "sha384-..." }) would hit the
    // browser's fetch-level SRI check against the *original* hash
    // regardless of what the DOM says. Strip it the same way the HTML
    // rewriter strips the declarative form. (Didn't end up being what was
    // actually breaking discord.com — see the Link-header fix right below
    // — but it's a real gap in its own right, worth keeping.)
    const fetchintegritybroken =
      "let r=(0,n.Qf)(t.args[0]);t.args[0]=e.rewriteUrl(r,s(t.args[1]))";
    if (!raw.includes(fetchintegritybroken)) {
      console.warn(
        "[scramjet-patch] expected minified fetch()/Request() rewrite pattern not found — shipping that part unpatched (did the alpha version change?)",
      );
    } else {
      raw = raw
        .split(fetchintegritybroken)
        .join(
          fetchintegritybroken +
            ';if(t.args[1]&&t.args[1].integrity)t.args[1]={...t.args[1],integrity:""}',
        );
    }

    // This is the one that actually explains discord.com's CSS not
    // applying: the ORIGIN's document response itself carries a
    // `Link: <url>; rel=preload; as=style; integrity="sha384-..."` HTTP
    // response header (Webflow emits these for critical-CSS preloading).
    // rewriteResponseHeaders() rewrites the <url> inside each Link-header
    // entry to point at our (necessarily modified) proxied content, but
    // never strips the `integrity=` parameter riding along with it — so
    // the browser preloads our rewritten URL while still holding it to
    // the original, now-mismatched hash, entirely independent of the
    // <link> tag's own (correctly-stripped) integrity attribute. Strip
    // `integrity=...` out of the header value after the URL rewrite.
    const linkheaderintegritybroken =
      'A.replace(/<([^>]+)>/gi,(e,t)=>`<${(0,i.Oy)(t,l,c)}>`));s.set("link",t)}';
    if (!raw.includes(linkheaderintegritybroken)) {
      console.warn(
        "[scramjet-patch] expected minified Link-header rewrite pattern not found — shipping that part unpatched (did the alpha version change?)",
      );
    } else {
      raw = raw.replace(
        linkheaderintegritybroken,
        'A.replace(/<([^>]+)>/gi,(e,t)=>`<${(0,i.Oy)(t,l,c)}>`).replace(/;\\s*integrity\\s*=\\s*(?:"[^"]*"|\'[^\']*\'|[^;,]*)/gi,""));s.set("link",t)}',
      );
    }

    patchedscramjetcore = raw;
  }
  reply.type("application/javascript").send(patchedscramjetcore);
});

// controller.sw.js used to be patched here to buffer the request body before
// relaying it to the page-side Controller. That work moved into public/sw.js
// (buildrouteevent), which reads the body with .arrayBuffer() and hands
// route() an ArrayBuffer directly — stock route() already accepts an
// ArrayBuffer body and already puts it in the postMessage transfer list, so
// there is nothing left to rewrite here. Doing it on our side also fixes the
// case the patch could never reach: Request.prototype.body (a request body
// ReadableStream) is Chromium-only, so on other engines route()'s read of
// event.request.body yielded undefined and POSTs went out empty regardless of
// what this patch did to the relay. Serve the file untouched.

fastify.register(fastifyStatic, { root: publicpath, decorateReply: true });
// scramjet v2's controller package hardcodes these two path prefixes as its
// defaults (Config.scramjetPath / Config.injectPath / Config.wasmPath in
// @mercuryworkshop/scramjet-controller) — keep them as-is rather than
// overriding, so every call site that builds a Controller without a custom
// `config` just works.
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
  // force exit after 3s if graceful close hangs (websocket connections keep the port held)
  setTimeout(() => process.exit(0), 3000).unref();
  await fastify.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// --- port ownership detection + duplicate-instance recovery ---
// The classic failure here: a stale `node index.js` started outside pm2 grabs
// port 8080, pm2's copy hits EADDRINUSE, and this catch used to exit(1) — which
// pm2 turns into a blind crash-loop that's opaque until you manually hunt the
// squatter. Instead, identify who owns the port, and if it's a duplicate of
// this exact app (same cwd, running index.js), optionally terminate it and take
// the port. Recovery is opt-in; by default no existing process is terminated.
// A foreign owner is never killed — diagnose, then fail loudly.

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

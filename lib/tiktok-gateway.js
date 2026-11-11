/* TikTok gateway, vendored into Aetheris under /tiktok.
 *
 * Adapted from https://github.com/mynamescrax/tiktok-gateway-proxy (ISC, see
 * ./tiktok-gateway.LICENSE). The original runs on its own port/origin; here it
 * runs in-process before Fastify so the raw request stream, Range responses
 * and WebSocket upgrade keep working unchanged.
 *
 * Routes (all on the site origin):
 *   GET  /tiktok/tt-client.js     injected browser hook
 *   *    /tiktok/tt?url=<upstream>&referer=<page>&tt=1
 *   WS   /tiktok/tt-ws?url=<wss-url>
 *   GET  /tiktok/<path>           masked upstream page/asset
 *   GET  /foryou, /@user, ...     302 into /tiktok/tt while the marker cookie
 *                                 is set (TikTok's router reads the root path)
 *
 * Key rules (from the original HAR analysis):
 *  - Only *.tiktok family hosts are proxied; google login hosts stay direct.
 *  - Telemetry hosts (mon*, mcs*, ...) get 204 unless TT_ALLOW_TELEMETRY=1.
 *  - Absolute upstream URLs are rewritten AFTER the app signs them (client hook
 *    runs at fetch time); JS sources keep relative paths untouched so X-Bogus
 *    style signatures computed over path+query stay valid.
 *  - Cookies are namespaced `aetheris_tt_` and Path=/ (masked root pages need
 *    them); the prefix is stripped before forwarding, and unprefixed site
 *    cookies are never sent upstream.
 */
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import net from "node:net";
import dns from "node:dns/promises";
import zlib from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CookieJar, toBrowserSetCookie } from "./tiktok-cookies.js";

const BASE = "/tiktok";
export const TIKTOK_BASE = BASE;
const ALLOW_TELEMETRY = process.env.TT_ALLOW_TELEMETRY === "1";
const NO_COOKIE_SCOPE = process.env.TT_NO_COOKIE_SCOPE === "1";
const GATE = BASE + "/tt";
const WS_GATE = BASE + "/tt-ws";
const CLIENT_JS = BASE + "/tt-client.js";
const CLIENT_SCRIPT = fileURLToPath(
  new URL("../public/js/tiktok-client.js", import.meta.url),
);
// TikTok's router reads location.pathname, so default-host pages are masked to
// their real paths (/foryou, /@user, ...) instead of /tiktok/foryou. Those root
// paths are only served as TikTok while this marker cookie is present, which
// the injected client sets and clears when the TikTok document goes away.
export const TIKTOK_NAV_COOKIE = "aetheris_tt";
const NAV_COOKIE_RE = new RegExp(
  "(?:^|;\\s*)" + TIKTOK_NAV_COOKIE + "=1(?:;|$)",
);
const TIKTOK_NAV_RE =
  /^\/(?:foryou|following|explore|discover|search|upload|login|signup|logout|passport|redirect|messages|inbox|notifications|settings|profile|friends|collections|playlist|qrcode|live|video|music|tag|coin|studio|analytics|creators|business|download|about|legal|privacy|terms|community-guidelines|safety|transparency|accessibility|feedback|contact|share|embed|404|t)(?:\/|$)/i;
// Top-level page navigations are masked as same-origin paths (the client hook
// replaceStates the gateway URL to the upstream path so the SPA router sees
// real routes). Unknown paths therefore mean "upstream page on the default
// host" — serve them as such instead of 404ing.
const DEFAULT_NAV_HOST = "www.tiktok.com";
const MAX_TEXT = 16 * 1024 * 1024;
const MAX_BODY = 8 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const DNS_TTL = 60_000;
// TikTok's first load is ~250 requests. Keep the rewritten JS/CSS bundles so
// repeat loads and other visitors don't pull and rewrite them again.
const TEXT_CACHE_TTL = 10 * 60_000;
const TEXT_CACHE_MAX = 32 * 1024 * 1024;
const TEXT_CACHE_ENTRY_MAX = 2 * 1024 * 1024;
const textCache = new Map();
let textCacheBytes = 0;

// Scope-aware cookie store (see cookies.mjs). The browser jar is shared by all
// upstream hosts because everything is proxied under one origin; the jar keeps
// the scope each name was minted with so we do not leak *.tiktok.com session
// cookies to CDN/telemetry hosts.
const cookieJar = new CookieJar();

// Apply to worker responses too: workers have their own CSP.
const PROXY_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "frame-src 'self'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

const BASE_DOMAINS = [
  "tiktok.com",
  "tiktokv.com",
  "tiktokv.eu",
  "tiktokcdn.com",
  "tiktokcdn-eu.com",
  "tiktokcdn-us.com",
  "tiktokw.eu",
  "ttwstatic.com",
];

function hostAllowed(h) {
  h = String(h || "").toLowerCase().replace(/\.$/, "");
  if (!h) return false;
  return BASE_DOMAINS.some((b) => h === b || h.endsWith("." + b));
}
function isTelemetry(hostname, pathname) {
  // Narrow by default: only pure-monitoring traffic is dropped. SDK/config
  // endpoints (mcs /v1/list, webmssdk /web/resource, verification, libraweb
  // abtest, starling text-check) look like telemetry but feed the antibot and
  // feature systems — blocking them breaks secsdk init, so they stay proxied.
  const h = String(hostname || "").toLowerCase();
  const p = String(pathname || "");
  if (/^mon[.-]/i.test(h) || h === "mon.tiktokv.com") return true;
  if (p.includes("/monitor_browser") || p.includes("/monitor_web")) return true;
  return false;
}
function isPublicIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a >= 224 || a === 0) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::") return false;
    if (low.startsWith("fe80:") || low.startsWith("fc") || low.startsWith("fd")) return false;
    if (low.startsWith("ff")) return false;
    if (low.startsWith("::ffff:")) return isPublicIp(low.slice("::ffff:".length));
    return true;
  }
  return false;
}

// Positive DNS cache: a single feed boot resolves the same handful of hosts
// hundreds of times. Pinning still happens per request off the cached (already
// validated) address list, so rebinding protection is unchanged.
const dnsCache = new Map();
async function resolvePublicAddresses(host) {
  const hit = dnsCache.get(host);
  if (hit && Date.now() - hit.at < DNS_TTL) return hit.addresses;
  let records;
  try {
    records = await Promise.race([
      dns.lookup(host, { all: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("dns timeout")), 5000)),
    ]);
  } catch (e) {
    throw new Error("dns failed: " + e.message, { cause: e });
  }
  if (!records.length || records.some((r) => !isPublicIp(r.address))) {
    throw new Error("private/non-public address");
  }
  if (dnsCache.size > 256) dnsCache.clear();
  dnsCache.set(host, { addresses: records, at: Date.now() });
  return records;
}

async function validateTarget(raw) {
  if (typeof raw !== "string" || !raw || raw.length > 8192) throw new Error("bad url");
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("bad url");
  }
  const isWs = u.protocol === "ws:" || u.protocol === "wss:";
  if (!["http:", "https:"].includes(u.protocol) && !isWs) throw new Error("http(s) only");
  if (u.username || u.password) throw new Error("no creds");
  // TikTok only serves these on the default web ports; anything else would
  // turn the relay into a port scanner for their edge.
  if (u.port && u.port !== "80" && u.port !== "443") throw new Error("port not allowed");
  const host = u.hostname.toLowerCase();
  if (!hostAllowed(host)) throw new Error("host not allowed: " + host);
  if (net.isIP(host)) {
    if (!isPublicIp(host)) throw new Error("private ip");
    return { url: u, addresses: [{ address: host, family: net.isIP(host) }] };
  }
  return { url: u, addresses: await resolvePublicAddresses(host) };
}

function pinnedLookup(addresses) {
  return (_host, opts, cb) => {
    if (typeof opts === "function") {
      cb = opts;
      opts = {};
    }
    const fam = typeof opts === "number" ? opts : opts?.family;
    const sel = fam ? addresses.filter((r) => r.family === fam) : addresses;
    if (!sel.length) return cb(new Error("no validated address"));
    if (opts && opts.all) return cb(null, sel);
    cb(null, sel[0].address, sel[0].family);
  };
}

const HAS_ZSTD = typeof zlib.zstdDecompressSync === "function";
function upstreamEncoding(incoming) {
  const fallback = HAS_ZSTD ? "gzip, deflate, br, zstd" : "gzip, deflate, br";
  if (!incoming || typeof incoming !== "string") return fallback;
  if (!HAS_ZSTD && incoming.toLowerCase().includes("zstd")) {
    const stripped = incoming
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && !/^zstd(\s*;|$)/i.test(s))
      .join(", ");
    return stripped || fallback;
  }
  return incoming;
}
function decompress(buf, enc) {
  if (!enc) return buf;
  for (const e of enc.toLowerCase().split(",").map((v) => v.trim()).reverse()) {
    if (e === "gzip") buf = zlib.gunzipSync(buf, { maxOutputLength: MAX_TEXT });
    else if (e === "br") buf = zlib.brotliDecompressSync(buf, { maxOutputLength: MAX_TEXT });
    else if (e === "deflate") buf = zlib.inflateSync(buf, { maxOutputLength: MAX_TEXT });
    else if (e === "zstd" && HAS_ZSTD) buf = zlib.zstdDecompressSync(buf, { maxOutputLength: MAX_TEXT });
    else if (e !== "identity") throw new Error("unsupported encoding " + e);
  }
  return buf;
}

function proxify(abs, referer) {
  // NOTE: every gateway URL ends with the "&tt=1" sentinel. Loaders glue
  // chunk paths AFTER our query string ("...&tt=1static/js/async/82403.js");
  // the sentinel marks the exact reattach point (see handleGateway).
  return `${GATE}?url=${encodeURIComponent(abs)}&referer=${encodeURIComponent(referer)}&tt=1`;
}

// Masked paths live under /tiktok; the upstream page path is what follows it.
function upstreamPath(pathname) {
  if (pathname === BASE) return "/";
  if (pathname.startsWith(BASE + "/")) return pathname.slice(BASE.length);
  return pathname;
}

// Rewrite absolute TikTok-family URLs anywhere in text (HTML SIGI blobs, JS
// string literals, CSS). Relative URLs are deliberately left alone so the
// client hook can resolve them at fetch time after the app signs them.
const ABS_URL_RE = /https?:\/\/[A-Za-z0-9._~-]+\.(?:tiktok\.com|tiktokv\.com|tiktokv\.eu|tiktokcdn\.com|tiktokcdn-eu\.com|tiktokcdn-us\.com|tiktokw\.eu|ttwstatic\.com)(?::\d+)?\/[^\s"'<>\\`]*/gi;
const PROTO_URL_RE = /(["'(\s=])\/\/(?:[A-Za-z0-9._~-]+\.)?(?:tiktok\.com|tiktokv\.com|tiktokv\.eu|tiktokcdn\.com|tiktokcdn-eu\.com|tiktokcdn-us\.com|tiktokw\.eu|ttwstatic\.com)(?::\d+)?\/[^\s"'<>\\`)]*/gi;
// NOTE: no ":" in the prefix class — otherwise the "://" of wss://... gets
// eaten ("wss:" + "//host/..." -> "wss:/tt?url=..."). wss: URLs stay raw here
// and are mapped to /tt-ws at runtime by the client hook instead.

// www.tiktok.com is the page/API host, but its absolute URLs inside JS still
// have to be rewritten: app code assigns them to `location.href` (post-login
// redirect to /foryou, /logout, legal pages). Response-side request URLs that
// get absolutised are handled by the client hook instead (it refuses to proxy a
// URL whose path is already /tt?url=…).

export function rewriteAbsoluteUrls(text, referer, isScript = false) {
  let out = text.replace(ABS_URL_RE, (m) => {
    if (m.includes(GATE + "?url=")) return m;
    try {
      const clean = m.replace(/&amp;/g, "&");
      const u = new URL(clean);
      if (!hostAllowed(u.hostname) || (isScript && u.pathname.startsWith("/api/"))) return m;
      return proxify(u.href, referer);
    } catch {
      return m;
    }
  });
  out = out.replace(PROTO_URL_RE, (m, prefix) => {
    const rest = m.slice(prefix.length);
    if (rest.includes(GATE + "?url=")) return m;
    try {
      const u = new URL("https:" + rest.replace(/&amp;/g, "&"));
      if (!hostAllowed(u.hostname) || (isScript && u.pathname.startsWith("/api/"))) return m;
      return prefix + proxify(u.href, referer);
    } catch {
      return m;
    }
  });
  return out;
}

function rewriteCssUrls(css, referer) {
  return css.replace(/url\((["']?)([^"')]+?)\1\)/gi, (m, q, u) => {
    u = (u || "").trim();
    if (!u || u.startsWith("data:") || u.startsWith("blob:") || u.includes(GATE + "?url=")) return m;
    // Absolute TikTok URLs -> gateway. Relative refs (unhookable @import/url
    // resolutions against the stylesheet URL) resolve against the upstream
    // target first, then go through the gateway like everything else.
    if (/^https?:\/\//i.test(u) || u.startsWith("//")) {
      const rw = rewriteAbsoluteUrls(u.startsWith("//") ? "https:" + u : u, referer);
      if (rw !== u) return `url(${q}${rw}${q})`;
      return m;
    }
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u) && !u.startsWith("#")) {
      try {
        const abs = new URL(u, referer).href;
        if (/^https?:/i.test(abs)) return `url(${q}${proxify(abs, referer)}${q})`;
      } catch {
        /* leave untouched */
      }
    }
    return m;
  });
}

function isRealHtml(text) {
  const snippet = text.slice(0, 500).toLowerCase();
  return (
    snippet.includes("<!doctype html") ||
    snippet.includes("<html") ||
    snippet.includes("<head")
  );
}

// On a dedicated origin, root-relative URLs in TikTok HTML resolve against the
// gateway root and the masked fallback serves them. Here the gateway lives at
// /tiktok, so asset URLs need that prefix or the browser asks Aetheris for
// /static/... . Anchor hrefs and form actions are deliberately left alone: the
// client click/submit hook maps them to the upstream page, while prefixing them
// would make the SPA see /tiktok/... in location.pathname.
const ROOT_REL_ATTR_RE =
  /(\b(?:src|poster|data-src)\s*=\s*)(["'])(\/(?!\/)[^"']*)\2/gi;
const LINK_TAG_RE = /<link\b[^>]*>/gi;
const LINK_HREF_RE = /(\bhref\s*=\s*)(["'])(\/(?!\/)[^"']*)\2/i;

function prefixRoot(path) {
  if (path === BASE || path.startsWith(BASE + "/")) return path;
  return BASE + path;
}

export function rewriteRootRelativeAttributes(html) {
  html = html.replace(ROOT_REL_ATTR_RE, (match, lead, quote, path) => {
    return lead + quote + prefixRoot(path) + quote;
  });
  return html.replace(LINK_TAG_RE, (tag) =>
    tag.replace(LINK_HREF_RE, (match, lead, quote, path) => {
      return lead + quote + prefixRoot(path) + quote;
    }),
  );
}

export function injectClient(html, targetHref) {
  html = html.replace(/<link\b[^>]*\brel\s*=\s*(?:"[^"]*\b(?:preconnect|dns-prefetch)\b[^"]*"|'[^']*\b(?:preconnect|dns-prefetch)\b[^']*'|(?:preconnect|dns-prefetch)(?=[\s/>]))[^>]*>/gi, "");
  // A <base href> would resolve relative URLs outside /tiktok (or straight to
  // tiktok.com); the document URL is already the right base.
  html = html.replace(/<base\b[^>]*>/gi, "");
  const tag =
    `<script>window.__TT_TARGET__=${JSON.stringify(targetHref).replace(/</g, "\\u003c")};</script>` +
    `<script src="${CLIENT_JS}"></script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/(<head[^>]*>)/i, `$1\n${tag}`);
  return tag + "\n" + html;
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
}

const STRIP_RES = new Set([
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "cross-origin-embedder-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "strict-transport-security",
  "content-disposition",
  "nel",
  "report-to",
  "reporting-endpoints",
  // Upstream Alt-Svc advertises TikTok's own h2/h3 endpoints. Passed through,
  // the browser would attempt them against OUR origin and fail with
  // ERR_ALPN_NEGOTIATION_FAILED on later requests. Never forward it.
  "alt-svc",
  "alt-used",
  // Preload hints: the rewritten HTML already carries them, and a stale
  // Link header can pin an integrity hash that no longer matches our bytes.
  "link",
  "refresh",
  "x-dns-prefetch-control",
]);

// Request headers we must not copy verbatim: hop-by-hop, routing, and the
// ones the gateway recomputes. Everything else (x-secsdk-csrf-token, x-tt-*,
// if-none-match, ...) is forwarded as the app sent it — an allowlist silently
// dropped app headers and broke CSRF/auth endpoints.
const REQUEST_SKIP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  // Node only sends 100-continue itself; we buffer the body first, so a
  // forwarded `Expect` would stall the upstream payload.
  "expect",
  // Recomputed below (per-hop referer/origin, zstd-stripped accept-encoding,
  // per-host cookie scoping, body length).
  "accept-encoding",
  "referer",
  "origin",
  "cookie",
  "content-length",
  // Caddy/Cloudflare add these; do not leak the visitor's address upstream.
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-real-ip",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cdn-loop",
]);

function secureServing(req) {
  if (req.socket && req.socket.encrypted) return true;
  // Behind a TLS terminator (Caddy) the peer is loopback; only trust the
  // forwarded scheme from there so a LAN client cannot downgrade cookies.
  const peer = String((req.socket && req.socket.remoteAddress) || "");
  const fromLoopback =
    peer === "::1" || peer.startsWith("127.") || peer.startsWith("::ffff:127.");
  if (!fromLoopback) return false;
  const proto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  return proto === "https";
}

function browserSetCookies(rawList, secure) {
  return (rawList || [])
    .map((raw) => toBrowserSetCookie(raw, { secure }))
    .filter(Boolean);
}

function textCacheGet(url) {
  const hit = textCache.get(url);
  if (!hit) return null;
  if (Date.now() - hit.at > TEXT_CACHE_TTL) {
    textCache.delete(url);
    textCacheBytes -= hit.body.length;
    return null;
  }
  // Refresh insertion order so the Map doubles as an LRU.
  textCache.delete(url);
  textCache.set(url, hit);
  return hit;
}

function textCacheSet(url, entry) {
  if (entry.body.length > TEXT_CACHE_ENTRY_MAX) return;
  const old = textCache.get(url);
  if (old) {
    textCache.delete(url);
    textCacheBytes -= old.body.length;
  }
  textCache.set(url, entry);
  textCacheBytes += entry.body.length;
  while (textCacheBytes > TEXT_CACHE_MAX) {
    const first = textCache.keys().next().value;
    if (first === undefined) break;
    const evicted = textCache.get(first);
    textCache.delete(first);
    textCacheBytes -= evicted.body.length;
  }
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on("data", (c) => {
      if (settled) return;
      size += c.length;
      if (size > limit) {
        settled = true;
        reject(new Error("body too large"));
        // Keep draining instead of destroying the socket: the 413 can then
        // actually reach the client.
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on("error", (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
  });
}

async function handleGateway(req, res, query) {
  const secure = secureServing(req);
  const rawTarget = query.get("url");
  if (!rawTarget) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("missing ?url=");
    return;
  }
  // Self-target remap BEFORE validation: app code sometimes resolves
  // same-origin API paths (location.origin + "/ttwid/check/") against OUR
  // masked document base instead of the upstream page. Those arrive here with
  // our own host as the target — remap the path onto the default upstream
  // host (validated below) rather than 403ing.
  let targetStr = rawTarget;
  try {
    const t0 = new URL(rawTarget);
    const selfHost = String(req.headers.host || "").split(":")[0].toLowerCase();
    const tHost = t0.hostname.toLowerCase();
    if (
      tHost === selfHost ||
      tHost === "127.0.0.1" ||
      tHost === "::1" ||
      tHost === "localhost"
    ) {
      targetStr = `https://${DEFAULT_NAV_HOST}${upstreamPath(t0.pathname)}${t0.search}${t0.hash}`;
    }
  } catch {
    /* unparseable here; validateTarget reports it */
  }
  let validated;
  try {
    validated = await validateTarget(targetStr);
  } catch (e) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("blocked: " + e.message);
    return;
  }
  let current = validated.url;
  let addresses = validated.addresses;
  if (!ALLOW_TELEMETRY && isTelemetry(current.hostname, current.pathname)) {
    answerTelemetry(req, res);
    return;
  }
  let customReferer = null;
  let refParam = query.get("referer");
  // Sentinel reattach (see proxify): dynamic import() specifiers cannot be
  // hooked client-side, so loaders fetch "/tt?url=<base>&referer=<ref>&tt=1"
  // with the chunk path glued after the sentinel ("...&tt=1static/js/...").
  // Split there and reattach the trail onto the base. Only when the url
  // target is a directory (never a real asset), and only when the trail does
  // NOT start with "&" (that means same-level extra query params, which parse
  // normally and must be left alone).
  if (current.pathname.endsWith("/")) {
    try {
      const rawQ = req.url.slice(req.url.indexOf("?") + 1);
      const sPos = rawQ.indexOf("&tt=1");
      if (sPos !== -1) {
        const trail = rawQ.slice(sPos + "&tt=1".length);
        if (trail && !trail.startsWith("&")) {
          const fixed = new URL(trail, current.href).href;
          const v = await validateTarget(fixed);
          current = v.url;
          addresses = v.addresses;
        }
      }
    } catch {
      /* fall through with the original target */
    }
  }
  if (refParam) {
    try {
      const r = new URL(refParam);
      if (!["http:", "https:"].includes(r.protocol)) throw new Error();
      customReferer = r.href;
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("bad referer");
      return;
    }
  }

  // Rewritten JS/CSS is deterministic for a given upstream URL, so repeat
  // loads do not need to go back to TikTok (and do not spend CPU rewriting).
  const cacheKey = current.href;
  if (req.method === "GET" && !req.headers.range) {
    const hit = textCacheGet(cacheKey);
    if (hit) {
      req.resume();
      cors(res);
      res.setHeader("X-TT-Cache", "hit");
      res.writeHead(hit.status, hit.headers);
      res.end(hit.body);
      return;
    }
  }

  let method = req.method;
  let body = null;
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    try {
      body = await readBody(req);
    } catch (e) {
      res.writeHead(413, { "Content-Type": "text/plain" });
      res.end(String(e.message));
      return;
    }
    if (body && body.length === 0) body = null;
  } else {
    req.resume();
  }

  let upstreamRes = null;
  let redirects = 0;
  // Cookies minted on redirect hops (login/passport flows set them on the 302)
  // used to be discarded with the response. Keep every hop's Set-Cookie and
  // record its scope before following.
  const setCookieHops = [];
  const collectCookies = (headers, host) => {
    const raw = headers && headers["set-cookie"];
    if (!raw) return;
    const list = Array.isArray(raw) ? raw : [raw];
    cookieJar.record(list, host);
    setCookieHops.push(...list);
  };
  try {
    while (redirects <= MAX_REDIRECTS) {
      if (!ALLOW_TELEMETRY && isTelemetry(current.hostname, current.pathname)) {
        upstreamRes?.destroy();
        answerTelemetry(req, res);
        return;
      }
      const refUrl = customReferer || current.href;
      let refOrigin;
      try {
        refOrigin = new URL(refUrl).origin;
      } catch {
        refOrigin = current.origin;
      }
      // Copy what the app sent, minus hop-by-hop/routing headers. The browser's
      // Referer/Origin point at our gateway origin, so they are replaced by the
      // upstream page — TikTok checks them on API calls.
      const outHeaders = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        const lk = key.toLowerCase();
        if (REQUEST_SKIP.has(lk)) continue;
        outHeaders[lk] = value;
      }
      if (!outHeaders["user-agent"]) {
        outHeaders["user-agent"] =
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0";
      }
      if (!outHeaders.accept) outHeaders.accept = "*/*";
      if (!outHeaders["accept-language"]) outHeaders["accept-language"] = "en-US,en;q=0.9";
      outHeaders["accept-encoding"] = upstreamEncoding(req.headers["accept-encoding"]);
      outHeaders.referer = refUrl;
      outHeaders.origin = refOrigin;
      // Only send cookies this upstream host would have received from a real
      // browser (see cookies.mjs); unknown/JS-set cookies pass through.
      // TT_NO_COOKIE_SCOPE=1 disables the scoping (diagnostic escape hatch).
      const cookieHeader = NO_COOKIE_SCOPE
        ? req.headers.cookie || ""
        : cookieJar.filter(req.headers.cookie, current.hostname);
      if (cookieHeader) outHeaders.cookie = cookieHeader;
      if (body && !["GET", "HEAD"].includes(method)) {
        outHeaders["content-length"] = Buffer.byteLength(body);
      } else {
        // Bodyless request (e.g. a 303 downgrade): a stale content-type/
        // content-encoding describing the discarded body confuses upstream.
        delete outHeaders["content-type"];
        delete outHeaders["content-encoding"];
      }
      // keep gzipped JSON bodies (TikTok POSTs gzip) intact
      const transport = current.protocol === "https:" ? https : http;
      upstreamRes = await new Promise((resolve, reject) => {
        const r = transport.request(
          current.href,
          {
            method,
            headers: outHeaders,
            lookup: pinnedLookup(addresses),
            timeout: 25000,
          },
          resolve,
        );
        r.on("error", reject);
        r.on("timeout", () => r.destroy(new Error("upstream timeout")));
        r.end(body && !["GET", "HEAD"].includes(method) ? body : undefined);
      });
      const st = upstreamRes.statusCode;
      collectCookies(upstreamRes.headers, current.hostname);
      if (st >= 300 && st < 400 && upstreamRes.headers.location) {
        redirects++;
        upstreamRes.destroy();
        try {
          const next = new URL(upstreamRes.headers.location, current.href);
          const v = await validateTarget(next.href);
          current = v.url;
          addresses = v.addresses;
          if (st === 303 || ((st === 301 || st === 302) && method === "POST")) {
            method = "GET";
            body = null;
          }
          continue;
        } catch (e) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("blocked redirect: " + e.message);
          return;
        }
      }
      break;
    }
  } catch (e) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("upstream error: " + e.message);
    return;
  }
  if (redirects > MAX_REDIRECTS) {
    res.writeHead(508, { "Content-Type": "text/plain" });
    res.end("too many redirects");
    return;
  }

  const upHeaders = upstreamRes.headers;
  const ctype = String(upHeaders["content-type"] || "").toLowerCase();
  const upath = current.pathname.toLowerCase();
  const isHtml = ctype.includes("text/html");
  const isJs =
    ctype.includes("javascript") || upath.endsWith(".js") || upath.endsWith(".mjs");
  const isCss = ctype.includes("text/css") || upath.endsWith(".css");
  const isJson = ctype.includes("application/json") || ctype.includes("text/json");
  const isM3u8 = ctype.includes("mpegurl") || upath.endsWith(".m3u8");
  const isPlainSniffable =
    ctype.startsWith("text/plain") &&
    !/\.(png|jpe?g|gif|webp|avif|ico|mp4|webm|mp3|m4a|ts|aac)$/.test(upath);

  const binary =
    req.method === "HEAD" ||
    upstreamRes.statusCode === 206 ||
    (!isHtml && !isJs && !isCss && !isJson && !isM3u8 && !isPlainSniffable);

  if (binary) {
    const passthrough = {};
    for (const [k, v] of Object.entries(upHeaders)) {
      if (STRIP_RES.has(k.toLowerCase())) continue;
      passthrough[k] = v;
    }
    const cookies = browserSetCookies(setCookieHops, secure);
    if (cookies.length) passthrough["set-cookie"] = cookies;
    passthrough["access-control-allow-origin"] = "*";
    passthrough["access-control-allow-methods"] = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS";
    passthrough["access-control-allow-headers"] = "*";
    res.writeHead(upstreamRes.statusCode, passthrough);
    upstreamRes.pipe(res);
    upstreamRes.on("error", () => {
      try {
        res.end();
      } catch {
        /* client already disconnected */
      }
    });
    return;
  }

  // text path: buffer, decompress, rewrite
  let raw;
  try {
    const chunks = [];
    let size = 0;
    for await (const c of upstreamRes) {
      size += c.length;
      if (size > MAX_TEXT) throw new Error("text too large");
      chunks.push(c);
    }
    raw = decompress(Buffer.concat(chunks), upHeaders["content-encoding"]);
  } catch (e) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("decode error: " + e.message);
    return;
  }
  if (raw.slice(0, 512).includes(0x00)) {
    const passthrough = {};
    for (const [k, v] of Object.entries(upHeaders)) {
      if (STRIP_RES.has(k.toLowerCase())) continue;
      passthrough[k] = v;
    }
    passthrough["content-type"] = "application/octet-stream";
    cors(res);
    res.writeHead(upstreamRes.statusCode, passthrough);
    res.end(raw);
    return;
  }
  const text = raw.toString("utf8");
  const refererForChildren = current.href;
  let out = text;
  let outType = "text/plain; charset=utf-8";
  if (process.env.TT_DEBUG) {
    console.error(`[tt] ${current.hostname}${current.pathname} ctype=${ctype.slice(0, 60)} len=${text.length}`);
  }
  try {
    if (isHtml) {
      out = injectClient(
        rewriteRootRelativeAttributes(
          rewriteAbsoluteUrls(text, refererForChildren),
        ),
        current.href,
      );
      outType = "text/html; charset=utf-8";
    } else if (isJs) {
      // API builders must see the upstream pathname before adding query parameters and signatures.
      out = rewriteAbsoluteUrls(text, refererForChildren, true);
      outType = "application/javascript; charset=utf-8";
    } else if (isCss) {
      out = rewriteCssUrls(rewriteAbsoluteUrls(text, refererForChildren), refererForChildren);
      outType = "text/css; charset=utf-8";
    } else if (isJson) {
      // API JSON is passed through byte-for-byte. TikTok embeds signed URLs,
      // opaque tokens and signature-bearing params (`qrcode_index_url` for QR
      // login, `ttwid_migration_ticket`, X-Bogus'd media URLs, ...) that must
      // reach the app exactly as issued; rewriting them produced gateway URLs
      // the phone cannot reach and broke QR login. The client hook maps the
      // URLs the app actually uses, at fetch/assign time.
      out = text;
      outType = "application/json; charset=utf-8";
    } else if (isM3u8) {
      out = text.split("\n").map((line) => {
        const t = line.trim();
        if (!t || t.startsWith("#")) return line;
        try {
          return proxify(new URL(t, current.href).href, refererForChildren);
        } catch {
          return line;
        }
      }).join("\n");
      outType = "application/vnd.apple.mpegurl";
    } else if (isPlainSniffable) {
      const s = text.trimStart();
      if (isRealHtml(text)) {
        // TikTok serves the app document mislabeled as text/plain — treat as
        // HTML or the browser downloads/renders it as text instead of booting.
        out = injectClient(
          rewriteRootRelativeAttributes(
            rewriteAbsoluteUrls(text, refererForChildren),
          ),
          current.href,
        );
        outType = "text/html; charset=utf-8";
      } else if (s.startsWith("{") || s.startsWith("[")) {
        // JSON mislabeled as text/plain: same rule as isJson — do not touch it.
        out = text;
        outType = "application/json; charset=utf-8";
      } else {
        out = rewriteAbsoluteUrls(text, refererForChildren);
      }
    }
  } catch (e) {
    console.error("[tt] rewrite failed for " + current.href + ": " + e.stack);
    out = text;
  }
  const outBuf = Buffer.from(out, "utf8");
  const headersOut = { "Content-Type": outType, "Content-Length": outBuf.length };
  // Caching metadata: the body is rewritten, so upstream ETag/Last-Modified no
  // longer describe these bytes — but preserving upstream freshness policy lets
  // the browser keep bundles instead of re-downloading megabytes per reload.
  for (const [key, value] of [
    ["Cache-Control", upHeaders["cache-control"]],
    ["Expires", upHeaders["expires"]],
    ["Content-Language", upHeaders["content-language"]],
  ]) {
    if (value) headersOut[key] = value;
  }
  const cacheControl = String(upHeaders["cache-control"] || "").toLowerCase();
  const vary = String(upHeaders["vary"] || "").toLowerCase();
  if (
    (isJs || isCss) &&
    upstreamRes.statusCode === 200 &&
    setCookieHops.length === 0 &&
    !cacheControl.includes("no-store") &&
    !cacheControl.includes("private") &&
    !vary.includes("cookie") &&
    !vary.includes("authorization")
  ) {
    const cacheHeaders = {};
    for (const key of [
      "Content-Type",
      "Content-Length",
      "Cache-Control",
      "Expires",
      "Content-Language",
    ]) {
      if (headersOut[key] !== undefined) cacheHeaders[key] = headersOut[key];
    }
    textCacheSet(cacheKey, {
      status: 200,
      headers: cacheHeaders,
      body: outBuf,
      at: Date.now(),
    });
  }
  const cookies = browserSetCookies(setCookieHops, secure);
  if (cookies.length) headersOut["Set-Cookie"] = cookies;
  cors(res);
  res.writeHead(upstreamRes.statusCode, headersOut);
  res.end(outBuf);
}

// Telemetry stub: trackers expect *something*. Beacons get 204; callers that
// asked for JSON get an empty object so their response parsing (statusCode
// reads, .json(), axios wrappers) doesn't throw.
function answerTelemetry(req, res) {
  cors(res);
  const accept = String(req.headers["accept"] || "");
  if (accept.includes("json")) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end("{}");
  } else {
    res.writeHead(204);
    res.end();
  }
}

// Raw TCP/TLS WebSocket relay: replay the browser handshake upstream with a
// rewritten Host/Origin, then pipe bytes both ways. Works for any WS host
// without a ws dependency.
function handleWsUpgrade(req, socket, head) {
  let target;
  try {
    const u = new URL(req.url, "http://local");
    if (u.pathname !== WS_GATE) throw new Error();
    target = new URL(u.searchParams.get("url") || "");
  } catch {
    socket.destroy();
    return;
  }
  validateTarget(target.href)
    .then(({ url, addresses }) => {
      if (!["ws:", "wss:"].includes(url.protocol)) throw new Error("ws(s) only");
      const secure = url.protocol === "wss:";
      const port = url.port ? Number(url.port) : secure ? 443 : 80;
      const options = { port, host: url.hostname, lookup: pinnedLookup(addresses) };
      const up = secure
        ? tls.connect({ ...options, servername: url.hostname })
        : net.connect(options);
      up.on("error", () => socket.destroy());
      up.on("close", () => socket.destroy());
      socket.on("error", () => up.destroy());
      socket.on("close", () => up.destroy());
      const lines = [`GET ${url.pathname}${url.search} HTTP/1.1`];
      lines.push(`Host: ${url.host}`);
      const fwd = [
        "sec-websocket-key",
        "sec-websocket-version",
        "sec-websocket-protocol",
        "sec-websocket-extensions",
        "user-agent",
      ];
      const hdrs = {};
      for (const k of Object.keys(req.headers)) hdrs[k.toLowerCase()] = req.headers[k];
      for (const k of fwd) {
        if (hdrs[k]) lines.push(`${k}: ${hdrs[k]}`);
      }
      // Same per-host cookie scoping as the HTTP gateway.
      // Same per-host cookie scoping as the HTTP gateway (TT_NO_COOKIE_SCOPE=1
      // disables it for diagnostics).
      const wsCookies = NO_COOKIE_SCOPE ? hdrs.cookie : cookieJar.filter(hdrs.cookie, url.hostname);
      if (wsCookies) lines.push(`cookie: ${wsCookies}`);
      lines.push(`Origin: https://${DEFAULT_NAV_HOST}`);
      lines.push("Connection: Upgrade", "Upgrade: websocket", "", "");
      up.write(lines.join("\r\n"));
      if (head && head.length) up.write(head);
      socket.pipe(up);
      up.pipe(socket);
    })
    .catch(() => socket.destroy());
}

async function routeRequest(req, res, u) {
  if (u.pathname === BASE || u.pathname === BASE + "/") {
    // The app lives in public/tiktok.html; /tiktok itself would otherwise be
    // served as a TikTok document whose URL the SPA router cannot recognize.
    res.writeHead(302, { Location: "/tiktok.html", "Cache-Control": "no-store" });
    res.end();
    return;
  }
  if (u.pathname === CLIENT_JS) {
    let js;
    try {
      js = readFileSync(CLIENT_SCRIPT, "utf8");
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("client script unavailable: " + e.message);
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(js);
    return;
  }
  if (u.pathname === GATE) {
    if (req.method === "OPTIONS") {
      cors(res);
      res.writeHead(204);
      res.end();
      return;
    }
    await handleGateway(req, res, u.searchParams);
    return;
  }
  // Masked navigation fallback (see DEFAULT_NAV_HOST): any other GET/HEAD
  // path under /tiktok is treated as an upstream page. This catches the SPA
  // router's full-navigations (e.g. /tiktok/404?fromUrl=...) and reloads of
  // masked URLs. Our own routes are all handled above.
  if (
    (req.method === "GET" || req.method === "HEAD") &&
    !u.pathname.includes("..")
  ) {
    const target = `https://${DEFAULT_NAV_HOST}${upstreamPath(u.pathname)}${u.search}`;
    const qp = new URLSearchParams();
    qp.set("url", target);
    qp.set("referer", target);
    qp.set("tt", "1");
    await handleGateway(req, res, qp);
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}

/** True when the URL belongs to the gateway's /tiktok subtree. */
export function isTikTokRequest(url) {
  let u;
  try {
    u = new URL(url, "http://local");
  } catch {
    return false;
  }
  return u.pathname === BASE || u.pathname.startsWith(BASE + "/");
}

/**
 * Root paths that TikTok's router navigates to (it reads location.pathname, so
 * they cannot be prefixed). Only claimed while the area's marker cookie is set.
 */
export function isTikTokNavPath(pathname) {
  const path = String(pathname || "").split(/[?#]/, 1)[0];
  if (path.startsWith("/@")) return true;
  return TIKTOK_NAV_RE.test(path);
}

async function routeNav(req, res, u) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  // Redirect into the gateway subtree instead of serving the document here:
  // TikTok cookies are scoped to /tiktok, so /foryou itself would not carry
  // the session. The gateway document loads with those cookies, then the
  // client replaceStates the URL back to the root path the router expects.
  const target = `https://${DEFAULT_NAV_HOST}${u.pathname}${u.search}`;
  const qp = new URLSearchParams();
  qp.set("url", target);
  qp.set("referer", target);
  qp.set("tt", "1");
  res.writeHead(302, {
    Location: GATE + "?" + qp.toString(),
    "Cache-Control": "no-store",
  });
  res.end();
}

/**
 * Handle a normal request before Fastify. Returns true when it was ours, so
 * the caller must not hand the socket to Fastify (the raw body stream and
 * response are managed here).
 */
export function handleTikTokRequest(req, res) {
  let u;
  try {
    u = new URL(req.url, "http://local");
  } catch {
    return false;
  }
  const gateway = u.pathname === BASE || u.pathname.startsWith(BASE + "/");
  const nav =
    !gateway &&
    isTikTokNavPath(u.pathname) &&
    NAV_COOKIE_RE.test(String(req.headers.cookie || ""));
  if (!gateway && !nav) return false;
  res.setHeader("Content-Security-Policy", PROXY_CSP);
  res.setHeader("X-DNS-Prefetch-Control", "off");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const task = gateway ? routeRequest(req, res, u) : routeNav(req, res, u);
  task.catch((e) => {
    try {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("server error: " + e.message);
    } catch {
      /* socket already gone */
    }
  });
  return true;
}

/** Handle the /tiktok/tt-ws upgrade. Returns true when it was ours. */
export function upgradeTikTok(req, socket, head) {
  let u;
  try {
    u = new URL(req.url, "http://local");
  } catch {
    return false;
  }
  if (u.pathname !== WS_GATE) return false;
  handleWsUpgrade(req, socket, head);
  return true;
}

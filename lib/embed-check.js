// The player iframes a game or app source directly when the provider allows
// it, and falls back to the Scramjet proxy when it doesn't. Framing policy is
// only visible in the response headers (X-Frame-Options / CSP frame-ancestors),
// and a browser only learns it after the frame has already been refused, so
// the player asks this endpoint before mounting the frame.
//
// The host list is exactly what our own catalogs can produce. It keeps the
// endpoint from becoming a generic "read any URL's headers" service.
import { resolvePublicUrl } from "./public-network.js";

const ALLOWED_DOMAINS = [
  // public/assets/data/apps.json
  "barricade.gg",
  "chess.com",
  "legionsdk.com",
  "officialchadrankings.com",
  "reddit.com",
  "vscode.dev",
  "myinstants.com",
  "tiktok.com",
  "youtube.com",
  // game catalog providers (public/assets/data/games.js)
  "githack.com",
  "github.io",
  "petezahgames.com",
  "selenite.cc",
  "truffled.lol",
  "velara.my",
];

const PROBE_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;
const PROBE_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

function allowedhost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return ALLOWED_DOMAINS.some(
    (domain) => host === domain || host.endsWith("." + domain),
  );
}

// Returns the parsed URL when it is a game source we are willing to probe,
// null otherwise.
export function allowedgameurl(raw) {
  let url;
  try {
    url = new URL(String(raw || ""));
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== "443") return null;
  return allowedhost(url.hostname) ? url : null;
}

function selfmatches(source, selfhost) {
  if (!selfhost) return false;
  const cleaned = String(source)
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/\/.*$/, "");
  return cleaned === selfhost.toLowerCase();
}

// X-Frame-Options only has DENY/SAMEORIGIN/ALLOW-FROM, and our origin is never
// the provider's, so any value refuses us. CSP frame-ancestors can name "*" or
// our own host, so those two are parsed.
export function isframeable(headers, selfhost = "") {
  if (String(headers.get("x-frame-options") || "").trim()) return false;
  for (const header of [
    "content-security-policy",
    "content-security-policy-report-only",
  ]) {
    const policy = String(headers.get(header) || "");
    for (const directive of policy.split(";")) {
      const [name, ...sources] = directive.trim().split(/\s+/);
      if (name.toLowerCase() !== "frame-ancestors") continue;
      const allowed = sources.some(
        (source) => source === "*" || selfmatches(source, selfhost),
      );
      if (!allowed) return false;
    }
  }
  return true;
}

async function probe(url, selfhost, fetchimpl) {
  const options = {
    redirect: "manual",
    headers: PROBE_HEADERS,
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  };
  let res = await fetchimpl(url, { ...options, method: "HEAD" });
  if (res.status === 405 || res.status === 501) {
    // Some static hosts only implement GET; the body is never read.
    res = await fetchimpl(url, {
      ...options,
      method: "GET",
      headers: { ...PROBE_HEADERS, range: "bytes=0-0" },
    });
    if (res.body) res.body.cancel().catch(() => {});
  }
  // A redirect, an error page or a challenge tells us nothing about the game
  // page itself; the player keeps using the proxy rather than guess.
  if (res.status < 200 || res.status >= 300) return null;
  return isframeable(res.headers, selfhost);
}

export function registerEmbedCheck(fastify, options = {}) {
  const fetchimpl = options.fetchimpl || fetch;
  const resolve = options.resolve || resolvePublicUrl;
  const cache = new Map(); // url -> { at, frameable }

  fastify.get("/api/embed-check", async (req, reply) => {
    const target = allowedgameurl(req.query && req.query.url);
    if (!target)
      return reply
        .code(400)
        .send({ ok: false, error: "That URL is not a game source." });

    const key = target.href;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS)
      return reply
        .header("Cache-Control", "private, max-age=300")
        .send({ ok: true, frameable: cached.frameable });

    const selfhost = String(
      req.headers["x-forwarded-host"] || req.headers.host || "",
    ).split(":")[0];
    let frameable = null;
    try {
      // Refuses private/reserved targets even for an allowlisted hostname.
      await resolve(key);
      frameable = await probe(key, selfhost, fetchimpl);
    } catch (error) {
      console.warn(
        `[embed-check] ${key} probe failed: ${String((error && error.message) || error)}`,
      );
    }

    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(key, { at: Date.now(), frameable });
    return reply
      .header("Cache-Control", "private, max-age=300")
      .send({ ok: true, frameable });
  });
}

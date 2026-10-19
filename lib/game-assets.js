// Same-origin delivery, allowlisted-mirror upstreams only. Never cache CDN
// error bodies as game data: GitHub rate-limit text has been served by CDNs
// with HTTP 200.
import { Readable } from "node:stream";

export const GAME_ASSET_REVISION = "4cf9c5500d0644a7de082e1a37d1be8ab46514f8";
const PREFIX = "/game-assets/1games-rips/";
const MIRROR_PREFIX = "/game-assets/m/";
// Host allowlist for the universal mirror relay. Each key maps to an ordered
// list of equivalent static upstreams that the relay tries in turn, so a CDN
// that refuses one file can be covered by a sibling endpoint. jsDelivr, for
// example, enforces its package-size guard (403 "Package size exceeded") per
// endpoint against that edge's own cache, so a path that 403s on
// cdn.jsdelivr.net frequently still serves from fastly/gcore and vice versa.
// Static file mirrors only: proxying API/ad/tracking hosts would break them and
// turn this into an open relay. Add new mirror hosts here (and only here).
const MIRRORS = {
  jsdelivr: ["https://cdn.jsdelivr.net/", "https://fastly.jsdelivr.net/", "https://gcore.jsdelivr.net/"],
  fastly: ["https://fastly.jsdelivr.net/"],
  gcore: ["https://gcore.jsdelivr.net/"],
  statically: ["https://cdn.statically.io/"],
  ghraw: ["https://raw.githubusercontent.com/"],
  // raw.githack.com is only a redirect to raw.githubusercontent.com these days
  // (301, same path shape) and the relay refuses upstream redirects, so the
  // githack mirror is served from GitHub directly.
  githack: ["https://raw.githubusercontent.com/"],
  cdnjs: ["https://cdnjs.cloudflare.com/"],
};
// A relayed path is relayed exactly as the visitor sent it. A jsDelivr path
// can contain percent escapes ("fruit%20ninja/Build/x.js") and the CDN must
// see the same path the browser would have sent directly, so the raw request
// target is used upstream. Fastify hands over a decoded wildcard parameter,
// which is only good enough for content-type and file-name checks.
const SEGMENT = /^[-A-Za-z0-9._~!$&'()*+,;=:@%]+$/;
const ESCAPE = /^[0-9A-Fa-f]{2}$/;

// Decodes one path segment, or returns null when it could name a different
// file than the visitor asked for: a malformed escape, an encoded separator
// or a traversal segment.
export function decodeAssetSegment(segment) {
  if (!SEGMENT.test(segment)) return null;
  for (let i = segment.indexOf("%"); i !== -1; i = segment.indexOf("%", i + 1)) {
    if (!ESCAPE.test(segment.slice(i + 1, i + 3))) return null;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  // A decoded separator would smuggle a path segment past the checks below.
  if (/[/\\\0]/.test(decoded)) return null;
  if (decoded === "." || decoded === "..") return null;
  return decoded;
}

// Validates a raw (still percent-encoded) asset path and returns its decoded
// form, or null when the path is not relayable. An empty segment is refused
// too, so "//" and a trailing slash never reach the CDN.
export function decodeAssetPath(raw) {
  if (typeof raw !== "string" || !raw || raw.length > 1024) return null;
  const decoded = [];
  for (const segment of raw.split("/")) {
    const value = decodeAssetSegment(segment);
    if (value === null) return null;
    decoded.push(value);
  }
  return decoded.join("/");
}

// The raw request target, without the query string. Client query strings are
// never forwarded upstream.
export function rawTarget(req) {
  const target = (req && req.raw && req.raw.url) || "";
  const q = target.indexOf("?");
  const path = q === -1 ? target : target.slice(0, q);
  // An absolute-form target ("GET http://host/x") is not a path.
  return path.startsWith("/") ? path : "";
}

// Only small assets are held in memory and cached. FNAF-style builds are split
// into ~20MB parts: buffering one would eat a third of the cache budget and
// make the visitor wait for the whole file before the first byte.
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
// Buffered downloads are memory-bound. Streamed bodies release their slot as
// soon as the size is known, so a 20MB game can't starve the rest of the site.
const SLOTS = 4;
const HEAD_TTL_MS = 5 * 60 * 1000;
const VALIDATE_BYTES = 512;
// Ask upstreams for an uncompressed body. Native fetch inflates gzip/br on its
// own but leaves the on-wire Content-Length header untouched, so a length read
// from such a response describes the *compressed* bytes. Acting on it truncated
// every compressed text asset (the FNAF loader's 19,599-byte main.js arrived as
// 7,229 bytes and the game sat at 0% forever). We never forward upstream
// compression anyway, so identity costs nothing and makes sizes truthful.
const UPSTREAM_HEADERS = { "accept-encoding": "identity" };

export function validGameAsset(path, data) {
  if (!data.length) return false;
  const text = data.subarray(0, 256).toString("utf8").trimStart();
  if (/^(?:\d{3}:|Failed to fetch|Package size exceeded|File size exceeded|Couldn't find|<!doctype html|<html)/i.test(text)) return false;
  if (/\.(?:unityweb|wasm)(?:\.part\d+)?$/.test(path)) {
    if (data.length < VALIDATE_BYTES) return false;
    // Later split parts start in the middle of an opaque binary stream.
    const part = path.match(/\.part(\d+)$/);
    if (part && Number(part[1]) > 1) return true;
    // Unity ships three web formats and only two of them are gzip: the
    // "Compressed" build type wraps the data in its own container ("UnityWeb
    // Compressed") and the WebGL framework file is the loader module itself
    // ("var UnityModule = (function() {"). Both are valid files, and refusing
    // them broke 3dash, BitLife, 10 Minutes Till Dawn and others with a 502.
    const head = data.subarray(0, 256);
    if (head.includes(Buffer.from("UnityWeb Compressed"))) return true;
    if (head.includes(Buffer.from("var UnityModule"))) return true;
    if (head.includes(Buffer.from("var Unity Module"))) return true;
    const gzip = data[0] === 31 && data[1] === 139;
    if (path.includes(".data.")) return gzip || text.startsWith("UnityWebData1.0");
    if (path.includes(".wasm")) return gzip || data.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]));
  }
  return true;
}

export function registerGameAssets(app, { fetchimpl = fetch, timeoutMs = 20000, stallMs = 45000, maxCacheBytes = MAX_CACHE_BYTES } = {}) {
  const cache = new Map();
  const pending = new Map();
  const heads = new Map();
  const headpending = new Map();
  const failures = new Map();
  let cacheBytes = 0;
  let active = 0;
  const waiting = [];

  async function withSlot(fn) {
    if (active >= SLOTS) await new Promise(resolve => waiting.push(resolve));
    else active++;
    let held = true;
    // A streamed body no longer holds asset bytes in memory, so hand the slot
    // back immediately instead of keeping it for the whole transfer.
    const release = () => {
      if (!held) return;
      held = false;
      if (waiting.length) waiting.shift()();
      else active--;
    };
    try {
      return await fn(release);
    } finally {
      release();
    }
  }

  // Abort a request that never answers, or one that stops sending mid-body. A
  // fixed deadline can't cover a 20MB part on a slow uplink, but a stalled
  // transfer can be cut off safely.
  function stallguard(initial = timeoutMs) {
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(new Error("upstream stalled")), initial);
    return {
      signal: controller.signal,
      reset() {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(new Error("upstream stalled")), stallMs);
      },
      clear() { clearTimeout(timer); },
    };
  }

  function contentType(path, response) {
    return path.endsWith(".js") ? "application/javascript; charset=utf-8"
      : path.endsWith(".css") ? "text/css; charset=utf-8"
      : response.headers.get("content-type") || "application/octet-stream";
  }

  // A size hint only. It decides buffer-vs-stream and rejects absurd assets; it
  // must never decide that a body has ended. A wrong hint (a compressed length
  // leaked through, a proxy adding a few bytes) would otherwise truncate the
  // response instead of failing loudly.
  function declaredLength(response) {
    const value = Number(response.headers.get("content-length"));
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  // Fetch one upstream URL with size caps and body validation shared by all
  // routes. Upstream hosts are fixed constants above: visitor input only ever
  // selects a path, never a host.
  //
  // Returns { data, type } when the asset fits in memory, or { stream, type }
  // when it should be piped straight to the client.
  async function fetchAsset(upstreamUrl, validatePath, release) {
    const guard = stallguard();
    let response;
    try {
      response = await fetchimpl(upstreamUrl, {
        signal: guard.signal,
        redirect: "error",
        headers: UPSTREAM_HEADERS,
      });
    } catch (error) {
      guard.clear();
      throw error;
    }
    if (!response.ok) {
      guard.clear();
      await response.body?.cancel().catch(() => {});
      throw new Error(`CDN returned ${response.status}`);
    }
    const declared = declaredLength(response);
    if (declared && declared > MAX_FILE_BYTES) {
      guard.clear();
      await response.body?.cancel().catch(() => {});
      throw new Error("Asset exceeds download limit");
    }
    const type = contentType(validatePath, response);
    const iterator = response.body[Symbol.asyncIterator]();
    const chunks = [];
    let size = 0;
    let done = false;
    let validated = false;

    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) { done = true; break; }
        const chunk = Buffer.from(next.value);
        chunks.push(chunk);
        size += chunk.length;
        if (size > MAX_FILE_BYTES) throw new Error("Asset exceeds download limit");
        // Judge the body before falling through to the next mirror; a short
        // first chunk is not evidence of anything.
        if (!validated && size >= VALIDATE_BYTES) {
          if (!validGameAsset(validatePath, Buffer.concat(chunks, size))) {
            throw new Error("CDN returned invalid game data");
          }
          validated = true;
        }
        // A declared size over the buffer limit means we already know this is
        // a stream: stop as soon as the prefix is validated so the first byte
        // reaches the game without waiting for megabytes. Without a declared
        // size, buffer until the limit and then stream the rest. The body ends
        // when upstream says it ends, never when the length hint is reached.
        const tooBig = declared ? declared > MAX_BUFFER_BYTES : size > MAX_BUFFER_BYTES;
        if (validated && tooBig) break;
        guard.reset();
      }
      if (done && !validated && !validGameAsset(validatePath, Buffer.concat(chunks, size))) {
        throw new Error("CDN returned invalid game data");
      }
    } catch (error) {
      guard.clear();
      await iterator.return?.().catch(() => {});
      throw error;
    }

    if (done) {
      guard.clear();
      await iterator.return?.().catch(() => {});
      const data = Buffer.concat(chunks, size);
      if (!validGameAsset(validatePath, data)) throw new Error("CDN returned invalid game data");
      return { data, type };
    }

    release();
    const stream = Readable.from((async function* () {
      try {
        yield* chunks;
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          guard.reset();
          yield next.value;
        }
      } finally {
        guard.clear();
        await iterator.return?.().catch(() => {});
      }
    })());
    return { stream, type };
  }

  // Try the same path across a mirror's ordered upstream list until one returns
  // valid data. Single-upstream mirrors simply have a one-entry list, so every
  // mirror flows through the same mechanism. URLs are fully formed by callers.
  async function fetchAny(upstreams, path, release) {
    let lastError;
    for (const upstream of upstreams) {
      try {
        return await fetchAsset(upstream, path, release);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  // A HEAD probe must never download the asset. Split-file loaders ask for the
  // size of every part before they start, so buffering here meant 160MB of
  // pointless traffic (and a timeout) just to learn eight numbers.
  async function fetchHead(upstreamUrl, path) {
    const guard = stallguard();
    let response;
    try {
      response = await fetchimpl(upstreamUrl, {
        method: "HEAD",
        signal: guard.signal,
        redirect: "error",
        headers: UPSTREAM_HEADERS,
      });
      if (!response.ok) throw new Error(`CDN returned ${response.status}`);
      const length = declaredLength(response);
      if (!length) throw new Error("CDN omitted a content length");
      if (length > MAX_FILE_BYTES) throw new Error("Asset exceeds download limit");
      return { length, type: contentType(path, response) };
    } finally {
      guard.clear();
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  }

  async function fetchHeadAny(upstreams, path) {
    let lastError;
    for (const upstream of upstreams) {
      try {
        return await fetchHead(upstream, path);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  function storeInCache(key, asset) {
    if (asset.data.length <= maxCacheBytes && asset.data.length <= MAX_BUFFER_BYTES) {
      while (cache.size && cacheBytes + asset.data.length > maxCacheBytes) {
        const oldest = cache.keys().next().value;
        cacheBytes -= cache.get(oldest).data.length;
        cache.delete(oldest);
      }
      cache.set(key, asset);
      cacheBytes += asset.data.length;
    }
  }

  async function serveCached(key, loader) {
    let asset = cache.get(key);
    if (asset) {
      cache.delete(key);
      cache.set(key, asset);
      return asset;
    }
    if ((failures.get(key) || 0) > Date.now() || (!pending.has(key) && pending.size >= 64)) {
      const err = new Error("cooldown");
      err.statusCode = 503;
      throw err;
    }
    let holder = pending.get(key);
    if (!holder) {
      holder = { task: null, claimed: false };
      holder.task = withSlot((release) => loader(release)).finally(() => {
        if (pending.get(key) === holder) pending.delete(key);
      });
      pending.set(key, holder);
    }
    try {
      const fetched = await holder.task;
      // Streams are single-use: a second waiter opens its own upstream request
      // instead of reading an already-consumed body.
      if (!fetched.stream) {
        storeInCache(key, fetched);
        return fetched;
      }
      if (holder.claimed) return withSlot((release) => loader(release));
      holder.claimed = true;
      return fetched;
    } catch (error) {
      if (error && error.statusCode) throw error;
      if (failures.size >= 256) failures.delete(failures.keys().next().value);
      failures.set(key, Date.now() + 10000);
      throw error;
    }
  }

  async function serveHead(key, loader) {
    const cached = heads.get(key);
    if (cached && cached.expires > Date.now()) return cached;
    let task = headpending.get(key);
    if (!task) {
      task = loader().then((meta) => {
        const entry = { ...meta, expires: Date.now() + HEAD_TTL_MS };
        if (heads.size >= 512) heads.delete(heads.keys().next().value);
        heads.set(key, entry);
        return entry;
      }).finally(() => headpending.delete(key));
      headpending.set(key, task);
    }
    return task;
  }

  function sendHeaders(req, reply, asset) {
    // Redirected cors-mode fetches stay CORS-checked across the whole chain,
    // so echo the origin (public static files only; upstream cookies are
    // never forwarded or stored).
    if (req.headers.origin) {
      reply.header("Access-Control-Allow-Origin", req.headers.origin);
      reply.header("Vary", "Origin");
    }
    // Native fetch decoded any HTTP compression. Do not forward upstream
    // Content-Encoding/Length, Set-Cookie, redirects or cache-error headers.
    return reply.type(asset.type).header("Cache-Control", "public, max-age=300");
  }

  function sendAsset(req, reply, asset) {
    sendHeaders(req, reply, asset);
    // Streams are chunked on purpose: jsDelivr's content-length metadata can be
    // a few bytes off the real body (HEAD and range-total both disagreed with
    // the bytes every edge actually served), and forwarding it would truncate
    // the response and break the game's merge step.
    if (asset.stream) return reply.send(asset.stream);
    return reply.header("Content-Length", asset.data.length).send(asset.data);
  }

  function sendHead(req, reply, meta) {
    // Fastify's auto-generated HEAD route rewrites the payload length, so write
    // the probe response directly: the visitor gets the real size and we never
    // touch the body.
    reply.hijack();
    const headers = {
      "content-type": meta.type,
      "cache-control": "public, max-age=300",
      "content-length": String(meta.length),
    };
    if (req.headers.origin) {
      headers["access-control-allow-origin"] = req.headers.origin;
      headers.vary = "Origin";
    }
    reply.raw.writeHead(200, headers);
    reply.raw.end();
  }

  // A visitor-side failure used to be invisible from here: this relay reported
  // through app.log, but Fastify is constructed without a logger, so every
  // warning was discarded, and Caddy records only aborted streams. "It hangs on
  // my tablet" therefore looked identical to "the visitor never asked". Client
  // aborts always leave a line now; a full per-request trace is opt-in via
  // GAME_ASSET_LOG=1 so it can be switched on without a code change.
  const traceAll = process.env.GAME_ASSET_LOG === "1";
  function observe(req, reply, key) {
    const started = Date.now();
    let sent = 0;
    const count = (chunk) => {
      if (!chunk || typeof chunk === "function") return;
      sent += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    };
    const write = reply.raw.write.bind(reply.raw);
    const end = reply.raw.end.bind(reply.raw);
    reply.raw.write = function (chunk, ...rest) { count(chunk); return write(chunk, ...rest); };
    reply.raw.end = function (chunk, ...rest) { count(chunk); return end(chunk, ...rest); };
    reply.raw.once("close", () => {
      const aborted = !reply.raw.writableFinished;
      if (!aborted && !traceAll) return;
      const ua = String(req.headers["user-agent"] || "-").slice(0, 110);
      const line = `${req.method} ${key} -> ${reply.raw.statusCode} sent=${sent}B in ${Date.now() - started}ms ua="${ua}"`;
      // console, not app.log: pm2 only receives what the modules write directly.
      if (aborted) console.warn(`[game-assets] client aborted ${line}`);
      else console.info(`[game-assets] served ${line}`);
    });
  }

  function sendRelayError(reply, key, error, logContext) {
    if (error && error.statusCode === 503) {
      return reply.code(503).header("Cache-Control", "no-store").header("Retry-After", "2").send("Game CDN temporarily unavailable; retry shortly.");
    }
    console.warn(`[game-assets] ${logContext}: ${key}: ${error && error.message}`);
    return reply.code(502).header("Cache-Control", "no-store").header("Retry-After", "10").send("Game CDN temporarily unavailable; retry shortly.");
  }

  // jsDelivr refuses repos over its package-size guard on a cold edge, which is
  // exactly what a 350MB FNAF archive trips. GitHub's raw host serves the same
  // bytes for the same pinned path, so use it as the last resort instead of
  // failing a whole split archive on one cold edge.
  // A jsDelivr path is "gh/<user>/<repo>@<ref>/<file>", but the ref may be
  // missing ("gh/<user>/<repo>/<file>") and GitHub's raw host then serves the
  // default branch. Both forms are needed: jsDelivr blocks abusive users
  // outright ("403 User <name> is blocked") while the file is still on GitHub.
  function githubFallback(path) {
    const match = path.match(/^gh\/([^/]+)\/([^/@]+)(@[^/]+)?\/(.+)$/);
    if (!match) return null;
    const [, user, repo, ref, file] = match;
    return `https://raw.githubusercontent.com/${user}/${repo}/${ref ? ref.slice(1) : "HEAD"}/${file}`;
  }

  function mirrorUpstreams(mirror, path) {
    const list = MIRRORS[mirror].map(base => base + path);
    const fallback = mirror === "jsdelivr" ? githubFallback(path) : null;
    return fallback ? [...list, fallback] : list;
  }

  // The 1games-rips repo has no GitHub raw twin, so both refs are jsDelivr.
  function ripsUpstreams(path) {
    return [
      `https://cdn.jsdelivr.net/gh/mynamescrax/1games-rips@${GAME_ASSET_REVISION}/${path}`,
      `https://cdn.jsdelivr.net/gh/mynamescrax/1games-rips@main/${path}`,
    ];
  }

  async function downloadFromCdn(raw, decoded, release) {
    let lastError;
    // Pinned URLs avoid poisoned @main entries; @main can still have a healthy
    // cached copy when jsDelivr cannot retrieve a cold commit URL from GitHub.
    for (const ref of [GAME_ASSET_REVISION, "main"]) {
      try {
        return await fetchAsset(`https://cdn.jsdelivr.net/gh/mynamescrax/1games-rips@${ref}/${raw}`, decoded, release);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  app.get(`${PREFIX}*`, async (req, reply) => {
    // The raw path goes upstream untouched; the decoded one only decides
    // whether the request is relayable at all.
    const raw = rawTarget(req);
    const path = raw.startsWith(PREFIX) ? raw.slice(PREFIX.length) : "";
    const decoded = decodeAssetPath(path);
    observe(req, reply, `1games-rips/${path}`);
    // Fixed public repository only: no arbitrary host, query or traversal relay.
    if (decoded === null || decoded.includes("@")) {
      return reply.code(400).header("Cache-Control", "no-store").send("Invalid game asset path");
    }
    try {
      if (req.method === "HEAD") {
        return sendHead(req, reply, await serveHead(`h:rips:${path}`, () => withSlot(() =>
          fetchHeadAny(ripsUpstreams(path), decoded))));
      }
      return sendAsset(req, reply, await serveCached(`rips:${path}`, (release) => downloadFromCdn(path, decoded, release)));
    } catch (error) {
      return sendRelayError(reply, path, error, "game CDN asset failed validation");
    }
  });

  // Universal mirror relay: /game-assets/m/<mirror>/<path>
  // The mirror key selects a fixed allowlisted host; visitor input only ever
  // supplies the path. Client query strings are never forwarded upstream.
  app.get(`${MIRROR_PREFIX}*`, async (req, reply) => {
    const raw = rawTarget(req);
    const rest = raw.startsWith(MIRROR_PREFIX) ? raw.slice(MIRROR_PREFIX.length) : "";
    const slash = rest.indexOf("/");
    const mirror = slash === -1 ? rest : rest.slice(0, slash);
    const subpath = slash === -1 ? "" : rest.slice(slash + 1);
    const decoded = decodeAssetPath(subpath);
    observe(req, reply, `m/${rest}`);
    if (!MIRRORS[mirror] || decoded === null) {
      return reply.code(400).header("Cache-Control", "no-store").send("Invalid mirror asset path");
    }
    const key = `m:${mirror}/${subpath}`;
    try {
      if (req.method === "HEAD") {
        return sendHead(req, reply, await serveHead(`h:${key}`, () => withSlot(() =>
          fetchHeadAny(mirrorUpstreams(mirror, subpath), decoded))));
      }
      return sendAsset(req, reply, await serveCached(key, (release) => fetchAny(mirrorUpstreams(mirror, subpath), decoded, release)));
    } catch (error) {
      return sendRelayError(reply, key, error, "mirror CDN asset failed validation");
    }
  });
}

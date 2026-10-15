// Same-origin delivery, allowlisted-mirror upstreams only. Never cache CDN
// error bodies as game data: GitHub rate-limit text has been served by CDNs
// with HTTP 200.
export const GAME_ASSET_REVISION = "4cf9c5500d0644a7de082e1a37d1be8ab46514f8";
const PREFIX = "/game-assets/1games-rips/";
const MIRROR_PREFIX = "/game-assets/m/";
// Host allowlist for the universal mirror relay. Static file mirrors only:
// proxying API/ad/tracking hosts would break them and turn this into an
// open relay. Add new mirror hosts here (and only here).
const MIRRORS = {
  jsdelivr: "https://cdn.jsdelivr.net/",
  fastly: "https://fastly.jsdelivr.net/",
  gcore: "https://gcore.jsdelivr.net/",
  statically: "https://cdn.statically.io/",
  ghraw: "https://raw.githubusercontent.com/",
  githack: "https://raw.githack.com/",
  cdnjs: "https://cdnjs.cloudflare.com/",
};
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;

export function validGameAsset(path, data) {
  if (!data.length) return false;
  const text = data.subarray(0, 256).toString("utf8").trimStart();
  if (/^(?:\d{3}:|Failed to fetch|Package size exceeded|File size exceeded|Couldn't find|<!doctype html|<html)/i.test(text)) return false;
  if (/\.(?:unityweb|wasm)(?:\.part\d+)?$/.test(path)) {
    if (data.length < 512) return false;
    // Later split parts start in the middle of an opaque binary stream.
    const part = path.match(/\.part(\d+)$/);
    if (part && Number(part[1]) > 1) return true;
    const gzip = data[0] === 31 && data[1] === 139;
    if (path.includes(".data.")) return gzip || text.startsWith("UnityWebData1.0");
    if (path.includes(".wasm")) return gzip || data.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]));
  }
  return true;
}

export function registerGameAssets(app, { fetchimpl = fetch, timeoutMs = 12000, maxCacheBytes = MAX_CACHE_BYTES } = {}) {
  const cache = new Map();
  const pending = new Map();
  const failures = new Map();
  let cacheBytes = 0;
  let active = 0;
  const waiting = [];

  async function withSlot(fn) {
    if (active >= 4) await new Promise(resolve => waiting.push(resolve));
    else active++;
    try {
      return await fn();
    } finally {
      // Hand the slot directly to the next queued download.
      if (waiting.length) waiting.shift()();
      else active--;
    }
  }

  async function download(path) {
    return withSlot(() => downloadFromCdn(path));
  }

  // Fetch one upstream URL with size caps and body validation shared by all
  // routes. Upstream hosts are fixed constants above: visitor input only ever
  // selects a path, never a host.
  async function fetchValidated(upstreamUrl, validatePath) {
    let response;
    try {
      response = await fetchimpl(upstreamUrl, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      if (!response.ok || Number(response.headers.get("content-length")) > MAX_FILE_BYTES) {
        throw new Error(`CDN returned ${response.status} or an oversized asset`);
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_FILE_BYTES) throw new Error("Asset exceeds download limit");
        chunks.push(chunk);
      }
      const data = Buffer.concat(chunks, size);
      if (!validGameAsset(validatePath, data)) throw new Error("CDN returned invalid game data");
      const type = validatePath.endsWith(".js") ? "application/javascript; charset=utf-8"
        : validatePath.endsWith(".css") ? "text/css; charset=utf-8"
        : response.headers.get("content-type") || "application/octet-stream";
      return { data, type };
    } finally {
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  }

  function storeInCache(key, asset) {
    if (asset.data.length <= maxCacheBytes) {
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
    if (!pending.has(key)) {
      const task = loader().then(
        (fetched) => { storeInCache(key, fetched); return fetched; },
      ).finally(() => pending.delete(key));
      pending.set(key, task);
    }
    try {
      return await pending.get(key);
    } catch (error) {
      if (error && error.statusCode) throw error;
      if (failures.size >= 256) failures.delete(failures.keys().next().value);
      failures.set(key, Date.now() + 10000);
      throw error;
    }
  }

  function sendAsset(req, reply, asset) {
    // Redirected cors-mode fetches stay CORS-checked across the whole chain,
    // so echo the origin (public static files only; upstream cookies are
    // never forwarded or stored).
    if (req.headers.origin) {
      reply.header("Access-Control-Allow-Origin", req.headers.origin);
      reply.header("Vary", "Origin");
    }
    // Native fetch decoded any HTTP compression. Do not forward upstream
    // Content-Encoding/Length, Set-Cookie, redirects or cache-error headers.
    return reply.type(asset.type).header("Cache-Control", "public, max-age=300").header("Content-Length", asset.data.length).send(asset.data);
  }

  function sendRelayError(reply, key, error, logContext) {
    if (error && error.statusCode === 503) {
      return reply.code(503).header("Cache-Control", "no-store").header("Retry-After", "2").send("Game CDN temporarily unavailable; retry shortly.");
    }
    app.log.warn({ path: key, err: error }, logContext);
    return reply.code(502).header("Cache-Control", "no-store").header("Retry-After", "10").send("Game CDN temporarily unavailable; retry shortly.");
  }

  function validRelPath(path) {
    return typeof path === "string" && path.length > 0 && path.length <= 512
      && /^[A-Za-z0-9_@.\-/]+$/.test(path)
      && !path.includes("//")
      && !path.split("/").some(p => !p || p === "." || p === "..");
  }

  async function downloadFromCdn(path) {
    let lastError;
    // Pinned URLs avoid poisoned @main entries; @main can still have a healthy
    // cached copy when jsDelivr cannot retrieve a cold commit URL from GitHub.
    for (const ref of [GAME_ASSET_REVISION, "main"]) {
      try {
        return await fetchValidated(`https://cdn.jsdelivr.net/gh/mynamescrax/1games-rips@${ref}/${path}`, path);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  app.get(`${PREFIX}*`, async (req, reply) => {
    const path = req.params["*"];
    // Fixed public repository only: no arbitrary host, query or traversal relay.
    if (!validRelPath(path) || path.includes("@")) {
      return reply.code(400).header("Cache-Control", "no-store").send("Invalid game asset path");
    }
    try {
      return sendAsset(req, reply, await serveCached(`rips:${path}`, () => download(path)));
    } catch (error) {
      return sendRelayError(reply, path, error, "game CDN asset failed validation");
    }
  });

  // Universal mirror relay: /game-assets/m/<mirror>/<path>
  // The mirror key selects a fixed allowlisted host; visitor input only ever
  // supplies the path. Client query strings are never forwarded upstream.
  app.get(`${MIRROR_PREFIX}*`, async (req, reply) => {
    const rest = req.params["*"] || "";
    const slash = rest.indexOf("/");
    const mirror = slash === -1 ? rest : rest.slice(0, slash);
    const subpath = slash === -1 ? "" : rest.slice(slash + 1);
    const base = MIRRORS[mirror];
    if (!base || !validRelPath(subpath)) {
      return reply.code(400).header("Cache-Control", "no-store").send("Invalid mirror asset path");
    }
    const key = `m:${mirror}/${subpath}`;
    try {
      return sendAsset(req, reply, await serveCached(key, () => withSlot(() => fetchValidated(base + subpath, subpath))));
    } catch (error) {
      return sendRelayError(reply, key, error, "mirror CDN asset failed validation");
    }
  });
}

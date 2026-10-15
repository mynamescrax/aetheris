// Same-origin delivery, jsDelivr-only upstreams. Never cache CDN error bodies
// as Unity data: GitHub rate-limit text has been served by the CDN with HTTP 200.
export const GAME_ASSET_REVISION = "4cf9c5500d0644a7de082e1a37d1be8ab46514f8";
const PREFIX = "/game-assets/1games-rips/";
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

  async function download(path) {
    if (active >= 4) await new Promise(resolve => waiting.push(resolve));
    else active++;
    try {
      return await downloadFromCdn(path);
    } finally {
      // Hand the slot directly to the next queued download.
      if (waiting.length) waiting.shift()();
      else active--;
    }
  }

  async function downloadFromCdn(path) {
    let lastError;
    // Pinned URLs avoid poisoned @main entries; @main can still have a healthy
    // cached copy when jsDelivr cannot retrieve a cold commit URL from GitHub.
    for (const ref of [GAME_ASSET_REVISION, "main"]) {
      let response;
      try {
        response = await fetchimpl(`https://cdn.jsdelivr.net/gh/mynamescrax/1games-rips@${ref}/${path}`, {
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
        if (!validGameAsset(path, data)) throw new Error("CDN returned invalid game data");
        const type = path.endsWith(".js") ? "application/javascript; charset=utf-8"
          : path.endsWith(".css") ? "text/css; charset=utf-8"
          : response.headers.get("content-type") || "application/octet-stream";
        const asset = { data, type };
        if (data.length <= maxCacheBytes) {
          while (cache.size && cacheBytes + data.length > maxCacheBytes) {
            const oldest = cache.keys().next().value;
            cacheBytes -= cache.get(oldest).data.length;
            cache.delete(oldest);
          }
          cache.set(path, asset);
          cacheBytes += data.length;
        }
        return asset;
      } catch (error) {
        lastError = error;
        if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
      }
    }
    if (failures.size >= 256) failures.delete(failures.keys().next().value);
    failures.set(path, Date.now() + 10000);
    throw lastError;
  }

  app.get(`${PREFIX}*`, async (req, reply) => {
    const path = req.params["*"];
    // Fixed public repository only: no arbitrary host, query or traversal relay.
    if (!path || !/^[A-Za-z0-9_.\-/]+$/.test(path) || path.split("/").some(p => !p || p === "." || p === "..")) {
      return reply.code(400).header("Cache-Control", "no-store").send("Invalid game asset path");
    }
    let asset = cache.get(path);
    if (asset) {
      cache.delete(path);
      cache.set(path, asset);
    } else {
      if ((failures.get(path) || 0) > Date.now() || (!pending.has(path) && pending.size >= 64)) {
        return reply.code(503).header("Cache-Control", "no-store").header("Retry-After", "2").send("Game CDN temporarily unavailable; retry shortly.");
      }
      try {
        if (!pending.has(path)) {
          const task = download(path).finally(() => pending.delete(path));
          pending.set(path, task);
        }
        asset = await pending.get(path);
      } catch (error) {
        app.log.warn({ path, err: error }, "game CDN asset failed validation");
        return reply.code(502).header("Cache-Control", "no-store").header("Retry-After", "10").send("Game CDN temporarily unavailable; retry shortly.");
      }
    }
    // Native fetch decoded any HTTP compression. Do not forward upstream
    // Content-Encoding/Length, Set-Cookie, redirects or cache-error headers.
    return reply.type(asset.type).header("Cache-Control", "public, max-age=300").header("Content-Length", asset.data.length).send(asset.data);
  });
}

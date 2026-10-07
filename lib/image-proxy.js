import { downloadPublicImage } from "./public-network.js";

// Same-origin relay for catalog covers and posters, whose hosts are often
// blocked by school DNS filters. SSRF checks, redirect revalidation and size
// limits live in public-network.js; this adds caching and HTTP responses.

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_URL_LENGTH = 8192;
const CACHE_MAX_ENTRIES = 400;
const CACHE_MAX_BYTES = 32 * 1024 * 1024;
const CACHE_CONTROL = "public, max-age=86400, stale-while-revalidate=604800";
const DOWNLOAD_TIMEOUT_MS = 15000;

// Some CDNs reject unknown user agents or requests without an Accept header.
const REQUEST_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.8",
};

// Validation errors (bad scheme, credentials, private/local address, ...) are
// the caller's problem (403); unsupported content types are 415; anything else
// (upstream status, size, redirects, timeouts) is an upstream failure (502).
const TARGET_ERROR =
  /invalid target url|only http\(s\)|only public web ports|local hostnames|private or non-public|dns lookup timed out|unsafe/i;

export function registerImageProxy(fastify) {
  // in-memory LRU; every visitor requests the same covers
  const cache = new Map();
  let cacheBytes = 0;

  function cacheGet(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    cache.delete(key); // refresh recency
    cache.set(key, entry);
    return entry;
  }

  function cacheSet(key, entry) {
    const existing = cache.get(key);
    if (existing) {
      cacheBytes -= existing.bytes.length;
      cache.delete(key);
    }
    cache.set(key, entry);
    cacheBytes += entry.bytes.length;
    while (
      (cache.size > CACHE_MAX_ENTRIES || cacheBytes > CACHE_MAX_BYTES) &&
      cache.size
    ) {
      const oldest = cache.keys().next().value;
      const dropped = cache.get(oldest);
      cache.delete(oldest);
      cacheBytes -= dropped.bytes.length;
    }
  }

  function sendImage(reply, mime, bytes) {
    return reply
      .header("Cache-Control", CACHE_CONTROL)
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'")
      .type(mime)
      .send(bytes);
  }

  fastify.get("/img", async (req, reply) => {
    const raw = req.query.url;
    if (typeof raw !== "string" || !raw || raw.length > MAX_URL_LENGTH)
      return reply.code(400).send("Missing or invalid url query parameter");

    const cached = cacheGet(raw);
    if (cached) return sendImage(reply, cached.mime, cached.bytes);

    let result;
    try {
      result = await downloadPublicImage(raw, {
        maxBytes: MAX_IMAGE_BYTES,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        headers: REQUEST_HEADERS,
      });
    } catch (error) {
      const message = String((error && error.message) || error);
      if (/unsupported image type/i.test(message))
        return reply.code(415).send(message);
      if (TARGET_ERROR.test(message)) return reply.code(403).send(message);
      console.warn(`[img-proxy] ${raw.slice(0, 160)}: ${message}`);
      return reply.code(502).send("Image could not be loaded.");
    }

    cacheSet(raw, result);
    return sendImage(reply, result.mime, result.bytes);
  });
}

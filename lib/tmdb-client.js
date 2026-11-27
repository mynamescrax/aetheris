import { prepareJson } from "./cached-response.js";

// Only public catalogue endpoints participate in the shared cache. Account,
// session and authentication APIs always go directly upstream.
const PUBLIC_PATH =
  /^(?:trending\/(?:all|movie|tv)\/(?:day|week)|search\/(?:movie|tv|multi)|(?:movie|tv)\/\d+(?:\/season\/\d+)?)$/;
const PUBLIC_PARAMS = new Set([
  "api_key",
  "language",
  "page",
  "query",
  "include_adult",
  "region",
  "year",
  "primary_release_year",
  "first_air_date_year",
]);

function validCatalogue(path, data) {
  if (!data || typeof data !== "object" || Array.isArray(data) || data.success === false) return false;
  return !/^(trending|search)\//.test(path) || Array.isArray(data.results);
}

export function cacheableTmdbRequest(path, url) {
  return (
    PUBLIC_PATH.test(path) &&
    [...url.searchParams.keys()].every((key) => PUBLIC_PARAMS.has(key))
  );
}

export function createTmdbClient({
  fetcher = fetch,
  now = Date.now,
  ttl = 300_000,
  maxEntries = 256,
  maxBytes = 16 * 1024 * 1024,
  maxResponseBytes = 4 * 1024 * 1024,
  maxConcurrent = 64,
} = {}) {
  const cache = new Map();
  const pending = new Map();
  let bytes = 0;
  let active = 0;

  function remove(key) {
    const entry = cache.get(key);
    if (!entry) return;
    bytes -= entry.size;
    cache.delete(key);
  }

  function remember(key, result) {
    const size = Object.values(result.prepared.variants).reduce(
      (total, body) => total + body.length,
      0,
    );
    if (size > maxBytes || maxEntries < 1) return;
    remove(key);
    while (cache.size && (cache.size >= maxEntries || bytes + size > maxBytes))
      remove(cache.keys().next().value);
    cache.set(key, { result, size, expires: now() + ttl });
    bytes += size;
  }

  async function download(url, path, cacheable) {
    if (active >= maxConcurrent) {
      const error = new Error("Movie metadata requests are busy.");
      error.code = "TMDB_BUSY";
      throw error;
    }
    active++;
    try {
      const response = await fetcher(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (Number(response.headers.get("content-length")) > maxResponseBytes) {
        await response.body?.cancel();
        throw new Error("Movie metadata exceeds the response size limit.");
      }
      const chunks = [];
      let length = 0;
      if (response.body)
        for await (const chunk of response.body) {
          length += chunk.length;
          if (length > maxResponseBytes)
            throw new Error("Movie metadata exceeds the response size limit.");
          chunks.push(Buffer.from(chunk));
        }
      const text = Buffer.concat(chunks, length).toString("utf8");
      let data;
      let valid = true;
      try {
        data = JSON.parse(text);
      } catch {
        valid = false;
        data = { ok: false, error: text.slice(0, 500) };
      }
      // A maintenance page or malformed catalogue is not a successful empty
      // search. Do not cache it (including for coalesced callers).
      if (response.status === 200 && (!valid || (PUBLIC_PATH.test(path) && !validCatalogue(path, data)))) {
        return { status: 502, ok: false, headers: response.headers,
          data: { error: { message: "Invalid movie metadata response." } } };
      }
      const result = {
        status: response.status,
        ok: response.ok,
        headers: response.headers,
        data,
      };
      if (cacheable && response.status === 200) {
        result.prepared = await prepareJson(data);
        // Keep only the serialized buffers, not another parsed catalogue.
        delete result.data;
      }
      return result;
    } finally {
      active--;
    }
  }

  return {
    async request(url, path) {
      if (!cacheableTmdbRequest(path, url)) return download(url, path, false);
      const normalized = new URL(url);
      normalized.searchParams.sort();
      const key = normalized.href;
      const entry = cache.get(key);
      if (entry && entry.expires > now()) {
        cache.delete(key);
        cache.set(key, entry);
        return { ...entry.result, cache: "hit" };
      }
      if (entry) remove(key);
      if (pending.has(key))
        return { ...(await pending.get(key)), cache: "coalesced" };
      const request = download(url, path, true)
        .then((result) => {
          if (result.prepared) remember(key, result);
          return result;
        })
        .finally(() => pending.delete(key));
      pending.set(key, request);
      return { ...(await request), cache: "miss" };
    },
  };
}

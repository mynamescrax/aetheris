import http from "node:http";
import https from "node:https";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pinnedLookup, resolvePublicUrl } from "./public-network.js";

// Live provider catalogs, fetched server-side because only gn-math sends CORS
// headers; the rest are same-origin-locked and the browser cannot read them.
//
// The source names are an allowlist, so a visitor can't aim this at another
// host. Each catalog is cached in memory: fresh copies answer directly, and a
// stale copy is served while a refresh runs in the background, so a slow or
// briefly dead provider never blanks the library.

const CATALOGS = new Map([
  [
    "gnmath",
    {
      label: "Gn-Math",
      // The provider's tokenized URL rotates and the old one 404s, so the
      // catalog is saved under public/assets/data instead of fetched. Update
      // the snapshot by replacing that file and restarting the app.
      file: "assets/data/gnmath.json",
    },
  ],
  [
    "truffled",
    { label: "Truffled", url: "https://truffled.lol/js/json/g.json" },
  ],
  ["velara", { label: "Velara", url: "https://velara.my/data/games.json" }],
  [
    "selenite",
    { label: "Selenite", url: "https://selenite.cc/resources/games.json" },
  ],
]);

const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const FRESH_MS = 15 * 60 * 1000;
// After a failed download, stop asking for a while: otherwise every visitor a
// dead provider turns away starts another outbound request, and each one holds
// a socket for the full timeout.
const FAIL_BACKOFF_MS = 60 * 1000;
const CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=3600";
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));

const REQUEST_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  accept: "application/json,text/plain,*/*;q=0.8",
};

// Mirrors catalogitems() in public/assets/data/games.js: an array, {games: []},
// or one object keyed by id. Keeping the two in step matters, or a provider
// whose shape the client understands gets rejected here and the whole source
// disappears behind a generic 502.
export function iscatalogpayload(data) {
  if (Array.isArray(data)) return true;
  if (data && Array.isArray(data.games)) return true;
  if (!data || typeof data !== "object") return false;
  const keys = Object.keys(data);
  return (
    keys.length > 0 &&
    keys.every((key) => {
      const value = data[key];
      return (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value.title || value.name || value.label)
      );
    })
  );
}

async function downloadCatalog(raw) {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let target = raw;
  for (let hop = 0; hop <= 3; hop++) {
    const resolved = await resolvePublicUrl(target);
    const response = await new Promise((resolve, reject) => {
      const transport = resolved.url.protocol === "https:" ? https : http;
      const request = transport.get(
        resolved.url,
        {
          lookup: pinnedLookup(resolved.addresses),
          signal,
          headers: REQUEST_HEADERS,
        },
        resolve,
      );
      request.on("error", reject);
    });
    if (
      response.statusCode >= 300 &&
      response.statusCode < 400 &&
      response.headers.location
    ) {
      target = new URL(response.headers.location, resolved.url).href;
      response.destroy();
      continue;
    }
    try {
      if (response.statusCode !== 200)
        throw new Error(`catalog returned ${response.statusCode}`);
      if (Number(response.headers["content-length"]) > MAX_BYTES)
        throw new Error("catalog exceeds the size limit");
      const chunks = [];
      let size = 0;
      for await (const chunk of response) {
        size += chunk.length;
        if (size > MAX_BYTES) throw new Error("catalog exceeds the size limit");
        chunks.push(chunk);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!iscatalogpayload(data)) throw new Error("unexpected catalog format");
      return data;
    } finally {
      response.destroy();
    }
  }
  throw new Error("too many catalog redirects");
}

// Saved snapshots never leave the disk, so there is no backoff or refresh:
// the file only changes when a new one is committed and the app restarts.
const savedcache = new Map();

async function loadsavedcatalog(name, file) {
  if (savedcache.has(name)) return savedcache.get(name);
  const text = await readFile(join(PUBLIC_DIR, file), "utf8");
  const data = JSON.parse(text);
  if (!iscatalogpayload(data)) throw new Error("unexpected catalog format");
  savedcache.set(name, data);
  return data;
}

export function registerGameCatalogs(fastify) {
  // source name -> { data, fetchedAt, failedAt, pending }
  const cache = new Map();

  function backingoff(entry) {
    return !!entry.failedAt && Date.now() - entry.failedAt < FAIL_BACKOFF_MS;
  }

  function refresh(name, entry) {
    if (entry.pending) return entry.pending;
    entry.pending = downloadCatalog(CATALOGS.get(name).url)
      .then((data) => {
        entry.data = data;
        entry.fetchedAt = Date.now();
        entry.failedAt = 0;
        return data;
      })
      .catch((error) => {
        entry.failedAt = Date.now();
        throw error;
      })
      .finally(() => {
        entry.pending = null;
      });
    return entry.pending;
  }

  function send(reply, data) {
    return reply
      .header("Cache-Control", CACHE_CONTROL)
      .header("X-Content-Type-Options", "nosniff")
      .type("application/json; charset=utf-8")
      .send(data);
  }

  fastify.get("/api/games/catalog/:source", async (req, reply) => {
    const name = String(req.params.source || "");
    const source = CATALOGS.get(name);
    if (!source)
      return reply.code(404).send({ ok: false, error: "Unknown catalog." });

    if (source.file) {
      try {
        return send(reply, await loadsavedcatalog(name, source.file));
      } catch (error) {
        console.warn(
          `[game-catalogs] ${name} saved catalog failed: ${String((error && error.message) || error)}`,
        );
        return reply
          .code(502)
          .send({ ok: false, error: "Catalog could not be loaded." });
      }
    }

    let entry = cache.get(name);
    if (!entry) {
      entry = { data: null, fetchedAt: 0, failedAt: 0, pending: null };
      cache.set(name, entry);
    }

    if (entry.data) {
      if (Date.now() - entry.fetchedAt > FRESH_MS && !backingoff(entry))
        refresh(name, entry).catch((error) => {
          console.warn(
            `[game-catalogs] ${name} refresh failed: ${String((error && error.message) || error)}`,
          );
        });
      return send(reply, entry.data);
    }

    if (backingoff(entry))
      return reply
        .code(502)
        .send({ ok: false, error: "Catalog could not be loaded." });

    try {
      return send(reply, await refresh(name, entry));
    } catch (error) {
      console.warn(
        `[game-catalogs] ${name} failed: ${String((error && error.message) || error)}`,
      );
      return reply
        .code(502)
        .send({ ok: false, error: "Catalog could not be loaded." });
    }
  });
}

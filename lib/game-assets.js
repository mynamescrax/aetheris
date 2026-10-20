// Same-origin delivery, allowlisted-mirror upstreams only. Never cache CDN
// error bodies as game data: GitHub rate-limit text has been served by CDNs
// with HTTP 200.
import { Readable, Transform } from "node:stream";
import { createHash, randomBytes } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mkdirSync,
  statSync,
  renameSync,
  unlinkSync,
  readdirSync,
  createReadStream,
  createWriteStream,
  writeFileSync,
  readFileSync,
} from "node:fs";

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

// The relay answers opaque URLs as well: /s/<token>/<file>. The token is
// base64url of "<mirror>:<directory>", so a page never has to show the CDN
// layout it pulls from ("/game-assets/m/jsdelivr/gh/user/repo@ref/file.js").
// The token is derived from the path instead of being stored, so the same file
// keeps the same token across restarts and cached pages keep working.
export const TOKEN_PREFIX = "/s/";

export function assetToken(mirror, dir) {
  return Buffer.from(`${mirror}:${dir}`, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function parseAssetToken(token) {
  if (typeof token !== "string" || !token || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  const payload = Buffer.from(
    token.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  ).toString("utf8");
  const colon = payload.indexOf(":");
  if (colon <= 0) return null;
  const mirror = payload.slice(0, colon);
  const dir = payload.slice(colon + 1);
  if (!MIRRORS[mirror]) return null;
  if (!dir || decodeAssetPath(dir) === null) return null;
  // Only the canonical spelling is accepted, so one token can never stand
  // for two different paths.
  if (assetToken(mirror, dir) !== token) return null;
  return { mirror, dir };
}

// The opaque form of a relay path: the directory travels in the token and the
// file name stays readable, the way a file host serves it.
export function opaqueAssetUrl(mirror, path) {
  if (!MIRRORS[mirror] || typeof path !== "string") return null;
  const slash = path.lastIndexOf("/");
  if (slash <= 0) return null;
  const dir = path.slice(0, slash);
  const file = path.slice(slash + 1);
  return `${TOKEN_PREFIX}${assetToken(mirror, dir)}/${file}`;
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

// A stalled upstream is cut loose after this long without a single byte and
// the transfer continues on the next mirror. 45s used to leave the visitor
// staring at a frozen progress bar; 20s is still generous for a slow but
// steady link, which resets the timer on every chunk.
const STALL_MS = Math.max(5000, Number(process.env.GAME_ASSET_STALL_MS) || 20000);

// A big build (a 30MB Unity wasm) was never cached: it is streamed, and the
// memory cache only keeps bodies that fit in the buffer limit. So every
// visitor pulled the same build through the VPS again. Streamed bodies are
// written to disk instead and served from there next time, which costs no
// upstream bandwidth at all.
const DISK_CACHE_DIR =
  process.env.GAME_ASSET_CACHE_DIR ||
  join(process.cwd(), "cache", "game-assets");
// The cached builds are private: they must never land inside the directory
// that is served as static files.
const PUBLIC_DIR = resolve(
  fileURLToPath(new URL("../public/", import.meta.url)),
);
const DISK_CACHE_MAX_BYTES = Math.max(
  0,
  (Number(process.env.GAME_ASSET_DISK_CACHE_MB) || 4096) * 1024 * 1024,
);
const DISK_CACHE_TTL_MS = Math.max(
  60_000,
  (Number(process.env.GAME_ASSET_DISK_CACHE_MIN) || 1440) * 60_000,
);

// A path that pins a commit never changes, so the browser may keep it for a
// year instead of re-pulling tens of megabytes every five minutes. A path on
// a moving ref (@main) keeps the short life it had.
const PINNED_REF = /@[0-9a-f]{40}(?:\/|$)/;

export function assetCacheControl(path) {
  return PINNED_REF.test(String(path || ""))
    ? "public, max-age=31536000, immutable"
    : "public, max-age=300";
}

// A build that is still being pulled may end short. It keeps the short life
// so a broken copy cannot sit in a browser cache for a year.
const STREAMED_CACHE_CONTROL = "public, max-age=300";

// --- disk cache for the builds that are too big to keep in memory ---

// The cache lives in its own directory so a build can be served straight from
// disk: it is already on the box, so the visitor waits for a file read and
// not for a download through the VPS.
function creatediskcache(dir, maxBytes = DISK_CACHE_MAX_BYTES, ttlMs = DISK_CACHE_TTL_MS) {
  let ready = false;
  const paths = (key) => {
    const hash = createHash("sha256").update(String(key)).digest("hex");
    return {
      data: join(dir, hash + ".bin"),
      meta: join(dir, hash + ".json"),
    };
  };
  const ensure = () => {
    if (ready) return true;
    ready = true;
    const target = resolve(dir);
    if (target === PUBLIC_DIR || target.startsWith(PUBLIC_DIR + sep)) {
      console.warn(
        `[game-assets] refusing to cache builds in the served directory: ${target}`,
      );
      return false;
    }
    try {
      mkdirSync(dir, { recursive: true });
      return true;
    } catch {
      return false;
    }
  };
  const drop = (key) => {
    const target = paths(key);
    try {
      unlinkSync(target.data);
    } catch {
      /* already gone */
    }
    try {
      unlinkSync(target.meta);
    } catch {
      /* already gone */
    }
  };
  // A cached build is returned with its size, its content type and the path on
  // disk. Anything unreadable is treated as a miss and the file is dropped.
  const get = (key) => {
    if (!ensure()) return null;
    const target = paths(key);
    try {
      const stat = statSync(target.data);
      if (!stat.isFile() || stat.size === 0) return null;
      if (Date.now() - stat.mtimeMs > ttlMs) {
        drop(key);
        return null;
      }
      const meta = JSON.parse(readFileSync(target.meta, "utf8"));
      return {
        path: target.data,
        size: stat.size,
        type:
          typeof meta?.type === "string"
            ? meta.type
            : "application/octet-stream",
        cacheControl:
          typeof meta?.cacheControl === "string"
            ? meta.cacheControl
            : "public, max-age=300",
        mtime: stat.mtimeMs,
      };
    } catch {
      return null;
    }
  };
  // Half-written builds from a crash or a restart are never usable, and they
  // are not in the budget either. They are swept once, when the cache is
  // opened.
  const sweep = () => {
    if (!ensure()) return;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const name of entries) {
      if (!name.endsWith(".tmp")) continue;
      const target = join(dir, name);
      try {
        if (statSync(target).mtimeMs > cutoff) continue;
        unlinkSync(target);
      } catch {
        /* already gone */
      }
    }
  };
  // Keeps the cache inside its budget: the oldest files go first. Walking the
  // whole directory on every write is wasteful, so it runs at most once a
  // minute.
  let lastTrim = 0;
  const trim = () => {
    if (!maxBytes) return;
    const now = Date.now();
    if (now - lastTrim < 60_000) return;
    lastTrim = now;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    let total = 0;
    const files = [];
    for (const name of entries) {
      if (!name.endsWith(".bin")) continue;
      try {
        const stat = statSync(join(dir, name));
        total += stat.size;
        files.push({ name, size: stat.size, mtime: stat.mtimeMs });
      } catch {
        /* the file vanished while we looked at it */
      }
    }
    if (total <= maxBytes) return;
    files.sort((a, b) => a.mtime - b.mtime);
    for (const file of files) {
      if (total <= maxBytes) break;
      try {
        unlinkSync(join(dir, file.name));
        unlinkSync(join(dir, file.name.replace(/\.bin$/, ".json")));
      } catch {
        /* already gone */
      }
      total -= file.size;
    }
  };
  return { paths, get, drop, trim, ensure, sweep };
}


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

export function registerGameAssets(app, { fetchimpl = fetch, timeoutMs = 20000, stallMs = STALL_MS, maxCacheBytes = MAX_CACHE_BYTES, cacheDir = DISK_CACHE_DIR } = {}) {
  const diskcache = creatediskcache(cacheDir);
  diskcache.sweep();
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

  // Opens one upstream body. `start` asks for the bytes after the ones a
  // previous mirror already delivered: an upstream that honours the Range
  // header answers 206 and the body starts exactly there, an upstream that
  // ignores it answers 200 with the whole file and the first `start` bytes
  // have to be dropped.
  async function openUpstream(upstreamUrl, validatePath, start = 0) {
    const guard = stallguard();
    const headers = { ...UPSTREAM_HEADERS };
    if (start > 0) headers.range = `bytes=${start}-`;
    let response;
    try {
      response = await fetchimpl(upstreamUrl, {
        signal: guard.signal,
        redirect: "error",
        headers,
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
    return {
      iterator: response.body[Symbol.asyncIterator](),
      guard,
      declared,
      // The length we may hand to the visitor. A body that came back
      // compressed was decoded on the way in, so its content-length describes
      // the compressed bytes and says nothing about what we send. An
      // uncompressed body is the file itself, and its length is exact - the
      // Unity loader needs it to show a progress bar at all.
      length: response.headers.get("content-encoding") ? null : declared,
      // A 206 means the upstream honoured the range. A 200 means it sent the
      // whole file again.
      partial: response.status === 206,
      type: contentType(validatePath, response),
    };
  }

  // Fetch one upstream URL with size caps and body validation shared by all
  // routes. Upstream hosts are fixed constants above: visitor input only ever
  // selects a path, never a host.
  //
  // Returns { data, type } when the asset fits in memory, or { stream, type }
  // when it should be piped straight to the client.
  async function fetchAsset(upstreamUrl, validatePath, release) {
    const opened = await openUpstream(upstreamUrl, validatePath, 0);
    const { declared, iterator, guard, type, length } = opened;
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
    return { stream: { chunks, iterator, guard, type, length }, type };
  }

  // Continues a transfer that turned out to be too big to keep in memory.
  //
  // A jsDelivr edge that stops sending halfway used to end the whole request:
  // the visitor waited for the stall guard, got a truncated file and reloaded.
  // Now the bytes already sent stay with the visitor and the next mirror is
  // asked for the rest with a Range header, so the file still arrives whole.
  async function* continueOnNextMirror(upstreams, validatePath, state, from) {
    let sent = 0;
    for (const chunk of state.chunks) {
      sent += chunk.length;
      yield chunk;
    }
    // The mirror that started the transfer finishes it. When it stops
    // halfway, the next mirror is asked for the bytes the visitor is missing.
    let index = from;
    let iterator = state.iterator;
    let guard = state.guard;
    // A mirror that ignored the range sent the whole file again, so the bytes
    // the visitor already has are dropped.
    let skip = 0;
    let lastError = null;
    while (index < upstreams.length) {
      try {
        for (;;) {
          const next = await iterator.next();
          if (next.done) {
            guard.clear();
            await iterator.return?.().catch(() => {});
            return;
          }
          const chunk = Buffer.from(next.value);
          if (skip > 0) {
            const drop = Math.min(skip, chunk.length);
            skip -= drop;
            if (drop === chunk.length) {
              guard.reset();
              continue;
            }
            const rest = chunk.subarray(drop);
            sent += rest.length;
            yield rest;
          } else {
            sent += chunk.length;
            yield chunk;
          }
          guard.reset();
        }
      } catch (error) {
        guard.clear();
        await iterator.return?.().catch(() => {});
        lastError = error;
        index++;
        if (index >= upstreams.length) throw lastError;
        // Ask the next mirror for the bytes the visitor is still missing.
        let opened = null;
        while (index < upstreams.length) {
          try {
            opened = await openUpstream(upstreams[index], validatePath, sent);
            break;
          } catch (error) {
            lastError = error;
            index++;
          }
        }
        if (!opened) throw lastError;
        iterator = opened.iterator;
        guard = opened.guard;
        skip = opened.partial ? 0 : sent;
      }
    }
    throw lastError || new Error("every mirror stopped mid-transfer");
  }

  // Try the same path across a mirror's ordered upstream list until one returns
  // valid data. Single-upstream mirrors simply have a one-entry list, so every
  // mirror flows through the same mechanism. URLs are fully formed by callers.
  async function fetchAny(upstreams, path, release, key) {
    let lastError;
    for (let i = 0; i < upstreams.length; i++) {
      try {
        const asset = await fetchAsset(upstreams[i], path, release);
        // The upstream URL says whether the file is pinned: a commit hash never
        // changes, a branch can. A pinned build may sit in the browser for a
        // year instead of being pulled again every five minutes.
        const cacheControl = assetCacheControl(upstreams[i]);
        if (!asset.stream) return { ...asset, cacheControl };
        // Too big for memory: the visitor gets the stream, and the rest of
        // the mirror list is kept in case this one stops halfway.
        const stream = Readable.from(
          continueOnNextMirror(upstreams, path, asset.stream, i),
        );
        return {
          stream: cacheToDisk(key, stream, asset.type, cacheControl),
          type: asset.type,
          // A body that is still on its way may be cut short. It may not sit in
          // the browser for a year: a half-written build would be stuck there
          // and the game could never load again. The copy on disk is complete
          // and checked, and that one is served with the long life.
          cacheControl: STREAMED_CACHE_CONTROL,
          // The size of the file, when the upstream told the truth. The
          // visitor gets it as Content-Length: the Unity loader refuses to
          // show any progress without it.
          length: asset.stream.length,
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  // Writes a streamed build to the disk cache while it goes to the visitor.
  // The file is written under a temp name and renamed when the body is
  // complete, so a half-finished transfer never becomes a cache entry.
  function cacheToDisk(key, source, type, cacheControl) {
    if (!key || !diskcache.ensure()) return source;
    const paths = diskcache.paths(key);
    // Every download gets its own temp file: a second visitor that asks for
    // the same build while the first one is still streaming it starts its own
    // transfer, and two writers on one file would race for the rename.
    const tmp = `${paths.data}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    let written = 0;
    let complete = false;
    const drop = () => {
      try {
        unlinkSync(tmp);
      } catch {
        /* already gone */
      }
    };
    const file = createWriteStream(tmp);
    // A real tee: the chunk is copied into the file and passed on, so the
    // visitor and the cache both see every byte.
    const tee = new Transform({
      transform(chunk, _encoding, done) {
        written += chunk.length;
        if (file.write(chunk)) done(null, chunk);
        else file.once("drain", () => done(null, chunk));
      },
      final(done) {
        complete = true;
        file.end();
        done();
      },
    });
    source.on("error", (error) => {
      complete = false;
      file.destroy();
      drop();
      tee.destroy(error);
    });
    // The visitor may walk away mid-build. The stream then ends without an
    // "end" of its own, and the half-written file must not stay behind: it is
    // never a cache entry and it would eat the disk budget.
    let ended = false;
    source.on("end", () => {
      ended = true;
    });
    source.on("close", () => {
      if (ended) return;
      complete = false;
      file.destroy();
      drop();
    });
    file.on("finish", () => {
      if (!complete) { drop(); return; }
      try {
        renameSync(tmp, paths.data);
        writeFileSync(
          paths.meta,
          JSON.stringify({ type, size: written, cacheControl }),
        );
        diskcache.trim();
      } catch {
        drop();
      }
    });
    file.on("error", drop);
    source.pipe(tee);
    return tee;
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
    // A build that is already on disk needs no upstream at all.
    const disk = diskcache.get(key);
    if (disk) return { disk };
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

  // Redirected cors-mode fetches stay CORS-checked across the whole chain,
  // so echo the origin (public static files only; upstream cookies are
  // never forwarded or stored). The service worker redirects a CDN request
  // to this relay, which makes the browser send "Origin: null"; that is
  // echoed too. Every response path needs this, the disk one included.
  function sendCors(req, reply) {
    if (req.headers.origin) {
      reply.header("Access-Control-Allow-Origin", req.headers.origin);
      reply.header("Vary", "Origin");
    }
  }

  function sendHeaders(req, reply, asset, cacheControl) {
    sendCors(req, reply);
    // Native fetch decoded any HTTP compression. Do not forward upstream
    // Content-Encoding/Length, Set-Cookie, redirects or cache-error headers.
    return reply
      .type(asset.type)
      .header(
        "Cache-Control",
        cacheControl || asset.cacheControl || "public, max-age=300",
      );
  }

  // "bytes=100-200", "bytes=100-" and "bytes=-200" are the forms a client
  // sends. A range that starts past the end of the file is a 416; anything
  // unparseable is ignored and the whole file is sent.
  function parseRange(header, size) {
    if (typeof header !== "string" || !header) return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match) return null;
    const rawstart = match[1];
    const rawend = match[2];
    if (rawstart === "" && rawend === "") return null;
    let start;
    let end;
    if (rawstart === "") {
      const length = Number(rawend);
      if (!Number.isFinite(length) || length <= 0) return null;
      start = Math.max(0, size - length);
      end = size - 1;
    } else {
      start = Number(rawstart);
      end = rawend === "" ? size - 1 : Number(rawend);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (start > end || start >= size) return "invalid";
    if (end >= size) end = size - 1;
    return { start, end };
  }

  // A build that is already on disk. The visitor may ask for a slice of it:
  // a loader that lost its connection resumes exactly where it stopped
  // instead of pulling the whole build again.
  function sendDiskAsset(req, reply, entry) {
    sendCors(req, reply);
    reply
      .type(entry.type)
      .header(
        "Cache-Control",
        entry.cacheControl || "public, max-age=300",
      );
    reply.header("Accept-Ranges", "bytes");
    const range = parseRange(req.headers.range, entry.size);
    if (range === "invalid") {
      return reply
        .code(416)
        .header("Content-Range", `bytes */${entry.size}`)
        .send();
    }
    if (range) {
      reply.code(206);
      reply.header("Content-Range", `bytes ${range.start}-${range.end}/${entry.size}`);
      reply.header("Content-Length", range.end - range.start + 1);
      return reply.send(
        createReadStream(entry.path, { start: range.start, end: range.end }),
      );
    }
    reply.header("Content-Length", entry.size);
    return reply.send(createReadStream(entry.path));
  }

  function sendAsset(req, reply, asset) {
    if (asset.disk) return sendDiskAsset(req, reply, asset.disk);
    sendHeaders(req, reply, asset);
    // A streamed body is chunked by default. When the upstream was not
    // compressed its length is the length of the file, and it is handed over:
    // the Unity loader warns "Response is served without Content-Length header"
    // and shows a progress bar that never moves without it. A length we cannot
    // trust is never sent, because a wrong one truncates the build.
    if (asset.stream) {
      if (asset.length) reply.header("Content-Length", asset.length);
      return reply.send(asset.stream);
    }
    return reply.header("Content-Length", asset.data.length).send(asset.data);
  }

  function sendHead(req, reply, meta, cacheControl) {
    // Fastify's auto-generated HEAD route rewrites the payload length, so write
    // the probe response directly: the visitor gets the real size and we never
    // touch the body.
    reply.hijack();
    const headers = {
      "content-type": meta.type,
      "cache-control": cacheControl || "public, max-age=300",
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
  // The pinned revision comes first: it never changes. @main is the fallback
  // for when jsDelivr cannot retrieve the cold commit URL from GitHub.
  function ripsUpstreams(path) {
    return [
      `https://cdn.jsdelivr.net/gh/mynamescrax/1games-rips@${GAME_ASSET_REVISION}/${path}`,
      `https://cdn.jsdelivr.net/gh/mynamescrax/1games-rips@main/${path}`,
    ];
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
    const key = `rips:${path}`;
    try {
      if (req.method === "HEAD") {
        return sendHead(req, reply, await serveHead(`h:${key}`, () => withSlot(() =>
          fetchHeadAny(ripsUpstreams(path), decoded))), "public, max-age=31536000, immutable");
      }
      return sendAsset(req, reply, await serveCached(key, (release) =>
        fetchAny(ripsUpstreams(path), decoded, release, key)));
    } catch (error) {
      return sendRelayError(reply, path, error, "game CDN asset failed validation");
    }
  });

  // Opaque relay URLs: /s/<token>/<file>
  // The token carries the mirror and the directory, the URL carries the file
  // inside it. Same upstreams, same validation, same cache as the plain
  // relay path - only the shape of the URL differs.
  app.get(`${TOKEN_PREFIX}*`, async (req, reply) => {
    const raw = rawTarget(req);
    const rest = raw.startsWith(TOKEN_PREFIX) ? raw.slice(TOKEN_PREFIX.length) : "";
    const slash = rest.indexOf("/");
    const token = slash === -1 ? rest : rest.slice(0, slash);
    const subpath = slash === -1 ? "" : rest.slice(slash + 1);
    const parsed = parseAssetToken(token);
    const decoded = parsed ? decodeAssetPath(subpath) : null;
    observe(req, reply, `s/${rest}`);
    if (!parsed || decoded === null) {
      return reply.code(400).header("Cache-Control", "no-store").send("Invalid game asset path");
    }
    const dirdecoded = decodeAssetPath(parsed.dir);
    const upstream = subpath ? `${parsed.dir}/${subpath}` : parsed.dir;
    const decodedpath = subpath ? `${dirdecoded}/${decoded}` : dirdecoded;
    const key = `s:${token}/${subpath}`;
    try {
      if (req.method === "HEAD") {
        return sendHead(req, reply, await serveHead(`h:${key}`, () => withSlot(() =>
          fetchHeadAny(mirrorUpstreams(parsed.mirror, upstream), decodedpath))),
          assetCacheControl(upstream));
      }
      return sendAsset(req, reply, await serveCached(key, (release) =>
        fetchAny(mirrorUpstreams(parsed.mirror, upstream), decodedpath, release, key)));
    } catch (error) {
      return sendRelayError(reply, key, error, "mirror CDN asset failed validation");
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
          fetchHeadAny(mirrorUpstreams(mirror, subpath), decoded))),
          assetCacheControl(subpath));
      }
      return sendAsset(req, reply, await serveCached(key, (release) =>
        fetchAny(mirrorUpstreams(mirror, subpath), decoded, release, key)));
    } catch (error) {
      return sendRelayError(reply, key, error, "mirror CDN asset failed validation");
    }
  });
}

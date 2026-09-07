import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import zlib from "node:zlib";
import { pipeline } from "node:stream";
import { resolvePublicUrl, pinnedLookup } from "./lib/public-network.js";

const MAX_REDIRECTS = 5;
const PROXY_ROUTE = "/movie-proxy";
const MAX_TEXT_BYTES = 16 * 1024 * 1024;

const BLOCKED_DOMAINS = new Set([
  "adexchangerapid.com",
  "usrpubtrk.com",
  "histats.com",
  "s10.histats.com",
]);

function decodeEntities(str) {
  if (!str) return str;
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function unwrapProxyUrl(rawUrl) {
  let current = decodeEntities(rawUrl ? rawUrl.trim() : "");
  while (current.includes("/movie-proxy?url=")) {
    try {
      const dummyUrl = new URL(current, "http://127.0.0.1");
      const innerParam = dummyUrl.searchParams.get("url");
      if (innerParam) {
        current = decodeEntities(innerParam.trim());
      } else {
        break;
      }
    } catch {
      break;
    }
  }
  return current;
}

const HAS_ZSTD = typeof zlib.zstdDecompressSync === "function";

// Never offer upstream an encoding we cannot decode: otherwise it replies
// with those bytes, decompressBuffer returns them raw, and we serve
// compressed binary as text/html (browser renders it as garbage text).
function normalizeAcceptEncoding(incoming) {
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

function decompressBuffer(buffer, encoding) {
  if (!encoding) return buffer;
  for (const enc of encoding
    .toLowerCase()
    .split(",")
    .map((v) => v.trim())
    .reverse()) {
    const options = { maxOutputLength: MAX_TEXT_BYTES };
    if (enc === "gzip") buffer = zlib.gunzipSync(buffer, options);
    else if (enc === "br") buffer = zlib.brotliDecompressSync(buffer, options);
    else if (enc === "deflate") buffer = zlib.inflateSync(buffer, options);
    else if (enc === "zstd" && HAS_ZSTD)
      buffer = zlib.zstdDecompressSync(buffer, options);
    else if (enc !== "identity")
      throw new Error("Unsupported upstream encoding.");
  }
  return buffer;
}

function isRealHtml(text) {
  if (!text || typeof text !== "string") return false;
  const snippet = text.slice(0, 500).toLowerCase();
  return (
    snippet.includes("<!doctype html") ||
    snippet.includes("<html") ||
    snippet.includes("<head") ||
    snippet.includes("<body")
  );
}

function rewriteHtml(html, targetUrl, proxyOrigin) {
  const baseUrl = new URL(unwrapProxyUrl(targetUrl.href));
  const origin = baseUrl.origin;
  const href = baseUrl.href;

  // Remove anti-devtools scripts & top checks, enable autoStart for VidSrc players
  let cleaned = html.replace(
    /<script[^>]*disable-devtool[^>]*>[\s\S]*?<\/script>/gi,
    "",
  );
  cleaned = cleaned.replace(
    /if\s*\(\s*window\s*===\s*window\.top\s*\)[\s\S]*?\}/gi,
    "/* removed top check */",
  );
  cleaned = cleaned.replace(/"autoStart"\s*:\s*false/g, '"autoStart":true');

  const rewriteAttr = (match, attr, quote, val) => {
    if (!val) return match;
    const decoded = unwrapProxyUrl(val);
    if (
      decoded.startsWith("data:") ||
      decoded.startsWith("blob:") ||
      decoded.startsWith("javascript:") ||
      decoded === "about:blank" ||
      decoded.startsWith(PROXY_ROUTE) ||
      decoded.startsWith("#") ||
      decoded.startsWith("/js/movie-proxy-client.js")
    ) {
      return match;
    }

    try {
      const abs = new URL(decoded, href).href;
      // The subtitle picker uses this value as a prefix and appends a
      // country code (for example, `us.png`) at runtime. Proxying the
      // prefix first puts that suffix after our `referer` query parameter
      // and produces malformed requests such as `autoplay=trueus.png`.
      if (abs.startsWith("https://flagcdn.com/w40/")) return match;
      // Use an absolute URL because some players prepend their own CDN base
      // to iframe attributes. A root-relative proxy path can otherwise become
      // https://provider.example/e//movie-proxy?... and bypass this relay.
      const proxied = `${proxyOrigin}${PROXY_ROUTE}?url=${encodeURIComponent(abs)}&referer=${encodeURIComponent(href)}`;
      return `${attr}=${quote}${proxied}${quote}`;
    } catch {
      return match;
    }
  };

  cleaned = cleaned.replace(
    /\b(src|href|data-src|data-api)=(["'])([^"']+)\2/gi,
    rewriteAttr,
  );

  const scriptTag = `<script>window.__MOVIE_PROXY_TARGET__=${JSON.stringify(href).replace(/</g, "\\u003c")};window.__MOVIE_PROXY_ORIGIN__=${JSON.stringify(origin).replace(/</g, "\\u003c")};</script><script src="/js/movie-proxy-client.js?v=20260907.2"></script>`;

  if (/<head[^>]*>/i.test(cleaned)) {
    cleaned = cleaned.replace(/(<head[^>]*>)/i, `$1\n${scriptTag}`);
  } else {
    cleaned = scriptTag + "\n" + cleaned;
  }

  return cleaned;
}

function rewriteM3u8(playlistText, targetUrl) {
  const baseUrl = new URL(unwrapProxyUrl(targetUrl.href));
  const href = baseUrl.href;
  const lines = playlistText.split("\n");

  const rewritten = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    // URI attributes also occur in MAP (fMP4 init), MEDIA (audio/subtitles),
    // I-FRAME-STREAM-INF, SESSION-KEY and low-latency PART/PRELOAD-HINT.
    if (trimmed.startsWith("#")) {
      return line.replace(/URI=(["'])([^"']+)\1/gi, (match, quote, val) => {
        try {
          const unescapedVal = unwrapProxyUrl(val);
          const abs = new URL(unescapedVal, href).href;
          if (!/^https?:/i.test(abs)) return match;
          const proxied = `${PROXY_ROUTE}?url=${encodeURIComponent(abs)}&referer=${encodeURIComponent(href)}`;
          return `URI=${quote}${proxied}${quote}`;
        } catch {
          return match;
        }
      });
    }

    if (!trimmed.startsWith("#")) {
      try {
        const unescapedLine = unwrapProxyUrl(trimmed);
        const abs = new URL(unescapedLine, href).href;
        return `${PROXY_ROUTE}?url=${encodeURIComponent(abs)}&referer=${encodeURIComponent(href)}`;
      } catch {
        return line;
      }
    }

    return line;
  });

  return rewritten.join("\n");
}

function rewriteCss(cssText, targetUrl) {
  const baseUrl = new URL(unwrapProxyUrl(targetUrl.href));
  const href = baseUrl.href;
  return cssText.replace(/url\((["']?)([^"']+?)\1\)/gi, (match, quote, url) => {
    const trimmed = url.trim();
    if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("blob:"))
      return match;
    try {
      const abs = new URL(unwrapProxyUrl(trimmed), href).href;
      const proxied = `${PROXY_ROUTE}?url=${encodeURIComponent(abs)}&referer=${encodeURIComponent(href)}`;
      return `url(${quote}${proxied}${quote})`;
    } catch {
      return match;
    }
  });
}

function rewriteJsImports(jsText, targetUrl) {
  const baseUrl = new URL(unwrapProxyUrl(targetUrl.href));
  const href = baseUrl.href;
  const srcUrl = targetUrl.href;

  // Vite 5 bundles keep their chunk table in m.f=[...] (the raw chunk paths,
  // e.g. "assets/vendor-x.js"), which dynamic import(__vite__mapDeps[N])
  // feeds to the module loader. Left relative they resolve against the proxy
  // document base instead of the upstream origin, so those chunk loads 404 /
  // NS_ERROR_CORRUPTED_CONTENT. Rewrite each chunk path to an absolute
  // proxied URL so the dynamic import goes back through us.
  const mapDepsPattern = /m\.f=(\(?)(\[[^;]*?\])(\)?)/g;
  let out = jsText.replace(
    mapDepsPattern,
    (whole, parenOpen, arr, parenClose) => {
      const rew = arr.replace(
        /"(?:\.\.?\/|\/)?(assets\/[^"']+\.(?:js|mjs|css|ts))"|'(?:\.\.?\/|\/)?(assets\/[^"']+\.(?:js|mjs|css|ts))'/g,
        (m, d1, d2) => {
          const p = (d1 || d2).replace(/^\.\.?\//, "");
          try {
            const abs = new URL(p, `${baseUrl.origin}/`).href;
            return JSON.stringify(
              `${PROXY_ROUTE}?url=${encodeURIComponent(abs)}&referer=${encodeURIComponent(srcUrl)}`,
            );
          } catch {
            return m;
          }
        },
      );
      return `m.f=${parenOpen}${rew}${parenClose}`;
    },
  );

  // NOTE: no early return here — a bundle can contain BOTH the m.f chunk
  // table AND relative import() calls (e.g. Vite's
  // `j(()=>import("./Homepage-x.js"),__vite__mapDeps([...]))`). Rewriting
  // only the table leaves the imports resolving against /movie-proxy
  // (whose path merges to /<chunk>.js) so every lazy chunk 404s as HTML
  // and Firefox reports NS_ERROR_CORRUPTED_CONTENT. Rewrite both.
  out = out.replace(
    /(from\s*["']|import\s*["']|import\(\s*["'])(\.\.?\/[^"']+|\/assets\/[^"']+)(["'])/g,
    (match, prefix, path, suffix) => {
      try {
        const abs = new URL(path, href).href;
        const proxied = `${PROXY_ROUTE}?url=${encodeURIComponent(abs)}&referer=${encodeURIComponent(href)}`;
        return prefix + proxied + suffix;
      } catch {
        return match;
      }
    },
  );

  // Asset workers: new URL("/assets/wasmPoolWorker-x.ts", import.meta.url)
  // resolves against the proxied document (→ /assets/... 404) instead of
  // the upstream origin once import.meta.url is the /movie-proxy URL.
  out = out.replace(
    /(new\s+URL\(\s*["'])(\.\.?\/[^"']+|\/assets\/[^"']+)(["'])/g,
    (match, prefix, path, suffix) => {
      try {
        const abs = new URL(path, href).href;
        const proxied = `${PROXY_ROUTE}?url=${encodeURIComponent(abs)}&referer=${encodeURIComponent(href)}`;
        return prefix + proxied + suffix;
      } catch {
        return match;
      }
    },
  );

  return out;
}

function rewriteJson(jsonText, targetUrl) {
  const baseUrl = new URL(unwrapProxyUrl(targetUrl.href));
  const href = baseUrl.href;
  try {
    const parsed = JSON.parse(jsonText);
    const rewriteObj = (obj) => {
      if (!obj || typeof obj !== "object") return obj;
      for (const k of Object.keys(obj)) {
        if (typeof obj[k] === "string") {
          const val = obj[k].trim();
          if (
            val.startsWith("http://") ||
            val.startsWith("https://") ||
            val.endsWith(".m3u8") ||
            val.includes("/embed/")
          ) {
            try {
              const abs = new URL(unwrapProxyUrl(val), href).href;
              obj[k] =
                `${PROXY_ROUTE}?url=${encodeURIComponent(abs)}&referer=${encodeURIComponent(href)}`;
            } catch {
              /* Leave non-URL values untouched. */
            }
          }
        } else if (typeof obj[k] === "object") {
          rewriteObj(obj[k]);
        }
      }
      return obj;
    };
    return JSON.stringify(rewriteObj(parsed));
  } catch {
    return jsonText;
  }
}

export function registerMovieRelay(
  server,
  { resolveTarget = resolvePublicUrl } = {},
) {
  // A trusted server-side dependency override supports isolated fixture tests.
  // No request parameter can bypass the default public-network validator.
  async function validateUrl(rawUrl) {
    const resolved = await resolveTarget(unwrapProxyUrl(rawUrl));
    resolved.url.validatedAddresses = resolved.addresses;
    return resolved.url;
  }
  server.register(async function (fastify) {
    // Relay request bodies byte-for-byte, including form and multipart POSTs.
    fastify.removeAllContentTypeParsers();
    fastify.addContentTypeParser(
      "*",
      { parseAs: "buffer", bodyLimit: 8 * 1024 * 1024 },
      (_req, body, done) => done(null, body),
    );
    const handleMovieProxy = async (req, reply) => {
      let rawTarget = req.query.url;
      if (!rawTarget || typeof rawTarget !== "string") {
        reply.code(400).send("Missing url query parameter");
        return;
      }

      rawTarget = unwrapProxyUrl(rawTarget);

      const forwardedProto = req.headers["x-forwarded-proto"];
      const requestedProto = Array.isArray(forwardedProto)
        ? forwardedProto[0]
        : forwardedProto?.split(",")[0];
      const proxyProtocol = requestedProto === "https" ? "https" : req.protocol;
      let proxyOrigin;
      try {
        proxyOrigin = new URL(
          `${proxyProtocol}://${req.headers.host || req.hostname}`,
        ).origin;
      } catch {
        return reply.code(400).send("Invalid request host");
      }

      if (rawTarget === "about:blank") {
        reply
          .code(200)
          .type("text/html")
          .send("<!DOCTYPE html><html><body></body></html>");
        return;
      }

      let customReferer = null;
      if (req.query.referer) {
        try {
          if (typeof req.query.referer !== "string") throw new Error();
          const ref = new URL(unwrapProxyUrl(req.query.referer));
          if (
            !["http:", "https:"].includes(ref.protocol) ||
            ref.username ||
            ref.password
          )
            throw new Error();
          customReferer = ref.href;
        } catch {
          return reply.code(400).send("Invalid referer parameter");
        }
      }

      let currentUrl;
      try {
        currentUrl = await validateUrl(rawTarget);
      } catch (err) {
        reply.code(403).send(`SSRF validation failed: ${err.message}`);
        return;
      }

      if (BLOCKED_DOMAINS.has(currentUrl.hostname.toLowerCase())) {
        reply.code(403).send("Blocked domain");
        return;
      }

      let redirectCount = 0;
      let upstreamRes = null;
      let method = req.method;
      let body = Buffer.isBuffer(req.body) ? req.body : null;
      const abort = new AbortController();
      const abortUpstream = () => {
        if (!reply.raw.writableFinished) abort.abort();
      };
      reply.raw.once("close", abortUpstream);

      while (redirectCount <= MAX_REDIRECTS) {
        if (BLOCKED_DOMAINS.has(currentUrl.hostname.toLowerCase()))
          return reply.code(403).send("Blocked domain");
        const refUrl = customReferer || currentUrl.href;
        const refOrigin = new URL(refUrl).origin;

        const reqHeaders = {
          "user-agent":
            req.headers["user-agent"] ||
            "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/605.1.15",
          accept:
            req.headers.accept ||
            "application/json, text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8",
          "accept-language": req.headers["accept-language"] || "en-US,en;q=0.9",
          "accept-encoding": normalizeAcceptEncoding(
            req.headers["accept-encoding"],
          ),
          referer: refUrl,
          origin: refOrigin,
          "sec-fetch-mode": req.headers["sec-fetch-mode"] || "cors",
          "sec-fetch-site": req.headers["sec-fetch-site"] || "same-origin",
          "sec-fetch-dest": req.headers["sec-fetch-dest"] || "empty",
        };

        if (req.headers.range) {
          reqHeaders.range = req.headers.range;
        }
        if (body && method !== "GET" && method !== "HEAD") {
          reqHeaders["content-type"] =
            req.headers["content-type"] || "application/octet-stream";
          reqHeaders["content-length"] = body.length;
        }

        const transport = currentUrl.protocol === "https:" ? https : http;

        try {
          upstreamRes = await new Promise((resolve, reject) => {
            const request = transport.request(
              currentUrl.href,
              {
                method,
                headers: reqHeaders,
                lookup: pinnedLookup(currentUrl.validatedAddresses),
                signal: AbortSignal.any([
                  abort.signal,
                  AbortSignal.timeout(30000),
                ]),
              },
              (response) => {
                // Cover the gap before a body consumer is attached, and
                // abandoned redirect bodies. Consumers still handle errors.
                response.on("error", () => {});
                resolve(response);
              },
            );
            request.on("error", reject);
            request.setTimeout(15000, () => {
              request.destroy(new Error("Upstream timeout"));
            });
            request.end(
              body && method !== "GET" && method !== "HEAD" ? body : undefined,
            );
          });
        } catch (err) {
          reply.code(502).send(`Upstream request error: ${err.message}`);
          return;
        }

        const status = upstreamRes.statusCode;
        if (status >= 300 && status < 400 && upstreamRes.headers.location) {
          redirectCount++;
          upstreamRes.destroy();
          try {
            const nextUrl = new URL(
              upstreamRes.headers.location,
              currentUrl.href,
            );
            currentUrl = await validateUrl(nextUrl.href);
            if (
              status === 303 ||
              ((status === 301 || status === 302) && method === "POST")
            ) {
              method = "GET";
              body = null;
            }
            continue;
          } catch (err) {
            reply
              .code(403)
              .send(`Redirect target validation failed: ${err.message}`);
            return;
          }
        }

        break;
      }

      if (redirectCount > MAX_REDIRECTS) {
        reply.code(508).send("Too many redirects");
        return;
      }

      reply.code(upstreamRes.statusCode);

      const filterHeaders = [
        "x-frame-options",
        "content-security-policy",
        "content-security-policy-report-only",
        "cross-origin-embedder-policy",
        "cross-origin-opener-policy",
        "cross-origin-resource-policy",
        "transfer-encoding",
        "content-encoding",
        "content-disposition",
        "connection",
        "keep-alive",
        "set-cookie",
        "clear-site-data",
        "service-worker-allowed",
        "refresh",
        "strict-transport-security",
        "etag",
        "content-md5",
      ];

      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        if (!filterHeaders.includes(k.toLowerCase())) {
          reply.header(k, v);
        }
      }

      reply.header("Access-Control-Allow-Origin", "*");
      reply.header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
      reply.header("Access-Control-Allow-Headers", "*");

      const cleanPath = currentUrl.pathname.toLowerCase();
      let forcedMime = null;
      if (cleanPath.endsWith(".css")) forcedMime = "text/css; charset=utf-8";
      else if (cleanPath.endsWith(".js") || cleanPath.endsWith(".mjs"))
        forcedMime = "application/javascript; charset=utf-8";
      else if (cleanPath.endsWith(".woff2")) forcedMime = "font/woff2";
      else if (cleanPath.endsWith(".woff")) forcedMime = "font/woff";
      else if (cleanPath.endsWith(".ttf")) forcedMime = "font/ttf";
      else if (cleanPath.endsWith(".svg")) forcedMime = "image/svg+xml";

      if (forcedMime) {
        reply.type(forcedMime);
        reply.raw.setHeader("Content-Type", forcedMime);
      }

      const contentType = (
        reply.getHeader("content-type") ||
        upstreamRes.headers["content-type"] ||
        ""
      )
        .toString()
        .toLowerCase();
      const isM3u8 =
        contentType.includes("mpegurl") ||
        contentType.includes("m3u8") ||
        cleanPath.endsWith(".m3u8");
      const isHtml = contentType.includes("text/html");
      const isJson =
        contentType.includes("application/json") ||
        contentType.includes("text/json");
      const isJs =
        contentType.includes("javascript") ||
        cleanPath.endsWith(".js") ||
        cleanPath.endsWith(".mjs");
      const isCss =
        contentType.includes("text/css") || cleanPath.endsWith(".css");
      // text/plain is ambiguous: many embeds mislabel m3u8 playlists or JSON
      // source payloads as text/plain. Buffer + content-sniff instead of
      // streaming raw so those get rewritten.
      const isPlain =
        contentType.startsWith("text/plain") &&
        !cleanPath.match(
          /\.(png|jpe?g|gif|webp|avif|ico|mp4|webm|mp3|m4a|ts|aac)$/,
        );

      // Fast path: clearly non-text payloads (video/audio segments, images,
      // fonts, blobs) are streamed raw without buffering so playback stays
      // smooth. text/plain is NOT fast-pathed because it may be a mislabeled
      // m3u8/JSON that needs rewriting.
      if (
        req.method === "HEAD" ||
        upstreamRes.statusCode === 206 ||
        (!isHtml && !isM3u8 && !isJson && !isJs && !isCss && !isPlain)
      ) {
        // reply.header() values are silently dropped after hijack(), so
        // write status + headers to the raw response explicitly. Without
        // this, binary went out with no content-type (browsers sniffed it
        // as text/garbage). content-encoding is preserved so gzipped
        // binary isn't served as garbage; only framing/policy headers and
        // content-disposition (force inline playback) stay stripped.
        reply.hijack();
        const passthrough = {};
        for (const [k, v] of Object.entries(upstreamRes.headers)) {
          const lk = k.toLowerCase();
          if (
            lk === "transfer-encoding" ||
            lk === "connection" ||
            lk === "keep-alive"
          )
            continue;
          if (filterHeaders.includes(lk) && lk !== "content-encoding") continue;
          passthrough[k] = v;
        }
        if (forcedMime) passthrough["content-type"] = forcedMime;
        passthrough["access-control-allow-origin"] = "*";
        passthrough["access-control-allow-methods"] =
          "GET, HEAD, POST, OPTIONS";
        passthrough["access-control-allow-headers"] = "*";
        reply.raw.writeHead(upstreamRes.statusCode, passthrough);
        pipeline(upstreamRes, reply.raw, (error) => {
          if (error && !abort.signal.aborted)
            console.warn("[movie-proxy] stream closed:", error.message);
        });
        return;
      }

      // Text files (HTML, JS, CSS, JSON, M3U8) decompressed & checked
      const chunks = [];
      let decompressed;
      try {
        let size = 0;
        for await (const chunk of upstreamRes) {
          size += chunk.length;
          if (size > MAX_TEXT_BYTES)
            throw new Error("Upstream text response exceeds 16 MB.");
          chunks.push(chunk);
        }
        decompressed = decompressBuffer(
          Buffer.concat(chunks),
          upstreamRes.headers["content-encoding"],
        );
      } catch (error) {
        upstreamRes.destroy();
        reply.removeHeader("content-length");
        reply.removeHeader("content-encoding");
        return reply
          .code(502)
          .type("text/plain")
          .send("Could not decode the provider response: " + error.message);
      }
      reply.removeHeader("content-length");

      // Guard against binary payloads mislabeled as text — some CDNs send
      // media/segments with a text-ish or missing content-type, which would
      // otherwise fall into the rewriters below and render as garbage in the
      // browser. NUL bytes in the probe are a strong binary indicator.
      if (!isHtml && !isM3u8 && decompressed.slice(0, 512).includes(0x00)) {
        return reply.type("application/octet-stream").send(decompressed);
      }

      const rawBody = decompressed.toString("utf-8");

      // For text/plain responses, sniff the body to detect mislabeled m3u8 or
      // JSON source payloads so they get rewritten instead of streamed raw.
      const sniffM3u8 =
        isPlain && /^#EXTM3U|^#EXT-X-/.test(rawBody.trimStart());
      const trimmedStart = rawBody.trimStart();
      const sniffJson =
        isPlain &&
        (trimmedStart.startsWith("{") || trimmedStart.startsWith("["));

      if (isHtml && isRealHtml(rawBody)) {
        const rewritten = rewriteHtml(rawBody, currentUrl, proxyOrigin);
        reply.type("text/html; charset=utf-8");
        reply.raw.setHeader("Content-Type", "text/html; charset=utf-8");
        reply.header("content-length", Buffer.byteLength(rewritten));
        reply.send(rewritten);
      } else if (isHtml) {
        // Upstream says text/html but content didn't match known HTML
        // patterns — still serve as HTML rather than falling through to
        // octet-stream which would trigger a browser download.
        reply.type("text/html; charset=utf-8");
        reply.raw.setHeader("Content-Type", "text/html; charset=utf-8");
        reply.header("content-length", Buffer.byteLength(rawBody));
        reply.send(rawBody);
      } else if (isM3u8 || sniffM3u8) {
        const rewritten = rewriteM3u8(rawBody, currentUrl);
        reply.type("application/vnd.apple.mpegurl");
        reply.raw.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        reply.header("content-length", Buffer.byteLength(rewritten));
        reply.send(rewritten);
      } else if (isJson || sniffJson) {
        const rewritten = rewriteJson(rawBody, currentUrl);
        reply.type("application/json");
        reply.raw.setHeader("Content-Type", "application/json");
        reply.header("content-length", Buffer.byteLength(rewritten));
        reply.send(rewritten);
      } else if (isCss) {
        const rewritten = rewriteCss(rawBody, currentUrl);
        reply.type("text/css; charset=utf-8");
        reply.raw.setHeader("Content-Type", "text/css; charset=utf-8");
        reply.header("content-length", Buffer.byteLength(rewritten));
        reply.send(rewritten);
      } else if (isJs) {
        const rewritten = rewriteJsImports(rawBody, currentUrl);
        reply.type("application/javascript; charset=utf-8");
        reply.raw.setHeader(
          "Content-Type",
          "application/javascript; charset=utf-8",
        );
        reply.header("content-length", Buffer.byteLength(rewritten));
        reply.send(rewritten);
      } else {
        // Fake-named .html video segments or raw binary text
        reply.type("application/octet-stream");
        reply.raw.setHeader("Content-Type", "application/octet-stream");
        reply.send(decompressed);
      }
    };

    fastify.route({
      method: ["GET", "HEAD", "POST"],
      url: PROXY_ROUTE,
      handler: handleMovieProxy,
    });
    fastify.options(PROXY_ROUTE, (_req, reply) =>
      reply
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
        .header("Access-Control-Allow-Headers", "Content-Type, Range, Accept")
        .code(204)
        .send(),
    );

    // Videm's subtitle menu loads its signed subtitle endpoint from a worker.
    // Worker requests are outside the page-level fetch/XHR hooks, so the
    // relative `/api.php?a=sub&ref=...` otherwise lands on Aetheris and 404s.
    // Keep this compatibility route deliberately limited to subtitle requests.
    fastify.get("/api.php", async (req, reply) => {
      if (
        req.query.a !== "sub" ||
        typeof req.query.ref !== "string" ||
        !req.query.ref
      ) {
        return reply.code(404).send("Not found");
      }

      let subtitleUrl;
      try {
        // The first section of Videm's signed ref is a base64url JSON payload
        // containing the actual VTT URL. Calling Videm's API server-side is
        // rejected because its signature is also bound to browser state, while
        // the signed CDN URL itself is intentionally fetchable by the player.
        const encodedPayload = req.query.ref.split(".", 1)[0];
        const payload = JSON.parse(
          Buffer.from(encodedPayload, "base64url").toString("utf8"),
        );
        if (!payload || typeof payload.u !== "string")
          throw new Error("Missing subtitle URL");
        subtitleUrl = payload.u;
      } catch {
        return reply.code(400).send("Invalid subtitle reference");
      }

      req.query = {
        url: subtitleUrl,
        referer: "https://videm.xyz/",
      };
      return handleMovieProxy(req, reply);
    });
  });
}

export {
  rewriteM3u8,
  rewriteHtml,
  rewriteCss,
  rewriteJsImports,
  decompressBuffer,
  unwrapProxyUrl,
};

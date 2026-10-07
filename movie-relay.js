import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { pipeline } from "node:stream";
import { resolvePublicUrl, pinnedLookup } from "./lib/public-network.js";

const MAX_REDIRECTS = 5;
const PROXY_ROUTE = "/movie-proxy";
const MAX_TEXT_BYTES = 16 * 1024 * 1024;
// HTML/CSS is rewritten synchronously, so keep it smaller than JSON/HLS.
const MAX_DOC_BYTES = 4 * 1024 * 1024;
const MAX_SCRIPT_BYTES = 8 * 1024 * 1024;

// Relayed documents may only talk to the relay. The image hosts are allowed
// directly because players set artwork from CSS/JS strings the URL hooks
// can't see.
const RELAY_CSP =
  "default-src 'self' data: blob:; " +
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "connect-src 'self' blob:; " +
  "img-src 'self' data: blob: https://flagcdn.com https://image.tmdb.org; " +
  "media-src 'self' data: blob:; " +
  "font-src 'self' data: https://fonts.gstatic.com; " +
  "frame-src 'self' blob:; " +
  "worker-src 'self' blob:; " +
  "form-action 'self'; " +
  "base-uri https:";

// Routes that fetch and serve third-party content.
const RELAY_ROUTES = [PROXY_ROUTE, "/api.php", "/hls-resolve"];
// Everything a dedicated relay host serves. Anything else there is a 404, so
// the relay origin holds no accounts, tokens or first-party pages.
const RELAY_HOST_PATHS = [
  ...RELAY_ROUTES,
  "/movie-ping",
  "/js/movie-proxy-client.js",
  "/hls-player.html",
  "/js/vendor/hls.min.js",
];

function matchesRoute(path, routes) {
  return routes.some((r) => path === r || path.startsWith(r + "/"));
}

function requestHostname(req) {
  return String(req.headers.host || "")
    .toLowerCase()
    .replace(/:\d+$/, "");
}

// Caddy terminates TLS, so trust its X-Forwarded-Proto for the scheme.
function requestOrigin(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const requestedProto = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : forwardedProto?.split(",")[0];
  const proto = requestedProto === "https" ? "https" : req.protocol;
  return new URL(`${proto}://${req.headers.host || req.hostname}`).origin;
}

const BLOCKED_DOMAINS = new Set([
  "adexchangerapid.com",
  "usrpubtrk.com",
  "histats.com",
  "s10.histats.com",
]);

// 2vcdn.skin's hls4 playlist is a decoy made of TikTok ad images. They
// "play" as black video and never trigger the player's hls4 -> hls3
// fallback, so refuse them and let the fallback fire.
function isDecoyAdImage(raw) {
  let url;
  try {
    url = raw instanceof URL ? raw : new URL(String(raw));
  } catch {
    return false;
  }
  return (
    url.hostname.toLowerCase().endsWith(".tiktokcdn.com") &&
    url.pathname.toLowerCase().includes("/ad-site-i18n")
  );
}

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

// Never offer upstream an encoding we can't decode, or we'd serve the raw
// compressed bytes as text.
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

// Content-Encoding lists codings in the order they were applied.
function encodingsToUndo(encoding) {
  return encoding
    .toLowerCase()
    .split(",")
    .map((v) => v.trim())
    .reverse();
}

function decompressBuffer(buffer, encoding) {
  if (!encoding) return buffer;
  for (const enc of encodingsToUndo(encoding)) {
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

// Async version for the request path, so large bodies don't block the event
// loop. The sync one is kept for tests.
const gunzipAsync = promisify(zlib.gunzip);
const brotliDecompressAsync = promisify(zlib.brotliDecompress);
const inflateAsync = promisify(zlib.inflate);
const zstdDecompressAsync = HAS_ZSTD ? promisify(zlib.zstdDecompress) : null;

async function decompressBufferAsync(
  buffer,
  encoding,
  maxBytes = MAX_TEXT_BYTES,
) {
  if (!encoding) return buffer;
  for (const enc of encodingsToUndo(encoding)) {
    const options = { maxOutputLength: maxBytes };
    if (enc === "gzip") buffer = await gunzipAsync(buffer, options);
    else if (enc === "br") buffer = await brotliDecompressAsync(buffer, options);
    else if (enc === "deflate") buffer = await inflateAsync(buffer, options);
    else if (enc === "zstd" && HAS_ZSTD)
      buffer = await zstdDecompressAsync(buffer, options);
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

  // Drop anti-devtools scripts and top-frame checks; autostart VidSrc players.
  let cleaned = html.replace(
    /<script[^>]*disable-devtool[^>]*>[\s\S]*?<\/script>/gi,
    "",
  );
  cleaned = cleaned.replace(
    /if\s*\(\s*window\s*===\s*window\.top\s*\)[\s\S]*?\}/gi,
    "/* removed top check */",
  );
  cleaned = cleaned.replace(/"autoStart"\s*:\s*false/g, '"autoStart":true');

  // Obsolete Feature-Policy metas only produce Firefox console noise.
  cleaned = cleaned.replace(
    /<meta[^>]*\bhttp-equiv\s*=\s*(["']?)feature-policy\1[^>]*>/gi,
    "",
  );

  // Keep the provider's <base> pointing upstream (Videm ships <base href="/">
  // and resolves api.php against it). It is pulled out here and put back
  // after the src/href rewrite so it never gets proxied.
  let upstreamBaseTag = null;
  const baseTagMatch = cleaned.match(/<base\b[^>]*>/i);
  if (baseTagMatch) {
    const hrefMatch = baseTagMatch[0].match(/\bhref\s*=\s*(["'])(.*?)\1/i);
    const targetMatch = baseTagMatch[0].match(/\btarget\s*=\s*(["'])(.*?)\1/i);
    let resolved = `${origin}/`;
    try {
      const raw = hrefMatch ? decodeEntities(hrefMatch[2].trim()) : "/";
      resolved = new URL(raw || "/", origin).href;
    } catch {
      /* keep the origin-root fallback */
    }
    upstreamBaseTag =
      `<base href="${resolved}"` +
      (targetMatch ? ` target="${targetMatch[2]}"` : "") +
      ">";
    cleaned = cleaned.replace(/<base\b[^>]*>/gi, "");
  }

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
    // mailto:, tel: etc. can't be relayed.
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(decoded);
    if (scheme && !/^https?$/i.test(scheme[1])) return match;

    try {
      const abs = new URL(decoded, href).href;
      // No referer param here: one upstream file must map to exactly one
      // proxy URL (see rewriteJsImports).
      // The subtitle picker appends a country code to this prefix at
      // runtime, so flagcdn stays direct (allowed in RELAY_CSP).
      if (abs.startsWith("https://flagcdn.com/w40/")) return match;
      // Absolute, because some players prepend their CDN base to iframe
      // src values and a root-relative path would escape the relay.
      let proxied;
      const parsed = new URL(abs);
      if (/\/jwplayer\.js$/i.test(parsed.pathname)) {
        // Self-hosted JWPlayer finds its base with
        // src.lastIndexOf("/jwplayer.js") and loads sibling chunks from it,
        // so the literal "/jwplayer.js" must survive after the encoded
        // upstream directory.
        const directory =
          parsed.origin +
          parsed.pathname.slice(0, parsed.pathname.lastIndexOf("/"));
        proxied = `${proxyOrigin}${PROXY_ROUTE}?url=${encodeURIComponent(directory)}/jwplayer.js${parsed.search}`;
      } else {
        proxied = `${proxyOrigin}${PROXY_ROUTE}?url=${encodeURIComponent(abs)}`;
      }
      return `${attr}=${quote}${proxied}${quote}`;
    } catch {
      return match;
    }
  };

  cleaned = cleaned.replace(
    /\b(src|href|data-src|data-api)=(["'])([^"']+)\2/gi,
    rewriteAttr,
  );

  // Posters and backdrops often live in inline CSS.
  cleaned = cleaned.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (match, open, css, close) => open + rewriteCss(css, baseUrl) + close,
  );
  cleaned = cleaned.replace(
    /\bstyle=(["'])([\s\S]*?)\1/gi,
    (match, quote, css) => `style=${quote}${rewriteCss(css, baseUrl)}${quote}`,
  );

  if (upstreamBaseTag) {
    if (/<head[^>]*>/i.test(cleaned)) {
      cleaned = cleaned.replace(/(<head[^>]*>)/i, `$1\n${upstreamBaseTag}`);
    } else {
      cleaned = `${upstreamBaseTag}\n${cleaned}`;
    }
  }

  const scriptTag = `<script>window.__MOVIE_PROXY_TARGET__=${JSON.stringify(href).replace(/</g, "\\u003c")};window.__MOVIE_PROXY_ORIGIN__=${JSON.stringify(origin).replace(/</g, "\\u003c")};</script><script src="/js/movie-proxy-client.js?v=20261007.1"></script>`;

  // Some players (2vcdn.skin) call `$` without loading jQuery, which aborts
  // their boot. Inject full jQuery (they use $.ajax) when the page uses `$(`
  // or `$.` but neither loads nor defines it.
  let jqueryTag = "";
  if (
    !/<script[^>]*jquery[^>]*>/i.test(cleaned) &&
    /\$\s*\(|\$\./.test(cleaned) &&
    !/(var|let|const|function)\s+\$[^a-zA-Z0-9_$]|window\.\$\s*=/.test(cleaned)
  ) {
    const jqueryUrl = `${proxyOrigin}${PROXY_ROUTE}?url=${encodeURIComponent("https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.3/jquery.min.js")}`;
    jqueryTag = `<script src="${jqueryUrl}"></script>`;
  }

  if (/<head[^>]*>/i.test(cleaned)) {
    cleaned = cleaned.replace(
      /(<head[^>]*>)/i,
      `$1\n${scriptTag}\n${jqueryTag}`,
    );
  } else {
    cleaned = scriptTag + "\n" + jqueryTag + "\n" + cleaned;
  }

  // Avoid quirks mode on pages without a doctype. Must stay the last step.
  if (!/^\s*<!doctype/i.test(cleaned)) cleaned = `<!DOCTYPE html>\n${cleaned}`;

  return cleaned;
}

// These media hosts redirect away unless the referer is an embed site.
const TOTALLYACDN_REFERER = "https://cinecat.eu/";
const TNMR_ORG_REFERER = "https://aether.ist/";

function playlistReferer(targetUrl, override) {
  if (override) return override;
  try {
    const host = new URL(unwrapProxyUrl(targetUrl.href)).hostname.toLowerCase();
    if (host === "totallyacdn.org" || host.endsWith(".totallyacdn.org"))
      return TOTALLYACDN_REFERER;
    if (host.endsWith(".tnmr.org")) return TNMR_ORG_REFERER;
  } catch {
    /* fall through to the playlist URL */
  }
  return targetUrl.href;
}

function rewriteM3u8(playlistText, targetUrl, refererOverride) {
  const baseUrl = new URL(unwrapProxyUrl(targetUrl.href));
  const href = baseUrl.href;
  const referer = playlistReferer(targetUrl, refererOverride);
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
          const proxied = `${PROXY_ROUTE}?url=${encodeURIComponent(abs)}&referer=${encodeURIComponent(referer)}`;
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
        return `${PROXY_ROUTE}?url=${encodeURIComponent(abs)}&referer=${encodeURIComponent(referer)}`;
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
  // No referer param, same as rewriteJsImports.
  let rewritten = cssText.replace(
    /url\((["']?)([^"']+?)\1\)/gi,
    (match, quote, url) => {
      const trimmed = url.trim();
      if (
        !trimmed ||
        trimmed.startsWith("data:") ||
        trimmed.startsWith("blob:")
      )
        return match;
      try {
        const abs = new URL(unwrapProxyUrl(trimmed), href).href;
        const proxied = `${PROXY_ROUTE}?url=${encodeURIComponent(abs)}`;
        return `url(${quote}${proxied}${quote})`;
      } catch {
        return match;
      }
    },
  );
  rewritten = rewritten.replace(
    /(@import\s+)(["'])([^"']+)\2/gi,
    (match, prefix, quote, url) => {
      try {
        const abs = new URL(unwrapProxyUrl(url.trim()), href).href;
        const proxied = `${PROXY_ROUTE}?url=${encodeURIComponent(abs)}`;
        return `${prefix}${quote}${proxied}${quote}`;
      } catch {
        return match;
      }
    },
  );
  return rewritten;
}

function rewriteJsImports(jsText, targetUrl) {
  const baseUrl = new URL(unwrapProxyUrl(targetUrl.href));
  const href = baseUrl.href;

  // Module URLs carry no referer param on purpose: browsers dedupe ES
  // modules by exact URL, and a per-importer param would load shared chunks
  // (React) more than once and break the app.

  // Vite's chunk table (m.f=["assets/x.js", ...]) holds paths relative to
  // the upstream origin.
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
            return JSON.stringify(`${PROXY_ROUTE}?url=${encodeURIComponent(abs)}`);
          } catch {
            return m;
          }
        },
      );
      return `m.f=${parenOpen}${rew}${parenClose}`;
    },
  );

  // A bundle can have both a chunk table and relative imports.
  out = out.replace(
    /(from\s*["']|import\s*["']|import\(\s*["'])(\.\.?\/[^"']+|\/assets\/[^"']+)(["'])/g,
    (match, prefix, path, suffix) => {
      try {
        const abs = new URL(path, href).href;
        const proxied = `${PROXY_ROUTE}?url=${encodeURIComponent(abs)}`;
        return prefix + proxied + suffix;
      } catch {
        return match;
      }
    },
  );

  // new URL("/assets/worker.ts", import.meta.url) would resolve against us.
  out = out.replace(
    /(new\s+URL\(\s*["'])(\.\.?\/[^"']+|\/assets\/[^"']+)(["'])/g,
    (match, prefix, path, suffix) => {
      try {
        const abs = new URL(path, href).href;
        const proxied = `${PROXY_ROUTE}?url=${encodeURIComponent(abs)}`;
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
  {
    resolveTarget = resolvePublicUrl,
    hlsApiBase = "https://cdn.hls.lol",
    lulApiBase = "https://lul.aether.cx",
    // Dedicated hostname for the relay (MOVIE_RELAY_HOST). Empty keeps the
    // relay on the main site.
    relayHost = "",
    // Site hostnames whose pages may frame the relay host
    // (MOVIE_RELAY_EMBEDDERS). Defaults to the relay's parent domain and its
    // subdomains (m.example.com -> example.com, *.example.com).
    embedders = [],
  } = {},
) {
  relayHost = String(relayHost || "")
    .trim()
    .toLowerCase();
  const relayHostname = relayHost.replace(/:\d+$/, "");
  let frameAncestors = "'self'";
  if (relayHost) {
    const parent = relayHostname.split(".").slice(1).join(".");
    const hosts = embedders.length
      ? embedders
      : parent.includes(".")
        ? [parent, `*.${parent}`]
        : [];
    if (!hosts.length)
      console.warn(
        "[movie-proxy] set MOVIE_RELAY_EMBEDDERS: the movies page can't frame the relay host",
      );
    frameAncestors = ["'self'", ...hosts].join(" ");
  }
  const relayCsp = `${RELAY_CSP}; frame-ancestors ${frameAncestors}`;

  if (relayHost) {
    // Root-level hook, so it also covers static files and the 404 handler.
    server.addHook("onRequest", async (req, reply) => {
      const path = req.url.split("?")[0];
      const onRelayHost = requestHostname(req) === relayHostname;
      if (
        onRelayHost
          ? !matchesRoute(path, RELAY_HOST_PATHS)
          : matchesRoute(path, RELAY_ROUTES)
      ) {
        return reply.code(404).type("text/plain").send("Not found");
      }
    });
  }

  // resolveTarget is overridable for tests only; requests can't bypass it.
  async function validateUrl(rawUrl) {
    const resolved = await resolveTarget(unwrapProxyUrl(rawUrl));
    resolved.url.validatedAddresses = resolved.addresses;
    return resolved.url;
  }

  // Buffered, SSRF-checked GET used by /hls-resolve.
  function fetchValidated(target, { accept = "*/*", referer = null } = {}) {
    return new Promise((resolve, reject) => {
      const attempt = (currentUrl, redirectsLeft) => {
        const transport = currentUrl.protocol === "https:" ? https : http;
        const dialAbort = new AbortController();
        const dialTimer = setTimeout(
          () => dialAbort.abort(new Error("Upstream connect timeout")),
          15000,
        );
        const headers = {
          "user-agent":
            "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/605.1.15",
          accept,
          "accept-language": "en-US,en;q=0.9",
          "accept-encoding": "identity",
        };
        if (referer) {
          headers.referer = referer;
          headers.origin = new URL(referer).origin;
        }
        const request = transport.request(
          currentUrl.href,
          {
            method: "GET",
            headers,
            lookup: pinnedLookup(currentUrl.validatedAddresses),
            signal: dialAbort.signal,
          },
          (response) => {
            clearTimeout(dialTimer);
            response.on("error", () => {});
            const status = response.statusCode;
            if (status >= 300 && status < 400 && response.headers.location) {
              response.destroy();
              if (redirectsLeft <= 0)
                return reject(new Error("Too many redirects"));
              let nextUrl;
              try {
                nextUrl = new URL(response.headers.location, currentUrl.href);
              } catch {
                return reject(new Error("Bad redirect target"));
              }
              validateUrl(nextUrl.href).then(
                (validated) => attempt(validated, redirectsLeft - 1),
                reject,
              );
              return;
            }
            const chunks = [];
            let size = 0;
            response.on("data", (chunk) => {
              size += chunk.length;
              if (size > MAX_TEXT_BYTES) {
                response.destroy();
                reject(new Error("Upstream text response exceeds 16 MB."));
              } else {
                chunks.push(chunk);
              }
            });
            response.on("end", () =>
              resolve({
                status,
                headers: response.headers,
                body: Buffer.concat(chunks),
                url: currentUrl,
              }),
            );
            response.on("error", reject);
          },
        );
        request.on("error", (err) => {
          clearTimeout(dialTimer);
          reject(err);
        });
        request.setTimeout(15000, () => {
          request.destroy(new Error("Upstream timeout"));
        });
        request.end();
      };
      attempt(target, MAX_REDIRECTS);
    });
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

      // Relayed pages are only meant to run inside the movies player frame.
      // Refusing top-level navigations stops a crafted link from opening
      // third-party script as a full page. Browsers without Fetch Metadata
      // send no header and are let through.
      if (req.headers["sec-fetch-dest"] === "document") {
        reply
          .code(403)
          .type("text/plain")
          .send("The relay only works inside the movies player.");
        return;
      }

      rawTarget = unwrapProxyUrl(rawTarget);

      if (isDecoyAdImage(rawTarget)) {
        reply.code(403).send("Blocked decoy media fragment");
        return;
      }

      let proxyOrigin;
      try {
        proxyOrigin = requestOrigin(req);
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
        // Flixer's sources endpoint 403s without its WASM-signed headers.
        for (const h of [
          "x-api-key",
          "x-request-timestamp",
          "x-request-nonce",
          "x-request-signature",
          "x-client-fingerprint",
          "x-fingerprint-lite",
          "x-server",
          "x-only-sources",
          "bw90agfmywth",
        ]) {
          if (req.headers[h] != null) reqHeaders[h] = req.headers[h];
        }
        if (body && method !== "GET" && method !== "HEAD") {
          reqHeaders["content-type"] =
            req.headers["content-type"] || "application/octet-stream";
          reqHeaders["content-length"] = body.length;
        }

        const transport = currentUrl.protocol === "https:" ? https : http;

        try {
          upstreamRes = await new Promise((resolve, reject) => {
            // This timer only covers connect + headers; the idle timeout
            // below guards the body, so slow downloads aren't cut off.
            const dialAbort = new AbortController();
            const dialTimer = setTimeout(
              () => dialAbort.abort(new Error("Upstream connect timeout")),
              30000,
            );
            const request = transport.request(
              currentUrl.href,
              {
                method,
                headers: reqHeaders,
                lookup: pinnedLookup(currentUrl.validatedAddresses),
                signal: AbortSignal.any([abort.signal, dialAbort.signal]),
              },
              (response) => {
                clearTimeout(dialTimer);
                // Until a consumer attaches (or for dropped redirect bodies).
                response.on("error", () => {});
                resolve(response);
              },
            );
            request.on("error", (err) => {
              clearTimeout(dialTimer);
              reject(err);
            });
            request.setTimeout(15000, () => {
              request.destroy(new Error("Upstream timeout"));
            });
            request.end(
              body && method !== "GET" && method !== "HEAD" ? body : undefined,
            );
          });
        } catch (err) {
          console.warn(
            `[movie-proxy] upstream error ${currentUrl.host}${currentUrl.pathname}: ${err.message}`,
          );
          if (abort.signal.aborted) {
            // Client went away; nothing to answer.
            reply.raw.destroy();
            return;
          }
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
            if (isDecoyAdImage(nextUrl))
              throw new Error("Blocked decoy media fragment");
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
        "feature-policy",
        "permissions-policy",
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
        // Relayed text embeds per-visit tokens; it must never be cached.
        "last-modified",
        "expires",
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
      const isHtml =
        contentType.includes("text/html") ||
        contentType.includes("application/xhtml+xml");
      const isJson =
        contentType.includes("application/json") ||
        contentType.includes("text/json");
      const isJs =
        contentType.includes("javascript") ||
        cleanPath.endsWith(".js") ||
        cleanPath.endsWith(".mjs");
      const isCss =
        contentType.includes("text/css") || cleanPath.endsWith(".css");
      // Embeds often label m3u8/JSON as text/plain, so sniff those.
      const isPlain =
        contentType.startsWith("text/plain") &&
        !cleanPath.match(
          /\.(png|jpe?g|gif|webp|avif|ico|mp4|webm|mp3|m4a|ts|aac)$/,
        );

      // Log text and failed responses (query truncated before tokens).
      const isTextual = isHtml || isM3u8 || isJson || isJs || isCss || isPlain;
      if (isTextual || upstreamRes.statusCode >= 400) {
        const query = currentUrl.search.slice(0, 48);
        console.log(
          `[movie-proxy] ${req.method} ${upstreamRes.statusCode} ${currentUrl.host}${currentUrl.pathname}${query} ct=${contentType.split(";")[0] || "-"}`,
        );
      }

      // Stream binary payloads straight through.
      if (
        req.method === "HEAD" ||
        upstreamRes.statusCode === 206 ||
        (!isHtml && !isM3u8 && !isJson && !isJs && !isCss && !isPlain)
      ) {
        // reply.header() is ignored after hijack(), so write headers raw.
        // Content-Encoding is kept here because the body isn't decoded.
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

      const chunks = [];
      let decompressed;
      try {
        const maxTextBytes =
          isHtml || isCss
            ? MAX_DOC_BYTES
            : isJs
              ? MAX_SCRIPT_BYTES
              : MAX_TEXT_BYTES;
        let size = 0;
        for await (const chunk of upstreamRes) {
          size += chunk.length;
          if (size > maxTextBytes)
            throw new Error(
              `Upstream text response exceeds ${Math.round(maxTextBytes / 1024 / 1024)} MB.`,
            );
          chunks.push(chunk);
        }
        decompressed = await decompressBufferAsync(
          Buffer.concat(chunks),
          upstreamRes.headers["content-encoding"],
          maxTextBytes,
        );
      } catch (error) {
        upstreamRes.destroy();
        if (abort.signal.aborted) {
          reply.raw.destroy();
          return;
        }
        reply.removeHeader("content-length");
        reply.removeHeader("content-encoding");
        return reply
          .code(502)
          .type("text/plain")
          .send("Could not decode the provider response: " + error.message);
      }
      reply.removeHeader("content-length");

      // Some hosts label video segments text/html; decoding them as UTF-8
      // would corrupt them. NUL bytes mean binary.
      if (decompressed.slice(0, 512).includes(0x00)) {
        return reply.type("application/octet-stream").send(decompressed);
      }

      reply.header(
        "Cache-Control",
        "no-store, no-cache, must-revalidate, max-age=0",
      );
      reply.header("Pragma", "no-cache");

      const rawBody = decompressed.toString("utf-8");

      const trimmedStart = rawBody.trimStart();
      const sniffM3u8 = isPlain && /^#EXTM3U|^#EXT-X-/.test(trimmedStart);
      const sniffJson =
        isPlain &&
        (trimmedStart.startsWith("{") || trimmedStart.startsWith("["));

      if (isHtml && isRealHtml(rawBody)) {
        const rewritten = rewriteHtml(rawBody, currentUrl, proxyOrigin);
        reply.type("text/html; charset=utf-8");
        reply.raw.setHeader("Content-Type", "text/html; charset=utf-8");
        // CSP backs up the URL hooks for anything they miss.
        reply.header("Content-Security-Policy", relayCsp);
        reply.header("content-length", Buffer.byteLength(rewritten));
        reply.send(rewritten);
      } else if (isHtml) {
        // Not recognisable HTML; serve unmodified rather than as a download.
        reply.type("text/html; charset=utf-8");
        reply.raw.setHeader("Content-Type", "text/html; charset=utf-8");
        reply.header("Content-Security-Policy", relayCsp);
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

    // Videm fetches subtitles from a worker, outside the client hooks, so
    // `/api.php?a=sub&ref=...` lands here. Only subtitle requests are served.
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
        // The ref starts with base64url JSON holding the VTT URL. Videm's API
        // rejects server-side calls, but the CDN URL itself is fetchable.
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

    // For hls-player.html: resolve a TMDB id to a playlist via the hls.lol
    // (?via=hls) or P-Stream lul (?via=lul) API and serve it rewritten
    // through /movie-proxy. Params are strictly validated, so they can't
    // steer the API URL.
    fastify.get("/hls-resolve", async (req, reply) => {
      const type = req.query.type;
      const id = req.query.id;
      const via = req.query.via || "hls";
      if (
        (type !== "movie" && type !== "tv") ||
        typeof id !== "string" ||
        !/^\d{1,10}$/.test(id) ||
        (via !== "hls" && via !== "lul")
      ) {
        return reply.code(400).send("Invalid type, id or via parameter");
      }
      let apiPath;
      let pickUrl;
      if (via === "lul") {
        apiPath = type === "movie" ? `/movie/${id}` : `/tv/${id}`;
        pickUrl = (payload) =>
          payload && typeof payload.stream === "string"
            ? payload.stream
            : null;
      } else {
        apiPath = `/content/${type}/${id}`;
        pickUrl = (payload) =>
          payload &&
          payload.found === true &&
          typeof payload.url === "string"
            ? payload.url
            : null;
      }
      if (type === "tv") {
        const s = Number(req.query.s);
        const e = Number(req.query.e);
        if (
          !Number.isInteger(s) ||
          !Number.isInteger(e) ||
          s < 0 ||
          e < 1 ||
          s > 100 ||
          e > 1000
        ) {
          return reply.code(400).send("Invalid season or episode parameter");
        }
        apiPath += `/${s}/${e}`;
      }
      const apiBase = via === "lul" ? lulApiBase : hlsApiBase;
      // lul 403s without a referer.
      const apiReferer = via === "lul" ? "https://aether.ist/" : null;
      let apiUrl;
      try {
        apiUrl = await validateUrl(`${apiBase}${apiPath}`);
      } catch (err) {
        return reply.code(403).send(`SSRF validation failed: ${err.message}`);
      }
      let playlistHref;
      try {
        const apiRes = await fetchValidated(apiUrl, {
          accept: "application/json",
          referer: apiReferer,
        });
        if (apiRes.status !== 200)
          throw new Error(`API answered ${apiRes.status}`);
        const playlistUrl = pickUrl(
          JSON.parse(apiRes.body.toString("utf-8")),
        );
        if (!playlistUrl)
          return reply.code(404).send("No stream found for this title");
        playlistHref = playlistUrl;
      } catch (err) {
        return reply.code(502).send(`Stream lookup failed: ${err.message}`);
      }
      let playlistUrl;
      try {
        playlistUrl = await validateUrl(playlistHref);
      } catch (err) {
        return reply.code(403).send(`SSRF validation failed: ${err.message}`);
      }
      try {
        // Throttled clients get a bounce page instead of a playlist; retry
        // once after a short pause.
        let playlistText = null;
        let finalUrl = null;
        for (let attempt = 0; attempt < 2 && !playlistText; attempt++) {
          if (attempt > 0)
            await new Promise((resolve) => setTimeout(resolve, 2000));
          const playlistRes = await fetchValidated(playlistUrl, {
            referer: TOTALLYACDN_REFERER,
          });
          if (playlistRes.status !== 200)
            throw new Error(`Playlist answered ${playlistRes.status}`);
          const body = playlistRes.body.toString("utf-8");
          if (body.trimStart().startsWith("#EXTM3U")) {
            playlistText = body;
            finalUrl = playlistRes.url;
          }
        }
        if (!playlistText)
          throw new Error("Playlist is not an m3u8 document");
        // Rewrite against the post-redirect URL (the signed master).
        const rewritten = rewriteM3u8(playlistText, finalUrl || playlistUrl);
        console.log(
          `[movie-proxy] hls-resolve ${type} ${id} -> ${playlistUrl.host}${playlistUrl.pathname.slice(0, 32)}`,
        );
        reply.header(
          "Cache-Control",
          "no-store, no-cache, must-revalidate, max-age=0",
        );
        reply.header("Pragma", "no-cache");
        reply.type("application/vnd.apple.mpegurl");
        reply.send(rewritten);
      } catch (err) {
        return reply.code(502).send(`Playlist fetch failed: ${err.message}`);
      }
    });

    // Tells the movies page where the relay lives. An empty origin means
    // same-origin URLs.
    fastify.get("/movie-relay-config.js", (req, reply) => {
      let origin = "";
      if (relayHost) {
        let proto = "https";
        try {
          proto = new URL(requestOrigin(req)).protocol.slice(0, -1);
        } catch {
          /* malformed Host header; keep https */
        }
        origin = `${proto}://${relayHost}`;
      }
      reply
        .header("Cache-Control", "no-cache")
        .type("application/javascript; charset=utf-8")
        .send(`window.MOVIE_RELAY_ORIGIN = ${JSON.stringify(origin)};\n`);
    });

    // Diagnostic beacon from the relay client and movies UI.
    fastify.get("/movie-ping", (req, reply) => {
      // Strip control characters so clients can't forge log lines.
      const clean = (v, max = 120) =>
        String(v ?? "?")
          // eslint-disable-next-line no-control-regex -- stripping control characters is the entire point
          .replace(/[\r\n\t\x00-\x1f]+/g, " ")
          .slice(0, max);
      const q = req.query;
      let line = `[movie-ping] v=${clean(q.v)} origin=${clean(q.origin)} sample=${clean(q.sample)}`;
      if (q.err) line += ` ERR=${clean(q.err, 300)}`;
      if (q.ui)
        line += ` UI ev=${clean(q.ev)} src=${clean(q.src)} kind=${clean(q.kind)} id=${clean(q.id)}${q.host ? ` host=${clean(q.host)}` : ""}`;
      console.log(line);
      reply.code(204).send();
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

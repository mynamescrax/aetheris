import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { lcRelayUpgrade } from "../lc-relay.js";
import {
  registerMovieRelay,
  rewriteHtml,
  rewriteM3u8,
} from "../movie-relay.js";

test("movie relay handles real HTTP bodies, ranges and redirect validation", async (t) => {
  const checked = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.url === "/range") {
      res.writeHead(206, {
        "content-type": "video/mp4",
        "content-range": "bytes 2-5/10",
        "accept-ranges": "bytes",
        "content-length": 4,
      });
      res.end(Buffer.from([2, 3, 4, 5]));
    } else if (req.url === "/html") {
      res.writeHead(200, {
        "content-type": "text/html",
        "content-encoding": "gzip",
        "set-cookie": "untrusted=yes",
        "clear-site-data": '"storage"',
        "service-worker-allowed": "/",
        etag: '"original"',
      });
      res.end(
        zlib.gzipSync(
          // Root-relative base mirrors Videm's player (`<base href="/">`).
          '<!doctype html><html><head><base href="/"></head><body><iframe src="about:blank" data-src="./child"></iframe></body></html>',
        ),
      );
    } else if (req.url === "/bad-compression") {
      res.writeHead(200, {
        "content-type": "text/html",
        "content-encoding": "gzip",
      });
      res.end("not gzip");
    } else if (req.url === "/big-html") {
      // larger than the relay's 4 MB HTML/CSS document cap
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<!doctype html><html><body>" +
          "x".repeat(4 * 1024 * 1024 + 64) +
          "</body></html>",
      );
    } else if (req.url === "/ts-as-html") {
      // Videm's segment host serves MPEG-TS video bytes labeled as text/html.
      res.writeHead(200, { "content-type": "text/html; charset=UTF-8" });
      res.end(
        Buffer.concat([
          Buffer.from([0x47, 0x40, 0x00, 0x30, 0xa6, 0x00]),
          Buffer.alloc(600, 0),
          Buffer.from("segment-payload"),
        ]),
      );
    } else if (req.url === "/redirect") {
      res.writeHead(302, { location: "./html" });
      res.end();
    } else if (req.url === "/private") {
      res.writeHead(302, { location: "http://127.0.0.1/private" });
      res.end();
    } else if (req.url === "/decoy-redirect") {
      res.writeHead(302, {
        location:
          "https://p19-ad-site-sign-sg.tiktokcdn.com/ad-site-i18n-sg/abc.image",
      });
      res.end();
    } else if (req.url === "/content/movie/7") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          found: true,
          url: `http://relay-fixture.test:${port}/pl.m3u8`,
        }),
      );
    } else if (req.url === "/lul/movie/7") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          stream: `http://relay-fixture.test:${port}/pl.m3u8`,
        }),
      );
    } else if (req.url === "/content/movie/404") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ found: false }));
    } else if (req.url === "/pl.m3u8") {
      res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      res.end("#EXTM3U\n#EXTINF:8.0,\nseg1.ts\n");
    } else if (req.url === "/pl-html") {
      // the playlist host bounces throttled clients to an HTML page; the
      // route must reject that instead of serving it as a playlist
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><html><body>bounce</body></html>");
    } else if (req.url === "/content/movie/9") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          found: true,
          url: `http://relay-fixture.test:${port}/pl-html`,
        }),
      );
    } else if (req.url === "/post-303" || req.url === "/post-307") {
      res.writeHead(req.url.endsWith("303") ? 303 : 307, {
        location: "./echo",
      });
      res.end();
    } else {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          method: req.method,
          body: Buffer.concat(chunks).toString(),
          type: req.headers["content-type"] || "",
        }),
      );
    }
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = upstream.address().port;
  const app = Fastify();
  registerMovieRelay(app, {
    resolveTarget: async (raw) => {
      const url = new URL(raw);
      checked.push(url.href);
      if (url.hostname !== "relay-fixture.test" || url.port !== String(port))
        throw new Error("Fixture redirect rejected.");
      return { url, addresses: [{ address: "127.0.0.1", family: 4 }] };
    },
    hlsApiBase: `http://relay-fixture.test:${port}`,
    lulApiBase: `http://relay-fixture.test:${port}/lul`,
  });
  await app.ready();
  t.after(async () => {
    await app.close();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  });
  const path = (tail) =>
    "/movie-proxy?url=" +
    encodeURIComponent(`http://relay-fixture.test:${port}${tail}`);

  await t.test("form POSTs keep the exact body and content type", async () => {
    const result = await app.inject({
      method: "POST",
      url: path("/echo"),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "title=a%26b&episode=2",
    });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json(), {
      method: "POST",
      body: "title=a%26b&episode=2",
      type: "application/x-www-form-urlencoded",
    });
  });
  await t.test(
    "partial binary responses retain bytes and range headers",
    async () => {
      const result = await app.inject({
        method: "GET",
        url: path("/range"),
        headers: { range: "bytes=2-5" },
      });
      assert.equal(result.statusCode, 206);
      assert.equal(result.headers["content-range"], "bytes 2-5/10");
      assert.deepEqual(result.rawPayload, Buffer.from([2, 3, 4, 5]));
      const head = await app.inject({ method: "HEAD", url: path("/range") });
      assert.equal(head.statusCode, 206);
      assert.equal(head.rawPayload.length, 0);
    },
  );
  await t.test(
    "HTML is decompressed and cannot set local cookies or clear storage",
    async () => {
      const result = await app.inject(path("/html"));
      assert.equal(result.statusCode, 200);
      assert.ok(result.body.includes("/js/movie-proxy-client.js"));
      assert.equal(
        result.body.match(/<script(?=[\s>])/g)?.length,
        result.body.match(/<\/script>/g)?.length,
        "every injected script tag must be closed or the provider page breaks",
      );
      assert.ok(
        result.body.includes(
          `<base href="http://relay-fixture.test:${port}/">`,
        ),
        "provider base must stay anchored upstream, never proxied onto ourselves",
      );
      assert.ok(
        !/<base[^>]*movie-proxy/.test(result.body),
        "a proxied base tag collapses relative provider URLs onto Aetheris",
      );
      assert.ok(
        result.body.includes(
          encodeURIComponent(`http://relay-fixture.test:${port}/child`),
        ),
      );
      assert.ok(result.body.includes('src="about:blank"'));
      assert.ok(
        result.body.includes(
          `data-src="http://localhost/movie-proxy?url=${encodeURIComponent(`http://relay-fixture.test:${port}/child`)}`,
        ),
        "rewritten iframe URLs must be absolute so a foreign base cannot capture them",
      );
      for (const name of [
        "set-cookie",
        "clear-site-data",
        "service-worker-allowed",
        "content-encoding",
        "etag",
        "last-modified",
        "expires",
      ])
        assert.equal(result.headers[name], undefined, name);
      assert.ok(
        String(result.headers["cache-control"]).includes("no-store"),
        "relayed documents must never be cached",
      );
      const csp = String(result.headers["content-security-policy"]);
      assert.ok(csp.includes("connect-src 'self'"));
      assert.ok(csp.includes("media-src 'self'"));
      assert.ok(csp.includes("frame-src 'self'"));
      assert.ok(
        csp.includes(
          "img-src 'self' data: blob: https://flagcdn.com https://image.tmdb.org;",
        ),
        "TMDB artwork loads directly because players set it via CSS/JS strings the URL hooks cannot see",
      );
      assert.ok(
        !/script-src[^;]*https:/i.test(csp) &&
          !/connect-src[^;]*https:/i.test(csp),
        "relayed documents must keep scripts and network calls on the relay",
      );
    },
  );
  await t.test(
    "redirects are validated again and blocked targets fail closed",
    async () => {
      checked.length = 0;
      assert.equal((await app.inject(path("/redirect"))).statusCode, 200);
      assert.ok(checked.some((url) => url.endsWith("/html")));
      assert.equal((await app.inject(path("/private"))).statusCode, 403);
    },
  );
  await t.test(
    "decoy HLS fragments are refused before any lookup or fetch",
    async () => {
      checked.length = 0;
      const direct = await app.inject(
        "/movie-proxy?url=" +
          encodeURIComponent(
            "https://p16-ad-site-sign-sg.tiktokcdn.com/ad-site-i18n-sg/20260702abc~tplv-d5opwmad15-ttam-origin.image",
          ),
      );
      assert.equal(direct.statusCode, 403);
      assert.match(direct.body, /decoy/i);
      assert.deepEqual(
        checked,
        [],
        "decoy hosts must not trigger a DNS lookup or upstream fetch",
      );

      // A validated redirect that lands on the decoy CDN must fail closed too.
      const viaRedirect = await app.inject(path("/decoy-redirect"));
      assert.equal(viaRedirect.statusCode, 403);
      assert.match(viaRedirect.body, /decoy/i);
    },
  );
  await t.test("totallyacdn playlists keep the embed referer", async () => {
    const target = new URL("https://totallyacdn.org/cdn-m3u8?payload=abc");
    const out = rewriteM3u8(
      "#EXTM3U\n#EXTINF:8.0,\nhttps://totallyacdn.org/?payload=seg1\n",
      target,
    );
    // totallyacdn bounces self-referred media to an unrelated page, so the
    // relay must stamp the embed referer instead of the playlist URL.
    assert.ok(
      out.includes(`referer=${encodeURIComponent("https://cinecat.eu/")}`),
    );
    assert.ok(!out.includes("referer=https%3A%2F%2Ftotallyacdn.org"));
    // tnmr.org media (P-Stream lul backend) needs its own embed referer
    const tnmr = rewriteM3u8(
      "#EXTM3U\nhttps://abc123.tnmr.org/hls2/seg1.ts\n",
      new URL("https://abc123.tnmr.org/hls2/master.m3u8"),
    );
    assert.ok(
      tnmr.includes(`referer=${encodeURIComponent("https://aether.ist/")}`),
    );
    // ordinary hosts keep the playlist URL as referer
    const plain = rewriteM3u8("#EXTM3U\nseg.ts\n", {
      href: "https://example.net/a/index.m3u8",
    });
    assert.ok(
      plain.includes(
        `referer=${encodeURIComponent("https://example.net/a/index.m3u8")}`,
      ),
    );
  });
  await t.test(
    "303 switches POST to GET while 307 preserves POST data",
    async () => {
      for (const code of [303, 307]) {
        const result = await app.inject({
          method: "POST",
          url: path("/post-" + code),
          headers: { "content-type": "text/plain" },
          payload: "preserve me",
        });
        assert.equal(result.statusCode, 200);
        assert.equal(result.json().method, code === 303 ? "GET" : "POST");
        assert.equal(result.json().body, code === 303 ? "" : "preserve me");
      }
    },
  );
  await t.test("/hls-resolve serves a rewritten playlist", async () => {
    const ok = await app.inject("/hls-resolve?type=movie&id=7");
    assert.equal(ok.statusCode, 200);
    assert.ok(
      String(ok.headers["content-type"]).includes("mpegurl"),
      "players key off the playlist content type",
    );
    assert.ok(
      String(ok.headers["cache-control"]).includes("no-store"),
      "signed playlists must never be cached",
    );
    // the segment resolves against the playlist URL and carries it back
    // as referer so the media host accepts the request
    assert.ok(
      ok.body.includes(
        `/movie-proxy?url=${encodeURIComponent(`http://relay-fixture.test:${port}/seg1.ts`)}`,
      ),
    );
    assert.ok(
      ok.body.includes(
        `referer=${encodeURIComponent(`http://relay-fixture.test:${port}/pl.m3u8`)}`,
      ),
    );

    assert.equal(
      (await app.inject("/hls-resolve?type=movie&id=7x")).statusCode,
      400,
    );
    assert.equal(
      (await app.inject("/hls-resolve?type=tv&id=7")).statusCode,
      400,
      "tv requires season and episode",
    );
    assert.equal(
      (await app.inject("/hls-resolve?type=movie&id=404")).statusCode,
      404,
      "found:false surfaces as not found",
    );
    assert.equal(
      (await app.inject("/hls-resolve?type=movie&id=9")).statusCode,
      502,
      "an HTML bounce page is never served as a playlist",
    );
    const lul = await app.inject("/hls-resolve?via=lul&type=movie&id=7");
    assert.equal(lul.statusCode, 200);
    assert.ok(
      lul.body.includes(
        `/movie-proxy?url=${encodeURIComponent(`http://relay-fixture.test:${port}/seg1.ts`)}`,
      ),
      "the lul {stream} shape resolves the same way",
    );
    assert.equal(
      (await app.inject("/hls-resolve?via=nope&type=movie&id=7")).statusCode,
      400,
      "unknown resolvers are rejected",
    );
  });
  await t.test(
    "bad upstream compression returns an explicit error",
    async () => {
      const result = await app.inject(path("/bad-compression"));
      assert.equal(result.statusCode, 502);
      assert.ok(result.body.toLowerCase().includes("decode"));
    },
  );
  await t.test(
    "oversized HTML documents are rejected before rewriting",
    async () => {
      const result = await app.inject(path("/big-html"));
      assert.equal(result.statusCode, 502);
      assert.match(result.body, /exceeds 4 MB/);
    },
  );
  await t.test(
    "binary segments mislabeled as text/html keep their exact bytes",
    async () => {
      const result = await app.inject(path("/ts-as-html"));
      assert.equal(result.statusCode, 200);
      assert.ok(
        String(result.headers["content-type"]).includes(
          "application/octet-stream",
        ),
      );
      assert.deepEqual(
        result.rawPayload,
        Buffer.concat([
          Buffer.from([0x47, 0x40, 0x00, 0x30, 0xa6, 0x00]),
          Buffer.alloc(600, 0),
          Buffer.from("segment-payload"),
        ]),
      );
    },
  );
});

test("rewriteHtml keeps self-hosted JWPlayer locatable", async (t) => {
  const target = new URL("https://2vcdn.skin/e/1e2f5rfkmjtj");
  await t.test("jwplayer script keeps a usable upstream base for chunks", () => {
    const out = rewriteHtml(
      '<!doctype html><html><head></head><body><script src="/player/jw8/jwplayer.js?v=7"></script></body></html>',
      target,
      "http://localhost",
    );
    const src = out.match(/<script[^>]*src="([^"]*movie-proxy\?url=[^"]*)"/)[1];
    // JW Player derives its webpack base with
    // src.substr(0, src.lastIndexOf("/jwplayer.js") + 1). A plain proxied
    // URL percent-encodes the upstream directory, so the relay appends a
    // literal /jwplayer.js after the encoded directory instead. No fragment:
    // the old `#/jwplayer.js` trick made the base end in `#/`, so every
    // chunk request came back to the jwplayer.js proxy URL.
    assert.ok(!src.includes("#/jwplayer.js"));
    const index = src.lastIndexOf("/jwplayer.js");
    assert.ok(index >= 0, "JW needs a literal /jwplayer.js in the script src");
    const base = src.slice(0, index + 1);
    for (const sibling of ["provider.hlsjs.js?v=42", "vast.js?v=32"]) {
      const siblingUrl = new URL(base + sibling, "http://localhost");
      assert.equal(siblingUrl.pathname, "/movie-proxy");
      assert.equal(
        siblingUrl.searchParams.get("url"),
        `https://2vcdn.skin/player/jw8/${sibling}`,
      );
    }
    const libraryUrl = new URL(src, "http://localhost");
    assert.equal(
      libraryUrl.searchParams.get("url"),
      "https://2vcdn.skin/player/jw8/jwplayer.js?v=7",
    );
  });
  await t.test("pages without a doctype get standards mode", () => {
    const out = rewriteHtml(
      '<HTML><HEAD><meta http-equiv="Feature-Policy" content="autoplay *; encrypted-media *"></HEAD><BODY><img src="/images/a.png"></BODY></HTML>',
      target,
      "http://localhost",
    );
    assert.ok(
      /^<!DOCTYPE html>/i.test(out),
      "quirks mode breaks provider layout and spams the console",
    );
    assert.ok(
      !/Feature-Policy/i.test(out),
      "obsolete feature policy metas are ignored anyway; strip them",
    );
  });
  await t.test(
    "jQuery is injected only when the page calls $ without it",
    () => {
      const needy =
        "<!doctype html><html><head></head><body><script>$.ajaxSetup({});</script></body></html>";
      const withJq = rewriteHtml(needy, target, "http://localhost");
      // The injected URL is percent-encoded inside url=, so match the tail.
      assert.ok(withJq.includes("2Fjquery.min.js"));
      assert.ok(withJq.includes("/movie-proxy?url="));

      const shipped =
        '<!doctype html><html><head><script src="https://cdn/x/jquery.min.js"></script></head><body><script>$.ajaxSetup({});</script></body></html>';
      assert.equal(
        rewriteHtml(shipped, target, "http://localhost").match(
          /jquery\.min\.js/g,
        ).length,
        1,
        "must not duplicate a shipped jQuery",
      );

      const ownDollar =
        '<!doctype html><html><head></head><body><script>var $=function(s){return document.querySelector(s)};$( "a" );</script></body></html>';
      assert.ok(
        !rewriteHtml(ownDollar, target, "http://localhost").includes(
          "jquery.min.js",
        ),
        "must not clobber a page-owned $ helper",
      );

      const plain =
        "<!doctype html><html><head></head><body><p>costs $ . Next</p></body></html>";
      assert.ok(
        !rewriteHtml(plain, target, "http://localhost").includes(
          "jquery.min.js",
        ),
      );
    },
  );
  await t.test("packed provider boot code passes through untouched", () => {
    // 2vcdn-style packers encode identifiers in transit, so the relay must
    // not mangle the block: script tags stay balanced and the payload that
    // reaches the browser still unpacks (player-side fallback intact).
    const packed =
      'eval(function(p,a,c,k,e,d){x=links.hls9}("a|b".split("|")))';
    const out = rewriteHtml(
      `<!doctype html><html><head></head><body><script>${packed}</script></body></html>`,
      target,
      "http://localhost",
    );
    assert.ok(out.includes(packed));
    assert.equal(
      out.match(/<script(?=[\s>])/g)?.length,
      out.match(/<\/script>/g)?.length,
    );
  });
  await t.test("pages without the packed pattern pass through", () => {
    const out = rewriteHtml(
      "<!doctype html><html><head></head><body><p>plain</p></body></html>",
      target,
      "http://localhost",
    );
    assert.ok(out.includes("<p>plain</p>"));
    assert.ok(!out.includes("links.hls"));
  });
});

test("movie relay forwards flixer signed auth headers upstream", async (t) => {
  // Flixer's sources endpoint 403s unless its signed headers reach upstream.
  const seen = {};
  const upstream = http.createServer((req, res) => {
    for (const h of [
      "x-api-key",
      "x-request-timestamp",
      "x-request-nonce",
      "x-request-signature",
      "x-client-fingerprint",
      "x-fingerprint-lite",
      "bw90agfmywth",
    ]) {
      if (req.headers[h] != null) seen[h] = req.headers[h];
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = upstream.address().port;
  const app = Fastify();
  registerMovieRelay(app, {
    resolveTarget: async (raw) => {
      const url = new URL(raw);
      if (url.hostname !== "relay-fixture.test" || url.port !== String(port))
        throw new Error("Fixture redirect rejected.");
      return { url, addresses: [{ address: "127.0.0.1", family: 4 }] };
    },
    hlsApiBase: `http://relay-fixture.test:${port}`,
    lulApiBase: `http://relay-fixture.test:${port}/lul`,
  });
  await app.ready();
  t.after(async () => {
    await app.close();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  });
  const result = await app.inject({
    method: "GET",
    url:
      "/movie-proxy?url=" +
      encodeURIComponent(`http://relay-fixture.test:${port}/api/images`),
    headers: {
      "x-api-key": "k".repeat(64),
      "x-request-timestamp": "1790698880",
      "x-request-nonce": "nonce123",
      "x-request-signature": "sig==",
      "x-client-fingerprint": "fp",
      "x-fingerprint-lite": "lite",
      bw90agfmywth: "1",
    },
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(seen, {
    "x-api-key": "k".repeat(64),
    "x-request-timestamp": "1790698880",
    "x-request-nonce": "nonce123",
    "x-request-signature": "sig==",
    "x-client-fingerprint": "fp",
    "x-fingerprint-lite": "lite",
    bw90agfmywth: "1",
  });
});

test("a dedicated relay host keeps relayed pages off the main origin", async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      '<!doctype html><html><head></head><body><img src="/a.png">provider</body></html>',
    );
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = upstream.address().port;
  t.after(async () => {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  });
  // Mirrors index.js: relay first, then site routes, static files and a 404.
  const build = async (options) => {
    const app = Fastify();
    registerMovieRelay(app, {
      resolveTarget: async (raw) => {
        const url = new URL(raw);
        if (url.hostname !== "relay-fixture.test")
          throw new Error("Fixture target rejected.");
        return { url, addresses: [{ address: "127.0.0.1", family: 4 }] };
      },
      ...options,
    });
    app.get("/api/accounts/me", () => ({ ok: true }));
    app.register(fastifyStatic, {
      root: fileURLToPath(new URL("../public/", import.meta.url)),
    });
    app.setNotFoundHandler((_req, reply) => reply.code(404).send("missing"));
    await app.ready();
    t.after(() => app.close());
    return app;
  };
  const target =
    "/movie-proxy?url=" +
    encodeURIComponent(`http://relay-fixture.test:${port}/page`);
  const main = { host: "aetheris.test" };
  const relay = { host: "m.aetheris.test" };

  await t.test("relay routes only answer on the relay host", async () => {
    const app = await build({ relayHost: "m.aetheris.test" });
    for (const url of [
      target,
      "/hls-resolve?type=movie&id=7",
      "/api.php?a=sub&ref=x",
    ]) {
      const res = await app.inject({ url, headers: main });
      assert.equal(res.statusCode, 404, url);
    }
    const relayed = await app.inject({ url: target, headers: relay });
    assert.equal(relayed.statusCode, 200);
    assert.ok(relayed.body.includes("provider"));
    assert.ok(
      relayed.body.includes('src="http://m.aetheris.test/movie-proxy?url='),
      "rewritten URLs must stay on the relay host",
    );
    assert.match(
      relayed.headers["content-security-policy"],
      /frame-ancestors 'self' aetheris\.test \*\.aetheris\.test$/,
    );
    const client = await app.inject({
      url: "/js/movie-proxy-client.js",
      headers: relay,
    });
    assert.equal(client.statusCode, 200);
    const ping = await app.inject({ url: "/movie-ping?v=1", headers: relay });
    assert.equal(ping.statusCode, 204);
  });

  await t.test("the relay host serves nothing else", async () => {
    const app = await build({ relayHost: "m.aetheris.test" });
    for (const url of [
      "/",
      "/movies.html",
      "/api/accounts/me",
      "/movie-relay-config.js",
      "/js/chat.js",
    ]) {
      const res = await app.inject({ url, headers: relay });
      assert.equal(res.statusCode, 404, url);
    }
    const api = await app.inject({ url: "/api/accounts/me", headers: main });
    assert.equal(api.statusCode, 200);
    const page = await app.inject({ url: "/movies.html", headers: main });
    assert.equal(page.statusCode, 200);
  });

  await t.test("the movies page learns the relay origin", async () => {
    const app = await build({
      relayHost: "m.aetheris.test",
      embedders: ["site.test"],
    });
    const config = await app.inject({
      url: "/movie-relay-config.js",
      headers: { ...main, "x-forwarded-proto": "https" },
    });
    assert.equal(
      config.body,
      'window.MOVIE_RELAY_ORIGIN = "https://m.aetheris.test";\n',
    );
    const relayed = await app.inject({ url: target, headers: relay });
    assert.match(
      relayed.headers["content-security-policy"],
      /frame-ancestors 'self' site\.test$/,
    );
  });

  await t.test("without a relay host nothing changes", async () => {
    const app = await build({});
    const relayed = await app.inject({ url: target, headers: main });
    assert.equal(relayed.statusCode, 200);
    assert.ok(relayed.body.includes('src="http://aetheris.test/movie-proxy?url='));
    assert.match(
      relayed.headers["content-security-policy"],
      /frame-ancestors 'self'$/,
    );
    const config = await app.inject({
      url: "/movie-relay-config.js",
      headers: main,
    });
    assert.equal(config.body, 'window.MOVIE_RELAY_ORIGIN = "";\n');
    for (const host of [main, relay]) {
      const api = await app.inject({ url: "/api/accounts/me", headers: host });
      assert.equal(api.statusCode, 200);
    }
  });

  await t.test("relayed pages refuse top-level navigation", async () => {
    const app = await build({});
    const top = await app.inject({
      url: target,
      headers: { ...main, "sec-fetch-dest": "document" },
    });
    assert.equal(top.statusCode, 403);
    const framed = await app.inject({
      url: target,
      headers: { ...main, "sec-fetch-dest": "iframe" },
    });
    assert.equal(framed.statusCode, 200);
  });
});

test("lc-relay limits room-code guessing and message floods", async (t) => {
  const server = http.createServer();
  server.on("upgrade", lcRelayUpgrade);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `ws://127.0.0.1:${server.address().port}/lc-relay`;
  const open = (ip) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { "x-forwarded-for": ip } });
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
  const joinFrame = (code) =>
    Buffer.concat([
      Buffer.from([1, 1, code.length]),
      Buffer.from(code),
      Buffer.from([1]),
      Buffer.from("1"),
    ]);
  // Resolves with the first ERROR frame's text.
  const tryJoin = async (ip, code) => {
    const ws = await open(ip);
    return new Promise((resolve) => {
      ws.once("message", (data) => {
        resolve(Buffer.from(data).subarray(1).toString());
        ws.terminate();
      });
      ws.send(joinFrame(code));
    });
  };

  await t.test("unknown room codes are rate limited per IP", async () => {
    for (let i = 0; i < 20; i++)
      assert.match(await tryJoin("203.0.113.7", `guess${i}`), /doesn't exist/);
    assert.match(await tryJoin("203.0.113.7", "guess20"), /Too many join/);
    // other addresses are unaffected
    assert.match(await tryJoin("203.0.113.8", "guess0"), /doesn't exist/);
  });

  await t.test("a socket flooding messages is closed", async () => {
    const ws = await open("203.0.113.9");
    const closed = new Promise((resolve) =>
      ws.once("close", (code) => resolve(code)),
    );
    const ping = Buffer.alloc(9);
    ping[0] = 8;
    for (let i = 0; i < 6000 && ws.readyState === WebSocket.OPEN; i++)
      ws.send(ping);
    assert.equal(await closed, 1008);
  });
});

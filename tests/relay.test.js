import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import Fastify from "fastify";
import { registerMovieRelay, rewriteHtml } from "../movie-relay.js";

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
  await t.test(
    "bad upstream compression returns an explicit error",
    async () => {
      const result = await app.inject(path("/bad-compression"));
      assert.equal(result.statusCode, 502);
      assert.ok(result.body.toLowerCase().includes("decode"));
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
  await t.test("jwplayer script keeps a literal /jwplayer.js match", () => {
    const out = rewriteHtml(
      '<!doctype html><html><head></head><body><script src="/player/jw8/jwplayer.js?v=7"></script></body></html>',
      target,
      "http://localhost",
    );
    // JWPlayer finds its base by scanning script `.src` for `/jwplayer.js`;
    // the proxied URL percent-encodes the path, so a fragment restores it.
    assert.ok(out.includes("#/jwplayer.js"));
    const src = out.match(/<script[^>]*src="([^"]*movie-proxy\?url=[^"]*)"/)[1];
    assert.ok(new URL(src, "http://localhost").pathname === "/movie-proxy");
  });
  await t.test("jQuery is injected only when the page calls $ without it", () => {
    const needy =
      '<!doctype html><html><head></head><body><script>$.ajaxSetup({});</script></body></html>';
    const withJq = rewriteHtml(needy, target, "http://localhost");
    // The injected URL is percent-encoded inside url=, so match the tail.
    assert.ok(withJq.includes("2Fjquery.min.js"));
    assert.ok(withJq.includes("/movie-proxy?url="));

    const shipped =
      '<!doctype html><html><head><script src="https://cdn/x/jquery.min.js"></script></head><body><script>$.ajaxSetup({});</script></body></html>';
    assert.equal(
      rewriteHtml(shipped, target, "http://localhost").match(/jquery\.min\.js/g)
        .length,
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
      !rewriteHtml(plain, target, "http://localhost").includes("jquery.min.js"),
    );
  });
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

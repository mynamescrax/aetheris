import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import Fastify from "fastify";
import { registerMovieRelay } from "../movie-relay.js";

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
          '<!doctype html><html><head><base href="https://foreign-base.test/e/"></head><body><iframe src="about:blank" data-src="./child"></iframe></body></html>',
        ),
      );
    } else if (req.url === "/bad-compression") {
      res.writeHead(200, {
        "content-type": "text/html",
        "content-encoding": "gzip",
      });
      res.end("not gzip");
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
      ])
        assert.equal(result.headers[name], undefined, name);
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
});

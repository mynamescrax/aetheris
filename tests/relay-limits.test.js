import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { setImmediate as nextTurn } from "node:timers/promises";
import Fastify from "fastify";
import { WebSocket, WebSocketServer } from "ws";
import { registerMovieRelay } from "../movie-relay.js";
import { createTikTokGateway } from "../lib/tiktok-gateway.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(t, kind, options = {}) {
  const release = deferred();
  const holding = deferred();
  const closed = deferred();
  const hits = [];
  const seen = new Map();
  const gone = new Map();
  const observe = (req, res) => {
    const id = req.headers["x-reader"];
    seen.get(id)?.resolve();
    res.once("close", () => gone.get(id)?.resolve());
  };
  const upstream = http.createServer(async (req, res) => {
    hits.push(req.url);
    if (req.url === "/hold") {
      res.on("close", closed.resolve);
      res.writeHead(200, { "content-type": "video/mp4" });
      res.write("first");
      holding.resolve();
      await release.promise;
      res.end("last");
    } else if (req.url === "/never") {
      res.on("close", closed.resolve);
      holding.resolve();
    } else if (req.url === "/echo") {
      const body = [];
      for await (const chunk of req) body.push(chunk);
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "x-received-encoding": req.headers["content-encoding"] || "none",
      });
      res.end(Buffer.concat(body));
    } else if (req.url === "/range") {
      res.writeHead(206, {
        "content-type": "video/mp4",
        "content-range": "bytes 2-5/10",
        "content-length": 4,
      });
      res.end(Buffer.from([2, 3, 4, 5]));
    } else res.end("ok");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = upstream.address().port;
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  upstream.on("connection", track);
  const resolveTarget = async (raw) => {
    const url = new URL(raw);
    if (url.hostname !== "fixture.test" || url.port !== String(port))
      throw new Error("Fixture target refused");
    return { url, addresses: [{ address: "127.0.0.1", family: 4 }] };
  };
  let server, base, gateway, app;
  const limits = {
    maxConcurrent: 1,
    maxPerKey: 1,
    maxQueued: 1,
    ...options.limits,
  };
  if (kind === "movie") {
    app = Fastify({ trustProxy: ["127.0.0.1", "::1"] });
    app.addHook("onRequest", async (req, reply) => observe(req.raw, reply.raw));
    registerMovieRelay(app, {
      resolveTarget,
      limits,
      hlsApiBase: `http://fixture.test:${port}`,
    });
    app.get("/unrelated", () => "site");
    base = await app.listen({ port: 0, host: "127.0.0.1" });
    server = app.server;
  } else {
    gateway = createTikTokGateway({
      resolveTarget,
      httpLimits: limits,
      ...options.gateway,
    });
    server = http.createServer((req, res) => {
      observe(req, res);
      if (gateway.handleRequest(req, res)) return;
      res.end("site");
    });
    server.on("upgrade", (req, socket, head) => {
      if (!gateway.upgrade(req, socket, head)) socket.destroy();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  server.on("connection", track);
  t.after(async () => {
    release.resolve();
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    upstream.closeAllConnections();
    if (app) await app.close();
    else await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  });
  return {
    base,
    server,
    upstream,
    hits,
    release,
    holding,
    closed,
    port,
    url: (path) =>
      base +
      (kind === "movie" ? "/movie-proxy?url=" : "/tiktok/tt?url=") +
      encodeURIComponent(`http://fixture.test:${port}${path}`),
    observe: (id) => {
      const arrived = deferred(),
        disconnected = deferred();
      seen.set(id, arrived);
      gone.set(id, disconnected);
      return { arrived: arrived.promise, disconnected: disconnected.promise };
    },
  };
}

for (const kind of ["movie", "tiktok"]) {
  test(
    `${kind}: streamed responses retain slots, overflow fails early, site routes remain free`,
    { timeout: 5000 },
    async (t) => {
      const f = await fixture(t, kind);
      const first = await fetch(f.url("/hold"));
      await f.holding.promise;
      const seen = f.observe("queued");
      const second = fetch(f.url("/next"), {
        headers: { "x-reader": "queued" },
      });
      await seen.arrived;
      await nextTurn();
      const overflow = await fetch(f.url("/third"));
      assert.equal(overflow.status, 503);
      assert.equal(overflow.headers.get("retry-after"), "1");
      assert.equal(overflow.headers.get("cache-control"), "no-store");
      assert.equal(overflow.headers.get("access-control-allow-origin"), "*");
      await overflow.text();
      assert.deepEqual(f.hits, ["/hold"]);
      assert.equal(await (await fetch(f.base + "/unrelated")).text(), "site");
      if (kind === "tiktok") {
        const local = await fetch(f.base + "/tiktok/tt-client.js");
        assert.equal(local.status, 200);
        await local.text();
      }
      const options = await fetch(f.url("/next"), { method: "OPTIONS" });
      assert.equal(options.status, 204);
      f.release.resolve();
      assert.equal(await first.text(), "firstlast");
      assert.equal(await (await second).text(), "ok");
      assert.deepEqual(f.hits, ["/hold", "/next"]);
    },
  );

  test(
    `${kind}: a busy IP does not block a different IP`,
    { timeout: 5000 },
    async (t) => {
      const f = await fixture(t, kind, { limits: { maxConcurrent: 2 } });
      const first = await fetch(f.url("/hold"), {
        headers: { "x-forwarded-for": "192.0.2.1" },
      });
      const queued = f.observe("queued");
      const second = fetch(f.url("/second"), {
        headers: { "x-forwarded-for": "192.0.2.1", "x-reader": "queued" },
      });
      await queued.arrived;
      await nextTurn();
      const other = await fetch(f.url("/other"), {
        headers: { "x-forwarded-for": "192.0.2.2" },
      });
      assert.equal(await other.text(), "ok");
      assert.deepEqual(f.hits, ["/hold", "/other"]);
      f.release.resolve();
      await first.text();
      assert.equal(await (await second).text(), "ok");
    },
  );

  test(
    `${kind}: queue deadlines and disconnected streams release admission`,
    { timeout: 5000 },
    async (t) => {
      const f = await fixture(t, kind, { limits: { queueTimeoutMs: 30 } });
      const controller = new AbortController();
      const first = await fetch(f.url("/hold"), { signal: controller.signal });
      const waiting = await fetch(f.url("/timed-out"));
      assert.equal(waiting.status, 503);
      await waiting.text();
      assert.deepEqual(f.hits, ["/hold"]);
      controller.abort();
      await assert.rejects(first.text());
      await f.closed.promise;
      const next = await fetch(f.url("/next"));
      assert.equal(await next.text(), "ok");
      assert.deepEqual(f.hits, ["/hold", "/next"]);
    },
  );

  test(
    `${kind}: a disconnected queued request is removed without fetching upstream`,
    { timeout: 5000 },
    async (t) => {
      const f = await fixture(t, kind);
      const first = await fetch(f.url("/hold"));
      const queued = f.observe("cancel");
      const controller = new AbortController();
      const cancelled = fetch(f.url("/cancel"), {
        headers: { "x-reader": "cancel" },
        signal: controller.signal,
      }).catch((error) => error);
      await queued.arrived;
      await nextTurn();
      controller.abort();
      await cancelled;
      await queued.disconnected;
      const replacementSeen = f.observe("replacement");
      const replacement = fetch(f.url("/replacement"), {
        headers: { "x-reader": "replacement" },
      });
      await replacementSeen.arrived;
      await nextTurn();
      f.release.resolve();
      await first.text();
      assert.equal(await (await replacement).text(), "ok");
      assert.deepEqual(f.hits, ["/hold", "/replacement"]);
    },
  );

  test(
    `${kind}: queued POST bytes and range responses survive admission`,
    { timeout: 5000 },
    async (t) => {
      const f = await fixture(t, kind);
      const first = await fetch(f.url("/hold"));
      const body =
        kind === "tiktok"
          ? gzipSync('{"video":"signed&unmodified"}')
          : Buffer.from("token=signed%2Bvalue&time=123");
      const queued = f.observe("post");
      const post = fetch(f.url("/echo"), {
        method: "POST",
        body,
        headers: {
          "content-type": "application/octet-stream",
          "x-reader": "post",
          ...(kind === "tiktok" ? { "content-encoding": "gzip" } : {}),
        },
      });
      await queued.arrived;
      await nextTurn();
      assert.deepEqual(f.hits, ["/hold"]);
      f.release.resolve();
      await first.text();
      const echoed = await post;
      assert.deepEqual(Buffer.from(await echoed.arrayBuffer()), body);
      if (kind === "tiktok")
        assert.equal(echoed.headers.get("x-received-encoding"), "gzip");
      const range = await fetch(f.url("/range"), {
        headers: { range: "bytes=2-5" },
      });
      assert.equal(range.status, 206);
      assert.equal(range.headers.get("content-range"), "bytes 2-5/10");
      assert.deepEqual(
        Buffer.from(await range.arrayBuffer()),
        Buffer.from([2, 3, 4, 5]),
      );
    },
  );
}

test(
  "TikTok: stalled upstream headers time out and release the slot",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t, "tiktok", {
      gateway: { upstreamTimeoutMs: 30 },
    });
    const response = await fetch(f.url("/never"));
    assert.equal(response.status, 502);
    await response.text();
    await f.closed.promise;
    assert.equal(await (await fetch(f.url("/next"))).text(), "ok");
  },
);

test(
  "TikTok: incomplete request bodies have a deadline",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t, "tiktok", { gateway: { bodyTimeoutMs: 30 } });
    const response = await new Promise((resolve, reject) => {
      const req = http.request(
        f.url("/echo"),
        { method: "POST", headers: { "content-length": 100 } },
        (res) => {
          res.resume();
          res.on("end", () => {
            resolve(res.statusCode);
            req.destroy();
          });
        },
      );
      req.on("error", reject);
      req.write("incomplete");
    });
    assert.equal(response, 408);
    assert.deepEqual(f.hits, []);
    assert.equal(await (await fetch(f.url("/next"))).text(), "ok");
  },
);

test(
  "TikTok: WebSocket caps hold for the whole connection and release on close",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t, "tiktok", {
      gateway: { wsLimits: { maxConcurrent: 1, maxPerKey: 1 } },
    });
    const wss = new WebSocketServer({ server: f.upstream });
    const upstreamClosed = deferred();
    let count = 0;
    wss.on("connection", (ws) => {
      count++;
      ws.on("message", (bytes, binary) => ws.send(bytes, { binary }));
      ws.on("close", upstreamClosed.resolve);
    });
    t.after(() => {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    });
    const url =
      f.base.replace(/^http:/, "ws:") +
      "/tiktok/tt-ws?url=" +
      encodeURIComponent(`ws://fixture.test:${f.port}/echo`);
    const first = new WebSocket(url);
    t.after(() => first.terminate());
    await once(first, "open");
    const reply = once(first, "message");
    first.send("hello");
    assert.equal((await reply)[0].toString(), "hello");
    const blocked = new WebSocket(url);
    blocked.on("error", () => {});
    const [req, response] = await once(blocked, "unexpected-response");
    assert.equal(response.statusCode, 503);
    response.resume();
    req.destroy();
    blocked.terminate();
    assert.equal(count, 1);
    first.terminate();
    await upstreamClosed.promise;
    const next = new WebSocket(url);
    t.after(() => next.terminate());
    await once(next, "open");
    assert.equal(count, 2);
    next.terminate();
  },
);

test(
  "movie: cancelling an HLS lookup closes its upstream and releases admission",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t, "movie");
    const started = deferred(),
      closed = deferred();
    f.upstream.removeAllListeners("request");
    f.upstream.on("request", (req, res) => {
      if (req.url === "/content/movie/7") {
        res.on("close", closed.resolve);
        started.resolve();
      } else res.end("ok");
    });
    const controller = new AbortController();
    const lookup = fetch(f.base + "/hls-resolve?type=movie&id=7", {
      signal: controller.signal,
    }).catch((error) => error);
    await started.promise;
    controller.abort();
    await lookup;
    await closed.promise;
    assert.equal(await (await fetch(f.url("/next"))).text(), "ok");
  },
);

test(
  "TikTok: an incomplete upstream WebSocket handshake cannot pin a slot",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t, "tiktok", {
      gateway: {
        wsLimits: { maxConcurrent: 1 },
        wsConnectTimeoutMs: 50,
      },
    });
    const wss = new WebSocketServer({ noServer: true });
    t.after(() => wss.close());
    f.upstream.on("upgrade", (req, socket, head) => {
      if (req.url === "/stall")
        socket.write("HTTP/1.1 101 Switching Protocols\r\n");
      else wss.handleUpgrade(req, socket, head, () => {});
    });
    const url = (path) =>
      f.base.replace(/^http:/, "ws:") +
      "/tiktok/tt-ws?url=" +
      encodeURIComponent(`ws://fixture.test:${f.port}${path}`);
    const stalled = new WebSocket(url("/stall"));
    stalled.on("error", () => {});
    await new Promise((resolve) => stalled.once("close", resolve));
    await nextTurn();
    const next = new WebSocket(url("/ok"));
    t.after(() => next.terminate());
    await once(next, "open");
    next.terminate();
  },
);

test(
  "TikTok: idle upgraded sockets expire without consuming a permanent slot",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t, "tiktok", {
      gateway: {
        wsLimits: { maxConcurrent: 1 },
        wsIdleTimeoutMs: 50,
      },
    });
    const wss = new WebSocketServer({ server: f.upstream });
    t.after(() => wss.close());
    const url =
      f.base.replace(/^http:/, "ws:") +
      "/tiktok/tt-ws?url=" +
      encodeURIComponent(`ws://fixture.test:${f.port}/ws`);
    const idle = new WebSocket(url);
    await once(idle, "open");
    await once(idle, "close");
    const next = new WebSocket(url);
    t.after(() => next.terminate());
    await once(next, "open");
    next.terminate();
  },
);

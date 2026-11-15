import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerImageProxy } from "../lib/image-proxy.js";
import { setImmediate as nextTurn } from "node:timers/promises";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("concurrent cover requests share one download and then use the cache", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  let calls = 0;
  let finish;
  const ready = new Promise((resolve) => {
    finish = resolve;
  });
  registerImageProxy(app, {
    download: async () => {
      calls++;
      await ready;
      return { mime: "image/png", bytes: Buffer.from("cover") };
    },
  });
  await app.ready();
  const url = "/img?url=https%3A%2F%2Fexample.com%2Fcover.png";
  const requests = Array.from({ length: 20 }, () => app.inject(url));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  finish();
  for (const response of await Promise.all(requests)) {
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, "cover");
    assert.equal(response.headers["content-type"], "image/png");
  }
  assert.equal((await app.inject(url)).body, "cover");
  assert.equal(calls, 1);
});

test("a failed cover download is released so the next request can retry", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  let calls = 0;
  registerImageProxy(app, {
    download: async () => {
      if (++calls === 1) throw new Error("unsupported image type");
      return { mime: "image/png", bytes: Buffer.from("retry") };
    },
  });
  const url = "/img?url=https%3A%2F%2Fexample.com%2Fretry.png";
  assert.equal((await app.inject(url)).statusCode, 415);
  assert.equal((await app.inject(url)).body, "retry");
  assert.equal(calls, 2);
});

test("artwork revalidates without a body and expires even while frequently accessed", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  let now = 1000;
  let calls = 0;
  registerImageProxy(app, {
    now: () => now,
    download: async () => ({
      mime: "image/png",
      bytes: Buffer.from(`cover-${++calls}`),
    }),
  });
  const url = "/img?url=https%3A%2F%2Fexample.com%2Fcover.png";
  const first = await app.inject(url);
  const headers = { "if-none-match": first.headers.etag };
  now += 23 * 60 * 60 * 1000;
  const unchanged = await app.inject({ url, headers });
  assert.equal(unchanged.statusCode, 304);
  assert.equal(unchanged.body, "");
  assert.equal(calls, 1);
  now += 60 * 60 * 1000;
  const changed = await app.inject({ url, headers });
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.body, "cover-2");
  assert.notEqual(changed.headers.etag, first.headers.etag);
});

test("a page of distinct covers queues behind a bounded number of downloads", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const gate = deferred();
  let active = 0;
  let peak = 0;
  let calls = 0;
  registerImageProxy(app, {
    limits: { maxConcurrent: 4, maxPerKey: 2 },
    download: async () => {
      calls++;
      peak = Math.max(peak, ++active);
      await gate.promise;
      active--;
      return { mime: "image/png", bytes: Buffer.from("cover") };
    },
  });
  await app.ready();
  const requests = Array.from({ length: 48 }, (_, i) =>
    app.inject({
      url: "/img?url=" + encodeURIComponent(`https://example.test/${i}.png`),
      remoteAddress: i % 2 ? "203.0.113.1" : "203.0.113.2",
    }),
  );
  await nextTurn();
  assert.equal(calls, 4);
  gate.resolve();
  for (const response of await Promise.all(requests))
    assert.equal(response.statusCode, 200);
  assert.equal(calls, 48);
  assert.equal(peak, 4);
});

test("image overload is non-cacheable and coalesced readers do not spend extra slots", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const gate = deferred();
  let calls = 0;
  registerImageProxy(app, {
    limits: { maxConcurrent: 1, maxPerKey: 1, maxQueued: 1 },
    download: async () => {
      calls++;
      await gate.promise;
      return { mime: "image/png", bytes: Buffer.from("cover") };
    },
  });
  await app.ready();
  const first = app.inject("/img?url=https://example.test/first.png");
  const shared = app.inject("/img?url=https://example.test/first.png");
  const queued = app.inject("/img?url=https://example.test/second.png");
  await nextTurn();
  const rejected = await app.inject("/img?url=https://example.test/third.png");
  assert.equal(rejected.statusCode, 503);
  assert.equal(rejected.headers["retry-after"], "1");
  assert.equal(rejected.headers["cache-control"], "no-store");
  assert.equal(calls, 1);
  gate.resolve();
  for (const response of await Promise.all([first, shared, queued]))
    assert.equal(response.statusCode, 200);
  assert.equal(calls, 2);
  assert.equal(
    (await app.inject("/img?url=https://example.test/third.png")).statusCode,
    200,
  );
});

test(
  "one disconnected reader keeps a shared image download alive; the last cancels it",
  { timeout: 5000 },
  async (t) => {
    const app = Fastify();
    t.after(() => app.close());
    const bothStarted = deferred();
    const firstClosed = deferred();
    const lastClosed = deferred();
    const cancelled = deferred();
    const lastStarted = deferred();
    const finish = deferred();
    let readers = 0;
    let downloadSignal;
    let calls = 0;
    app.addHook("onRequest", async (req, reply) => {
      if (++readers === 2) bothStarted.resolve();
      if (req.headers["x-reader"] === "first")
        reply.raw.once("close", firstClosed.resolve);
      if (req.headers["x-reader"] === "last")
        reply.raw.once("close", lastClosed.resolve);
    });
    registerImageProxy(app, {
      download: async (_url, { signal }) => {
        calls++;
        downloadSignal = signal;
        if (calls === 1) await finish.promise;
        else if (calls === 2)
          await new Promise((_, reject) => {
            lastStarted.resolve();
            signal.addEventListener(
              "abort",
              () => {
                cancelled.resolve();
                reject(signal.reason);
              },
              { once: true },
            );
          });
        return { mime: "image/png", bytes: Buffer.from("cover") };
      },
    });
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    const url = base + "/img?url=https://example.test/shared.png";
    const controller = new AbortController();
    const first = fetch(url, {
      headers: { "x-reader": "first" },
      signal: controller.signal,
    }).catch((error) => error);
    const second = fetch(url);
    await bothStarted.promise;
    await nextTurn();
    controller.abort();
    await first;
    await firstClosed.promise;
    assert.equal(downloadSignal.aborted, false);
    finish.resolve();
    assert.equal(await (await second).text(), "cover");
    assert.equal(calls, 1);

    const lastController = new AbortController();
    const last = fetch(base + "/img?url=https://example.test/cancelled.png", {
      headers: { "x-reader": "last" },
      signal: lastController.signal,
    }).catch((error) => error);
    // Wait for the downloader, not just the request headers, before disconnecting.
    await lastStarted.promise;
    lastController.abort();
    await last;
    await Promise.all([lastClosed.promise, cancelled.promise]);
    assert.equal(downloadSignal.aborted, true);
    const retry = await fetch(
      base + "/img?url=https://example.test/cancelled.png",
    );
    assert.equal(await retry.text(), "cover");
    assert.equal(calls, 3);
  },
);

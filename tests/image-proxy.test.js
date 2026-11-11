import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerImageProxy } from "../lib/image-proxy.js";

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

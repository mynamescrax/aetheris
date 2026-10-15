import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerGameAssets, validGameAsset, GAME_ASSET_REVISION } from "../lib/game-assets.js";

const path = "/game-assets/1games-rips/trackdash/game.data.unityweb";
const binary = Buffer.concat([Buffer.from("UnityWebData1.0\0"), Buffer.alloc(1024)]);
function fixture(options = {}) {
  const app = Fastify();
  registerGameAssets(app, options);
  return app;
}

test("game CDN rejects HTTP-200 errors and falls back only within jsDelivr", async () => {
  const urls = [];
  const app = fixture({ fetchimpl: async (url, options) => {
    urls.push(url);
    assert.equal(options.redirect, "error");
    assert.equal(options.headers, undefined, "visitor credentials are never forwarded");
    return urls.length === 1
      ? new Response("429: Too Many Requests", { status: 200 })
      : new Response(binary, { headers: { "Content-Encoding": "br", "Set-Cookie": "bad=1" } });
  }});
  try {
    const result = await app.inject(path);
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.rawPayload, binary);
    assert.equal(urls.length, 2);
    assert.ok(urls[0].includes("@" + GAME_ASSET_REVISION));
    assert.ok(urls[1].includes("@main/"));
    assert.ok(urls.every(url => url.startsWith("https://cdn.jsdelivr.net/gh/mynamescrax/1games-rips@")));
    assert.equal(result.headers["content-encoding"], undefined);
    assert.equal(result.headers["set-cookie"], undefined);
    await app.inject(path);
    assert.equal(urls.length, 2, "valid bytes are cached");
  } finally { await app.close(); }
});

test("failed assets return non-cacheable errors, not fake Unity data", async () => {
  let calls = 0;
  const app = fixture({ fetchimpl: async () => {
    calls++;
    return new Response("Failed to fetch repository", { status: 404 });
  }});
  try {
    const result = await app.inject(path);
    assert.equal(result.statusCode, 502);
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(calls, 2);
    assert.equal((await app.inject(path)).statusCode, 503);
    assert.equal(calls, 2, "a cooldown prevents retry storms");
  } finally { await app.close(); }
});

test("concurrent callers share an in-flight asset download", async () => {
  let calls = 0;
  const app = fixture({ fetchimpl: async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 10));
    return new Response(binary);
  }});
  try {
    const results = await Promise.all([app.inject(path), app.inject(path)]);
    assert.ok(results.every(result => result.statusCode === 200));
    assert.equal(calls, 1);
  } finally { await app.close(); }
});

test("sixteen split downloads queue without rejecting a normal large game", async () => {
  let active = 0, maximum = 0;
  const app = fixture({ fetchimpl: async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return new Response(binary);
  }});
  try {
    const results = await Promise.all(Array.from({ length: 16 }, (_, i) => app.inject(path + ".part" + (i + 1))));
    assert.ok(results.every(result => result.statusCode === 200));
    assert.ok(maximum <= 4);
  } finally { await app.close(); }
});

test("binary validation distinguishes first and later split chunks", () => {
  assert.equal(validGameAsset("x.data.unityweb", Buffer.from("429: Too Many Requests")), false);
  assert.equal(validGameAsset("x.data.unityweb", Buffer.alloc(1024)), false);
  assert.equal(validGameAsset("x.data.unityweb.part1", binary), true);
  assert.equal(validGameAsset("x.data.unityweb.part2", Buffer.alloc(1024)), true);
  assert.equal(validGameAsset("x.wasm.unityweb", Buffer.concat([Buffer.from([0,97,115,109]), Buffer.alloc(1024)])), true);
});

test("the CDN relay rejects encoded traversal and enforces its cache budget", async () => {
  let calls = 0;
  const app = fixture({ maxCacheBytes: 1, fetchimpl: async () => {
    calls++;
    return new Response(binary);
  }});
  try {
    const invalid = await app.inject("/game-assets/1games-rips/game/%2e%2e%2fsecret");
    assert.equal(invalid.statusCode, 400);
    assert.equal(calls, 0);
    await app.inject(path);
    await app.inject(path);
    assert.equal(calls, 2, "oversized entries are not retained");
  } finally { await app.close(); }
});

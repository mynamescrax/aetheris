import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { prepareJson, sendJson } from "../lib/cached-response.js";
import { registerGameCatalogs } from "../lib/game-catalogs.js";

test("cached JSON negotiates compression and conditional requests without changing data", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const data = Array.from({ length: 200 }, (_, id) => ({
    id,
    title: "A game with a cover",
  }));
  const prepared = await prepareJson(data);
  app.get("/catalog", (req, reply) =>
    sendJson(req, reply, prepared, "public, max-age=60"),
  );
  const identity = await app.inject("/catalog");
  assert.deepEqual(identity.json(), data);
  assert.equal(identity.headers.vary, "Accept-Encoding");
  for (const encoding of ["br", "gzip"]) {
    const response = await app.inject({
      url: "/catalog",
      headers: { "accept-encoding": encoding },
    });
    assert.equal(response.headers["content-encoding"], encoding);
    const decode = encoding === "br" ? brotliDecompressSync : gunzipSync;
    assert.deepEqual(JSON.parse(decode(response.rawPayload)), data);
    assert.ok(response.rawPayload.length < identity.rawPayload.length / 2);
    const unchanged = await app.inject({
      url: "/catalog",
      headers: {
        "accept-encoding": encoding,
        "if-none-match": `"other", ${identity.headers.etag.replace(/^W\//, "")}`,
      },
    });
    assert.equal(unchanged.statusCode, 304);
    assert.equal(unchanged.body, "");
    assert.equal(unchanged.headers.etag, identity.headers.etag);
  }
  const head = await app.inject({
    method: "HEAD",
    url: "/catalog",
    headers: { "accept-encoding": "br" },
  });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, "");
  assert.equal(
    head.headers["content-length"],
    String(prepared.variants.br.length),
  );
});

test("compression honors q=0, wildcard exclusions and preference weights", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const prepared = await prepareJson({ text: "compressible ".repeat(500) });
  app.get("/", (req, reply) =>
    sendJson(req, reply, prepared, "public, max-age=60"),
  );
  for (const [accept, expected] of [
    ["br;q=0, gzip", "gzip"],
    ["gzip;q=0.8, br;q=0.2, identity;q=0", "gzip"],
    ["br;q=0, *;q=1", "gzip"],
    ["gzip;q=0, br;q=0", undefined],
    ["br;q=bogus", undefined],
  ]) {
    const response = await app.inject({
      url: "/",
      headers: { "accept-encoding": accept },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-encoding"], expected, accept);
  }
  const refused = await app.inject({
    url: "/",
    headers: { "accept-encoding": "*;q=0" },
  });
  assert.equal(refused.statusCode, 406);
});

test("saved catalog serves compressed data and a bodyless revalidation", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  registerGameCatalogs(app);
  const url = "/api/games/catalog/gnmath";
  const responses = await Promise.all(
    Array.from({ length: 8 }, () =>
      app.inject({ url, headers: { "accept-encoding": "br" } }),
    ),
  );
  for (const response of responses) {
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-encoding"], "br");
    assert.ok(
      Array.isArray(JSON.parse(brotliDecompressSync(response.rawPayload))),
    );
    assert.equal(response.headers.etag, responses[0].headers.etag);
  }
  const response = await app.inject({
    url,
    headers: { "if-none-match": responses[0].headers.etag },
  });
  assert.equal(response.statusCode, 304);
  assert.equal(response.body, "");
});

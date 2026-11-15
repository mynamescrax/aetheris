import test from "node:test";
import assert from "node:assert/strict";
import { createTmdbClient } from "../lib/tmdb-client.js";

const url = (query = "") =>
  new URL(`https://api.example/3/trending/all/week?api_key=server${query}`);
const path = "trending/all/week";
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

test("concurrent movie catalogue requests share a fetch, compression and cached response", async () => {
  let calls = 0;
  let finish;
  const ready = new Promise((resolve) => {
    finish = resolve;
  });
  const data = {
    results: Array.from({ length: 200 }, (_, id) => ({
      id,
      title: "Movie title",
    })),
  };
  const client = createTmdbClient({
    fetcher: async () => {
      calls++;
      await ready;
      return json(data);
    },
  });
  const requests = Array.from({ length: 30 }, () =>
    client.request(url(), path),
  );
  assert.equal(calls, 1);
  finish();
  const results = await Promise.all(requests);
  assert.equal(results[0].cache, "miss");
  for (const result of results.slice(1)) {
    assert.equal(result.cache, "coalesced");
    assert.equal(result.prepared, results[0].prepared);
  }
  assert.deepEqual(JSON.parse(results[0].prepared.variants.identity), data);
  assert.ok(
    results[0].prepared.variants.br.length <
      results[0].prepared.variants.identity.length,
  );
  assert.equal((await client.request(url(), path)).cache, "hit");
  assert.equal(calls, 1);
});

test("cache keys normalize parameter order but keep language, page and query distinct", async () => {
  let calls = 0;
  const client = createTmdbClient({
    fetcher: async () => json({ count: ++calls }),
  });
  await client.request(url("&language=en&page=1"), path);
  assert.equal(
    (await client.request(url("&page=1&language=en"), path)).cache,
    "hit",
  );
  await client.request(url("&language=fr&page=1"), path);
  await client.request(url("&language=en&page=2"), path);
  assert.equal(calls, 3);
  for (const query of [
    "&session_id=one",
    "&guest_session_id=two",
    "&append_to_response=account_states",
  ])
    for (let i = 0; i < 2; i++)
      assert.equal(
        (await client.request(url(query), path)).prepared,
        undefined,
      );
  for (let i = 0; i < 2; i++) await client.request(url(), "account/123");
  assert.equal(
    calls,
    11,
    "personalized and unknown APIs never share cache entries",
  );
});

test("expiry and LRU limits refetch metadata instead of serving it indefinitely", async () => {
  let time = 0;
  let calls = 0;
  const client = createTmdbClient({
    now: () => time,
    ttl: 100,
    maxEntries: 2,
    fetcher: async () => json({ count: ++calls }),
  });
  await client.request(url("&page=1"), path);
  await client.request(url("&page=2"), path);
  assert.equal((await client.request(url("&page=1"), path)).cache, "hit");
  await client.request(url("&page=3"), path);
  assert.equal((await client.request(url("&page=2"), path)).cache, "miss");
  time = 101;
  assert.equal((await client.request(url("&page=2"), path)).cache, "miss");
  assert.equal(calls, 5);
  const tiny = createTmdbClient({
    maxBytes: 1,
    fetcher: async () => json({ count: ++calls }),
  });
  await tiny.request(url(), path);
  assert.equal(
    (await tiny.request(url(), path)).cache,
    "miss",
    "oversized entries bypass the cache",
  );
});

test("upstream failures and malformed JSON are retried, not stored as successful metadata", async () => {
  let calls = 0;
  const responses = [
    json({ error: "temporary" }, 503),
    new Response("bad json"),
    json({ success: false }),
    json({ results: [] }),
  ];
  const client = createTmdbClient({ fetcher: async () => responses[calls++] });
  assert.equal((await client.request(url(), path)).status, 503);
  assert.equal((await client.request(url(), path)).prepared, undefined);
  assert.equal((await client.request(url(), path)).prepared, undefined);
  assert.ok((await client.request(url(), path)).prepared);
  assert.equal((await client.request(url(), path)).cache, "hit");
  assert.equal(calls, 4);
});

test("concurrency pressure and rejected fetches release slots for later requests", async () => {
  let finish;
  const ready = new Promise((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  const client = createTmdbClient({
    maxConcurrent: 1,
    fetcher: async () => {
      if (++calls === 1) {
        await ready;
        throw new Error("offline");
      }
      return json({ results: [] });
    },
  });
  const first = client.request(url(), path);
  const failure = assert.rejects(first, /offline/);
  await assert.rejects(client.request(url("&page=2"), path), {
    code: "TMDB_BUSY",
  });
  finish();
  await failure;
  assert.equal((await client.request(url(), path)).status, 200);
  assert.equal(calls, 2);
});

test("metadata downloads enforce the byte limit for declared and streaming bodies", async () => {
  for (const headers of [{ "content-length": "1000" }, {}]) {
    let cancelled = false;
    const client = createTmdbClient({
      maxResponseBytes: 10,
      fetcher: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new TextEncoder().encode("12345678901"));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers },
        ),
    });
    await assert.rejects(client.request(url(), path), /size limit/);
    assert.equal(cancelled, true);
  }
});

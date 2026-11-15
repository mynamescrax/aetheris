// Offline microbenchmarks. These isolate hot paths; they do not measure whole
// request latency, disk I/O, or production upstream response times.
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createRateLimiter } from "../lib/rate-limit.js";
import { messagesAfter } from "../lib/chat-history.js";
import { createTmdbClient } from "../lib/tmdb-client.js";

// The previous fixed-window implementation, retained here only as a benchmark
// reference so results stay reproducible after the optimization is committed.
function fullScanLimiter({ maxEntries, now }) {
  const entries = new Map();
  return (key, limit, windowMs) => {
    const time = now();
    let entry = entries.get(key);
    if (!entry || entry.reset <= time) {
      if (entries.size >= maxEntries) {
        for (const [name, item] of entries)
          if (item.reset <= time) entries.delete(name);
        if (entries.size >= maxEntries && !entries.has(key))
          entries.delete(entries.keys().next().value);
      }
      entry = { used: 0, reset: time + windowMs };
      entries.set(key, entry);
    }
    entry.used++;
    return {
      allowed: entry.used <= limit,
      retryAfter: Math.max(1, Math.ceil((entry.reset - time) / 1000)),
    };
  };
}

function median(work) {
  work(); // warm up
  const runs = Array.from({ length: 5 }, work).sort((a, b) => a - b);
  return Number(runs[2].toFixed(2));
}

function limiterRun(factory) {
  const consume = factory({ maxEntries: 20_000, now: () => 1000 });
  for (let i = 0; i < 20_000; i++) consume(`seed:${i}`, 10, 60_000);
  let allowed = 0;
  const start = performance.now();
  for (let i = 0; i < 5000; i++)
    allowed += Number(consume(`new:${i}`, 10, 60_000).allowed);
  const elapsed = performance.now() - start;
  assert.equal(allowed, 5000);
  return elapsed;
}

const messages = Array.from({ length: 1000 }, (_, i) => ({
  time: i + 1,
  from: "other",
}));
function historyRun(select) {
  let found = 0;
  const start = performance.now();
  for (let i = 0; i < 100_000; i++) found += select(messages, 995).length;
  const elapsed = performance.now() - start;
  assert.equal(found, 500_000);
  return elapsed;
}

let downloads = 0;
const movies = createTmdbClient({
  fetcher: async () => {
    downloads++;
    await setImmediate();
    return new Response(
      JSON.stringify({ results: [{ id: 1, title: "Fixture" }] }),
    );
  },
});
await Promise.all(
  Array.from({ length: 100 }, () =>
    movies.request(
      new URL("https://fixture.invalid/3/trending/all/week?api_key=fixture"),
      "trending/all/week",
    ),
  ),
);
assert.equal(downloads, 1);

console.log(
  JSON.stringify(
    {
      rateLimiter: {
        workload: "5,000 new keys at 20,000-entry capacity",
        fullScanMedianMs: median(() => limiterRun(fullScanLimiter)),
        indexedExpiryMedianMs: median(() => limiterRun(createRateLimiter)),
      },
      chatPolling: {
        workload: "100,000 cursor lookups; 1,000 stored messages, 5 new",
        fullScanMedianMs: median(() =>
          historyRun((items, after) => items.filter((m) => m.time > after)),
        ),
        indexedMedianMs: median(() => historyRun(messagesAfter)),
      },
      movieMetadata: {
        simultaneousRequests: 100,
        upstreamDownloads: downloads,
      },
    },
    null,
    2,
  ),
);

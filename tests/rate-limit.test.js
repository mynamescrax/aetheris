import test from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "../lib/rate-limit.js";

test("indexed expiration preserves fixed-window limits and eviction order", () => {
  let time = 1000;
  const capacity = 17;
  const consume = createRateLimiter({ maxEntries: capacity, now: () => time });
  // Straightforward reference policy: expire windows, then evict the oldest
  // key only if necessary. Exercise varied TTLs and renewal at capacity.
  const reference = new Map();
  function expected(key, limit, windowMs) {
    let entry = reference.get(key);
    if (!entry || entry.reset <= time) {
      if (reference.size >= capacity) {
        for (const [name, item] of reference)
          if (item.reset <= time) reference.delete(name);
        if (reference.size >= capacity && !reference.has(key))
          reference.delete(reference.keys().next().value);
      }
      entry = { used: 0, reset: time + windowMs };
      reference.set(key, entry);
    }
    entry.used++;
    return {
      allowed: entry.used <= limit,
      retryAfter: Math.max(1, Math.ceil((entry.reset - time) / 1000)),
    };
  }
  let seed = 71;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let i = 0; i < 20000; i++) {
    const key = String(random() % 31);
    const limit = 1 + (random() % 5);
    const ttl = [50, 1000, 60000][random() % 3];
    time += random() % 29;
    assert.deepEqual(
      consume(key, limit, ttl),
      expected(key, limit, ttl),
      `request ${i}`,
    );
  }
});

test("expired short windows are removed before live long windows at capacity", () => {
  let time = 0;
  const consume = createRateLimiter({ maxEntries: 3, now: () => time });
  consume("long", 1, 60000);
  consume("short", 1, 10);
  consume("middle", 1, 5000);
  time = 11;
  assert.equal(consume("new", 1, 1000).allowed, true);
  assert.equal(consume("long", 1, 60000).allowed, false);
  assert.equal(consume("middle", 1, 5000).allowed, false);
  time = 60001;
  assert.equal(consume("long", 1, 60000).allowed, true);
  assert.equal(consume("long", 1, 60000).allowed, false);
});

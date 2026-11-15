import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createRelayLimiter } from "../lib/relay-limiter.js";
import { rawClientIp } from "../lib/client-ip.js";

function connection() {
  return { request: new EventEmitter(), response: new EventEmitter() };
}

test("relay slots survive handler return and release only once when the response ends", async () => {
  const enter = createRelayLimiter({ maxConcurrent: 1, maxQueued: 0 });
  const first = connection();
  const signal = await enter(first.request, first.response, "a");
  const blocked = connection();
  await assert.rejects(enter(blocked.request, blocked.response, "b"), {
    code: "WORK_BUSY",
  });
  assert.equal(signal.aborted, false);
  first.response.emit("finish");
  first.response.emit("close");
  assert.equal(signal.aborted, true);
  await nextTurn();
  for (const name of ["finish", "close", "error"])
    assert.equal(first.response.listenerCount(name), 0);
  const next = connection();
  await enter(next.request, next.response, "b");
  next.response.emit("close");
});

test("disconnected queued relay requests never gain admission", async () => {
  const enter = createRelayLimiter({ maxConcurrent: 1, maxQueued: 1 });
  const first = connection();
  await enter(first.request, first.response, "a");
  const second = connection();
  const pending = enter(second.request, second.response, "b");
  second.request.emit("aborted");
  await assert.rejects(pending, { name: "AbortError" });
  const replacement = connection();
  const admitted = enter(replacement.request, replacement.response, "c");
  first.response.emit("close");
  await admitted;
  replacement.response.emit("close");
});

test("raw relay IPs trust only the local proxy's rightmost validated hop", () => {
  const ip = (peer, forwarded) =>
    rawClientIp({
      socket: { remoteAddress: peer },
      headers: { "x-forwarded-for": forwarded },
    });
  assert.equal(ip("203.0.113.8", "192.0.2.1"), "203.0.113.8");
  assert.equal(ip("::ffff:203.0.113.8", "192.0.2.1"), "203.0.113.8");
  assert.equal(ip("127.0.0.1", "spoofed, 192.0.2.1"), "192.0.2.1");
  assert.equal(ip("::1", "192.0.2.1, ::ffff:192.0.2.2"), "192.0.2.2");
  assert.equal(ip("127.0.0.1", "not-an-ip"), "127.0.0.1");
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  setImmediate as nextTurn,
  setTimeout as wait,
} from "node:timers/promises";
import { createWorkLimiter } from "../lib/work-limiter.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("work limits bound running requests and reject an overflowing queue", async () => {
  const run = createWorkLimiter({
    maxConcurrent: 2,
    maxPerKey: 2,
    maxQueued: 1,
  });
  const gate = deferred();
  let active = 0;
  let peak = 0;
  const task = async () => {
    peak = Math.max(peak, ++active);
    await gate.promise;
    active--;
  };
  const requests = [run("a", task), run("b", task), run("c", task)];
  await assert.rejects(run("d", task), { code: "WORK_BUSY" });
  assert.equal(active, 2);
  gate.resolve();
  await Promise.all(requests);
  assert.equal(peak, 2);
  await run("e", task);
});

test("a queued busy IP does not prevent other IPs from using free slots", async () => {
  const run = createWorkLimiter({
    maxConcurrent: 2,
    maxPerKey: 1,
    maxQueuedPerKey: 1,
  });
  const gate = deferred();
  const calls = [];
  const first = run("a", async () => {
    calls.push("a1");
    await gate.promise;
  });
  const second = run("a", () => {
    calls.push("a2");
  });
  await assert.rejects(
    run("a", () => {}),
    { code: "WORK_BUSY" },
  );
  await run("b", () => {
    calls.push("b");
  });
  assert.deepEqual(calls, ["a1", "b"]);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ["a1", "b", "a2"]);
});

test("cancelled work leaves the queue and is never started", async () => {
  const run = createWorkLimiter({ maxConcurrent: 1, maxQueued: 1 });
  const gate = deferred();
  const first = run("a", () => gate.promise);
  const controller = new AbortController();
  let called = false;
  const queued = run(
    "b",
    () => {
      called = true;
    },
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(queued, { name: "AbortError" });
  const next = run("c", () => "next");
  gate.resolve();
  await first;
  assert.equal(await next, "next");
  assert.equal(called, false);
  await assert.rejects(
    run("b", () => {}, { signal: controller.signal }),
    { name: "AbortError" },
  );
});

test("failed and aborted running work releases its slot", async () => {
  const run = createWorkLimiter({ maxConcurrent: 1 });
  const controller = new AbortController();
  const failed = run("a", () => {
    throw new Error("fixture failure");
  });
  const aborted = run("b", () => "should not start", {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(aborted, { name: "AbortError" });
  await assert.rejects(failed, /fixture failure/);
  assert.equal(await run("c", () => "recovered"), "recovered");
  await nextTurn();
});

test("queue deadlines release capacity instead of pinning waiting requests", async () => {
  const run = createWorkLimiter({
    maxConcurrent: 1,
    maxQueued: 1,
    queueTimeoutMs: 10,
  });
  const gate = deferred();
  const first = run("a", () => gate.promise);
  let called = false;
  const queued = run("b", () => {
    called = true;
  });
  await Promise.all([assert.rejects(queued, { code: "WORK_BUSY" }), wait(25)]);
  const next = run("c", () => "next");
  gate.resolve();
  await first;
  assert.equal(await next, "next");
  assert.equal(called, false);
});

test("a zero-length queue still permits work that can start immediately", async () => {
  const run = createWorkLimiter({ maxConcurrent: 1, maxQueued: 0 });
  const gate = deferred();
  const first = run("a", () => gate.promise);
  await assert.rejects(
    run("b", () => {}),
    { code: "WORK_BUSY" },
  );
  gate.resolve();
  await first;
  assert.equal(await run("b", () => 2), 2);
});

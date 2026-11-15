// Local disk/JSON workload, not an HTTP throughput benchmark. Compare event-loop
// responsiveness and physical reads while servicing the same account polls.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createJsonStore } from "../lib/json-store.js";

const dir = await fs.mkdtemp(join(tmpdir(), "aetheris-storage-bench-"));
const polls = 200;
const concurrency = 8;
let reads = 0;
const store = await createJsonStore(dir, {
  io: {
    ...fs,
    readFile(...args) {
      reads++;
      return fs.readFile(...args);
    },
  },
});
const account = {
  username: "Fixture",
  sessions: {},
  dms: Object.fromEntries(
    ["alice", "bob"].map((name) => [
      name,
      Array.from({ length: 500 }, (_, i) => ({
        from: name,
        time: i + 1,
        message: "A chat message. ".repeat(16),
      })),
    ]),
  ),
};

async function measure(work) {
  let last = performance.now();
  let maxGap = 0;
  const timer = setInterval(() => {
    const time = performance.now();
    maxGap = Math.max(maxGap, time - last);
    last = time;
  }, 5);
  try {
    await delay(20);
    maxGap = 0;
    last = performance.now();
    const start = performance.now();
    const messages = await work();
    const elapsed = performance.now() - start;
    await delay(15);
    assert.equal(messages, polls * 500);
    return {
      elapsedMs: Number(elapsed.toFixed(2)),
      maxEventLoopDelayMs: Number(Math.max(0, maxGap - 5).toFixed(2)),
    };
  } finally {
    clearInterval(timer);
  }
}

try {
  await store.write("fixture", account);
  const path = join(dir, "fixture.json");
  const bytes = (await fs.stat(path)).size;
  await store.read("fixture");
  JSON.parse(readFileSync(path, "utf8"));
  const sync = await measure(() => {
    let total = 0;
    for (let i = 0; i < polls; i++)
      total += JSON.parse(readFileSync(path, "utf8")).dms.alice.length;
    return total;
  });
  reads = 0;
  const async = await measure(async () => {
    const totals = await Promise.all(
      Array.from({ length: concurrency }, async (_, worker) => {
        let total = 0;
        for (let i = worker; i < polls; i += concurrency)
          total += (await store.read("fixture")).dms.alice.length;
        return total;
      }),
    );
    return totals.reduce((a, b) => a + b, 0);
  });
  console.log(
    JSON.stringify(
      {
        workload: { polls, concurrency, recordBytes: bytes },
        sync: { ...sync, diskReads: polls },
        async: { ...async, diskReads: reads },
      },
      null,
      2,
    ),
  );
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}

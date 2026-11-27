import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lockDatabase } from "../lib/database-lock.js";

test("a second recovery process cannot touch a live writer's journal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aetheris-owner-"));
  const recover = () => spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/recover-storage.js", import.meta.url)), dir], { encoding: "utf8", timeout: 5000 });
  try {
    const release = await lockDatabase(dir);
    try {
      await mkdir(join(dir, ".transactions"));
      await writeFile(join(dir, "user.json"), '"in progress"');
      await writeFile(join(dir, ".transactions", "abc.pending.json"), JSON.stringify({ version: 1,
        records: [{ key: "user", before: '"before"', after: '"after"' }] }));
      const result = recover();
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /exclusive database lock/);
      assert.equal(await readFile(join(dir, "user.json"), "utf8"), '"in progress"');
    } finally {
      await release();
    }
    const result = recover();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(join(dir, "user.json"), "utf8"), '"before"');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJsonStore } from "../lib/json-store.js";
import { createGroupStore } from "../lib/groups.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), "aetheris-storage-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("JSON records retain their on-disk format and observe external changes", async (t) => {
  const dir = await fixture(t);
  const store = await createJsonStore(dir);
  const user = {
    username: "Example",
    sessions: { hash: { createdAt: 42 } },
    dms: { friend: [{ message: "hi", time: 1 }] },
  };
  await store.write("example", user);
  assert.deepEqual(
    JSON.parse(await fs.readFile(join(dir, "example.json"), "utf8")),
    user,
  );
  assert.deepEqual(await store.read("example"), user);
  await fs.writeFile(
    join(dir, "example.json"),
    JSON.stringify({ ...user, sessions: {} }),
  );
  assert.deepEqual((await store.read("example")).sessions, {});
  await fs.writeFile(join(dir, "unfinished.json.tmp"), "partial");
  await fs.mkdir(join(dir, "groups"));
  assert.deepEqual(await store.keys(), ["example"]);
  assert.equal(await store.read("missing"), null);
  await fs.writeFile(join(dir, "broken.json"), "{");
  assert.equal(await store.read("broken"), null);
  for (const key of ["../escape", "a/b", "a\\b", ""])
    await assert.rejects(store.write(key, {}), /Invalid record key/);
  await store.write("..", { username: ".." });
  assert.deepEqual(await store.read(".."), { username: ".." });
});

test("concurrent readers share one disk operation but get independent mutable records", async (t) => {
  const dir = await fixture(t);
  const gate = deferred();
  let reads = 0;
  const store = await createJsonStore(dir, {
    io: {
      ...fs,
      async readFile(...args) {
        reads++;
        await gate.promise;
        return fs.readFile(...args);
      },
    },
  });
  await store.write("user", { sessions: {}, dms: { friend: [] } });
  const requests = Array.from({ length: 30 }, () => store.read("user"));
  assert.equal(reads, 1);
  let eventLoopRan = false;
  await new Promise((resolve) =>
    setImmediate(() => {
      eventLoopRan = true;
      resolve();
    }),
  );
  assert.equal(
    eventLoopRan,
    true,
    "the event loop runs while disk access waits",
  );
  gate.resolve();
  const records = await Promise.all(requests);
  records[0].dms.friend.push({ message: "local mutation" });
  assert.equal(records[1].dms.friend.length, 0);
  assert.equal((await store.read("user")).dms.friend.length, 0);
  assert.equal(reads, 2, "a later read checks disk, not an auth cache");
});

test("a committed write invalidates an older in-flight read without losing the newer read", async (t) => {
  const dir = await fixture(t);
  const started = [deferred(), deferred()];
  const gates = [deferred(), deferred()];
  let reads = 0;
  const store = await createJsonStore(dir, {
    io: {
      ...fs,
      async readFile(...args) {
        const index = reads++;
        const text = await fs.readFile(...args);
        if (index < 2) {
          started[index].resolve();
          await gates[index].promise;
        }
        return text;
      },
    },
  });
  await store.write("user", { version: 1 });
  const old = store.read("user");
  await started[0].promise;
  await store.write("user", { version: 2 });
  const fresh = store.read("user");
  await started[1].promise;
  gates[0].resolve();
  assert.deepEqual(await old, { version: 1 });
  const sharedFresh = store.read("user");
  assert.equal(
    reads,
    2,
    "old read cleanup must not clear the new pending read",
  );
  gates[1].resolve();
  assert.deepEqual(await fresh, { version: 2 });
  assert.deepEqual(await sharedFresh, { version: 2 });
});

test("write completion waits for atomic replacement and readers never see a partial file", async (t) => {
  const dir = await fixture(t);
  const normal = await createJsonStore(dir);
  await normal.write("user", { version: 1 });
  const started = deferred();
  const gate = deferred();
  const store = await createJsonStore(dir, {
    io: {
      ...fs,
      async rename(...args) {
        started.resolve();
        await gate.promise;
        return fs.rename(...args);
      },
    },
  });
  let completed = false;
  const write = store.write("user", { version: 2 }).then(() => {
    completed = true;
  });
  await started.promise;
  assert.equal(completed, false);
  assert.deepEqual(await store.read("user"), { version: 1 });
  gate.resolve();
  await write;
  assert.deepEqual(await store.read("user"), { version: 2 });
  assert.deepEqual(await fs.readdir(dir), ["user.json"]);
});

test("failed writes retain the committed record and remove partial temporary files", async (t) => {
  const dir = await fixture(t);
  const normal = await createJsonStore(dir);
  await normal.write("user", { version: 1 });
  const fault = Object.assign(new Error("disk failure"), { code: "EIO" });
  for (const failure of [
    {
      rename: async () => {
        throw fault;
      },
    },
    {
      writeFile: async (path, text, options) => {
        await fs.writeFile(path, text.slice(0, 3), options);
        throw fault;
      },
    },
  ]) {
    const store = await createJsonStore(dir, { io: { ...fs, ...failure } });
    await assert.rejects(store.write("user", { version: 2 }), { code: "EIO" });
    assert.deepEqual(await normal.read("user"), { version: 1 });
    assert.deepEqual(await fs.readdir(dir), ["user.json"]);
  }
  await normal.write("user", { version: 3 });
  assert.deepEqual(await normal.read("user"), { version: 3 });
});

test("read/delete errors are not mistaken for missing accounts and rejected reads can retry", async (t) => {
  const dir = await fixture(t);
  const normal = await createJsonStore(dir);
  await normal.write("user", { username: "User" });
  const fault = Object.assign(new Error("permission denied"), {
    code: "EACCES",
  });
  let reads = 0;
  const store = await createJsonStore(dir, {
    io: {
      ...fs,
      async readFile(...args) {
        if (++reads === 1) throw fault;
        return fs.readFile(...args);
      },
      async unlink() {
        throw fault;
      },
    },
  });
  await assert.rejects(store.read("user"), { code: "EACCES" });
  assert.deepEqual(await store.read("user"), { username: "User" });
  await assert.rejects(store.remove("user"), { code: "EACCES" });
  assert.equal(await normal.exists("user"), true);
  await normal.remove("user");
  assert.equal(await normal.read("user"), null);
  await normal.remove("user");
});

test("group membership indices rebuild from the existing JSON format", async (t) => {
  const dir = await fixture(t);
  const store = await createGroupStore(dir);
  const id = await store.newId();
  const group = {
    id,
    name: "Friends",
    owner: "alice",
    members: ["alice", "bob"],
    messages: [{ from: "alice", message: "hi", time: 10 }],
    lastRead: { alice: 10 },
  };
  await store.write(group);
  const reopened = await createGroupStore(dir);
  assert.deepEqual(reopened.groupsOf("bob"), [id]);
  assert.deepEqual(await reopened.read(id), group);
  assert.equal(await reopened.read("../invalid"), null);
  await reopened.remove(id);
  await reopened.rebuild();
  assert.deepEqual(reopened.groupsOf("bob"), []);
});

test("a multi-record write is invisible until every record commits", async t => {
  const dir = await fixture(t);
  const entered = deferred(), finish = deferred();
  let hold = false;
  const store = await createJsonStore(dir, { io: {
    ...fs,
    async rename(from, to) {
      if (hold && to === join(dir, "bob.json")) {
        entered.resolve();
        await finish.promise;
      }
      return fs.rename(from, to);
    },
  } });
  await store.write("alice", { message: "before" });
  await store.write("bob", { message: "before" });
  hold = true;
  const commit = store.writeMany([["alice", { message: "after" }], ["bob", { message: "after" }]]);
  await entered.promise;
  let readFinished = false;
  const read = Promise.all([store.read("alice"), store.read("bob")]).then(records => { readFinished = true; return records; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(readFinished, false);
  finish.resolve();
  await commit;
  assert.deepEqual(await read, [{ message: "after" }, { message: "after" }]);
  assert.deepEqual(await fs.readdir(join(dir, ".transactions")), []);
});

test("a failed second record rolls both sides back and permits a safe retry", async t => {
  const dir = await fixture(t);
  let fail = false;
  const store = await createJsonStore(dir, { io: {
    ...fs,
    async rename(from, to) {
      if (fail && to === join(dir, "bob.json")) {
        fail = false;
        throw Object.assign(new Error("disk failure"), { code: "EIO" });
      }
      return fs.rename(from, to);
    },
  } });
  await store.write("alice", { count: 0 });
  await store.write("bob", { count: 0 });
  fail = true;
  await assert.rejects(store.writeMany([["alice", { count: 1 }], ["bob", { count: 1 }]]), { code: "EIO" });
  assert.deepEqual(await store.read("alice"), { count: 0 });
  assert.deepEqual(await store.read("bob"), { count: 0 });
  await store.writeMany([["alice", { count: 1 }], ["bob", { count: 1 }]]);
  assert.deepEqual(await store.read("alice"), { count: 1 });
  assert.deepEqual(await store.read("bob"), { count: 1 });
});

test("an uncertain rollback fails closed until startup recovers the journal", async t => {
  const dir = await fixture(t);
  const normal = await createJsonStore(dir);
  await normal.write("alice", { count: 0 });
  await normal.write("bob", { count: 0 });
  let failed = false;
  const store = await createJsonStore(dir, { io: {
    ...fs,
    async rename(from, to) {
      if (to === join(dir, "bob.json") || failed) {
        failed = true;
        throw Object.assign(new Error("disk unavailable"), { code: "EIO" });
      }
      return fs.rename(from, to);
    },
  } });
  await assert.rejects(store.writeMany([["alice", { count: 1 }], ["bob", { count: 1 }]]), { code: "EIO" });
  await assert.rejects(store.read("alice"), { code: "STORE_RECOVERY_REQUIRED" });
  await assert.rejects(store.write("charlie", {}), { code: "STORE_RECOVERY_REQUIRED" });
  const recovered = await createJsonStore(dir);
  assert.deepEqual(await recovered.read("alice"), { count: 0 });
  assert.deepEqual(await recovered.read("bob"), { count: 0 });
  assert.deepEqual(await fs.readdir(join(dir, ".transactions")), []);
});

test("committed journal recovery preserves both records after cleanup fails", async t => {
  const dir = await fixture(t);
  const store = await createJsonStore(dir, { io: {
    ...fs,
    async unlink(path) {
      if (path.endsWith(".committed.json")) throw Object.assign(new Error("cleanup unavailable"), { code: "EIO" });
      return fs.unlink(path);
    },
  } });
  await assert.rejects(store.writeMany([["alice", { count: 1 }], ["bob", { count: 1 }]]), { code: "EIO" });
  await assert.rejects(store.remove("alice"), { code: "STORE_RECOVERY_REQUIRED" });
  const recovered = await createJsonStore(dir);
  assert.deepEqual(await recovered.read("alice"), { count: 1 });
  assert.deepEqual(await recovered.read("bob"), { count: 1 });
});

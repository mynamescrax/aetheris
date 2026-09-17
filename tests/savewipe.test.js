import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function harness({ dbs = [], keys = {}, blocked = [] } = {}) {
  const store = new Map(Object.entries(keys));
  const storage = {
    get length() {
      return store.size;
    },
    key(i) {
      return Array.from(store.keys())[i] ?? null;
    },
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
  };
  const deleted = [];
  const context = {
    setTimeout,
    clearTimeout,
    localStorage: storage,
    sessionStorage: { cleared: false, clear() { this.cleared = true; } },
    indexedDB: {
      databases: () => Promise.resolve(dbs.map((name) => ({ name }))),
      deleteDatabase(name) {
        const req = {};
        setTimeout(() => {
          if (blocked.includes(name)) req.onblocked && req.onblocked();
          else {
            deleted.push(name);
            req.onsuccess && req.onsuccess();
          }
        }, 0);
        return req;
      },
    },
    Aetheris: {
      readList(key) {
        try {
          const value = JSON.parse(storage.getItem(key) || "[]");
          return Array.isArray(value) ? value.map(String) : [];
        } catch {
          return [];
        }
      },
    },
  };
  context.window = { addEventListener() {} };
  vm.runInNewContext(
    fs.readFileSync(
      new URL("../public/js/data-transfer.js", import.meta.url),
      "utf8",
    ),
    context,
  );
  return { api: context.window.AetherisBackup, storage, deleted, context };
}

test("wipe deletes game databases and keys, keeps site data", async () => {
  const { api, storage, deleted, context } = harness({
    dbs: ["/idbfs", "/userfs", "localforage", "$scramjet", "aetheris-games-cache"],
    keys: {
      "aetheris-theme": "dark",
      favoritedGames: '["1"]',
      dmToken: "secret",
      "track-progress": "level9",
      "somegame@save": "{}",
    },
  });
  const stages = [];
  const report = await api.wipe((s) => stages.push(s));

  assert.deepEqual(deleted.sort(), ["/idbfs", "/userfs", "localforage"]);
  assert.equal(report.databases, 3);
  assert.equal(report.keys, 2);
  assert.ok(stages.length > 0);
  // Site settings, favorites, and sessions survive.
  assert.equal(storage.getItem("aetheris-theme"), "dark");
  assert.equal(storage.getItem("favoritedGames"), '["1"]');
  assert.equal(storage.getItem("dmToken"), "secret");
  // Game keys are gone.
  assert.equal(storage.getItem("track-progress"), null);
  assert.equal(storage.getItem("somegame@save"), null);
  assert.equal(context.sessionStorage.cleared, true);
});

test("wipe fails loudly on a database held by another tab", async () => {
  const { api } = harness({ dbs: ["/idbfs"], blocked: ["/idbfs"] });
  await assert.rejects(api.wipe(), /another tab/);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function skey(key) {
  return typeof key + ":" + JSON.stringify(key);
}

// Minimal in-memory IndexedDB: databases, readonly/readwrite transactions,
// value cursors, and key deletes — everything the tracked-wipe flow uses.
function fakeIndexedDB(seed) {
  const dbs = new Map();
  for (const [db, stores] of Object.entries(seed)) {
    const m = new Map();
    for (const [s, rows] of Object.entries(stores))
      m.set(
        s,
        new Map(rows.map(([k, v]) => [skey(k), { key: k, value: v }])),
      );
    dbs.set(db, m);
  }
  function fire(fn) {
    setTimeout(fn, 0);
  }
  // Completion follows real IndexedDB semantics: the transaction completes
  // only after every request it served has finished.
  function makeTx() {
    return {
      oncomplete: null,
      onerror: null,
      onabort: null,
      error: null,
      _active: 0,
      _hold() {
        this._active++;
      },
      _release() {
        if (--this._active !== 0) return;
        const tx = this;
        fire(() => tx.oncomplete && tx.oncomplete());
      },
    };
  }
  function openCursor(storeMap, tx) {
    const req = {};
    const rows = Array.from(storeMap.values());
    let i = 0;
    tx._hold();
    (function step() {
      if (i >= rows.length) {
        req.result = null;
        fire(() => {
          req.onsuccess && req.onsuccess();
          tx._release();
        });
        return;
      }
      const row = rows[i++];
      req.result = {
        primaryKey: row.key,
        value: row.value,
        continue() {
          fire(step);
        },
      };
      fire(() => req.onsuccess && req.onsuccess());
    })();
    return req;
  }
  return {
    _dbs: dbs,
    databases: () =>
      Promise.resolve(Array.from(dbs.keys()).map((name) => ({ name }))),
    open(name) {
      const req = { result: null, error: null, transaction: null };
      fire(() => {
        if (!dbs.has(name)) {
          req.result = { objectStoreNames: [] };
          req.transaction = {
            abort() {
              const err = new Error("abort");
              err.name = "AbortError";
              fire(() => {
                req.error = err;
                req.onerror && req.onerror();
              });
            },
          };
          req.onupgradeneeded && req.onupgradeneeded();
          return;
        }
        const stores = dbs.get(name);
        req.result = {
          version: 1,
          objectStoreNames: Array.from(stores.keys()),
          close() {},
          transaction() {
            const tx = makeTx();
            tx.objectStore = (s) => ({
              openCursor: () => openCursor(stores.get(s), tx),
              delete(key) {
                const del = {};
                tx._hold();
                fire(() => {
                  stores.get(s).delete(skey(key));
                  del.onsuccess && del.onsuccess();
                  tx._release();
                });
                return del;
              },
            });
            return tx;
          },
        };
        req.onsuccess && req.onsuccess();
      });
      return req;
    },
  };
}

function harness(seed, lsKeys) {
  const store = new Map(Object.entries(lsKeys));
  const context = {
    setTimeout,
    clearTimeout,
    localStorage: {
      get length() {
        return store.size;
      },
      key: (i) => Array.from(store.keys())[i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => void store.set(k, String(v)),
      removeItem: (k) => void store.delete(k),
    },
    sessionStorage: { clear() {} },
    indexedDB: fakeIndexedDB(seed),
    Aetheris: { readList: () => [] },
  };
  context.window = { addEventListener() {} };
  vm.runInNewContext(
    fs.readFileSync(
      new URL("../public/js/data-transfer.js", import.meta.url),
      "utf8",
    ),
    context,
  );
  return { api: context.window.AetherisBackup, context, store };
}

function prefs(n) {
  return { timestamp: n, mode: 33206, contents: "save" + n };
}

test("tracked wipe deletes exactly the played game's footprint", async () => {
  const { api, context, store } = harness(
    {
      "/idbfs": {
        FILE_DATA: [
          ["/idbfs/aaa", { timestamp: 1, mode: 16877 }],
          ["/idbfs/aaa/PlayerPrefs", prefs(1)],
          ["/idbfs/aaa/oldfile", prefs(1)],
          ["/idbfs/bbb/PlayerPrefs", prefs(1)],
        ],
      },
      "/userfs": {
        FILE_DATA: [
          ["/userfs/godot/app_userdata/Crazy/save", prefs(1)],
          ["/userfs/godot/app_userdata/Crazy/old", prefs(1)],
        ],
      },
      localforage: { kv: [["other", 1]] },
    },
    {
      "aetheris-theme": "dark",
      gameA_level: "3",
      gameA_old: "x",
    },
  );
  const idb = context.indexedDB._dbs;

  await api.trackStart();
  // Simulate a play session touching exactly one Unity game, one Godot
  // game, and two storage keys.
  idb.get("/idbfs").get("FILE_DATA").get("string:\"/idbfs/aaa/PlayerPrefs\"").value =
    prefs(2);
  idb
    .get("/idbfs")
    .get("FILE_DATA")
    .set("string:\"/idbfs/aaa/newfile\"", {
      key: "/idbfs/aaa/newfile",
      value: prefs(2),
    });
  idb.get("/userfs").get("FILE_DATA").get(
    "string:\"/userfs/godot/app_userdata/Crazy/save\"",
  ).value = prefs(2);
  store.set("gameA_level", "4");
  store.set("gameA_score", "9000");

  const diff = await api.trackDiff();
  assert.equal(diff.records, 3);
  assert.equal(diff.keys, 2);
  assert.deepEqual(Array.from(diff.subtrees), [
    "/idbfs/aaa/",
    "/userfs/godot/app_userdata/Crazy/",
  ]);
  assert.equal(diff.lsPrefix, "gameA_");

  const report = await api.trackWipe();
  // Whole Unity subtree incl. the untouched old file, whole Godot folder.
  assert.equal(idb.get("/idbfs").get("FILE_DATA").size, 1);
  assert.ok(
    idb.get("/idbfs").get("FILE_DATA").has("string:\"/idbfs/bbb/PlayerPrefs\""),
  );
  assert.equal(idb.get("/userfs").get("FILE_DATA").size, 0);
  // Prefix expansion caught the untouched gameA_old too.
  assert.equal(store.has("gameA_level"), false);
  assert.equal(store.has("gameA_score"), false);
  assert.equal(store.has("gameA_old"), false);
  assert.equal(store.get("aetheris-theme"), "dark");
  // Untouched stores are intact.
  assert.equal(idb.get("localforage").get("kv").size, 1);
  assert.ok(report.records >= 6);
  assert.equal(report.keys, 3);

  // Single-use: wiping again without re-tracking fails loudly.
  await assert.rejects(api.trackWipe(), /Show what changed/);
});

test("empty diff reports nothing to wipe", async () => {
  const { api } = harness(
    { "/idbfs": { FILE_DATA: [["/idbfs/aaa/PlayerPrefs", prefs(1)]] } },
    { theme: "dark" },
  );
  await api.trackStart();
  const diff = await api.trackDiff();
  assert.equal(diff.records, 0);
  assert.equal(diff.keys, 0);
  await assert.rejects(api.trackWipe(), /nothing/i);
});

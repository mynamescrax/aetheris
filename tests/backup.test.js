import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function backup() {
  const context = {
    atob,
    btoa,
    Aetheris: {
      httpUrl(value) {
        try {
          const url = new URL(value);
          return url.protocol === "https:" ? url.href : null;
        } catch {
          return null;
        }
      },
      readList() {
        return [];
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
  return context.window.AetherisBackup;
}

function isDate(value) {
  // Values are constructed inside the vm realm, where outer instanceof
  // checks do not apply — same reason the production code avoids them.
  return Object.prototype.toString.call(value) === "[object Date]";
}

function fileRecord(timestamp) {
  return {
    $aetheris: "Object",
    value: [
      ["timestamp", timestamp],
      ["mode", 33206],
      [
        "contents",
        { $aetheris: "TypedArray", value: "AQID", ctor: "Uint8Array" },
      ],
    ],
  };
}

function fileStore(values) {
  return {
    keyPath: null,
    autoIncrement: false,
    indexes: [
      {
        name: "timestamp",
        keyPath: "timestamp",
        unique: false,
        multiEntry: false,
      },
    ],
    keys: values.map((_, i) => "k" + i),
    values,
  };
}

test("import normalizes degraded FILE_DATA timestamps and nothing else", () => {
  const api = backup();
  const prepared = api.prepare({
    format: "aetheris-backup",
    version: 2,
    localStorage: { theme: "dark" },
    indexedDB: {
      "/idbfs": {
        version: 21,
        stores: {
          FILE_DATA: fileStore([
            fileRecord(null),
            fileRecord("2020-05-01T00:00:00.000Z"),
            fileRecord({
              $aetheris: "Date",
              value: "2021-06-01T00:00:00.000Z",
            }),
            {
              $aetheris: "Object",
              value: [["mode", 33206]],
            },
          ]),
        },
      },
      other: {
        version: 1,
        stores: {
          kv: {
            keyPath: null,
            autoIncrement: false,
            indexes: [],
            keys: ["k"],
            values: [
              {
                $aetheris: "Object",
                value: [
                  ["timestamp", "2020-01-01T00:00:00.000Z"],
                  ["mode", 1],
                ],
              },
            ],
          },
        },
      },
    },
  });

  assert.equal(prepared.repaired, 3);
  const rows = prepared.databases["/idbfs"].stores.FILE_DATA.values;
  assert.ok(isDate(rows[0].timestamp));
  assert.equal(rows[1].timestamp.toISOString(), "2020-05-01T00:00:00.000Z");
  assert.equal(rows[2].timestamp.toISOString(), "2021-06-01T00:00:00.000Z");
  assert.ok(isDate(rows[3].timestamp));
  // Non-FILE_DATA stores keep whatever the game stored.
  const other = prepared.databases.other.stores.kv.values[0];
  assert.equal(other.timestamp, "2020-01-01T00:00:00.000Z");
  // Save contents still round-trip.
  assert.equal(
    Object.prototype.toString.call(rows[0].contents),
    "[object Uint8Array]",
  );
  assert.deepEqual(Array.from(rows[0].contents), [1, 2, 3]);
});

test("normalizeTimestamp only touches FILE_DATA-shaped records", () => {
  const api = backup();
  const good = { timestamp: new Date("2022-02-02T00:00:00.000Z"), mode: 1 };
  assert.equal(api.normalizeTimestamp(good), false);
  assert.equal(good.timestamp.toISOString(), "2022-02-02T00:00:00.000Z");

  const nulled = { timestamp: null, mode: 1 };
  assert.equal(api.normalizeTimestamp(nulled), true);
  assert.ok(isDate(nulled.timestamp));

  const missing = { mode: 16877 };
  assert.equal(api.normalizeTimestamp(missing), true);
  assert.ok(isDate(missing.timestamp));

  assert.equal(api.normalizeTimestamp(null), false);
  assert.equal(api.normalizeTimestamp([1, 2]), false);
  assert.equal(api.normalizeTimestamp({ timestamp: "x" }), false);
  assert.equal(api.normalizeTimestamp("2020-01-01"), false);
});

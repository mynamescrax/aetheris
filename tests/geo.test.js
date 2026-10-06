import test from "node:test";
import assert from "node:assert/strict";
import {
  countryflag,
  createGeoResolver,
  formattopcountries,
  isprivateip,
  normalizeip,
  topcountries,
} from "../lib/geo.js";

test("country flags and ip helpers", () => {
  assert.equal(countryflag("US"), "🇺🇸");
  assert.equal(countryflag("ie"), "🇮🇪");
  assert.equal(countryflag(""), "🏳️");
  assert.equal(normalizeip("::ffff:8.8.8.8"), "8.8.8.8");
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "192.168.0.5",
    "172.20.0.1",
    "::1",
    "fd00::1",
    "",
  ])
    assert.equal(isprivateip(ip), true, ip);
  for (const ip of ["8.8.8.8", "172.32.0.1", "2a00:1450::1"])
    assert.equal(isprivateip(ip), false, ip);
});

test("top countries ranks by count and caps at 5", () => {
  const c = (code, name) => ({ code, name });
  const list = [
    c("US", "United States"),
    c("US", "United States"),
    c("US", "United States"),
    c("IE", "Ireland"),
    c("IE", "Ireland"),
    c("GB", "United Kingdom"),
    c("DE", "Germany"),
    c("FR", "France"),
    c("CA", "Canada"),
    null,
  ];
  const top = topcountries(list, 5);
  assert.equal(top.length, 5);
  assert.deepEqual(
    top.slice(0, 2).map((t) => [t.code, t.count]),
    [
      ["US", 3],
      ["IE", 2],
    ],
  );
  assert.match(
    formattopcountries(top),
    /^1\. 🇺🇸 \*\*United States\*\* \(US\) — 3/,
  );
  assert.equal(formattopcountries([]), "No location data yet");
});

test("geo resolver batches, caches and skips private ips", async () => {
  const calls = [];
  const fetchImpl = async (_url, opts) => {
    const ips = JSON.parse(opts.body);
    calls.push(ips);
    return {
      ok: true,
      json: async () =>
        ips.map((query) => ({
          status: "success",
          query,
          countryCode: "IE",
          country: "Ireland",
        })),
    };
  };
  const geo = createGeoResolver({ fetchImpl });
  const r1 = await geo.resolve(["1.1.1.1", "::ffff:1.1.1.1", "127.0.0.1"]);
  assert.deepEqual(calls, [["1.1.1.1"]]);
  assert.deepEqual(r1.get("1.1.1.1"), { code: "IE", name: "Ireland" });
  assert.equal(r1.get("127.0.0.1"), null);
  await geo.resolve(["1.1.1.1"]);
  assert.equal(calls.length, 1, "cached ip should not be re-fetched");
});

test("geo resolver survives lookup failures", async () => {
  const geo = createGeoResolver({
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  const r = await geo.resolve(["8.8.8.8"]);
  assert.equal(r.get("8.8.8.8"), null);
});

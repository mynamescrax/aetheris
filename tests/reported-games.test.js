import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
const read = path => readFileSync(new URL(path, import.meta.url), "utf8");

test("Escape Road City 2 retains the supplied HTML and original Unity build", () => {
  const html = read("../public/assets/games/erc2.html");
  // The game is user-supplied. Fix the player, not its source or build version.
  assert.equal(createHash("sha256").update(html.replace(/\r\n/g, "\n")).digest("hex"),
    "d9e8e6b22fb8afa3885ba83138a2c01564b3293ec9cc6881a0c6026a497922ed");
  assert.match(html, /escape-road-city-2-v25022604\.loader\.js/);
  assert.doesNotMatch(html, /<iframe/i);
  const catalog = JSON.parse(read("../public/assets/data/aetheris.json"));
  const entry = catalog.find(item => item.id === "escaperoadcity2");
  assert.equal(entry.html, "assets/games/erc2.html");
  assert.notEqual(entry.noProxy, true);
});

test("repaired provider bookmarks resolve locally even when the provider catalog is unavailable", () => {
  const source = read("../public/js/load.js");
  const repairs = [
    ["https://truffled.lol/games/gta/index.html", "gta"],
    ["https://gn-math.github.io/html/410-fix.html", "telekinesisdrive"],
    ["https://velara.my/assets/games/onepiecefighting.html", "onepiecefighting"],
    ["https://velara.my/assets/games/1on1tennis.html", "1on1tennis"],
  ];
  const ctx = vm.createContext({
    appid: null, srcsource: null, srctitle: null,
    Aetheris: { httpUrl(value) { try { const u = new URL(value, "https://aetheris.win/"); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; } } },
    window: { games: repairs.map(([, id]) => ({ id, html: "assets/games/" + id + ".html" })) },
  });
  vm.runInContext(source.slice(source.indexOf("  function sourceurl("), source.indexOf("  function withtimeout(")) +
    source.slice(source.indexOf("  function slugify("), source.indexOf("  function setgameinfo(")), ctx);
  for (const [url, id] of repairs) {
    ctx.gameid = url;
    assert.equal(vm.runInContext("finditem().id", ctx), id);
    assert.equal(vm.runInContext("sourceurl({url: gameid})", ctx), "https://aetheris.win/assets/games/" + id + ".html");
  }
  ctx.gameid = "https://example.com/unknown";
  assert.equal(vm.runInContext("finditem()", ctx), null);
});

test("Yandere passes a JSON URL to UnityLoader and resolves build files outside the blob URL", async () => {
  const html = read("../public/assets/games/yanderesimulator.html");
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  let config, instantiated;
  const text = { textContent: "" };
  class GameURL extends URL { static createObjectURL(blob) { if (blob.type === "application/json") config = blob; return "blob:test"; } }
  vm.runInNewContext(script, {
    URL: GameURL, Blob, console,
    fetch: async () => new Response(new Uint8Array([1])),
    document: { baseURI: "https://cdn.jsdelivr.net/gh/bubblfan/web-port@master/yandere-simulator/", querySelector: () => text, getElementById: () => ({ style: {} }) },
    window: { addEventListener() {}, innerWidth: 800, innerHeight: 600 },
    UnityLoader: { instantiate(...args) { instantiated = args; } },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(instantiated[1], "blob:test");
  assert.equal(instantiated[2].Module.resolveBuildUrl("blob:game-data"), "blob:game-data");
  assert.match(instantiated[2].Module.streamingAssetsUrl(), /\/yandere-simulator\/StreamingAssets$/);
  const json = JSON.parse(await config.text());
  assert.match(json.wasmCodeUrl, /\/Build\/YandereSim\.wasm\.code\.unityweb$/);
  assert.match(json.wasmFrameworkUrl, /\/Build\/YandereSim\.wasm\.framework\.unityweb$/);
});

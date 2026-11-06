import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

test("popular games wrap using the shared responsive card grid", () => {
  const html = fs.readFileSync(new URL("../public/maths.html", import.meta.url), "utf8");
  const gamesCss = fs.readFileSync(new URL("../public/css/games.css", import.meta.url), "utf8");
  const cardsCss = fs.readFileSync(new URL("../public/css/cards.css", import.meta.url), "utf8");
  assert.match(html, /class="card-container" id="populargames"/);
  assert.match(cardsCss, /\.card-container\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(auto-fill,/);
  assert.doesNotMatch(gamesCss, /#populargames[^}]*grid-auto-flow:\s*column/);
  assert.doesNotMatch(gamesCss, /#populargames[^}]*overflow-x:\s*(?:auto|scroll)/);
  // the stamp itself is checked against the file by asset-stamps.test.js
  assert.match(html, /games\.css\?v=\d{8}\.\d+/);
});

test("proxy engine URLs carry a version so a cached bundle can't outlive a deploy", () => {
  const source = fs.readFileSync(
    new URL("../public/js/scramjet-init.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /var PROXY_ENGINE_VERSION = "\d{8}\.\d+"/);
  assert.match(source, /\/scramjet\/scramjet\.js\?v=" \+ PROXY_ENGINE_VERSION/);
  assert.match(
    source,
    /\/controller\/controller\.api\.js\?v=" \+ PROXY_ENGINE_VERSION/,
  );
});

test("YouTube page origins are routed around epoxy's HTTP/2 header limit", () => {
  // YouTube's HTML response headers exceed the 16 KB header-list size hyper
  // advertises, and epoxy's h2 client resets the stream. These page origins
  // go through libcurl instead; media/API hosts stay on the active transport.
  const source = fs.readFileSync(
    new URL("../public/js/scramjet-init.js", import.meta.url),
    "utf8",
  );
  const from = source.indexOf("var OVERSIZEDHEADERHOSTS =");
  const to = source.indexOf("function hostnameof");
  assert.ok(from !== -1 && to > from, "the host route is where we expect it");
  const context = {};
  vm.runInNewContext(
    source.slice(from, to) + "\nthis.hosts = OVERSIZEDHEADERHOSTS;",
    context,
  );
  for (const host of [
    "www.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "www.youtube-nocookie.com",
  ]) {
    assert.equal(context.hosts.test(host), true, `${host} must be routed`);
  }
  for (const host of [
    "googlevideo.com",
    "i.ytimg.com",
    "www.google.com",
    "notyoutube.com",
  ]) {
    assert.equal(context.hosts.test(host), false, `${host} must stay put`);
  }
});

test("a rewritten proxied body never keeps a stale content-length", async () => {
  const source = fs.readFileSync(
    new URL("../public/sw.js", import.meta.url),
    "utf8",
  );
  const from = source.indexOf("var EMPTY_STATUS =");
  const to = source.indexOf('// "Internal Service Worker Error');
  assert.ok(from !== -1 && to > from, "the length helper is where we expect it");
  const context = { Response, Headers };
  vm.runInNewContext(
    source.slice(from, to) + "\nthis.strip = stripcontentlength;",
    context,
  );
  const strip = context.strip;

  // Worker/script bodies are rewritten and grow; the upstream length is a
  // lie, and Firefox truncates the body to it (the Unity worker then never
  // starts). Chrome ignores the header, which is why only Firefox broke.
  const worker = new Response("importScripts(...); more code", {
    headers: { "content-length": "5", "content-type": "text/javascript" },
  });
  const stripped = strip(worker, {
    destination: "worker",
    url: "https://aetheris.test/~/sj/t/f/blob:https://aetheris.test/uuid",
  });
  assert.equal(stripped.headers.has("content-length"), false);
  assert.equal(await stripped.text(), "importScripts(...); more code");

  // A blob script is rewritten even when the browser reports no destination.
  const blob = new Response("code", {
    headers: { "content-length": "1" },
  });
  assert.equal(
    strip(blob, {
      destination: "",
      url: "https://aetheris.test/~/sj/t/f/blob:https://aetheris.test/uuid",
    }).headers.has("content-length"),
    false,
  );

  // Binary passthrough keeps its length so Unity can show progress.
  const binary = new Response("unityweb", {
    headers: { "content-length": "8", "content-type": "application/vnd.unity" },
  });
  const kept = strip(binary, {
    destination: "",
    url: "https://aetheris.test/s/x/y",
  });
  assert.equal(kept, binary);
  assert.equal(kept.headers.get("content-length"), "8");

  const empty = new Response(null, { status: 204 });
  assert.equal(strip(empty, { destination: "script", url: "x" }), empty);
});

test("proxied pages block ad networks the light list leaves out", () => {
  const source = fs.readFileSync(
    new URL("../public/sw.js", import.meta.url),
    "utf8",
  );
  const from = source.indexOf("var AD_HOSTS_BUILTIN");
  const to = source.indexOf("// /~/sj/<tab id>");
  assert.ok(from !== -1 && to > from, "the built-in ad hosts are where we expect them");
  const context = {
    SITE_HOST: "aetheris.test",
    adhosts: new Set(["tracker.example"]),
  };
  vm.runInNewContext(
    "var adhosts = this.adhosts;\n" +
      "var SITE_HOST = this.SITE_HOST;\n" +
      source.slice(from, to) +
      "\nthis.isadhost = isadhost;",
    context,
  );
  const isadhost = context.isadhost;
  for (const host of [
    "securepubads.g.doubleclick.net",
    "pagead2.googlesyndication.com",
    "imasdk.googleapis.com",
    "ads.pubmatic.com",
    "cdn.applovin.com",
    "pl28758395.profitablecpmratenetwork.com",
    "x.tracker.example",
    "analytics.tracker.example",
  ])
    assert.equal(isadhost(host), true, host);
  assert.equal(isadhost("cdn.jsdelivr.net"), false);
  assert.equal(isadhost("aetheris.test"), false);
  assert.equal(isadhost("game-cdn.poki.com"), false);
});

function helpers(initial = {}, blocked = false) {
  const data = new Map(Object.entries(initial));
  const storage = {
    getItem(key) {
      if (blocked) throw new Error("Storage disabled");
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      if (blocked) throw new Error("Storage disabled");
      data.set(key, String(value));
    },
    removeItem(key) {
      if (blocked) throw new Error("Storage disabled");
      data.delete(key);
    },
  };
  const context = {
    URL,
    URLSearchParams,
    localStorage: storage,
    sessionStorage: storage,
    location: {
      href: "https://aetheris.test/index.html",
      origin: "https://aetheris.test",
    },
    document: {
      addEventListener() {},
      documentElement: { style: { setProperty() {} }, classList: { add() {} } },
    },
  };
  context.window = context;
  context.parent = context;
  context.addEventListener = () => {};
  context.innerHeight = 1180;
  vm.runInNewContext(
    fs.readFileSync(new URL("../public/js/site.js", import.meta.url), "utf8"),
    context,
  );
  return context.Aetheris;
}

test("shared URL validation rejects missing values and unsafe schemes", () => {
  const site = helpers();
  for (const input of [
    undefined,
    null,
    "",
    "   ",
    123,
    "javascript:alert(1)",
    "data:text/html,bad",
    "https://user:pass@example.com/",
  ])
    assert.equal(site.httpUrl(input), null);
  assert.equal(
    site.httpUrl("/load.html?game=abc"),
    "https://aetheris.test/load.html?game=abc",
  );
});

test("routes retain game/search arguments and reject unknown pages or origins", () => {
  const site = helpers();
  assert.equal(
    site.parseRoute("#load?game=two+words").url,
    "load.html?game=two+words",
  );
  assert.equal(
    site.routeForUrl("https://aetheris.test/search.html?q=hello%20world").route,
    "search?q=hello+world",
  );
  for (const value of ["__proto__", "../settings", "javascript:alert(1)"])
    assert.equal(site.parseRoute(value), null);
  assert.equal(
    site.routeForUrl("https://different.example/load.html?game=abc"),
    null,
  );
});

test("favorites tolerate malformed storage and normalize numeric IDs", () => {
  assert.equal(
    JSON.stringify(
      helpers({ favorites: '[1,"1","a",null,{}]' }).readList("favorites"),
    ),
    '["1","a"]',
  );
  assert.equal(
    JSON.stringify(helpers({ favorites: "broken JSON" }).readList("favorites")),
    "[]",
  );
  const site = helpers({}, true);
  assert.equal(site.storage.setItem("value", "temporary"), false);
  assert.equal(site.storage.getItem("value"), "temporary");
  site.storage.removeItem("value");
  assert.equal(site.storage.getItem("value"), null);
});

test("remote images route through the same-origin relay", () => {
  const site = helpers();
  const remote = "https://truffled.lol/png/games/1.webp";
  assert.equal(site.imageUrl(remote), "/img?url=" + encodeURIComponent(remote));
  assert.equal(
    site.imageUrl("//cdn.example/cover.png"),
    "/img?url=" + encodeURIComponent("https://cdn.example/cover.png"),
  );
  assert.equal(
    site.imageUrl("/assets/ui/placeholder.svg"),
    "https://aetheris.test/assets/ui/placeholder.svg",
  );
  assert.equal(
    site.imageUrl("data:image/png;base64,AAAA"),
    "data:image/png;base64,AAAA",
  );
  // values the relay cannot use are passed through unchanged (img ignores them)
  assert.equal(site.imageUrl("javascript:alert(1)"), "javascript:alert(1)");
  assert.equal(site.imageUrl(""), "");
  assert.equal(site.imageUrl(undefined), undefined);
});

test("the player recognizes proxy failure documents without rejecting ordinary text games", () => {
  const source = fs.readFileSync(new URL("../public/js/load.js", import.meta.url), "utf8");
  const start = source.indexOf("  function proxyerrortext(");
  const end = source.indexOf("\n  var SOURCE_LABELS", start);
  const context = {};
  vm.runInNewContext(source.slice(start, end) + "\nthis.errorText = proxyerrortext;", context);
  for (const text of ["Internal Service Worker Error: TLS rejected", "Proxy unavailable"]) {
    assert.equal(context.errorText({ contentType: "text/plain", body: { textContent: text } }), text);
    assert.equal(context.errorText({ contentType: "text/html", body: { textContent: text } }), "");
  }
  assert.equal(context.errorText({ contentType: "text/plain", body: { textContent: "Welcome to a text adventure" } }), "");
  assert.equal(context.errorText(null), "");
});

test("Poki lifecycle survives a later SDK assignment without starting its broken ad backend", async () => {
  const source = fs.readFileSync(new URL("../public/js/ad-spoof.js", import.meta.url), "utf8");
  const window = { location: { search: "?level=3" } };
  vm.runInNewContext(source, { window, setTimeout, URLSearchParams });
  await window.PokiSDK.init();
  window.PokiSDK = { init() { throw new Error("missing IMA"); }, custom: 42 };
  window.PokiSDK.init = () => { throw new Error("late SDK mutation"); };
  window.PokiSDK.gameLoadingFinished = () => { throw new Error("uninitialized backend"); };
  await window.PokiSDK.init();
  await window.PokiSDK.initWithVideoHB();
  await window.PokiSDK.commercialBreak();
  assert.equal(await window.PokiSDK.rewardedBreak(), false);
  assert.equal(window.PokiSDK.getURLParam("level"), "3");
  assert.equal(window.PokiSDK.custom, 42);
  window.PokiSDK.gameLoadingFinished();
});

test("relative proxy asset URLs recover the originating game directory and query", async () => {
  const source = fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  const from = source.indexOf("function hasrequestbody(");
  const to = source.indexOf("var recoveryhtml", from);
  const prefix = "https://site.example/~/sj/tab/frame/";
  const base = "https://games.example/subdir/index.html";
  const referrer = prefix + encodeURIComponent(base);
  const context = { URL, spoofdesktopua: false, self: { clients: { get: async () => ({ url: referrer }) } } };
  vm.runInNewContext(source.slice(from, to) + "\nthis.repair = repairrelativeproxyurl; this.build = buildrouteevent;", context);
  const request = new Request(prefix + "assets/font/test.woff2?h=123");
  const expected = prefix + encodeURIComponent("https://games.example/subdir/assets/font/test.woff2?h=123");
  assert.equal(context.repair(request.url, referrer), expected);
  const event = { request, clientId: "frame-client" };
  const routed = await context.build(event);
  assert.equal(routed.request.url, expected);
  for (const target of [prefix + "scramjet.wasm.js", prefix + encodeURIComponent("https://remote.example/x"), prefix + "blob:https://site.example/id"]) {
    assert.equal(context.repair(target, referrer), null);
  }
  assert.equal(context.repair(request.url, "https://unrelated.example/index.html"), null);
  assert.equal(context.repair(request.url, prefix.replace("/frame/", "/other/") + encodeURIComponent(base)), null);
});

test("player accepts iframe-only catalog entries", () => {
  const source = fs.readFileSync(
    new URL("../public/js/load.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /source\.url \|\| source\.html \|\| source\.iframe/);
  // flat records that predate the merged `sources` list still work.
  assert.match(source, /iframe: entry\.iframe/);
});

test("the player refreshes its source list as catalogs merge in", () => {
  const source = fs.readFileSync(
    new URL("../public/js/load.js", import.meta.url),
    "utf8",
  );
  // The catalog promise resolves after the first source, so a game can gain
  // provider copies later. The player must extend the swap cycle instead of
  // freezing the sources it happened to have at that moment.
  assert.match(source, /addEventListener\("gamesupdated", refreshsources\)/);
  assert.match(source, /addEventListener\("gamesloaded", refreshsources\)/);
  assert.match(source, /attempts = next/);
  assert.match(
    source,
    /refreshsources\(\);\s+var failed = attempts\[attemptindex\]/,
  );
});

// Loads the real service worker in a VM with just enough of the worker
// global to evaluate its top-level code, so its string builders and helpers
// can be exercised without a browser.
function loadswRuntime(userAgent, adspoofSource) {
  const source = fs.readFileSync(
    new URL("../public/sw.js", import.meta.url),
    "utf8",
  );
  const context = {
    console: { log() {}, warn() {}, error() {} },
    navigator: { userAgent },
    self: {
      location: {
        origin: "https://aetheris.test",
        hostname: "aetheris.test",
      },
      addEventListener() {},
      skipWaiting() {},
      clients: { claim() {} },
    },
    caches: {
      open: () =>
        Promise.resolve({
          match: () => Promise.resolve(null),
          put: () => Promise.resolve(),
        }),
    },
    importScripts() {},
    fetch: () =>
      Promise.resolve({
        ok: Boolean(adspoofSource),
        text: () => Promise.resolve(adspoofSource || ""),
      }),
    setTimeout,
    clearTimeout,
    Headers,
    Response,
    URL,
    ReadableStream,
    TextDecoder,
    TextEncoder,
  };
  context.window = context;
  vm.runInNewContext(source, context);
  return context;
}

test("desktop UA spoof follows the real Chrome major and keeps hints consistent", async () => {
  const chromium = loadswRuntime(
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
  );
  assert.equal(chromium.spoofchromemajor, "154");
  assert.match(chromium.desktopua, /Chrome\/154\.0\.0\.0/);
  assert.match(chromium.spoofuach, /"Google Chrome";v="154"/);

  // Safari/iPad borrows no Chrome version, so the fallback must be a modern
  // one and must be identical in the header value and the injected shim.
  const safari = loadswRuntime(
    "Mozilla/5.0 (iPad; CPU OS 15_3 like Mac OS X) AppleWebKit/605.1.15 " +
      "(KHTML, like Gecko) Version/15.3 Mobile/15E148 Safari/604.1",
  );
  const fallback = Number(safari.spoofchromemajor);
  assert.ok(
    Number.isInteger(fallback) && fallback >= 130,
    "fallback Chrome major should stay recent",
  );
  assert.match(safari.desktopua, new RegExp("Chrome/" + fallback + "\\.0\\.0\\.0"));
  assert.match(
    safari.spoofuachfull,
    new RegExp('"Google Chrome";v="' + fallback + '\\.0\\.0\\.0"'),
  );

  function runshim(sw) {
    const body = sw.desktopuashim
      .replace(/^<script>/, "")
      .replace(/<\/script>$/, "");
    function Navigator() {}
    const nav = Object.create(Navigator.prototype);
    vm.runInNewContext(body, {
      window: {},
      navigator: nav,
      Navigator,
      console: { log() {}, warn() {}, error() {} },
    });
    return nav;
  }

  const nav = runshim(safari);
  assert.match(nav.userAgent, new RegExp("Chrome/" + fallback + "\\.0\\.0\\.0"));
  assert.equal(nav.userAgentData.brands[1].brand, "Google Chrome");
  assert.equal(nav.userAgentData.brands[1].version, String(fallback));
  const hints = await nav.userAgentData.getHighEntropyValues(["uaFullVersion"]);
  assert.equal(hints.uaFullVersion, fallback + ".0.0.0");
});

test("game clock shim shifts Date and follows the stored offset", () => {
  const sw = loadswRuntime("Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36");
  const body = sw.gameclockshim
    .replace(/^<script>/, "")
    .replace(/<\/script>$/, "");
  const stored = { gameClockOffsetMs: String(2 * 86400000 + 3600000) };
  const window = { Date };
  vm.runInNewContext(body, {
    window,
    localStorage: { getItem: (key) => stored[key] ?? null },
    console: { log() {}, warn() {}, error() {} },
  });

  const FakeDate = window.Date;
  assert.ok(FakeDate);
  assert.ok(new FakeDate() instanceof FakeDate);
  assert.ok(new FakeDate() instanceof Date);
  assert.equal(new FakeDate(2020, 0, 1).getFullYear(), 2020);
  assert.equal(typeof FakeDate(), "string");

  const real = Date.now();
  const shift = FakeDate.now() - real;
  assert.ok(Math.abs(shift - (2 * 86400000 + 3600000)) < 5000);
  const instanceShift = new FakeDate().getTime() - Date.now();
  assert.ok(Math.abs(instanceShift - (2 * 86400000 + 3600000)) < 5000);
});

test("audio unlock shim only logs when debugging is switched on", () => {
  const sw = loadswRuntime("Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36");
  const body = sw.audiounlockshim
    .replace(/^<script>/, "")
    .replace(/<\/script>$/, "");

  function runshim(store) {
    const logged = [];
    function AudioContext() {
      this.state = "suspended";
      this.sampleRate = 48000;
      this.destination = {};
    }
    AudioContext.prototype.createBuffer = () => ({});
    AudioContext.prototype.createBufferSource = function () {
      return { buffer: null, connect() {}, start() {} };
    };
    AudioContext.prototype.resume = () => Promise.resolve();
    AudioContext.prototype.addEventListener = function () {};
    const document = {
      addEventListener() {},
      querySelectorAll: () => [],
      documentElement: {},
      visibilityState: "visible",
      hidden: false,
    };
    const window = { AudioContext, addEventListener() {} };
    vm.runInNewContext(body, {
      window,
      document,
      navigator: { userAgent: "Mozilla/5.0 Chrome/150.0.0.0" },
      localStorage: { getItem: (key) => store[key] ?? null },
      console: { log: (...args) => logged.push(args) },
      setInterval: () => 0,
      clearInterval() {},
      MutationObserver: class {
        observe() {}
      },
    });
    return { logged, window };
  }

  const quiet = runshim({});
  assert.equal(quiet.window.__aetherisAudioUnlockInstalled, true);
  assert.equal(quiet.logged.length, 0, "no [audio-dbg] noise by default");

  const loud = runshim({ aetherisAudioDebug: "1" });
  assert.ok(
    loud.logged.some((args) => String(args[0]).includes("[audio-dbg]")),
    "the opt-in flag brings the trace back",
  );
});

test("Firefox emulator ROM caching stays below the IndexedDB record limit", async () => {
  const sw = loadswRuntime("Firefox/135.0", "");
  const response = sw.injecthtmlshims(new Response("<html><head></head></html>", {
    headers: { "content-type": "text/html" },
  }), {});
  const html = await response.text();
  const shim = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).find(script => script.includes("EJS_CacheLimit"));
  assert.ok(shim);
  for (const [userAgent, initial, expected] of [
    ["Firefox/135.0", undefined, 128 * 1024 * 1024],
    ["Firefox/135.0", 1024, 1024],
    ["Chrome/135.0", undefined, undefined],
  ]) {
    const window = { EJS_CacheLimit: initial };
    vm.runInNewContext(shim, { window, navigator: { userAgent } });
    assert.equal(window.EJS_CacheLimit, expected);
  }
});

test("html shim injection streams and inserts at the same point", async () => {
  const adspoofSource = "(function(){window.__adSpoofInstalled=true})();";
  const sw = loadswRuntime(
    "Mozilla/5.0 (iPad; CPU OS 15_3 like Mac OS X) Safari/604.1",
    adspoofSource,
  );

  function html(body, extraHeaders) {
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ...extraHeaders,
      },
    });
  }

  // Head found in the first chunk: shims go directly after <head>, the body
  // is streamed, and the stale length header is dropped.
  let res = sw.injecthtmlshims(
    html(
      "<!doctype html><html><head><title>x</title></head><body>hi</body></html>",
      { "Content-Length": "1000" },
    ),
    {},
  );
  let out = await res.text();
  assert.equal(
    out.indexOf("<script>"),
    out.indexOf("<head>") + "<head>".length,
  );
  assert.ok(out.includes("__aetherisCookieEnabledShimInstalled"));
  assert.ok(out.includes("__aetherisPanicInstalled"));
  assert.ok(out.includes("/js/ad-spoof.js"));
  assert.ok(out.endsWith("</body></html>"));
  assert.equal(res.headers.get("content-length"), null);

  // The insertion tag may be split across stream chunks.
  const chunks = ["<!doctype html><ht", "ml><bo", "dy>hi</body></html>"];
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks)
        controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  res = sw.injecthtmlshims(
    new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/html" },
    }),
    {},
  );
  out = await res.text();
  assert.equal(
    out.indexOf("<script>"),
    out.indexOf("<html>") + "<html>".length,
  );

  // No <head>/<html> anywhere: shims first, matching the old fallback.
  res = sw.injecthtmlshims(html("just text"), {});
  out = await res.text();
  assert.ok(out.startsWith("<script>"));
  assert.ok(out.endsWith("just text"));

  // Non-HTML and non-200 responses are passed through untouched.
  const json = new Response("{}", {
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(sw.injecthtmlshims(json, {}), json);
  const error = new Response("<html></html>", {
    status: 500,
    headers: { "Content-Type": "text/html" },
  });
  assert.equal(sw.injecthtmlshims(error, {}), error);

  // Desktop-UA mode adds the spoof shim; plain mode does not.
  res = sw.injecthtmlshims(
    html("<html><head></head><body></body></html>"),
    { desktopua: true },
  );
  out = await res.text();
  assert.ok(out.includes("__aetherisDesktopUASpoofInstalled"));
  res = sw.injecthtmlshims(
    html("<html><head></head><body></body></html>"),
    {},
  );
  out = await res.text();
  assert.ok(!out.includes("__aetherisDesktopUASpoofInstalled"));

  // Game pages get the clock shim before the other shims; proxied pages
  // and pages without the option do not.
  res = sw.injecthtmlshims(
    html("<html><head></head><body></body></html>"),
    { gameclock: true },
  );
  out = await res.text();
  assert.ok(out.includes("__aetherisGameClockInstalled"));
  assert.ok(out.includes("gameClockOffsetMs"));
  assert.ok(
    out.indexOf("__aetherisGameClockInstalled") <
      out.indexOf("__aetherisPanicInstalled"),
  );

  // Once the ad-spoof source has warmed it is inlined instead of loaded from
  // /js/ad-spoof.js, so proxied pages have no local <script src> to trip
  // scramjet's URL getters over.
  await new Promise((resolve) => setImmediate(resolve));
  res = sw.injecthtmlshims(
    html("<html><head></head><body></body></html>"),
    {},
  );
  out = await res.text();
  assert.ok(!out.includes("__aetherisGameClockInstalled"));
  assert.ok(out.includes("__adSpoofInstalled"));
  assert.ok(!out.includes("/js/ad-spoof.js"));
});

test("navigation fallback is absolute and modified clicks are left to the browser", () => {
  const listeners = {};
  const location = {
    origin: "https://aetheris.test",
    href: "https://aetheris.test/foo/bar",
  };
  const context = {
    document: {
      addEventListener(type, handler) {
        listeners[type] = handler;
      },
    },
    location,
    console: { error() {} },
  };
  context.window = context;
  context.parent = context;
  context.self = context;
  context.top = context;
  vm.runInNewContext(
    fs.readFileSync(
      new URL("../public/js/navigation.js", import.meta.url),
      "utf8",
    ),
    context,
  );

  // Uncoupled page (served as 404.html for nested URLs): go home absolutely.
  context.gotoapp("home");
  assert.equal(location.href, "/index.html#home");

  const click = (overrides) => {
    let prevented = false;
    listeners.click({
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      target: { closest: () => ({ getAttribute: () => "./about.html" }) },
      preventDefault() {
        prevented = true;
      },
      ...overrides,
    });
    return prevented;
  };

  // Ctrl/Cmd-click must reach the browser so it can open a new tab.
  assert.equal(click({ metaKey: true }), false);
  assert.equal(click({ ctrlKey: true }), false);

  // Inside the shell, mapped links route through the parent frame.
  let routed = "";
  context.parent = {
    navigateApp(page) {
      routed = page;
    },
  };
  context.self = { frame: true };
  assert.equal(click({}), true);
  assert.equal(routed, "about");
});

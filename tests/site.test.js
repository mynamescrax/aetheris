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
  assert.match(html, /games\.css\?v=20261015\.3/);
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

test("player accepts iframe-only catalog entries", () => {
  const source = fs.readFileSync(
    new URL("../public/js/load.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /item\.url \|\| item\.html \|\| item\.iframe/);
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

  // Once the ad-spoof source has warmed it is inlined instead of loaded from
  // /js/ad-spoof.js, so proxied pages have no local <script src> to trip
  // scramjet's URL getters over.
  await new Promise((resolve) => setImmediate(resolve));
  res = sw.injecthtmlshims(
    html("<html><head></head><body></body></html>"),
    {},
  );
  out = await res.text();
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

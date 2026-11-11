import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Runs the shipped relay client in a minimal browser sandbox and checks how it
// rewrites window.fetch URLs.
function loadClient() {
  const source = fs.readFileSync(
    new URL("../public/js/movie-proxy-client.js", import.meta.url),
    "utf8",
  );

  const fetched = [];

  function ctor(Base, methods = {}) {
    function C() {}
    C.prototype = Object.create(Base ? Base.prototype : {});
    Object.assign(C.prototype, methods);
    return C;
  }

  function Element() {}
  Element.prototype.setAttribute = function () {};
  Object.defineProperty(Element.prototype, "innerHTML", {
    get() {
      return "";
    },
    set() {},
    configurable: true,
    enumerable: true,
  });

  function Node() {}
  Node.prototype = Object.create(Element.prototype);
  Object.defineProperty(Node.prototype, "textContent", {
    get() {
      return "";
    },
    set() {},
    configurable: true,
    enumerable: true,
  });

  const HTMLScriptElement = ctor(Element);
  const HTMLMediaElement = ctor(Element, {
    setAttribute() {},
    play() {
      return Promise.resolve();
    },
  });
  Object.defineProperty(HTMLMediaElement.prototype, "src", {
    get() {
      return "";
    },
    set() {},
    configurable: true,
    enumerable: true,
  });
  const HTMLIFrameElement = ctor(Element, { setAttribute() {} });
  Object.defineProperty(HTMLIFrameElement.prototype, "src", {
    get() {
      return "";
    },
    set() {},
    configurable: true,
    enumerable: true,
  });
  const HTMLTrackElement = ctor(Element);
  const HTMLSourceElement = ctor(Element);

  function XMLHttpRequest() {}
  XMLHttpRequest.prototype.open = function () {};

  function Image() {}
  Image.prototype = {};

  const sandbox = {
    // bare vm contexts have no URL globals
    URL,
    URLSearchParams,
    location: {
      href: "https://aetheris.win/movie-proxy?url=https%3A%2F%2Fflixer.su%2Fwatch%2Fmovie%2F969681",
      origin: "https://aetheris.win",
      host: "aetheris.win",
      pathname: "/movie-proxy",
      search: "?url=https%3A%2F%2Fflixer.su%2Fwatch%2Fmovie%2F969681",
      hash: "",
    },
    history: { replaceState() {} },
    document: {
      querySelector: () => null,
      addEventListener() {},
    },
    navigator: {},
    Image,
    XMLHttpRequest,
    Element,
    Node,
    HTMLScriptElement,
    HTMLMediaElement,
    HTMLIFrameElement,
    HTMLTrackElement,
    HTMLSourceElement,
    setTimeout: () => 0,
    clearTimeout: () => {},
    window: null,
  };
  sandbox.window = {
    __MOVIE_PROXY_TARGET__: "https://flixer.su/watch/movie/969681",
    __MOVIE_PROXY_ORIGIN__: "https://flixer.su",
    fetch: (input) => {
      fetched.push(String(input));
      return Promise.resolve({ ok: true });
    },
    addEventListener() {},
    Element,
    Node,
    HTMLScriptElement,
    HTMLMediaElement,
    HTMLIFrameElement,
    HTMLTrackElement,
    HTMLSourceElement,
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: "movie-proxy-client.js" });
  return { sandbox, fetched };
}

test("nested relay URLs are unwrapped before proxying (subtitle endpoint)", () => {
  const { sandbox, fetched } = loadClient();
  const direct = "https://cache.vdrk.site/v1/vtt/movie/969681/English.vtt";
  const nested =
    "/api/subtitle?url=" +
    encodeURIComponent(
      "/movie-proxy?url=" + encodeURIComponent(direct),
    );
  sandbox.window.fetch(nested);
  assert.equal(fetched.length, 1);
  const proxied = new URL(fetched[0]);
  assert.equal(proxied.origin, "https://aetheris.win");
  assert.equal(proxied.pathname, "/movie-proxy");
  const outer = new URL(proxied.searchParams.get("url"));
  assert.equal(
    outer.href,
    "https://flixer.su/api/subtitle?url=" + encodeURIComponent(direct),
  );
  // the inner value must be the direct file URL, not another relay URL
  assert.equal(outer.searchParams.get("url"), direct);
});

test("already-proxied and plain provider URLs keep their behavior", () => {
  const { sandbox, fetched } = loadClient();
  const already =
    "/movie-proxy?url=" + encodeURIComponent("https://cdn.test/a.js");
  sandbox.window.fetch(already);
  assert.equal(fetched[0], already);

  sandbox.window.fetch("api.php?a=sub&ref=abc");
  const proxied = new URL(fetched[1]);
  assert.equal(proxied.pathname, "/movie-proxy");
  assert.equal(
    new URL(proxied.searchParams.get("url")).href,
    "https://flixer.su/watch/movie/api.php?a=sub&ref=abc",
  );
});

function readPublic(path) {
  return fs.readFileSync(new URL("../public/" + path, import.meta.url), "utf8");
}

test("index.html theme list matches theme.js", () => {
  const Aetheris = {
    storage: { getItem: () => null, setItem: () => true, removeItem() {} },
  };
  vm.runInNewContext(readPublic("js/theme.js"), {
    Aetheris,
    window: { addEventListener() {} },
    location: {},
    document: {
      body: null,
      documentElement: { setAttribute() {} },
      addEventListener() {},
    },
    MutationObserver: class {
      observe() {}
    },
  });

  const block = readPublic("index.html").match(
    /Aetheris\.themeColors = (\{[^}]*\});/,
  );
  assert.ok(block, "index.html should define Aetheris.themeColors");
  const shellThemes = vm.runInNewContext("(" + block[1] + ")");
  assert.deepEqual(
    Object.keys(shellThemes).sort(),
    Object.keys(Aetheris.themes).sort(),
  );
  for (const name of Object.keys(shellThemes))
    assert.equal(shellThemes[name], Aetheris.themes[name].bgc, name);
});

test("chat pages share dm-ui.js instead of inline copies", () => {
  for (const page of ["chat.html", "minichat.html"]) {
    const html = readPublic(page);
    assert.match(html, /js\/dm-shared\.js/, page);
    assert.match(html, /js\/dm-ui\.js/, page);
    assert.doesNotMatch(html, /function (loadmsgs|senddm|renderinbox)\b/, page);
  }
});

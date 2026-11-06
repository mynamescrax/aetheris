import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { MessageChannel } from "node:worker_threads";

const source = fs.readFileSync(
  new URL("../public/js/scramjet-init.js", import.meta.url),
  "utf8",
);

test("CSS URL regex works without scoped modifiers and keeps other tokens case-sensitive", () => {
  const expression = /[uU][rR][lL]\(([^)]+)\)/g;
  for (const value of ["url(asset.png)", "URL(asset.png)", "uRl(asset.png)"]) {
    assert.equal([...value.matchAll(expression)][0][1], "asset.png");
  }
  const server = fs.readFileSync(
    new URL("../index.js", import.meta.url),
    "utf8",
  );
  assert.ok(server.includes('patchsource(raw, "(?i:url)", "[uU][rR][lL]"'));
});
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function bootstrap() {
  const worker = {};
  const context = {
    window: { isSecureContext: true },
    navigator: {
      userAgent: "Firefox",
      serviceWorker: {
        register: async () => {},
        controller: worker,
        ready: Promise.resolve({ active: worker }),
      },
    },
    document: { addEventListener() {} },
    location: {
      protocol: "https:",
      host: "example.com",
      origin: "https://example.com",
    },
    Aetheris: {
      storage: {
        getItem() {
          return null;
        },
      },
    },
    console: { warn() {} },
    URL,
    setTimeout,
    clearTimeout,
    $scramjet: {},
    $scramjetController: {
      Controller: class {
        wait() {
          return Promise.resolve();
        }
        createFrame() {}
      },
    },
  };
  vm.runInNewContext(
    source.replace(
      "window.aetherisProxy = {",
      `window.internals = {
    setFactory: function(factory) { createtransport = factory; },
    setActive: function(transport) { activetransport = transport; },
    active: function() { return activetransport; },
    install: installtransportfailover,
    wait: waitforserviceworker,
    installSaves: installlocalsaves,
    installLocalFetch: servelocally,
    probe: probetransport
  }; window.aetherisProxy = {`,
    ),
    context,
  );
  return context;
}

test("local game assets use visitor CORS access and retain the proxy fallback", async () => {
  const c = bootstrap();
  c.Headers = Headers;
  c.Response = Response;
  c.AbortController = AbortController;
  let hook;
  c.$scramjet.Tap = {
    tap(_, callback) {
      hook = callback;
    },
  };
  const frame = { aetherisLocal: true, hooks: { fetch: { request: {} } } };
  c.window.internals.installLocalFetch(frame);
  const url = new URL("https://static.example.org/media/scenes/game.babylon");
  const request = {
    method: "GET",
    initialHeaders: {
      toRawHeaders: () => [
        ["Range", "bytes=10-"],
        ["Cookie", "private"],
      ],
    },
  };
  const context = { request, parsed: { url, destination: "" } };
  const calls = [];
  c.fetch = async (target, init) => {
    calls.push({ target, init });
    return new Response("asset");
  };
  const props = {};
  await hook(context, props);
  assert.equal(await props.earlyResponse.text(), "asset");
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.headers.Range, "bytes=10-");
  assert.equal(calls[0].init.headers.Cookie, undefined);
  for (const fetcher of [
    async () => {
      throw new TypeError("CORS denied");
    },
    async () => new Response("blocked", { status: 403 }),
  ]) {
    c.fetch = fetcher;
    const fallback = {};
    await hook(context, fallback);
    assert.equal(fallback.earlyResponse, undefined);
  }
  c.fetch = async () => {
    throw new Error("must stay on transport");
  };
  assert.equal(
    hook({ request, parsed: { url, destination: "iframe" } }, {}),
    undefined,
  );
  frame.aetherisLocal = false;
  assert.equal(hook(context, {}), undefined);
});

test("remote game CDN assets use mirrors without granting access to site APIs", async () => {
  const c = bootstrap();
  let hook;
  c.$scramjet.Tap = { tap(_, callback) { hook = callback; } };
  const frame = { aetherisLocal: false, hooks: { fetch: { request: {} } } };
  c.window.internals.installLocalFetch(frame);
  const calls = [];
  c.fetch = async (url, init) => { calls.push({ url, init }); return { headers: null }; };
  const request = { method: "HEAD", initialHeaders: { toRawHeaders: () => [["Range", "bytes=0-1023"], ["Cookie", "private"]] } };
  const url = new URL("https://bbcdn.githack.com/user/repo/raw/main/game.zip");
  const props = {};
  await hook({ request, parsed: { url, destination: "" } }, props);
  assert.ok(props.earlyResponse);
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.headers.Range, "bytes=0-1023");
  assert.equal(calls[0].init.headers.Cookie, undefined);
  for (const target of ["https://example.com/api/private", "https://example.com/assets/game.js", "https://other.example/game.js"]) {
    assert.equal(hook({ request, parsed: { url: new URL(target), destination: "" } }, {}), undefined);
  }
  for (const destination of ["iframe", "document"]) {
    const props = {};
    await hook({ request, parsed: { url, destination } }, props);
    assert.ok(props.earlyResponse);
  }
  assert.equal(hook({ request, parsed: { url: new URL("https://other.example/game.html"), destination: "iframe" } }, {}), undefined);
  assert.equal(calls.length, 3);
});

test("worker bodies run after bootstrap without another synchronous proxy import", async () => {
  const c = bootstrap();
  let init;
  c.$scramjetController.Controller = class {
    constructor(options) {
      init = options;
    }
    wait() {
      return Promise.resolve();
    }
    createFrame() {}
  };
  c.window.internals.setFactory(async () => ({
    transport: {},
    name: "libcurl",
  }));
  await c.window.aetherisProxy.getController();
  assert.equal(init.scramjetConfig.flags.encapsulateWorkers, false);
  assert.equal(init.scramjetConfig.flags.debugSourceURL, true);
});

test("local games reopen legacy saves and keep proxy-only database names", () => {
  const c = bootstrap();
  const calls = [];
  const data = {
    score: "old-progress",
    "example.com@score": "reset-progress",
    "example.com@newSave": "new-progress",
  };
  const storage = { ...data };
  Object.defineProperties(storage, {
    getItem: {
      value(key) {
        return Object.hasOwn(this, key) ? this[key] : null;
      },
    },
    setItem: {
      value(key, value) {
        this[key] = value;
      },
    },
  });
  c.window.localStorage = storage;
  c.window.sessionStorage = storage;
  c.window.indexedDB = {
    open(...args) {
      calls.push(args);
      return "request";
    },
    deleteDatabase(name) {
      calls.push(["delete", name]);
    },
  };
  c.location.host = "example.com";
  const installs = [];
  c.$scramjet.Tap = {
    tap(hook, callback) {
      installs.push(callback);
    },
  };
  const frame = { aetherisLocal: true, hooks: { init: { pre: {}, post: {} } } };
  c.window.internals.installSaves(frame, {
    names: [
      "/idbfs",
      "https://example.com@/idbfs",
      "https://example.com@new-game",
    ],
    prefix: "https://example.com@",
  });
  const win = { indexedDB: {}, localStorage: storage, sessionStorage: storage };
  const context = {
    window: win,
    client: {
      url: new URL("https://example.com/assets/games/trackdash.html"),
      Proxy(name, handler) {
        win.indexedDB[name.split(".").pop()] = function (...args) {
          let result;
          handler.apply({
            args,
            this: win.indexedDB,
            return(value) {
              result = value;
            },
          });
          return result;
        };
      },
      natives: {
        call(name, receiver, ...args) {
          return c.window.indexedDB[name.split(".").pop()](...args);
        },
      },
    },
  };
  installs[0](context);
  win.localStorage = {};
  win.sessionStorage = {};
  installs[1](context);
  assert.equal(win.indexedDB.open("/idbfs", 21), "request");
  win.indexedDB.open("new-game");
  assert.deepEqual(calls, [["/idbfs", 21], ["https://example.com@new-game"]]);
  assert.equal(win.localStorage.getItem("score"), "old-progress");
  assert.equal(win.localStorage.getItem("newSave"), "new-progress");
  assert.equal(storage["example.com@score"], "reset-progress");
  assert.equal(storage["example.com@newSave"], "new-progress");
});

test("remote pages and non-game local pages retain proxy storage isolation", () => {
  const c = bootstrap();
  let install;
  c.$scramjet.Tap = {
    tap(hook, callback) {
      install = callback;
    },
  };
  const frame = { aetherisLocal: true, hooks: { init: { pre: {}, post: {} } } };
  c.window.internals.installSaves(frame, {
    names: [],
    prefix: "https://example.com@",
  });
  for (const url of [
    "https://remote.example/assets/games/test.html",
    "https://example.com/api/private",
  ]) {
    const win = { indexedDB: {} };
    install({ window: win, client: { url: new URL(url) } });
    assert.equal(win.indexedDB.open, undefined);
    assert.equal(win.localStorage, undefined);
  }
});

test("reset during controller.wait cannot clear or replace the next startup", async () => {
  const c = bootstrap();
  const waits = [deferred(), deferred()];
  const transports = [];
  c.$scramjetController.Controller = class {
    constructor() {
      this.index = transports.length - 1;
    }
    wait() {
      return waits[this.index].promise;
    }
    createFrame() {}
  };
  c.window.internals.setFactory(async () => {
    const transport = {
      closed: false,
      close() {
        this.closed = true;
      },
    };
    transports.push(transport);
    return { transport, name: "libcurl" };
  });
  const api = c.window.aetherisProxy;
  const old = api.getController();
  const rejected = assert.rejects(old, /reset/);
  while (transports.length < 1) await new Promise(setImmediate);
  api.reset();
  const fresh = api.getController();
  while (transports.length < 2) await new Promise(setImmediate);
  waits[0].resolve();
  await rejected;
  assert.equal(api.getController(), fresh);
  waits[1].resolve();
  await fresh;
  assert.equal(transports[0].closed, true);
  assert.equal(transports[1].closed, false);
});

test("TLS failover completing after reset closes its replacement", async () => {
  const c = bootstrap();
  const next = deferred();
  const transport = {
    request: async () => {
      throw new Error("TLS certificate rejected");
    },
  };
  const replacement = {
    closed: false,
    close() {
      this.closed = true;
    },
  };
  let swaps = 0;
  c.window.internals.setActive(transport);
  c.window.internals.setFactory(() => next.promise);
  c.window.internals.install(
    {
      setTransport() {
        swaps++;
      },
    },
    transport,
    "wss://example.com/wisp/",
    "libcurl",
  );
  const request = transport.request(
    new URL("https://upstream.example/"),
    "GET",
    null,
    [],
  );
  const rejected = assert.rejects(request, /TLS/);
  await new Promise(setImmediate);
  c.window.aetherisProxy.reset();
  next.resolve({ transport: replacement, name: "epoxy" });
  await rejected;
  assert.equal(swaps, 0);
  assert.equal(replacement.closed, true);
  assert.equal(c.window.internals.active(), null);
});

test("concurrent TLS failures share a replacement and replay every download", async () => {
  const c = bootstrap();
  const next = deferred();
  let starts = 0;
  const transport = {
    request: async () => {
      throw new Error("TLS rejected");
    },
    close() {},
  };
  const replacement = { request: async (url) => url.href };
  c.window.internals.setActive(transport);
  c.window.internals.setFactory(() => {
    starts++;
    return next.promise;
  });
  c.window.internals.install(
    { setTransport() {} },
    transport,
    "wss://example.com/wisp/",
    "libcurl",
  );
  const urls = [
    new URL("https://cdn.example/a"),
    new URL("https://cdn.example/b"),
  ];
  const requests = urls.map((url) => transport.request(url, "GET", null, []));
  await new Promise(setImmediate);
  assert.equal(starts, 1);
  next.resolve({ transport: replacement, name: "epoxy" });
  assert.deepEqual(
    await Promise.all(requests),
    urls.map((url) => url.href),
  );
});

test("a failed replacement startup does not permanently disable TLS recovery", async () => {
  const c = bootstrap();
  let starts = 0;
  const transport = {
    request: async () => {
      throw new Error("TLS rejected");
    },
    close() {},
  };
  const replacement = { request: async () => "asset" };
  c.window.internals.setActive(transport);
  c.window.internals.setFactory(async () => {
    if (++starts === 1) throw new Error("temporarily offline");
    return { transport: replacement, name: "epoxy" };
  });
  c.window.internals.install(
    { setTransport() {} },
    transport,
    "wss://example.com/wisp/",
    "libcurl",
  );
  const url = new URL("https://cdn.example/a");
  await assert.rejects(transport.request(url, "GET", null, []), /offline/);
  assert.equal(await transport.request(url, "GET", null, []), "asset");
  assert.equal(starts, 2);
});

test("a transport ignoring abort signals cannot hang the resume probe", async () => {
  const c = bootstrap();
  c.AbortSignal = AbortSignal;
  c.location.origin = "https://example.com";
  c.window.internals.setActive({ request: () => new Promise(() => {}) });
  let timer;
  c.setTimeout = callback => { timer = callback; return 1; };
  c.clearTimeout = () => {};
  const probe = c.window.internals.probe();
  await new Promise(setImmediate);
  assert.equal(typeof timer, "function");
  timer();
  assert.equal(await probe, false);
});

test("an active worker without page control is rejected before opening a frame", async () => {
  const c = bootstrap();
  c.navigator.serviceWorker.controller = null;
  c.navigator.serviceWorker.register = async () => {};
  c.navigator.serviceWorker.addEventListener = () => {
    throw new Error("unavailable");
  };
  await assert.rejects(c.window.internals.wait(), /not controlling/);
});

test("stream transfer probe detects both supported and Safari-style rejected transfers", () => {
  const server = fs.readFileSync(
    new URL("../index.js", import.meta.url),
    "utf8",
  );
  const start = server.indexOf("function cantransferstream()");
  const end = server.indexOf(
    'fastify.get("/controller/controller.api.js"',
    start,
  );
  const probe = server.slice(start, end) + "cantransferstream()";
  assert.equal(
    vm.runInNewContext(probe, { MessageChannel, ReadableStream }),
    true,
  );
  let closed = 0;
  class SafariChannel {
    constructor() {
      this.port1 = {
        postMessage() {
          throw new Error("DataCloneError");
        },
        close() {
          closed++;
        },
      };
      this.port2 = {
        close() {
          closed++;
        },
      };
    }
  }
  assert.equal(
    vm.runInNewContext(probe, {
      MessageChannel: SafariChannel,
      ReadableStream,
    }),
    false,
  );
  assert.equal(closed, 2);
});

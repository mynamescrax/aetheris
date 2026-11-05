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
    wait: waitforserviceworker
  }; window.aetherisProxy = {`,
    ),
    context,
  );
  return context;
}

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

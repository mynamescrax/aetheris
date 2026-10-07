"use strict";

// scramjet bootstrap shared by index.html, cheats.html, search.html and load.js.
// controller.api.js reads $scramjet.defaultConfig as soon as it runs, so it
// has to load after scramjet.js.

(function () {
  var SCRAMJET_CORE_SRC = "/scramjet/scramjet.js";
  var SCRAMJET_CONTROLLER_SRC = "/controller/controller.api.js";
  // Keep this in sync with settings.js's transport default. Apple devices
  // get epoxy because libcurl's WASM build does not start there.
  var APPLE_UA_CHECK =
    /iP(hone|ad|od)/.test(navigator.userAgent) ||
    /Macintosh/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  function loadscript(src) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(
          new Error(
            "Timed out loading " + src + ". Check your connection and retry.",
          ),
        );
      }, 15000);
      function loaded() {
        clearTimeout(timer);
        resolve();
      }
      function failed() {
        clearTimeout(timer);
        reject(new Error("Failed to load " + src));
      }
      var existing = document.querySelector('script[src="' + src + '"]');
      if (existing) {
        if (existing.getAttribute("data-loaded") === "1") {
          loaded();
          return;
        }
        // A parser-inserted script that already executed (or failed) will
        // never fire load/error again. Once the document is fully parsed,
        // waiting for those events means sitting on the 15s timeout for
        // nothing.
        if (document.readyState === "complete") {
          failed();
          return;
        }
        existing.addEventListener("load", loaded, { once: true });
        existing.addEventListener("error", failed, { once: true });
        return;
      }
      var s = document.createElement("script");
      s.src = src;
      s.onload = function () {
        s.setAttribute("data-loaded", "1");
        loaded();
      };
      s.onerror = failed;
      document.head.appendChild(s);
    });
  }

  var loadedpromise = null;
  function ensureloaded() {
    if (loadedpromise) return loadedpromise;

    loadedpromise = (async function () {
      // order matters, see the note at the top
      if (typeof $scramjet === "undefined") await loadscript(SCRAMJET_CORE_SRC);
      if (typeof $scramjet === "undefined") {
        throw new Error(
          "scramjet core failed to load ($scramjet missing after script load)",
        );
      }

      if (
        typeof $scramjetController === "undefined" ||
        typeof $scramjetController.Controller !== "function"
      ) {
        await loadscript(SCRAMJET_CONTROLLER_SRC);
      }
      if (
        typeof $scramjetController === "undefined" ||
        typeof $scramjetController.Controller !== "function"
      ) {
        throw new Error(
          "scramjet controller failed to load ($scramjetController.Controller missing after script load)",
        );
      }
    })().catch(function (err) {
      loadedpromise = null;
      throw err;
    });

    return loadedpromise;
  }

  // libcurl's init() never rejects if its WASM can't start, so time it out
  // instead of sitting on "Loading..." forever.
  var TRANSPORT_INIT_TIMEOUT = 15000;

  function withtimeout(promise, ms, message) {
    var timer;
    return Promise.race([
      promise,
      new Promise(function (_, reject) {
        timer = setTimeout(function () {
          reject(new Error(message));
        }, ms);
      }),
    ]).finally(function () {
      clearTimeout(timer);
    });
  }

  var activetransport = null;

  function closequietly(transport) {
    try {
      if (transport && typeof transport.close === "function") transport.close();
    } catch (_) {
      /* best effort */
    }
  }

  // try the preferred transport first, then fall back to the other one.
  // apple only works with epoxy; libcurl is faster elsewhere but its CA list
  // rejects some certs epoxy accepts.
  async function createtransport(wispurl, avoidname) {
    var requested = Aetheris.storage.getItem("proxyTransport");
    var preferred = requested || (APPLE_UA_CHECK ? "epoxy" : "libcurl");
    var order =
      preferred === "epoxy" ? ["epoxy", "libcurl"] : ["libcurl", "epoxy"];
    if (avoidname) {
      order = order.filter(function (name) {
        return name !== avoidname;
      });
    }

    var lasterror = null;
    for (var i = 0; i < order.length; i++) {
      var name = order[i];
      var transport = null;
      try {
        var mod = await import(
          name === "epoxy" ? "/epoxy/index.mjs" : "/libcurl/index.mjs"
        );
        transport = new mod.default({ wisp: wispurl });
        await withtimeout(
          transport.init(),
          TRANSPORT_INIT_TIMEOUT,
          name + " transport did not finish starting",
        );
        return { transport: transport, name: name };
      } catch (err) {
        lasterror = err;
        closequietly(transport);
        console.warn(
          "[init] " +
            name +
            " transport unavailable" +
            (i + 1 < order.length ? ", trying " + order[i + 1] : ""),
          err,
        );
      }
    }
    throw lasterror || new Error("No proxy transport could be started.");
  }

  // libcurl error codes that mean "the TLS handshake was rejected": 35 (SSL
  // connect), 51 (peer cert), 58 (local cert), 60 (cert verify), 77 (CA cert
  // read), 80 (SSL shutdown), 90 (pinned key), 91 (SSL invalid cert status).
  var TLSERROR = /(SSL|TLS|certificate|error code (35|51|58|60|77|80|90|91))/i;

  // Wrap a transport so a TLS failure quietly moves the session to the other
  // transport and replays the one failed request. Without this, sites whose
  // certificate chain is missing from libcurl's bundled CA list stay broken
  // (one 500 per request) even though epoxy handles them fine.
  function installtransportfailover(controller, transport, wispurl, name) {
    if (typeof controller.setTransport !== "function") return;
    var native = transport.request.bind(transport);
    var switched = false;

    transport.request = function (url, method, body, headers, signal) {
      return native(url, method, body, headers, signal).catch(function (err) {
        var message = String((err && err.message) || err);
        if (!TLSERROR.test(message) || switched) throw err;
        if (typeof ReadableStream === "function" && body instanceof ReadableStream)
          throw err; // a consumed request stream cannot be replayed
        switched = true;
        console.warn(
          "[init] " +
            name +
            " transport was rejected by TLS, switching to the other transport:",
          message,
        );
        return createtransport(wispurl, name).then(function (picked) {
          activetransport = picked.transport;
          controller.setTransport(picked.transport);
          closequietly(transport);
          return picked.transport.request(url, method, body, headers, signal);
        });
      });
    };
  }

  async function waitforserviceworker() {
    if (!window.isSecureContext || !("serviceWorker" in navigator)) {
      throw new Error(
        "The proxy needs HTTPS (or localhost) and service-worker support.",
      );
    }

    var timeout;
    try {
      return await Promise.race([
        (async function () {
          if (typeof registersw === "function") {
            var registered = await registersw();
            if (!registered)
              throw new Error(
                "Service-worker registration failed. Try the recovery page.",
              );
          } else {
            await navigator.serviceWorker.register("/sw.js", {
              scope: "/",
              updateViaCache: "none",
            });
          }
          var reg = await navigator.serviceWorker.ready;
          var sw = navigator.serviceWorker.controller || reg.active;
          if (!sw) throw new Error("No active service worker is available.");
          return sw;
        })(),
        new Promise(function (_, reject) {
          timeout = setTimeout(function () {
            reject(
              new Error(
                "Proxy startup timed out. Reload or use /recover.html.",
              ),
            );
          }, 15000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  // every call site navigates through here so there's one place to hook later
  function safego(frame, url) {
    return frame.go(url);
  }

  var controllerpromise = null;
  // bumped by reset() so a startup that was already in flight can close its
  // own transport instead of publishing it as the active one after reset.
  var starttoken = 0;

  function getcontroller() {
    if (controllerpromise) return controllerpromise;
    var token = starttoken;

    controllerpromise = (async function () {
      await ensureloaded();
      var sw = await waitforserviceworker();

      var wispurl =
        (location.protocol === "https:" ? "wss" : "ws") +
        "://" +
        location.host +
        "/wisp/";
      var picked = await createtransport(wispurl);
      var transport = picked.transport;

      if (token !== starttoken) {
        closequietly(transport);
        throw new Error("Proxy startup was reset. Try again.");
      }
      activetransport = transport;
      try {
        var controller = new $scramjetController.Controller({
          serviceworker: sw,
          transport: transport,
          scramjetConfig: { flags: { allowFailedIntercepts: true } },
        });
        await controller.wait();
        installtransportfailover(controller, transport, wispurl, picked.name);
        // Track frames so the resume handler below can tell whether anything
        // is actually running in this page (Frame#element is the iframe the
        // call sites mounted).
        var nativecreate = controller.createFrame.bind(controller);
        controller.createFrame = function (element, frameoptions) {
          var frame = nativecreate(element, frameoptions);
          rememberframe(frame);
          return frame;
        };
        return controller;
      } catch (error) {
        // Don't leak the transport when controller startup fails: a retry
        // would otherwise build another one on top of it.
        closequietly(transport);
        if (activetransport === transport) activetransport = null;
        throw error;
      }
    })().catch(function (err) {
      controllerpromise = null;
      throw err;
    });

    return controllerpromise;
  }

  // Drop the cached controller and transport so the next getController()
  // builds a fresh one. Pages cache the controller in a local variable, so
  // call this from explicit retry paths only: after a proxy failure (iOS
  // Safari silently kills the transport WebSocket when a tab is suspended)
  // or when the user hits "Try again".
  function resetcontroller() {
    starttoken++;
    closequietly(activetransport);
    activetransport = null;
    controllerpromise = null;
    // Frames created through the dropped controller are no longer part of a
    // live session; the new controller's frames re-register themselves.
    trackedframes = [];
  }

  // Keep only the frames that are still attached to the document, so the
  // list stays small through long search sessions with many frames.
  var trackedframes = [];

  function rememberframe(frame) {
    trackedframes = trackedframes.filter(function (f) {
      try {
        return f.element && f.element.isConnected;
      } catch (_) {
        return false;
      }
    });
    trackedframes.push(frame);
  }

  function hasliveframe() {
    for (var i = 0; i < trackedframes.length; i++) {
      try {
        if (trackedframes[i].element && trackedframes[i].element.isConnected)
          return true;
      } catch (_) {
        /* an unreadable frame must not break the check */
      }
    }
    return false;
  }

  // iOS/Safari suspends background tabs and silently kills the transport
  // WebSocket. If the tab comes back after a long break with nothing framed,
  // drop the cached controller so the next launch builds a live transport
  // instead of reusing a socket the OS already closed. A connected frame is
  // left alone: resetting would kill a game that may still be running.
  var RESUME_RESET_AFTER = 60000;
  var hiddensince = 0;
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") {
      hiddensince = Date.now();
      return;
    }
    if (!hiddensince || Date.now() - hiddensince < RESUME_RESET_AFTER) return;
    hiddensince = 0;
    if (!hasliveframe()) resetcontroller();
  });

  window.aetherisProxy = {
    getController: getcontroller,
    ensureLoaded: ensureloaded,
    go: safego,
    reset: resetcontroller,
  };
})();

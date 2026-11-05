"use strict";

// scramjet bootstrap shared by index.html, cheats.html, search.html and load.js.
// controller.api.js reads $scramjet.defaultConfig as soon as it runs, so it
// has to load after scramjet.js.

(function () {
  // Bump when the serve-time scramjet patches in index.js change. The bundle
  // URL is otherwise the same across deploys, so a browser or a Cloudflare
  // edge node that cached the old copy keeps the old same-origin guard (which
  // aborts every local game) until its cache expires. The server marks a
  // versioned URL immutable and an unversioned one no-cache.
  var PROXY_ENGINE_VERSION = "20261105.1";
  var SCRAMJET_CORE_SRC =
    "/scramjet/scramjet.js?v=" + PROXY_ENGINE_VERSION;
  var SCRAMJET_CONTROLLER_SRC =
    "/controller/controller.api.js?v=" + PROXY_ENGINE_VERSION;
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
  var auxiliarytransport = null;

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

  // YouTube's HTML pages send a response header block larger than the 16 KB
  // SETTINGS_MAX_HEADER_LIST_SIZE hyper advertises for HTTP/2. h2 then treats
  // the response as a protocol error, resets the stream and the frame renders
  // "Internal Service Worker Error: ... Http2 ... Reset(StreamId(1),
  // PROTOCOL_ERROR, Library)". libcurl has no such header-list limit, so when
  // epoxy is the active transport these page origins go through a second,
  // lazily-started libcurl transport. Media and API hosts (googlevideo,
  // ytimg, youtubei) stay on the active transport: their headers fit.
  var OVERSIZEDHEADERHOSTS =
    /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;

  function hostnameof(url) {
    try {
      return String(url && url.hostname ? url.hostname : new URL(url).hostname);
    } catch (_) {
      return "";
    }
  }

  function routeoversizedheaders(transport, wispurl, name) {
    if (name === "libcurl" || typeof transport.request !== "function") return;
    if (transport.oversizedheadersrouted) return;
    transport.oversizedheadersrouted = true;

    var native = transport.request.bind(transport);
    var starting = null;
    var unavailable = false;

    function getauxiliary() {
      if (auxiliarytransport) return Promise.resolve(auxiliarytransport);
      if (unavailable) {
        return Promise.reject(new Error("libcurl transport unavailable"));
      }
      if (!starting) {
        starting = (async function () {
          var mod = await import("/libcurl/index.mjs");
          var extra = new mod.default({ wisp: wispurl });
          try {
            await withtimeout(
              extra.init(),
              TRANSPORT_INIT_TIMEOUT,
              "libcurl transport did not finish starting",
            );
          } catch (err) {
            closequietly(extra);
            throw err;
          }
          auxiliarytransport = extra;
          return extra;
        })()
          .catch(function (err) {
            // Don't retry the 15s init on every YouTube request.
            unavailable = true;
            throw err;
          })
          .finally(function () {
            starting = null;
          });
      }
      return starting;
    }

    transport.request = function (url, method, body, headers, signal) {
      function sendactive() {
        return native(url, method, body, headers, signal);
      }
      if (!OVERSIZEDHEADERHOSTS.test(hostnameof(url))) return sendactive();
      // Keep the original request if libcurl can't start (Apple devices where
      // the WASM build is unavailable): the caller still sees the real error.
      return getauxiliary().then(
        function (extra) {
          return extra
            .request(url, method, body, headers, signal)
            .catch(function (err) {
              // A certificate libcurl's bundle doesn't know still works on the
              // active transport; a consumed request stream can't be replayed.
              if (
                typeof ReadableStream === "function" &&
                body instanceof ReadableStream
              )
                throw err;
              return sendactive();
            });
        },
        function () {
          return sendactive();
        },
      );
    };
  }

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
        if (
          typeof ReadableStream === "function" &&
          body instanceof ReadableStream
        )
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
          routeoversizedheaders(picked.transport, wispurl, picked.name);
          installtransportfailover(
            controller,
            picked.transport,
            wispurl,
            picked.name,
          );
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
    try {
      // An aetheris-served game (same origin) is what enables the CDN relay
      // path below; provider pages keep talking to their own CDNs.
      frame.aetherisLocal =
        new URL(url, location.href).origin === location.origin;
    } catch (_) {
      frame.aetherisLocal = false;
    }
    return frame.go(url);
  }

  // Static CDN hosts the service worker relays through /s/ (the MIRROR_HOSTS
  // map in sw.js, plus GitHub's own raw links). A local game page hardcodes
  // these, and jsDelivr refuses some of the split files a game asks for, so
  // the relay mirrors them from the GitHub/AWS source instead. Keep in sync
  // with MIRROR_HOSTS in sw.js.
  var RELAYED_HOSTS = {
    "cdn.jsdelivr.net": true,
    "fastly.jsdelivr.net": true,
    "gcore.jsdelivr.net": true,
    "cdn.statically.io": true,
    "raw.githubusercontent.com": true,
    "raw.githack.com": true,
    "rawcdn.githack.com": true,
    "cdn.githack.com": true,
    "bbcdn.githack.com": true,
    "raw.github.com": true,
    "cdnjs.cloudflare.com": true,
    "github.com": true,
    "www.github.com": true,
    "gist.github.com": true,
  };

  function relayedhost(host) {
    host = String(host || "").toLowerCase();
    return !!RELAYED_HOSTS[host] || /\.githubusercontent\.com$/.test(host);
  }

  // A Response from the page's own fetch has already been decoded (gzip/br)
  // but still carries the upstream Content-Encoding, and its Content-Length
  // then describes the compressed bytes. Scramjet would hand both headers to
  // the frame; Firefox is stricter about them than Chrome. Keep the length
  // when the body was not encoded (Unity's .unityweb progress bar needs it).
  function decodedresponse(response) {
    try {
      if (!response || !response.headers) return response;
      var headers = new Headers(response.headers);
      var encoded = headers.has("content-encoding");
      if (!encoded) return response;
      headers.delete("content-encoding");
      headers.delete("content-length");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: headers,
      });
    } catch (_) {
      return response;
    }
  }

  // Same-origin requests (the aetheris game page, its relative assets and the
  // /game-assets relay) are served by the page itself, not by the transport:
  // wisp cannot reach loopback, so a local dev server would be unreachable,
  // and in production it would have to fetch our own public host back through
  // Cloudflare. The service worker's game-page cache and shims also only run
  // on the page's own fetch. The response still goes through the rest of
  // scramjet's fetch path, so the document is rewritten and everything the
  // game itself asks other servers for is proxied.
  var FORWARDED_LOCAL_HEADERS = { range: true };

  // Only the site's static files are served this way. Anything else on our
  // origin (/api/, /auth/, …) stays on the transport, so a proxied page can
  // never use the player page's cookies to read an authenticated answer.
  var LOCAL_PATHS = [
    "/assets/",
    "/game-assets/",
    "/s/",
    "/js/",
    "/css/",
    // The engine the controller injects into every proxied frame. Serving it
    // from the page's own cache keeps ~1MB per frame off wisp.
    "/scramjet/",
    "/controller/",
  ];

  function localpath(url) {
    var path = url.pathname;
    if (path === "/favicon.ico" || path === "/img") return true;
    for (var i = 0; i < LOCAL_PATHS.length; i++)
      if (path.indexOf(LOCAL_PATHS[i]) === 0) return true;
    return false;
  }

  function servelocally(frame) {
    if (!frame || !frame.hooks || !frame.hooks.fetch || !$scramjet.Tap) return;
    $scramjet.Tap.tap(frame.hooks.fetch.request, function (context, props) {
      var request = context && context.request;
      var url = context && context.parsed && context.parsed.url;
      if (!request || !url) return;
      if (request.method !== "GET" && request.method !== "HEAD") return;
      if (!frame.aetherisLocal) return;

      var sameorigin = url.origin === location.origin && localpath(url);
      // A local game's CDN files are fetched from the page too: the service
      // worker answers them with a redirect into the /s/ relay, which is what
      // makes split files and jsDelivr's refusals work. The response still
      // goes back through scramjet, so scripts are rewritten as usual.
      var relayed =
        url.origin !== location.origin && relayedhost(url.hostname);
      if (!sameorigin && !relayed) return;

      var init = { method: request.method };
      if (sameorigin) {
        try {
          request.initialHeaders.toRawHeaders().forEach(function (pair) {
            if (!FORWARDED_LOCAL_HEADERS[String(pair[0]).toLowerCase()]) return;
            if (!init.headers) init.headers = {};
            init.headers[pair[0]] = pair[1];
          });
        } catch (_) {
          /* headers are optional, a missing Range still returns the whole file */
        }
      }

      // Without an active service worker the relay redirect never happens, so
      // a cross-origin fetch would just fail; let the transport handle it.
      if (relayed && !navigator.serviceWorker.controller) return;

      return fetch(url.href, init)
        .then(function (response) {
          props.earlyResponse = decodedresponse(response);
        })
        .catch(function (error) {
          // the transport may still reach it; don't fail the whole request here
          console.warn(
            "[init] local fetch failed, letting the proxy try:",
            url.href,
            error,
          );
        });
    });
  }

  // The service worker's game-clock shim (sw.js) shifts Date inside aetheris
  // game pages, but it reads localStorage, which scramjet virtualizes per
  // proxied origin: inside the frame the setting is invisible. This callback
  // runs in the player page's realm, so it can read the real value and hand
  // it to the shim through a window global. The shim re-reads it about once a
  // second, so a change made in Settings still reaches an open game.
  var GAMECLOCK_KEY = "gameClockOffsetMs";
  var GAMECLOCK_MAX = 3650 * 24 * 60 * 60 * 1000;

  function clockoffset() {
    try {
      var value = Number(Aetheris.storage.getItem(GAMECLOCK_KEY));
      return isFinite(value) && value > 0 ? Math.min(value, GAMECLOCK_MAX) : 0;
    } catch (_) {
      return 0;
    }
  }

  function installclock(frame) {
    if (!frame || !frame.hooks || !frame.hooks.init || !$scramjet.Tap) return;
    $scramjet.Tap.tap(frame.hooks.init.pre, function (context) {
      if (!frame.aetherisLocal || !context || !context.window) return;
      var win = context.window;
      win.__aetherisGameClockOffset = clockoffset();
      var timer = setInterval(function () {
        try {
          // removing the iframe does not reliably fire pagehide in every
          // browser, so stop polling once the frame is gone
          if (!frame.element || !frame.element.isConnected) {
            clearInterval(timer);
            return;
          }
          win.__aetherisGameClockOffset = clockoffset();
        } catch (_) {
          clearInterval(timer);
        }
      }, 1000);
      try {
        win.addEventListener("pagehide", function () {
          clearInterval(timer);
        });
      } catch (_) {
        clearInterval(timer);
      }
    });
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
      routeoversizedheaders(transport, wispurl, picked.name);
      try {
        var controller = new $scramjetController.Controller({
          serviceworker: sw,
          transport: transport,
          // The injected client loads the engine from inside each proxied
          // frame; the same version keeps it on the same cached copy.
          config: {
            scramjetPath: SCRAMJET_CORE_SRC,
            injectPath:
              "/controller/controller.inject.js?v=" + PROXY_ENGINE_VERSION,
            wasmPath: "/scramjet/scramjet.wasm?v=" + PROXY_ENGINE_VERSION,
          },
          // allowInvalidJs: scripts the rewriter can't parse are passed
          // through instead of failing, so more sites keep working.
          scramjetConfig: {
            flags: { allowFailedIntercepts: true, allowInvalidJs: true },
          },
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
          servelocally(frame);
          installclock(frame);
          return frame;
        };
        return controller;
      } catch (error) {
        // Don't leak the transport when controller startup fails: a retry
        // would otherwise build another one on top of it.
        closequietly(transport);
        if (activetransport === transport) activetransport = null;
        closequietly(auxiliarytransport);
        auxiliarytransport = null;
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
    closequietly(auxiliarytransport);
    auxiliarytransport = null;
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

  // Probe the transport end to end: a tiny same-origin request through the
  // real wisp path. A socket the OS killed silently neither errors nor
  // resolves, so bound the probe with a timeout. On old Safari without
  // AbortSignal.timeout, keep trusting a connected frame instead of risking a
  // reset of a working session.
  function probetransport() {
    if (
      !activetransport ||
      typeof activetransport.request !== "function" ||
      typeof AbortSignal === "undefined" ||
      typeof AbortSignal.timeout !== "function"
    ) {
      return Promise.resolve(true);
    }
    var transport = activetransport;
    return Promise.resolve()
      .then(function () {
        // Transports read `remote.href` and iterate `headers`, so the probe
        // must use the same shapes the controller sends: a URL object and an
        // iterable of pairs. A plain string and `{}` threw inside epoxy/libcurl
        // ("Invalid URL input: undefined") and made a healthy session look dead.
        return transport.request(
          new URL(location.origin + "/online-count?proxy-probe=" + Date.now()),
          "GET",
          null,
          [],
          AbortSignal.timeout(8000),
        );
      })
      .then(
        function (r) {
          try {
            if (r && r.body && typeof r.body.cancel === "function") {
              var closing = r.body.cancel();
              if (closing && typeof closing.catch === "function")
                closing.catch(function () {});
            }
          } catch (_) {
            /* releasing the probe stream is best effort */
          }
          return true;
        },
        function () {
          // a failover swap means the failed probe tested a transport that is
          // no longer in use; don't judge the replacement by it
          return transport !== activetransport;
        },
      );
  }

  // iOS/Safari suspends background tabs and silently kills the transport
  // WebSocket. If the tab comes back after a long break with nothing framed,
  // drop the cached controller so the next launch builds a live transport
  // instead of reusing a socket the OS already closed. A connected frame is
  // kept: resetting would kill a game that may still be running, so probe the
  // transport first and only pull the rug after two failures (one failed
  // probe also happens while the network is still waking up).
  var RESUME_RESET_AFTER = 60000;
  var hiddensince = 0;
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") {
      hiddensince = Date.now();
      return;
    }
    if (!hiddensince || Date.now() - hiddensince < RESUME_RESET_AFTER) return;
    hiddensince = 0;
    if (!hasliveframe()) {
      resetcontroller();
      return;
    }
    probetransport().then(function (alive) {
      if (alive) return;
      probetransport().then(function (aliveagain) {
        if (!aliveagain) resetcontroller();
      });
    });
  });

  window.aetherisProxy = {
    getController: getcontroller,
    ensureLoaded: ensureloaded,
    go: safego,
    reset: resetcontroller,
  };
})();

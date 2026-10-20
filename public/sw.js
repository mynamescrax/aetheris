var MIGRATION_VERSION = 2;

async function migrateifneeded() {
  var needed = true;
  try {
    var meta = await caches.open("__sw_meta__");
    var resp = await meta.match("/migration-version");
    if (resp) {
      var v = parseInt(await resp.text(), 10);
      if (v >= MIGRATION_VERSION) needed = false;
    }
  } catch (e) {}

  if (!needed) return;

  console.log("[SW] running one-time DB migration v" + MIGRATION_VERSION);

  var deleted = await new Promise(function (resolve) {
    var req = indexedDB.deleteDatabase("scramjet-config");
    req.onsuccess = function () {
      console.log("[SW] scramjet-config deleted");
      resolve(true);
    };
    req.onerror = function () {
      console.warn("[SW] scramjet-config delete error");
      resolve(false);
    };
    req.onblocked = function () {
      console.warn("[SW] scramjet-config blocked - will retry next install");
      resolve(false);
    };
    setTimeout(function () {
      resolve(false);
    }, 3000);
  });

  // only record the migration once it actually ran, so a blocked delete retries
  if (!deleted) return;
  try {
    var meta2 = await caches.open("__sw_meta__");
    await meta2.put(
      "/migration-version",
      new Response(String(MIGRATION_VERSION)),
    );
  } catch (e) {}
}

var scramjetloaded = false;
var spoofdesktopua = false;

// use the SW's own origin so self-hosted copies behave like aetheris.win
var SITE_ORIGIN = self.location.origin;
var SITE_HOST = self.location.hostname;

// the SW can be recycled at any time, so the spoof setting is persisted; this
// promise settles once the stored value is back in memory, so the first
// requests after a cold start wait for it instead of racing the restore
var spoofrestored = new Promise(function (resolve) {
  caches
    .open("__sw_meta__")
    .then(function (c) {
      return c.match("/spoof-desktop-ua");
    })
    .then(function (r) {
      return r ? r.text() : null;
    })
    .then(function (v) {
      if (v !== null) spoofdesktopua = v === "1";
    })
    .catch(function () {})
    .then(resolve);
});

// --- game page cache ---
// One game page is 34MB and Cloudflare does not cache HTML, so every visit
// pulled the whole thing from the origin again. Keep a copy here: the page
// goes out from the cache and a fresh one is fetched in the background.
// The version is part of the URL the page is fetched and stored under. The
// pages are served with a week of stale-while-revalidate, so a fixed URL
// keeps handing out the copy the browser cached a week ago - a visitor whose
// page is a week old never sees the fix that was deployed since. A new
// version is a new cache key and a new HTTP cache entry, so the first visit
// after a change always gets the current page.
var GAMEPAGE_VERSION = "2";
var GAMEPAGE_CACHE = "aetheris-gamepages-v" + GAMEPAGE_VERSION;
// A handful of games is plenty; the cache is dropped when it grows past this.
var GAMEPAGE_MAX_ENTRIES = 16;
// Anything bigger is not worth the storage.
var GAMEPAGE_MAX_BYTES = 48 * 1024 * 1024;

function gamepageurl(request) {
  var url = new URL(request.url);
  url.searchParams.set("v", GAMEPAGE_VERSION);
  return url.href;
}

function gamepageresponse(request) {
  // Only a GET may be answered from the cache: a HEAD has to report the
  // headers of the file that is on the server, not a stored body.
  if (request.method !== "GET") return fetch(request);
  var target = gamepageurl(request);
  return caches.open(GAMEPAGE_CACHE).then(function (cache) {
    return cache.match(target).then(function (cached) {
      if (cached) {
        // A fresh copy is fetched in the background for the next visit. Its
        // body goes straight into the cache, so nothing is read twice.
        fetch(target)
          .then(function (response) {
            if (response && response.ok) storegamepage(cache, target, response);
          })
          .catch(function () {});
        return cached;
      }
      return fetch(target)
        .then(function (response) {
          if (response && response.ok) storegamepage(cache, target, response, true);
          return response;
        })
        .catch(function () {
          return new Response("", {
            status: 503,
            statusText: "Game unavailable",
          });
        });
    });
  });
}

function storegamepage(cache, key, response, clone) {
  var length = Number(response.headers.get("content-length") || 0);
  if (length && length > GAMEPAGE_MAX_BYTES) {
    if (response.body) response.body.cancel().catch(function () {});
    return;
  }
  var headers = new Headers(response.headers);
  // The cache keeps the decoded body, so the encoding headers must not go
  // with it.
  headers.delete("content-length");
  headers.delete("content-encoding");
  if (!response.body) return;
  var stored = clone ? response.clone().body : response.body;
  cache
    .put(key, new Response(stored, { status: 200, headers: headers }))
    .then(function () {
      return cache.keys();
    })
    .then(function (keys) {
      if (keys.length <= GAMEPAGE_MAX_ENTRIES) return;
      var excess = keys.slice(0, keys.length - GAMEPAGE_MAX_ENTRIES);
      return Promise.all(
        excess.map(function (entry) {
          return cache.delete(entry);
        }),
      );
    })
    .catch(function () {
      // a full storage quota must never break the game
    });
}

// --- proxy ad/tracker blocking ---
// Requests from proxied pages to domains on the HaGeZi LIGHT list (see
// scripts/update-adblock.js) fail like a blocked network request. Top-level
// navigations are never blocked. Users can turn this off in settings.
// Bump ADBLOCK_LIST_VERSION whenever the list file changes.
var ADBLOCK_LIST_VERSION = "20261011.1";
var ADBLOCK_LIST_URL =
  "/assets/data/adblock-domains.txt?v=" + ADBLOCK_LIST_VERSION;
var ADBLOCK_CACHE = "aetheris-adblock";
var adblockenabled = true;
var adhosts = null;
var adloading = null;

function loadadblocklist() {
  if (adhosts) return Promise.resolve();
  if (adloading) return adloading;
  adloading = caches
    .open(ADBLOCK_CACHE)
    .then(function (cache) {
      return cache.match(ADBLOCK_LIST_URL).then(function (hit) {
        if (hit) return hit.text();
        return fetch(ADBLOCK_LIST_URL).then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          var copy = r.clone();
          return cache
            .keys()
            .then(function (keys) {
              return Promise.all(
                keys.map(function (k) {
                  return cache.delete(k);
                }),
              );
            })
            .then(function () {
              return cache.put(ADBLOCK_LIST_URL, copy);
            })
            .then(function () {
              return r.text();
            });
        });
      });
    })
    .then(function (text) {
      var set = new Set();
      var lines = text.split("\n");
      for (var i = 0; i < lines.length; i++) {
        var d = lines[i].trim();
        if (d && d.charCodeAt(0) !== 35) set.add(d);
      }
      adhosts = set;
    })
    .catch(function (e) {
      console.warn("[SW] adblock list unavailable:", (e && e.message) || e);
      adloading = null;
    });
  return adloading;
}

// entries cover their subdomains, so walk up the labels
function isadhost(host) {
  if (!adhosts || !host || host === SITE_HOST) return false;
  var h = host;
  while (h.indexOf(".") !== -1) {
    if (adhosts.has(h)) return true;
    h = h.slice(h.indexOf(".") + 1);
  }
  return false;
}

// /~/sj/<tab id>/<frame id>/<encodeURIComponent(remote url)>; skip id
// segments until one starts with a scheme
var PROXIED_TARGET_RE = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#:]+)/i;
function proxiedtargethost(url) {
  var i = url.indexOf("/~/sj/");
  if (i === -1) return null;
  var rest = url.slice(i + 6);
  for (var hop = 0; hop < 4; hop++) {
    var slash = rest.indexOf("/");
    if (slash === -1) return null;
    rest = rest.slice(slash + 1);
    var decoded = rest;
    try {
      decoded = decodeURIComponent(rest);
    } catch (e) {}
    var m = PROXIED_TARGET_RE.exec(decoded);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

// Some ad players retry a blocked request in a tight loop (CNN's video ad
// fallback hit ~2000/s), so past 20 blocks/s per host the failure is delayed,
// growing while the loop keeps going and decaying once it stops.
// Blocked requests get an empty 204 instead of Response.error(): Firefox logs
// every Response.error() passed to respondWith(), which flooded the console
// on sites with chatty trackers (DuckDuckGo's improving.duckduckgo.com).
var AD_BURST_PER_SEC = 20;
function emptyblocked() {
  return new Response(null, { status: 204, statusText: "Blocked" });
}
var adhostrate = new Map();
function blockedresponse(host) {
  var now = Date.now();
  var e = adhostrate.get(host);
  if (!e || now - e.start >= 1000) {
    var strikes = 0;
    if (e) {
      strikes =
        e.n > AD_BURST_PER_SEC ? e.strikes + 1 : Math.max(0, e.strikes - 1);
    }
    if (adhostrate.size > 500) adhostrate.clear();
    e = { start: now, n: 0, strikes: strikes };
    adhostrate.set(host, e);
  }
  e.n++;
  if (e.strikes === 0 && e.n <= AD_BURST_PER_SEC) return emptyblocked();
  var delay = Math.min(5000, 1000 * Math.max(1, e.strikes));
  return new Promise(function (resolve) {
    setTimeout(function () {
      resolve(emptyblocked());
    }, delay);
  });
}

// same as the spoof flag: settle the stored value before requests route, so a
// user who turned blocking off doesn't get blocked requests after a cold start
var adblockrestored = new Promise(function (resolve) {
  caches
    .open("__sw_meta__")
    .then(function (c) {
      return c.match("/proxy-adblock");
    })
    .then(function (r) {
      return r ? r.text() : null;
    })
    .then(function (v) {
      if (v !== null) adblockenabled = v === "1";
      if (adblockenabled) loadadblocklist();
    })
    .catch(function () {
      loadadblocklist();
    })
    .then(resolve);
});

// both flags live in the same cache; the fetch handler awaits this before
// routing so early requests never see the defaults
var settingsrestored = Promise.all([spoofrestored, adblockrestored]);

function persistadblockstate(enabled) {
  caches
    .open("__sw_meta__")
    .then(function (c) {
      return c.put("/proxy-adblock", new Response(enabled ? "1" : "0"));
    })
    .catch(function () {});
}

function persistspoofstate(enabled) {
  caches
    .open("__sw_meta__")
    .then(function (c) {
      return c.put("/spoof-desktop-ua", new Response(enabled ? "1" : "0"));
    })
    .catch(function () {});
}

// Desktop-UA spoofing. Chromium reuses its real major version so the UA
// matches the Sec-CH-UA headers it sends; Safari has none to borrow, so keep
// CHROME_FALLBACK_MAJOR roughly current or version-gated sites reject it.
var CHROME_FALLBACK_MAJOR = "154";
var spoofchromemajor = (function () {
  var match = /(?:Chrome|Chromium)\/(\d+)/.exec(navigator.userAgent);
  return match ? match[1] : CHROME_FALLBACK_MAJOR;
})();
var spooffullversion = spoofchromemajor + ".0.0.0";
var spoofbrandsjson = JSON.stringify([
  { brand: "Chromium", version: spoofchromemajor },
  { brand: "Google Chrome", version: spoofchromemajor },
  { brand: "Not=A?Brand", version: "99" },
]);
// Request-header values matching the shim below, applied in buildrouteevent.
var spoofuach =
  '"Chromium";v="' +
  spoofchromemajor +
  '", "Google Chrome";v="' +
  spoofchromemajor +
  '", "Not=A?Brand";v="99"';
var spoofuachfull =
  '"Chromium";v="' +
  spooffullversion +
  '", "Google Chrome";v="' +
  spooffullversion +
  '", "Not=A?Brand";v="99.0.0.0"';

var desktopua =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" +
  spooffullversion +
  " Safari/537.36";

var desktopuashim =
  "<script>" +
  "(function(){" +
  "  if (window.__aetherisDesktopUASpoofInstalled) return;" +
  "  window.__aetherisDesktopUASpoofInstalled = true;" +
  "  var pcua = " +
  JSON.stringify(desktopua) +
  ";" +
  "  function def(obj, key, value) {" +
  "    try { Object.defineProperty(obj, key, { get: function(){ return value; }, configurable: true }); } catch(e) {}" +
  "  }" +
  '  def(Navigator.prototype, "userAgent", pcua);' +
  '  def(Navigator.prototype, "platform", "Win32");' +
  '  def(Navigator.prototype, "maxTouchPoints", 0);' +
  '  def(Navigator.prototype, "vendor", "Google Inc.");' +
  "  try {" +
  '    Object.defineProperty(Navigator.prototype, "userAgentData", {' +
  "      get: function(){" +
  "        return {" +
  "          brands: " +
  spoofbrandsjson +
  "," +
  "          mobile: false," +
  '          platform: "Windows",' +
  "          getHighEntropyValues: function(hints) {" +
  "            var values = {" +
  "              brands: this.brands," +
  "              mobile: false," +
  '              platform: "Windows",' +
  '              architecture: "x86",' +
  '              bitness: "64",' +
  '              model: "",' +
  '              platformVersion: "10.0.0",' +
  "              uaFullVersion: " +
  JSON.stringify(spooffullversion) +
  "," +
  "              fullVersionList: this.brands" +
  "            };" +
  "            var out = {};" +
  "            (hints || []).forEach(function(k){ if (k in values) out[k] = values[k]; });" +
  "            return Promise.resolve(out);" +
  "          }" +
  "        };" +
  "      }," +
  "      configurable: true" +
  "    });" +
  "  } catch(e) {}" +
  "})();" +
  "<\/script>";

// controller.sw.js relays /~/sj/<id>/ fetches to the tab whose Controller
// registered that prefix (see scramjet-init.js). Retried from the fetch
// handler so one failed import on a cold start doesn't disable the proxy.
function ensurecontrollerloaded() {
  if (scramjetloaded) return true;
  try {
    importScripts("/controller/controller.sw.js");
    scramjetloaded = true;
  } catch (err) {
    console.error("[SW] Scramjet controller failed to load:", err);
    scramjetloaded = false;
  }
  return scramjetloaded;
}
ensurecontrollerloaded();

// Duck-typed FetchEvent for $scramjetController.route():
// - bodies are buffered with arrayBuffer() because Request.body streams are
//   Chromium-only; elsewhere POSTs went out empty (Discord answered 400).
// - spoofed headers go in a bare Headers(): a Request's "request"-guarded
//   headers silently drop User-Agent and Sec-CH-UA-*.
function hasrequestbody(req) {
  return req.method !== "GET" && req.method !== "HEAD";
}

async function buildrouteevent(event) {
  var req = event.request;
  var spoof = spoofdesktopua;
  var withbody = hasrequestbody(req);

  // Nothing to rewrite — hand route() the real FetchEvent untouched.
  if (!spoof && !withbody) return event;

  try {
    var headers;
    if (spoof) {
      headers = new Headers();
      for (var pair of req.headers) headers.set(pair[0], pair[1]);
      headers.set("User-Agent", desktopua);
      headers.set("Sec-CH-UA-Mobile", "?0");
      headers.set("Sec-CH-UA-Platform", '"Windows"');
      // client hints would otherwise contradict the spoofed UA
      headers.set("Sec-CH-UA", spoofuach);
      headers.set("Sec-CH-UA-Full-Version-List", spoofuachfull);
      headers.set("Sec-CH-UA-Platform-Version", '"10.0.0"');
      headers.set("Sec-CH-UA-Arch", '"x86"');
      headers.set("Sec-CH-UA-Bitness", '"64"');
    } else {
      headers = req.headers;
    }

    // clone before any await so the original stays usable on error paths
    var bodypromise = withbody ? req.clone().arrayBuffer() : null;
    var body = bodypromise ? await bodypromise : null;

    return {
      request: {
        url: req.url,
        referrer: req.referrer,
        destination: req.destination,
        mode: req.mode,
        method: req.method,
        body: body,
        cache: req.cache,
        headers: headers,
      },
      clientId: event.clientId,
      resultingClientId: event.resultingClientId,
    };
  } catch (e) {
    console.error("[SW] failed to build route event, using original:", e);
    return event;
  }
}

var recoveryhtml =
  "<!DOCTYPE html>" +
  '<html lang="en">' +
  "<head>" +
  '<meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  "<title>Fixing connection…</title>" +
  "<style>" +
  "*{box-sizing:border-box;margin:0;padding:0}" +
  "body{min-height:100vh;display:flex;align-items:center;justify-content:center;" +
  "  background:#0e0010;font-family:system-ui,sans-serif;color:#e2d6f5}" +
  ".card{text-align:center;padding:2.5rem 2rem;max-width:360px}" +
  ".spinner{width:48px;height:48px;border:3px solid rgba(180,120,255,.2);" +
  "  border-top-color:#b478ff;border-radius:50%;animation:spin .8s linear infinite;" +
  "  margin:0 auto 1.5rem}" +
  "@keyframes spin{to{transform:rotate(360deg)}}" +
  "h1{font-size:1.1rem;font-weight:600;margin-bottom:.5rem;color:#f0eaff}" +
  "p{font-size:.875rem;color:#a090c0;line-height:1.5}" +
  "</style>" +
  "</head>" +
  "<body>" +
  '<div class="card">' +
  '  <div class="spinner"></div>' +
  "  <h1>fixing stuff...</h1>" +
  "  <p>clearing your cache, won't take long.</p>" +
  "</div>" +
  '<script src="/js/cache-reset.js?v=20260924.1"><\/script>' +
  "<script>" +
  'AetherisCache.reset().then(function(){ window.location.replace("/"); })' +
  '.catch(function(e){ document.querySelector("h1").textContent="Reset incomplete"; document.querySelector("p").textContent=e.message; });' +
  "<\/script>" +
  "</body>" +
  "</html>";

var audiounlockshim =
  "<script>" +
  "(function(){" +
  "  if (window.__aetherisAudioUnlockInstalled) return;" +
  "  window.__aetherisAudioUnlockInstalled = true;" +
  "  var issafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);" +
  "  var contexts = new Set();" +
  "  var unlocked = false;" +
  "  function dbg(){" +
  "    if (console && console.log) {" +
  '      var args = ["[audio-dbg]"].concat(Array.prototype.slice.call(arguments));' +
  "      console.log.apply(console, args);" +
  "    }" +
  "  }" +
  "  function silentping(ctx){" +
  "    try {" +
  "      var buf = ctx.createBuffer(1, 1, 22050);" +
  "      var src = ctx.createBufferSource();" +
  "      src.buffer = buf; src.connect(ctx.destination);" +
  '      if (typeof src.start === "function") src.start(0);' +
  '      else if (typeof src.noteOn === "function") src.noteOn(0);' +
  "    } catch(e){}" +
  "  }" +
  "  function tryresume(ctx){" +
  '    if (!ctx || typeof ctx.resume !== "function") return;' +
  '    if (ctx.state === "suspended" || ctx.state === "interrupted") {' +
  "      silentping(ctx);" +
  "      try {" +
  '        ctx.resume().then(function(){ dbg("resume() resolved, new state:", ctx.state); })' +
  '          .catch(function(e){ dbg("resume() rejected:", e && e.message); });' +
  '      } catch(e){ dbg("resume() threw:", e && e.message); }' +
  "    }" +
  "  }" +
  "  function watchcontext(ctx){" +
  "    if (!ctx || ctx.__aetherisWatched) return;" +
  "    ctx.__aetherisWatched = true; contexts.add(ctx);" +
  '    try { ctx.addEventListener("statechange", function(){' +
  '      dbg("watched context statechange ->", ctx.state);' +
  '      if (unlocked && (ctx.state === "suspended" || ctx.state === "interrupted")) tryresume(ctx);' +
  "    }); } catch(e){}" +
  "  }" +
  "  function scanunitycontexts(){" +
  "    try {" +
  '      var canvases = document.querySelectorAll("canvas");' +
  "      for (var i=0;i<canvases.length;i++){" +
  "        var c = canvases[i];" +
  "        var u = c.unityInstance || window.unityInstance || window.myGameInstance || window.gameInstance;" +
  "        var ctx = u && u.Module && u.Module.WEBAudio && u.Module.WEBAudio.audioContext;" +
  '        if (ctx) { dbg("found Unity WEBAudio context, state:", ctx.state); watchcontext(ctx); if (unlocked) tryresume(ctx); }' +
  "      }" +
  "    } catch(e){}" +
  "  }" +
  "  function unlockall(){" +
  '    if (!unlocked) { dbg("first unlock gesture fired (Safari:", issafari, ")"); startpolling(); }' +
  "    unlocked = true; contexts.forEach(tryresume); scanunitycontexts();" +
  "  }" +
  "  var _polltimer = null;" +
  "  function startpolling(){" +
  "    if (_polltimer) return;" +
  "    _polltimer = setInterval(function(){" +
  "      if (document.hidden) return;" +
  "      contexts.forEach(function(ctx){" +
  '        if (ctx.state === "suspended" || ctx.state === "interrupted") { dbg("poll: resuming context, state:", ctx.state); tryresume(ctx); }' +
  "      }); scanunitycontexts();" +
  "    }, 2000);" +
  "  }" +
  '  document.addEventListener("visibilitychange", function(){' +
  '    if (document.visibilityState === "visible" && unlocked) { dbg("visibilitychange -> visible, re-resuming contexts"); unlockall(); }' +
  "  });" +
  "  var native = window.AudioContext || window.webkitAudioContext;" +
  "  if (native) {" +
  '    dbg("patching AudioContext constructor (Safari:", issafari, ")");' +
  "    var wrapped = function(){" +
  "      var ctx = arguments.length ? new native(arguments[0]) : new native();" +
  '      dbg("AudioContext created, initial state:", ctx.state, "sampleRate:", ctx.sampleRate);' +
  "      watchcontext(ctx); tryresume(ctx); return ctx;" +
  "    };" +
  "    wrapped.prototype = native.prototype;" +
  "    try { window.AudioContext = wrapped; } catch(e){}" +
  "    try { window.webkitAudioContext = wrapped; } catch(e){}" +
  '  } else { dbg("no AudioContext available on this page"); }' +
  '  var events = ["touchstart","touchend","mousedown","click","keydown","pointerdown","gesturestart"];' +
  "  events.forEach(function(evt){ document.addEventListener(evt, unlockall, { capture: true, passive: true }); });" +
  '  window.addEventListener("message", function(e){ if (e && e.data && e.data.type === "aetheris-unlock-audio") unlockall(); });' +
  "  function patchchildiframe(el){" +
  '    if (!el || el.tagName !== "IFRAME") return;' +
  "    try {" +
  '      var cur = el.getAttribute("allow") || "";' +
  '      if (cur.indexOf("autoplay") === -1) {' +
  '        el.setAttribute("allow", cur ? cur + "; autoplay" : "autoplay; fullscreen");' +
  '        dbg("patched child iframe allow:", el.src || el.getAttribute("src"));' +
  "      }" +
  "    } catch(e){}" +
  "  }" +
  '  function patchchildiframes(){ try { var iframes = document.querySelectorAll("iframe"); for (var i = 0; i < iframes.length; i++) patchchildiframe(iframes[i]); } catch(e){} }' +
  "  patchchildiframes();" +
  "  try {" +
  "    var mo = new MutationObserver(function(mutations){" +
  "      for (var i = 0; i < mutations.length; i++){" +
  "        var added = mutations[i].addedNodes;" +
  "        for (var j = 0; j < added.length; j++){" +
  "          var n = added[j];" +
  '          if (n && n.tagName === "IFRAME") patchchildiframe(n);' +
  '          else if (n && n.querySelectorAll) { var nested = n.querySelectorAll("iframe"); for (var k = 0; k < nested.length; k++) patchchildiframe(nested[k]); }' +
  "        }" +
  "      }" +
  "    });" +
  "    mo.observe(document.documentElement, { childList: true, subtree: true });" +
  "  } catch(e){}" +
  "  window.__audiodbg = { getcontexts: function(){ return Array.from(contexts); }, forceunlock: unlockall, get unlocked(){ return unlocked; } };" +
  "})();" +
  "<\/script>";

// Ad spoof shim, inlined once fetched (external tag until then). Inline avoids
// scramjet logging "unexpected url" for every local <script src> it unrewrites.
var ADSPOOF_SRC = "/js/ad-spoof.js?v=20260928.3";
var adspoofshim = '<script src="' + ADSPOOF_SRC + '"><\/script>';
var adspoofinline = null;
(function warmadspoof() {
  fetch(ADSPOOF_SRC)
    .then(function (response) {
      return response.ok ? response.text() : "";
    })
    .then(function (text) {
      if (!text) return;
      adspoofinline =
        "<script>" + text.replace(/<\/script/gi, "<\\/script") + "<\/script>";
    })
    .catch(function () {
      /* the external fallback tag still works */
    });
})();

// panic key inside proxied pages (same origin, so same localStorage)
var panicshim =
  "<script>" +
  "(function(){" +
  "  if (window.__aetherisPanicInstalled) return;" +
  "  window.__aetherisPanicInstalled = true;" +
  "  function panic(e) {" +
  "    try {" +
  '      var k = localStorage.getItem("panickey");' +
  "      if (!k || e.key !== k) return;" +
  "      var t = e.target;" +
  '      if (e.key.length === 1 && t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;' +
  '      var u = localStorage.getItem("panicurl") || "https://classroom.google.com/";' +
  '      try { var parsed = new URL(u, location.href); if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) u = "https://classroom.google.com/"; } catch (_) { u = "https://classroom.google.com/"; }' +
  "      var w = window.top || window;" +
  "      try { w.location.replace(u); } catch (_) { window.location.replace(u); }" +
  "    } catch (_) {}" +
  "  }" +
  '  document.addEventListener("keydown", panic, true);' +
  "})();" +
  "<\/script>";

// scramjet virtualizes cookies but leaves navigator.cookieEnabled alone, and
// some sites (e.g. legionsdk.com) block sign-in when it's false
var cookieenabledshim =
  "<script>" +
  "(function(){" +
  "  if (window.__aetherisCookieEnabledShimInstalled) return;" +
  "  window.__aetherisCookieEnabledShimInstalled = true;" +
  "  try {" +
  '    Object.defineProperty(Navigator.prototype, "cookieEnabled", { get: function(){ return true; }, configurable: true });' +
  "  } catch(e){}" +
  "})();" +
  "<\/script>";

// Cloudflare's Web Analytics beacon was saved into the game pages when they
// were copied from a browser. The beacon posts to a root-relative
// "/cdn-cgi/rum", and the games carry a <base href="https://cdn.jsdelivr.net/...">
// that sends that post to the CDN: the answer there has no CORS header, so
// every game that ships the beacon logs a CORS error that has nothing to do
// with the game itself. The site has its own analytics, so the beacon is
// dropped from the game pages.
var CF_BEACON_TAG =
  /<script[^>]*static\.cloudflareinsights\.com[^>]*>[\s\S]*?<\/script>/gi;

async function stripbeacon(response) {
  if (!response || response.status !== 200) return response;
  var ct = (response.headers.get("content-type") || "").toLowerCase();
  if (ct.indexOf("text/html") === -1) return response;
  try {
    var text = await response.clone().text();
    if (text.indexOf("static.cloudflareinsights.com") === -1) return response;
    var headers = new Headers(response.headers);
    // The body is plain text now: the length and the encoding of the
    // original body no longer describe it.
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(text.replace(CF_BEACON_TAG, ""), {
      status: response.status,
      statusText: response.statusText,
      headers: headers,
    });
  } catch (e) {
    return response;
  }
}

// past this many bytes without <head>/<html>, shims go at the front
var SHIM_SCAN_LIMIT = 256 * 1024;

// Streams HTML and inserts the shims at the first insertion point, so pages
// render without buffering the whole document. Reads ahead until the queue is
// full; not pull-only because some engines don't re-pull after an empty pull.
function streamwithshims(body, shims) {
  var reader = body.getReader();
  var decoder = new TextDecoder("utf-8");
  var encoder = new TextEncoder();
  var injected = false;
  var pending = "";
  var paused = false;
  var finished = false;

  function process(controller, result) {
    if (result.done) {
      var tail = decoder.decode();
      if (!injected) {
        controller.enqueue(encoder.encode(shims + pending + tail));
      } else if (tail) {
        controller.enqueue(encoder.encode(tail));
      }
      controller.close();
      finished = true;
      return;
    }

    var text = decoder.decode(result.value, { stream: true });

    if (!injected) {
      pending += text;
      var match =
        /<head[^>]*>/i.exec(pending) || /<html[^>]*>/i.exec(pending);
      if (match) {
        var cut = match.index + match[0].length;
        controller.enqueue(
          encoder.encode(pending.slice(0, cut) + shims + pending.slice(cut)),
        );
        pending = "";
        injected = true;
      } else if (pending.length >= SHIM_SCAN_LIMIT) {
        controller.enqueue(encoder.encode(shims + pending));
        pending = "";
        injected = true;
      }
    } else if (text) {
      controller.enqueue(encoder.encode(text));
    }
  }

  function pump(controller) {
    if (finished || paused) return;
    reader.read().then(
      function (result) {
        // The consumer may have cancelled while this read was in flight.
        if (finished || paused) return;
        try {
          process(controller, result);
        } catch (err) {
          finished = true;
          try {
            controller.error(err);
          } catch (_) {
            /* already closed */
          }
          return;
        }
        if (finished || paused) return;
        if (controller.desiredSize <= 0) {
          paused = true;
          return;
        }
        pump(controller);
      },
      function (err) {
        if (finished) return;
        finished = true;
        try {
          controller.error(err);
        } catch (_) {
          /* already closed */
        }
      },
    );
  }

  return new ReadableStream({
    start: function (controller) {
      pump(controller);
    },
    pull: function (controller) {
      if (paused) {
        paused = false;
        pump(controller);
      }
    },
    cancel: function (reason) {
      finished = true;
      return reader.cancel(reason);
    },
  });
}

function injecthtmlshims(response, options) {
  if (!options) options = {};
  try {
    if (!response || !(response instanceof Response)) return response;
    if (response.status !== 200) return response;
    if (response.type === "opaque" || response.type === "opaqueredirect")
      return response;
    var ct = (response.headers.get("content-type") || "").toLowerCase();
    if (ct.indexOf("text/html") === -1) return response;

    var shims =
      cookieenabledshim +
      panicshim +
      (options.desktopua ? desktopuashim : "") +
      audiounlockshim +
      (adspoofinline || adspoofshim);

    var newheaders = new Headers(response.headers);
    newheaders.delete("content-length");
    // Override only the features the proxy needs; keep any policy the remote
    // page declared for camera, microphone, geolocation, and friends.
    var existingpolicy = newheaders.get("Permissions-Policy") || "";
    var kept = [];
    existingpolicy
      .split(",")
      .map(function (part) {
        return part.trim();
      })
      .forEach(function (part) {
        if (!part) return;
        var name = part.split("=")[0].trim().toLowerCase();
        if (name === "autoplay" || name === "fullscreen") return;
        kept.push(part);
      });
    kept.push("autoplay=*", "fullscreen=*");
    newheaders.set("Permissions-Policy", kept.join(", "));

    var body = response.body ? streamwithshims(response.body, shims) : shims;
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: newheaders,
    });
  } catch (err) {
    return response;
  }
}

// route() never rejects: controller failures come back as a 500 text/plain
// "Internal Service Worker Error: ..." body. Detect that shape and log the
// real reason instead of letting pages choke on it as JSON.
var SW_ERROR_PREFIX = "Internal Service Worker Error";

async function surfacerouteerror(response, request) {
  try {
    if (!response || response.status !== 500) return response;
    var ct = (response.headers.get("content-type") || "").toLowerCase();
    if (ct.indexOf("text/plain") !== 0) return response;

    var text = await response.clone().text();
    if (text.indexOf(SW_ERROR_PREFIX) !== 0) return response;

    // normal when a frame is replaced mid-request; not worth logging
    if (text.indexOf("No frame found for request") !== -1) {
      console.warn(
        "[SW] dropped request from a closed frame:",
        request.method,
        request.url.slice(0, 200),
      );
      return response;
    }

    console.error(
      "[SW] scramjet controller failed to handle a request —",
      text,
      "\n  method:",
      request.method,
      "\n  url:",
      request.url,
      "\n  destination:",
      request.destination || "(empty)",
      "\n  mode:",
      request.mode,
    );
  } catch (e) {
    /* diagnostic only — never let it break the response */
  }

  return response;
}

var fetcherrors = new Map();
function logfetchfail(req, err) {
  var now = Date.now();
  if (now - (fetcherrors.get(req.url) || 0) < 5000) return;
  // bound memory on pages that fail lots of distinct URLs
  if (fetcherrors.size > 500) fetcherrors.clear();
  fetcherrors.set(req.url, now);
  console.error(
    "[SW] fetch failed:",
    (err && err.message) || err,
    "\n url:",
    req.url,
  );
}

// Proxied URLs embed the remote URL nearly verbatim (encodeURIComponent), so
// every substring/extension rule must skip /~/sj/ or it steals proxy traffic.
function isproxiedurl(url) {
  return url.indexOf("/~/sj/") !== -1;
}

// Static CDN mirrors relayed same-origin through /game-assets/m/ (see
// MIRRORS in lib/game-assets.js). Keys must stay in sync with that map:
// unknown hosts are never relayed, so this can't become an open proxy.
var MIRROR_HOSTS = {
  "cdn.jsdelivr.net": "jsdelivr",
  "fastly.jsdelivr.net": "fastly",
  "gcore.jsdelivr.net": "gcore",
  "cdn.statically.io": "statically",
  "raw.githubusercontent.com": "ghraw",
  "raw.githack.com": "githack",
  "cdnjs.cloudflare.com": "cdnjs",
};

// One path segment of a relayed asset path. Percent escapes are allowed (a
// jsDelivr path can contain encoded spaces, "fruit%20ninja/"), but a decoded
// separator or a traversal segment is not: it would name a different file
// than the visitor asked for. Keep this in sync with decodeAssetSegment()
// in lib/game-assets.js.
var SEGMENT = /^[-A-Za-z0-9._~!$&'()*+,;=:@%]+$/;

function validsegment(segment) {
  if (!SEGMENT.test(segment)) return false;
  for (var i = segment.indexOf("%"); i !== -1; i = segment.indexOf("%", i + 1)) {
    if (!/^[0-9A-Fa-f]{2}$/.test(segment.substring(i + 1, i + 3))) return false;
  }
  var decoded;
  try {
    decoded = decodeURIComponent(segment);
  } catch (e) {
    return false;
  }
  if (decoded.indexOf("/") !== -1 || decoded.indexOf("\\") !== -1) return false;
  if (decoded === "." || decoded === "..") return false;
  return true;
}

// The relay serves opaque URLs as well, so an absolute CDN URL is sent there
// too: a page never shows the CDN layout it pulls from. The token is
// base64url of "<mirror>:<directory>"; keep this in sync with assetToken()
// in lib/game-assets.js.
function assettoken(mirror, dir) {
  return btoa(mirror + ":" + dir)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Absolute CDN URLs hardcoded in game pages (hundreds of them) bypass the
// relay on their own. Redirect them same-origin so every mirror fetch gets
// the relay's poisoned-body validation and shows as localhost/our domain.
// Only safe GET/HEAD traffic: never redirect POSTs or proxied (/~/sj/)
// requests, and never touch the relay's own same-origin requests.
function mirrorredirecturl(url, method) {
  if (method !== "GET" && method !== "HEAD") return null;
  if (isproxiedurl(url)) return null;
  var parsed = null;
  try {
    parsed = new URL(url);
  } catch (e) {
    return null;
  }
  if (parsed.origin === SITE_ORIGIN) return null;
  if (parsed.username || parsed.password) return null;
  var mirror = MIRROR_HOSTS[parsed.hostname.toLowerCase()];
  if (!mirror) return null;
  // Visitor path only: strict charset, no traversal, no credential smuggling.
  // Client query strings are dropped; the relay ignores them anyway.
  var path = parsed.pathname;
  if (path.length > 512) return null;
  // pathname always starts with "/"; skip that empty first segment.
  var segments = path.split("/").slice(1);
  for (var i = 0; i < segments.length; i++) {
    if (!validsegment(segments[i])) return null;
  }
  // The directory travels in the token, the file name stays readable.
  var relative = path.slice(1);
  var slash = relative.lastIndexOf("/");
  if (slash <= 0) return null;
  var dir = relative.slice(0, slash);
  var file = relative.slice(slash + 1);
  return SITE_ORIGIN + "/s/" + assettoken(mirror, dir) + "/" + file;
}

// The redirect for a cross-origin fetch() is itself CORS-checked: the browser
// needs Access-Control-Allow-Origin on the 302, not just on the file it points
// to. Response.redirect() cannot carry headers, and a strict engine (WebKit)
// then drops the request before it ever reaches the relay.
function mirrorredirectresponse(location) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}

// The relay answers a failed asset with a 5xx. Cloudflare replaces a 5xx from
// the origin with its own error page, and that page carries no CORS header:
// the browser then refuses it and reports "blocked by CORS policy", so the real
// status never reaches the game. The worker sees the answer before the
// browser does and puts the header back, which turns the CORS error into the
// status it always was.
function isrelaypath(pathname) {
  return (
    pathname.indexOf("/s/") === 0 || pathname.indexOf("/game-assets/") === 0
  );
}

function relayresponse(request) {
  return fetch(request).then(
    function (response) {
      if (response && response.status < 500) return response;
      var headers = new Headers(response.headers);
      headers.set(
        "Access-Control-Allow-Origin",
        request.headers.get("Origin") || "*",
      );
      headers.set("Vary", "Origin");
      // The body is handed over unchanged, so the length may no longer be
      // the one of the error page.
      headers.delete("content-length");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: headers,
      });
    },
    function () {
      return new Response("Game CDN temporarily unavailable; retry shortly.", {
        status: 502,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Access-Control-Allow-Origin":
            request.headers.get("Origin") || "*",
          "Cache-Control": "no-store",
          "Retry-After": "10",
        },
      });
    },
  );
}

function shouldbypass(url) {
  if (
    url.indexOf("data:") === 0 ||
    url.indexOf("chrome-extension:") === 0 ||
    url.indexOf("blob:") === 0 ||
    url.indexOf("ws:") === 0
  )
    return true;

  // includes the controller's virtual /~/sj/.../scramjet.wasm.js
  if (isproxiedurl(url)) return false;

  if (url.indexOf(".unityweb") !== -1 || url.indexOf(".wasm") !== -1)
    return true;

  if (
    url.indexOf("/api-proxy/") !== -1 ||
    url.indexOf("/proxy/") !== -1 ||
    url.indexOf("jsdelivr.net") !== -1 ||
    url.indexOf(SITE_ORIGIN + "/assets/") !== -1 ||
    url.indexOf(SITE_ORIGIN + "/game-assets/") === 0 ||
    url.indexOf(SITE_ORIGIN + "/s/") === 0 ||
    url.indexOf(SITE_ORIGIN + "/scramjet/") !== -1 ||
    url.indexOf(SITE_ORIGIN + "/controller/") !== -1 ||
    url.indexOf(SITE_ORIGIN + "/api/") !== -1 ||
    url.indexOf(SITE_ORIGIN + "/js/") !== -1 ||
    url.indexOf(SITE_ORIGIN + "/css/") !== -1
  )
    return true;

  try {
    var parsed = new URL(url);
    if (parsed.hostname === SITE_HOST && /\.html$/.test(parsed.pathname))
      return true;
  } catch (e) {}

  try {
    if (/\/online(-count)?$/.test(new URL(url).pathname)) return true;
  } catch (e) {}

  return false;
}

self.addEventListener("fetch", function (event) {
  var url = event.request.url;
  var proxied = isproxiedurl(url);

  // recovery page: own origin and exact paths only
  if (!proxied && url.indexOf("/recover") !== -1) {
    var recoverparsed = null;
    try {
      recoverparsed = new URL(url);
    } catch (e) {}
    var recoverpath = recoverparsed ? recoverparsed.pathname : "";
    if (
      recoverparsed &&
      recoverparsed.origin === self.location.origin &&
      (recoverpath === "/recover" ||
        recoverpath === "/recover.html" ||
        recoverpath === "/sw-recover")
    ) {
      event.respondWith(
        new Response(recoveryhtml, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
      );
      return;
    }
  }

  // match the host exactly; a substring match also caught unrelated URLs
  // (e.g. ones carrying it in a query string) and refetched them unchanged
  if (!proxied && url.indexOf("https://api.1games.io/") === 0) {
    var rewritten = SITE_ORIGIN + "/api-proxy/" + url.slice(22);
    event.respondWith(
      event.request.text().then(function (body) {
        return fetch(rewritten, {
          method: event.request.method,
          headers: event.request.headers,
          body: hasrequestbody(event.request) ? body : undefined,
        });
      }),
    );
    return;
  }

  var parsed = null;
  try {
    parsed = new URL(url);
  } catch (e) {}

  if (
    parsed &&
    parsed.origin === self.location.origin &&
    parsed.pathname.indexOf("/assets/games/") === 0 &&
    /\.html$/i.test(parsed.pathname)
  ) {
    event.respondWith(
      settingsrestored
        .then(function () {
          return gamepageresponse(event.request).then(function (r) {
            return stripbeacon(r).then(function (clean) {
              return injecthtmlshims(clean, { desktopua: spoofdesktopua });
            });
          });
        })
        .catch(function () {
          return fetch(event.request).catch(function () {
            if (event.request.mode === "navigate")
              return Response.redirect("/recover", 302);
            return new Response("", {
              status: 503,
              statusText: "Game unavailable",
            });
          });
        }),
    );
    return;
  }

  if (!proxied && url.indexOf("disable-devtool") !== -1) {
    event.respondWith(
      new Response("", {
        headers: { "Content-Type": "application/javascript" },
      }),
    );
    return;
  }

  // Universal mirror relay: any absolute static-CDN URL becomes a same-origin
  // /game-assets/m/ request before the bypass below can let it through direct.
  if (!proxied) {
    var mirrorurl = mirrorredirecturl(url, event.request.method);
    if (mirrorurl) {
      event.respondWith(mirrorredirectresponse(mirrorurl));
      return;
    }
  }

  // The relay answers are CORS-checked by the game. A failed asset would
  // arrive without a CORS header (Cloudflare replaces a 5xx with its own
  // error page), so the browser reports a CORS error instead of the status.
  // The worker is the last place where the header can be put back.
  if (!proxied && parsed && parsed.origin === SITE_ORIGIN && isrelaypath(parsed.pathname)) {
    event.respondWith(relayresponse(event.request));
    return;
  }

  if (shouldbypass(url)) return;

  if (!ensurecontrollerloaded()) {
    if (proxied) {
      // /~/sj/ only exists as a proxy prefix; the origin would just 404
      if (event.request.mode === "navigate") {
        event.respondWith(Response.redirect("/recover", 302));
      } else {
        event.respondWith(
          new Response("", { status: 503, statusText: "Proxy unavailable" }),
        );
      }
      return;
    }
    event.respondWith(
      fetch(event.request).catch(function () {
        if (event.request.mode === "navigate")
          return Response.redirect("/recover", 302);
        return new Response("", { status: 503, statusText: "SW unavailable" });
      }),
    );
    return;
  }

  // only URLs under a live tab's /~/sj/<id>/ prefix are routed
  var shouldroute = false;
  try {
    shouldroute = $scramjetController.shouldRoute(event);
  } catch (e) {
    shouldroute = false;
  }

  if (!shouldroute) return;

  event.respondWith(
    settingsrestored
      .then(function () {
        // the adblock check moved in here so a cold start can't block with
        // the blocker the user turned off (or slip past one they enabled)
        if (adblockenabled && event.request.mode !== "navigate") {
          if (!adhosts) loadadblocklist();
          var adtarget = proxiedtargethost(url);
          if (isadhost(adtarget)) return blockedresponse(adtarget);
        }
        return buildrouteevent(event)
          .then(function (re) {
            return $scramjetController.route(re);
          })
          .then(function (r) {
            return surfacerouteerror(r, event.request);
          })
          .then(function (r) {
            return injecthtmlshims(r, { desktopua: spoofdesktopua });
          });
      })
      .catch(function (err) {
        logfetchfail(event.request, err);
        if (event.request.mode === "navigate")
          return Response.redirect("/recover", 302);
        // not fetch(event.request): the origin would return 404.html, which
        // callers then fail to parse as JSON
        return new Response("", {
          status: 503,
          statusText: "Proxy unavailable",
        });
      }),
  );
});

self.addEventListener("install", function (event) {
  event.waitUntil(
    migrateifneeded()
      .then(function () {
        // warm the blocklist cache; never let it block the install
        return Promise.race([
          loadadblocklist(),
          new Promise(function (r) {
            setTimeout(r, 5000);
          }),
        ]);
      })
      .then(function () {
        return self.skipWaiting();
      }),
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (names) {
        // The game page cache is versioned. The older ones are never read
        // again, and they hold tens of megabytes, so they go.
        return Promise.all(
          names.map(function (name) {
            if (
              name.indexOf("aetheris-gamepages") === 0 &&
              name !== GAMEPAGE_CACHE
            ) {
              return caches.delete(name);
            }
            return null;
          }),
        );
      })
      .then(function () {
        return self.clients.claim();
      }),
  );
});

self.addEventListener("message", function (event) {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data && event.data.type === "aetheris-set-desktop-ua-spoof") {
    spoofdesktopua = event.data.enabled === true;
    persistspoofstate(spoofdesktopua);
  }
  if (event.data && event.data.type === "aetheris-set-adblock") {
    adblockenabled = event.data.enabled !== false;
    persistadblockstate(adblockenabled);
    if (adblockenabled) loadadblocklist();
  }
});

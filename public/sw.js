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
var GAMEPAGE_VERSION = "8";
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
// HaGeZi LIGHT is deliberately conservative (it leaves ad networks that ad
// funded games load), so the ad networks a web game actually uses are listed
// here as well. Apex entries cover their subdomains; host entries are exact.
var AD_HOSTS_BUILTIN = new Set([
  // display / video ad exchanges and their players
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "googletagservices.com",
  "googletagmanager.com",
  "imasdk.googleapis.com",
  "adnxs.com",
  "amazon-adsystem.com",
  "adsrvr.org",
  "bidswitch.net",
  "casalemedia.com",
  "contextweb.com",
  "criteo.com",
  "districtm.io",
  "gumgum.com",
  "indexexchange.com",
  "innovid.com",
  "lijit.com",
  "loopme.me",
  "media.net",
  "mgid.com",
  "moatads.com",
  "openx.net",
  "outbrain.com",
  "pubmatic.com",
  "revcontent.com",
  "rubiconproject.com",
  "sharethrough.com",
  "smaato.net",
  "smartadserver.com",
  "sovrn.com",
  "spotx.tv",
  "spotxchange.com",
  "springserve.com",
  "taboola.com",
  "teads.tv",
  "tremorhub.com",
  "triplelift.com",
  "undertone.com",
  "yieldmo.com",
  "zergnet.com",
  // mobile / HTML5 game ad SDKs
  "adcolony.com",
  "adincube.com",
  "admob.com",
  "applovin.com",
  "chartboost.com",
  "fyber.com",
  "heyzap.com",
  "inmobi.com",
  "ironsrc.com",
  "ironsrc.mobi",
  "mopub.com",
  "startappservice.com",
  "supersonicads.com",
  "tapjoy.com",
  "unityads.unity3d.com",
  "vungle.com",
  // cheap popunder / redirect networks
  "adcash.com",
  "adsterra.com",
  "exoclick.com",
  "hilltopads.net",
  "juicyads.com",
  "onclickads.net",
  "popads.net",
  "popcash.net",
  "profitablecpmratenetwork.com",
  "propellerads.com",
  "trafficjunky.com",
  // audience / tracking side of the same stacks
  "adsafeprotected.com",
  "advertising.com",
  "agkn.com",
  "bluekai.com",
  "demdex.net",
  "everesttech.net",
  "exelator.com",
  "krxd.net",
  "omtrdc.net",
  "quantserve.com",
  "rlcdn.com",
  "scorecardresearch.com",
  "serving-sys.com",
  "tapad.com",
  "yieldmanager.com",
  "2mdn.net",
]);

function isadhost(host) {
  if (!host || host === SITE_HOST) return false;
  var h = host;
  while (h.indexOf(".") !== -1) {
    if (AD_HOSTS_BUILTIN.has(h)) return true;
    if (adhosts && adhosts.has(h)) return true;
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

function isrelativeproxyurl(value) {
  try {
    var url = new URL(value);
    var match = url.pathname.match(/^\/~\/sj\/[^/]+\/[^/]+\/(.*)$/);
    if (!match || match[1] === "scramjet.wasm.js") return false;
    return !/^[a-z][a-z0-9+.-]*:/i.test(decodeURIComponent(match[1]));
  } catch (_) { return false; }
}

// Dynamic CSS/FontFace URLs can bypass rewriting and resolve against the
// encoded proxy pathname. Recover their base from the actual frame document.
function repairrelativeproxyurl(value, referrer) {
  if (!isrelativeproxyurl(value)) return null;
  try {
    var url = new URL(value);
    var parent = new URL(referrer);
    var prefix = url.pathname.match(/^\/~\/sj\/[^/]+\/[^/]+\//)[0];
    if (parent.origin !== url.origin || !parent.pathname.startsWith(prefix)) return null;
    var base = new URL(decodeURIComponent(parent.pathname.slice(prefix.length)));
    if (!/^https?:$/.test(base.protocol)) return null;
    var relative = url.pathname.slice(prefix.length) + url.search + url.hash;
    return url.origin + prefix + encodeURIComponent(new URL(relative, base).href);
  } catch (_) { return null; }
}

async function buildrouteevent(event) {
  var req = event.request;
  var spoof = spoofdesktopua;
  var withbody = hasrequestbody(req);
  var repaired = repairrelativeproxyurl(req.url, req.referrer);
  if (!repaired && isrelativeproxyurl(req.url) && event.clientId) {
    var client = await self.clients.get(event.clientId);
    if (client) repaired = repairrelativeproxyurl(req.url, client.url);
  }

  // Nothing to rewrite — hand route() the real FetchEvent untouched.
  if (!spoof && !withbody && !repaired) return event;

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
        url: repaired || req.url,
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
  // Diagnostics are off unless asked for, so a game page does not fill the
  // console with our own logging. Set localStorage "aetherisAudioDebug" to "1"
  // and reload to get the [audio-dbg] trace back.
  "  var debug = false;" +
  '  try { debug = localStorage.getItem("aetherisAudioDebug") === "1"; } catch(e){}' +
  "  function dbg(){" +
  "    if (!debug || !console || !console.log) return;" +
  '      var args = ["[audio-dbg]"].concat(Array.prototype.slice.call(arguments));' +
  "      console.log.apply(console, args);" +
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
var ADSPOOF_SRC = "/js/ad-spoof.js?v=20261106.2";
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

// Moves the clock forward inside game pages so day-based timers (daily
// rewards, streaks) can be claimed again. Unity/Emscripten read wall-clock
// time through Date, so that is where the offset goes. The offset lives in
// localStorage and is re-read about once a second, so changing it in Settings
// reaches an already open game without a reload. Only game pages get this;
// proxy pages keep the real clock. A proxied game frame gets the offset as
// window.__aetherisGameClockOffset instead, because localStorage is
// virtualized per proxied origin inside scramjet (see scramjet-init.js).
var GAMECLOCK_KEY = "gameClockOffsetMs";
var gameclockshim =
  "<script>" +
  "(function(){" +
  "  if (window.__aetherisGameClockInstalled) return;" +
  "  window.__aetherisGameClockInstalled = true;" +
  "  var KEY = '" +
  GAMECLOCK_KEY +
  "';" +
  "  var RealDate = window.Date;" +
  "  var realnow = RealDate.now;" +
  "  var offset = 0;" +
  "  var checked = -1e15;" +
  "  function read(){" +
  "    try {" +
  "      var injected = Number(window.__aetherisGameClockOffset);" +
  "      if (isFinite(injected) && injected > 0) return injected;" +
  "      var value = Number(localStorage.getItem(KEY)) || 0;" +
  "      return isFinite(value) && value > 0 ? value : 0;" +
  "    } catch(e){ return 0; }" +
  "  }" +
  "  offset = read();" +
  "  function now(){" +
  "    var time = realnow.call(RealDate);" +
  "    if (time - checked > 1000) { checked = time; offset = read(); }" +
  "    return time + offset;" +
  "  }" +
  "  function FakeDate(){" +
  "    if (!(this instanceof FakeDate)) return new RealDate(now()).toString();" +
  "    if (arguments.length === 0) return new RealDate(now());" +
  "    return Reflect.construct(RealDate, arguments, RealDate);" +
  "  }" +
  "  FakeDate.prototype = RealDate.prototype;" +
  "  FakeDate.now = now;" +
  "  FakeDate.parse = RealDate.parse;" +
  "  FakeDate.UTC = RealDate.UTC;" +
  "  window.Date = FakeDate;" +
  "})();" +
  "<\/script>";

// Cloudflare's Web Analytics beacon was saved into the game pages when they
// were copied from a browser. The beacon posts to a root-relative
// "/cdn-cgi/rum", and the games carry a <base href="https://cdn.jsdelivr.net/...">
// that sends that post to the CDN: the answer there has no CORS header, so
// every game that ships the beacon logs a CORS error that has nothing to do
// with the game itself. The site has its own analytics, so the beacon is
// dropped from the game pages.
var CF_BEACON_HOST = "static.cloudflareinsights.com";
var CF_BEACON_TAG =
  /<script[^>]*static\.cloudflareinsights\.com[^>]*>[\s\S]*?<\/script>/gi;

// A game page is up to 34MB. Reading it whole to look for a 300 byte tag held
// the page back until the last byte had arrived and put two copies of it in
// memory, which an iPad does not have to spare. The page is filtered as it
// streams instead. Only a tag that a chunk boundary may have cut in two is
// held back until the next chunk completes it.
var BEACON_HOLD_LIMIT = 4096;

// Where the part of `text` that is not safe to emit yet begins; the whole
// length when all of it is.
function beaconholdfrom(text) {
  var hold = text.length;
  // "<scr" at the very end may still turn into "<script"
  var lt = text.lastIndexOf("<");
  if (
    lt !== -1 &&
    text.length - lt < 7 &&
    "<script".indexOf(text.slice(lt).toLowerCase()) === 0
  ) {
    hold = lt;
  }
  // the last script tag in the window, when it is not complete yet
  var re = /<script/gi;
  re.lastIndex = Math.max(0, text.length - BEACON_HOLD_LIMIT);
  var last = -1;
  var match;
  while ((match = re.exec(text))) last = match.index;
  if (last !== -1 && last < hold) {
    var tail = text.slice(last);
    if (!/<\/script\s*>/i.test(tail)) {
      var open = tail.indexOf(">");
      // the opening tag is cut, or it is the beacon and its end is missing
      if (open === -1 || tail.slice(0, open).indexOf(CF_BEACON_HOST) !== -1) {
        hold = last;
      }
    }
  }
  return hold;
}

function stripbeaconstream(body) {
  var reader = body.getReader();
  var decoder = new TextDecoder("utf-8");
  var encoder = new TextEncoder();
  var carry = "";

  function clean(text) {
    return text.indexOf(CF_BEACON_HOST) === -1
      ? text
      : text.replace(CF_BEACON_TAG, "");
  }

  // Reads until something can be emitted: a pull that enqueues nothing is not
  // repeated by every engine.
  function step(controller) {
    return reader.read().then(function (result) {
      if (result.done) {
        var rest = carry + decoder.decode();
        carry = "";
        if (rest) controller.enqueue(encoder.encode(clean(rest)));
        controller.close();
        return;
      }
      var text = carry + decoder.decode(result.value, { stream: true });
      var cut = beaconholdfrom(text);
      carry = text.slice(cut);
      var out = clean(text.slice(0, cut));
      if (!out) return step(controller);
      controller.enqueue(encoder.encode(out));
    });
  }

  return new ReadableStream({
    pull: step,
    cancel: function (reason) {
      return reader.cancel(reason);
    },
  });
}

async function stripbeacon(response) {
  if (!response || response.status !== 200 || !response.body) return response;
  var ct = (response.headers.get("content-type") || "").toLowerCase();
  if (ct.indexOf("text/html") === -1) return response;
  try {
    var headers = new Headers(response.headers);
    // The body is re-encoded text: the length and the encoding of the
    // original body no longer describe it.
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(stripbeaconstream(response.body), {
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
      (options.gameclock ? gameclockshim : "") +
      cookieenabledshim +
      '<script>if(/Firefox\\//.test(navigator.userAgent)&&typeof window.EJS_CacheLimit!=="number")window.EJS_CacheLimit=134217728;<\/script>' +
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
// scramjet rewrites document/script/style/worker bodies, which changes their
// length, but it hands the upstream Content-Length through unchanged. Firefox
// trusts that header and cuts the rewritten body to it: a Unity game's worker
// (the rewritten framework blob) is truncated before its code, the worker
// never starts, and the game hangs (Chrome ignores the header). Binary
// fetches such as .unityweb are passed through untouched, so their length
// stays valid and keeps the loader's progress bar.
var EMPTY_STATUS = { 101: true, 204: true, 205: true, 304: true };
var REWRITTEN_DESTINATIONS = {
  document: true,
  iframe: true,
  frame: true,
  script: true,
  style: true,
  worker: true,
  sharedworker: true,
};

function stripcontentlength(response, request) {
  try {
    if (!response || !response.headers || !request) return response;
    var rewritten =
      REWRITTEN_DESTINATIONS[request.destination || ""] ||
      /(?:%2F|\/)(?:blob|data)(?:%3A|:)/i.test(request.url);
    if (!rewritten) return response;
    if (EMPTY_STATUS[response.status]) return response;
    if (!response.headers.has("content-length")) return response;
    var headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: headers,
    });
  } catch (e) {
    return response;
  }
}

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
// unknown hosts are never relayed, so this can't become an open proxy. Other
// *.githubusercontent.com hosts are relayed through the ghuc mirror, which
// carries the host in the path (see isgithubusercontent below).
var MIRROR_HOSTS = {
  "cdn.jsdelivr.net": "jsdelivr",
  "fastly.jsdelivr.net": "fastly",
  "gcore.jsdelivr.net": "gcore",
  "cdn.statically.io": "statically",
  "raw.githubusercontent.com": "ghraw",
  "raw.githack.com": "githack",
  "rawcdn.githack.com": "githack",
  "cdn.githack.com": "githack",
  "bbcdn.githack.com": "bbgithack",
  "raw.github.com": "ghraw",
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

// GitHub's own Raw/blame links are redirects to the user-content hosts.
// Translate them here so the browser never leaves for github.com:
//   github.com/u/r/raw/ref/file       -> raw.githubusercontent.com/u/r/ref/file
//   github.com/u/r/blob/ref/file?raw  -> raw.githubusercontent.com/u/r/ref/file
//   gist.github.com/u/id/raw/file     -> gist.githubusercontent.com/u/id/raw/file
// (Release downloads redirect to a signed objects.githubusercontent.com URL
// that cannot be constructed without following that redirect.)
function githubtranslate(parsed) {
  var host = parsed.hostname.toLowerCase();
  var path = parsed.pathname;
  if (host === "github.com" || host === "www.github.com") {
    var raw = /^\/([^/]+)\/([^/]+)\/raw\/(.+)$/.exec(path);
    if (raw)
      return {
        host: "raw.githubusercontent.com",
        path: "/" + raw[1] + "/" + raw[2] + "/" + raw[3],
        search: "",
      };
    var blob = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(path);
    if (blob && parsed.searchParams.get("raw") === "true")
      return {
        host: "raw.githubusercontent.com",
        path: "/" + blob[1] + "/" + blob[2] + "/" + blob[3],
        search: "",
      };
  } else if (host === "gist.github.com") {
    var gist = /^\/([^/]+)\/([^/]+)\/raw\/(.+)$/.exec(path);
    if (gist)
      return { host: "gist.githubusercontent.com", path: path, search: "" };
  }
  return null;
}

// Any GitHub user-content host is relayed (objects., media., gist.,
// user-images., private-user-images., …): the host travels in the path and the
// server validates it, see GITHUB_USERCONTENT in lib/game-assets.js.
function isgithubusercontent(host) {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.githubusercontent\.com$/.test(host);
}

// A service worker script may not be answered with a redirect at all, and a
// request that asked for "manual"/"error" redirect handling refuses one by
// definition. Firefox surfaces both as "Failed to load ''" from respondWith(),
// so those requests stay on the direct CDN path instead of the mirror relay.
var NOREDIRECTDESTINATIONS = {
  serviceworker: true,
  worker: true,
  sharedworker: true,
  manifest: true,
};

function canmirrorredirect(request) {
  if (request.redirect === "manual" || request.redirect === "error") return false;
  return !NOREDIRECTDESTINATIONS[request.destination || ""];
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
  var host = parsed.hostname.toLowerCase();
  var pathname = parsed.pathname;
  var search = parsed.search;
  var translated = githubtranslate(parsed);
  if (translated) {
    host = translated.host;
    pathname = translated.path;
    search = translated.search;
  }
  // Signed GitHub URLs carry a long query; anything larger is not a file link.
  if (search.length > 4096) return null;
  var mirror = MIRROR_HOSTS[host];
  if (!mirror && isgithubusercontent(host)) mirror = "ghuc";
  if (!mirror) return null;
  // Visitor path only: strict charset, no traversal, no credential smuggling.
  // Client query strings are dropped for every mirror but ghuc, where they are
  // part of the signature.
  var path = pathname;
  if (path.length > 512) return null;
  // pathname always starts with "/"; skip that empty first segment.
  var segments = path.split("/").slice(1);
  for (var i = 0; i < segments.length; i++) {
    if (!validsegment(segments[i])) return null;
  }
  // The directory travels in the token, the file name stays readable. For a
  // user-content host the host is the first directory segment, so the server
  // knows which upstream to fetch.
  var relative = path.slice(1);
  if (mirror === "ghuc") relative = host + "/" + relative;
  var slash = relative.lastIndexOf("/");
  if (slash <= 0) return null;
  var dir = relative.slice(0, slash);
  var file = relative.slice(slash + 1);
  return (
    SITE_ORIGIN +
    "/s/" +
    assettoken(mirror, dir) +
    "/" +
    file +
    (mirror === "ghuc" ? search : "")
  );
}

// Firefox rejects synthetic cross-origin redirects from respondWith(). Fetch
// the mirror here and return a fresh response without a redirect URL chain.
function mirrorfetchresponse(request, location) {
  var headers = new Headers();
  var range = request.headers.get("Range");
  if (range) headers.set("Range", range);
  return relayresponse(new Request(location, {
    method: request.method,
    headers: headers,
    credentials: "omit",
  })).then(function (response) {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
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
      if (response && response.status < 400) return response;
      var headers = new Headers(response.headers);
      // A failed answer must still be readable by the page. Cloudflare
      // replaces a 5xx from the origin with its own error page, and that
      // page has no CORS header at all, so the browser would report a CORS
      // error instead of the status. Any answer that arrives without the
      // header gets it here.
      if (!headers.get("Access-Control-Allow-Origin")) {
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
      }
      return response;
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

// Keep Firefox's worker alive after headers have resolved respondWith(): a
// large forwarded stream can otherwise be cut off by the idle timeout.
function keepstreamalive(response, event) {
  if (!response.body) return response;
  var reader = response.body.getReader();
  var finish;
  event.waitUntil(new Promise(function (resolve) { finish = resolve; }));
  var body = new ReadableStream({
    async pull(controller) {
      try {
        var chunk = await reader.read();
        if (chunk.done) { finish(); controller.close(); }
        else controller.enqueue(chunk.value);
      } catch (error) { finish(); controller.error(error); }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

// A recycled worker asks clients to re-register after startup. Requests can
// arrive first; never let those virtual URLs fall through to the web server.
async function waitforproxyroute(event) {
  for (var attempt = 0; attempt < 120; attempt++) {
    if ($scramjetController.shouldRoute(event)) return;
    await new Promise(function (resolve) { setTimeout(resolve, 25); });
  }
  throw new Error("Proxy controller did not reconnect after worker restart");
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
              return injecthtmlshims(clean, {
                desktopua: spoofdesktopua,
                gameclock: true,
              });
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
    var mirrorurl =
      canmirrorredirect(event.request) &&
      mirrorredirecturl(url, event.request.method);
    if (mirrorurl) {
      event.respondWith(mirrorfetchresponse(event.request, mirrorurl).then(function (response) {
        return keepstreamalive(response, event);
      }));
      return;
    }
  }

  // The relay answers are CORS-checked by the game. A failed asset would
  // arrive without a CORS header (Cloudflare replaces a 5xx with its own
  // error page), so the browser reports a CORS error instead of the status.
  // The worker is the last place where the header can be put back.
  if (!proxied && parsed && parsed.origin === SITE_ORIGIN && isrelaypath(parsed.pathname)) {
    event.respondWith(relayresponse(event.request).then(function (response) {
      return keepstreamalive(response, event);
    }));
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

  if (!shouldroute && !proxied) return;

  event.respondWith(
    settingsrestored
      .then(async function () {
        if (!shouldroute) await waitforproxyroute(event);
        // the adblock check moved in here so a cold start can't block with
        // the blocker the user turned off (or slip past one they enabled)
        // Subframe navigations are ads too (a game's ad iframe would
        // otherwise always load, since top-level navigations are never
        // blocked); the destination tells the two apart.
        var adtargetable =
          event.request.mode !== "navigate" ||
          event.request.destination === "iframe";
        if (adblockenabled && adtargetable) {
          if (!adhosts) loadadblocklist();
          var adtarget = proxiedtargethost(url);
          if (isadhost(adtarget)) return blockedresponse(adtarget);
        }
        return buildrouteevent(event)
          .then(function (re) {
            return $scramjetController.route(re);
          })
          .then(function (r) {
            return stripcontentlength(r, event.request);
          })
          .then(function (r) {
            return surfacerouteerror(r, event.request);
          })
          .then(function (r) {
            return injecthtmlshims(r, { desktopua: spoofdesktopua });
          })
          .then(function (r) {
            return keepstreamalive(r, event);
          });
      })
      .catch(function (err) {
        logfetchfail(event.request, err);
        if (event.request.mode === "navigate")
          return Response.redirect("/recover", 302);
        // not fetch(event.request): the origin would return 404.html, which
        // callers then fail to parse as JSON
        return new Response("Proxy unavailable", {
          status: 503,
          statusText: "Proxy unavailable",
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          },
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
      // Safari can reject a cache delete (quota, private browsing). Taking
      // control matters more than cleanup: without clients.claim() a page is
      // uncontrolled and every /~/sj/ subresource hits the origin and 404s.
      .catch(function () {})
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

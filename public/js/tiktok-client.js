/* Injected into every proxied HTML page (see lib/tiktok-gateway.js).
 * Adapted from https://github.com/mynamescrax/tiktok-gateway-proxy (ISC, see
 * lib/tiktok-gateway.LICENSE).
 * Maps TikTok-family URLs to the /tt gateway at fetch time — i.e. AFTER the
 * app has computed signatures (X-Bogus etc.) over the upstream URL. The server
 * forwards path+query untouched, so signatures stay valid.
 */
(function () {
  if (window.__TT_INIT__) return;
  window.__TT_INIT__ = true;

  var BASE = "/tiktok";
  var GATE = BASE + "/tt";
  var WS_GATE = BASE + "/tt-ws";
  // Session marker for root-path navigation (/foryou, /@user, ...): those
  // paths are only served as TikTok while this cookie is present. Set on every
  // TikTok document and cleared when the frame goes away.
  var NAV_MARKER = "aetheris_tt";
  // Masked root paths (/foryou) need Path=/ cookies, so keep TikTok's names in
  // a private namespace instead; site cookies stay unprefixed and are never
  // forwarded upstream (see lib/tiktok-cookies.js).
  var COOKIE_PREFIX = "aetheris_tt_";
  var COOKIE_PATH = "/";
  // Mutable: SPA navigations (history/click/form, see below) keep this in sync
  // with the upstream page the app thinks it is on. All hooks resolve against
  // it so relative API paths stay signable after client-side route changes.
  var CURRENT = window.__TT_TARGET__ || location.href;
  window.__TT_TARGET__ = CURRENT;
  // Must match DEFAULT_NAV_HOST in server.mjs: top-level navigations on this
  // host are masked as same-origin paths (see below).
  var NAV_HOST = "www.tiktok.com";
  var GATE_RE = new RegExp(
    "^" + GATE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
      "\\?url=([^&]*)&referer=([^&]*)$",
  );

  function maskedFor(up) {
    // Same-origin path form for default-host pages, so the SPA router sees
    // real routes ("/foryou" instead of "/tt?url=..."). The server fallback
    // serves these back as the upstream page. Returns null for other hosts
    // (caller should use gatewayFor instead).
    try {
      var u = new URL(up);
      if (u.hostname.toLowerCase() !== NAV_HOST) return null;
      // The site already owns "/", so mask the feed root as /foryou. Clicking
      // TikTok's logo then stays inside the gateway instead of loading the
      // Aetheris homepage in the frame.
      var path = u.pathname === "/" ? "/foryou" : u.pathname;
      return path + u.search + u.hash;
    } catch (e) {
      return null;
    }
  }
  var BASES = [
    "tiktok.com",
    "tiktokv.com",
    "tiktokv.eu",
    "tiktokcdn.com",
    "tiktokcdn-eu.com",
    "tiktokcdn-us.com",
    "tiktokw.eu",
    "ttwstatic.com",
  ];

  function allowed(host) {
    host = String(host || "").toLowerCase();
    for (var i = 0; i < BASES.length; i++) {
      if (host === BASES[i] || host.slice(-BASES[i].length - 1) === "." + BASES[i]) return true;
    }
    return false;
  }

  function setnavmarker(on) {
    try {
      document.cookie =
        NAV_MARKER +
        "=" +
        (on ? "1" : "") +
        "; Path=/; SameSite=Lax" +
        (location.protocol === "https:" ? "; Secure" : "") +
        (on ? "" : "; Max-Age=0");
    } catch (e) {}
  }
  setnavmarker(true);
  window.addEventListener("pagehide", function () {
    setnavmarker(false);
  });

  // Server-side Set-Cookie rewriting cannot see cookies written by app JS.
  // Mirrors cookies.mjs: drop a tiktok.com Domain (we only ever set cookies on
  // the gateway origin) and, on plain HTTP, drop Secure / downgrade
  // SameSite=None — otherwise the browser rejects the cookie outright and the
  // app thinks the write failed (TikTok's cookie-consent banner stores its
  // decision exactly like that, so it reappeared on every load).
  var cookie = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
  if (cookie && cookie.configurable && cookie.set) {
    Object.defineProperty(Document.prototype, "cookie", {
      configurable: true,
      enumerable: cookie.enumerable,
      get: function () {
        // Expose upstream names only; prefixed site-side names are an
        // implementation detail, and site cookies are not TikTok's to read.
        var raw = String(cookie.get.call(this) || "");
        var out = [];
        var pairs = raw.split(";");
        for (var i = 0; i < pairs.length; i++) {
          var pair = pairs[i].trim();
          if (pair.indexOf(COOKIE_PREFIX) === 0) {
            out.push(pair.slice(COOKIE_PREFIX.length));
          }
        }
        return out.join("; ");
      },
      set: function (value) {
        // The navigation marker is ours, not TikTok's: keep Path=/ for it.
        if (String(value).indexOf(NAV_MARKER + "=") === 0) {
          cookie.set.call(this, value);
          return;
        }
        var insecure = String(location.protocol || "").toLowerCase() !== "https:";
        var parts = String(value).split(";");
        var nameValue = parts.shift();
        var nameEnd = nameValue.indexOf("=");
        var name = nameEnd === -1 ? "" : nameValue.slice(0, nameEnd).trim();
        if (name && name.indexOf(COOKIE_PREFIX) !== 0) {
          nameValue = COOKIE_PREFIX + nameValue;
        }
        var attributes = [];
        for (var i = 0; i < parts.length; i++) {
          var part = parts[i];
          var domain = /^\s*domain\s*=\s*\.?([^\s]+)\s*$/i.exec(part);
          // Drop the upstream Domain (we can only set cookies on this host) and
          // force every TikTok cookie under /tiktok.
          if (domain && (allowed(domain[1]) || domain[1].toLowerCase() === location.hostname.toLowerCase())) continue;
          if (/^\s*path\s*=/i.test(part)) continue;
          if (insecure && /^\s*secure\s*$/i.test(part)) continue;
          if (insecure && /^\s*samesite\s*=\s*none\s*$/i.test(part)) {
            attributes.push("SameSite=Lax");
            continue;
          }
          attributes.push(part);
        }
        attributes.push("Path=" + COOKIE_PATH);
        cookie.set.call(this, [nameValue].concat(attributes).join(";"));
      },
    });
  }

  function toProxy(raw, ref) {
    if (!raw || typeof raw !== "string") return raw;
    var t = raw.trim();
    if (
      t === "" || t.charAt(0) === "#" ||
      t.indexOf("data:") === 0 || t.indexOf("blob:") === 0 ||
      t.indexOf("javascript:") === 0 || t.indexOf("about:") === 0 ||
      t.indexOf("mailto:") === 0 || t.indexOf("tel:") === 0
    ) return raw;
    // Repair concatenated chunk URLs. Loaders do
    //   script.src = PUBLIC_PATH + "82403.abcd.js"
    // after PUBLIC_PATH was rewritten to "/tiktok/tt?url=<base>&referer=<ref>&tt=1",
    // so the chunk path lands after the "&tt=1" sentinel. Split there and
    // splice the trail back onto the base. (Same for any base+relative
    // concat, e.g. CSS or JSONP loaders.) A trail starting with "&" is NOT a
    // glued path — it's same-level extra query params, which the server
    // parses (and ignores) normally — so leave those alone.
    try {
      var gi = t.indexOf(GATE + "?url=");
      if (gi !== -1) {
        var gq = t.slice(gi);
        var si = gq.indexOf("&tt=1");
        var core = si === -1 ? gq : gq.slice(0, si);
        var trail = si === -1 ? "" : gq.slice(si + 5); // skip "&tt=1"
        var gm = core.match(GATE_RE);
        if (gm && trail && trail.charAt(0) !== "&") {
          var fixed = new URL(trail, decodeURIComponent(gm[1])).href;
          return GATE + "?url=" + encodeURIComponent(fixed) +
            "&referer=" + encodeURIComponent(ref || CURRENT) + "&tt=1";
        }
      }
    } catch (e) {}
    if (t.indexOf(GATE + "?url=") !== -1 || t.indexOf(WS_GATE + "?url=") !== -1) {
      try {
        // App code often absolutises our relative gateway path with a hardcoded
        // https: scheme (video segments, captions). On a plain-HTTP gateway that
        // is a dead origin, so keep it same-origin by dropping the scheme.
        var g = new URL(t, location.href);
        if (g.host === location.host && g.protocol !== location.protocol) {
          return g.pathname + g.search + g.hash;
        }
      } catch (e) {}
      return raw;
    }
    try {
      // A URL that is ALREADY a gateway URL can still arrive here wrapped in an
      // upstream host: app code takes a string we rewrote inside a bundle and
      // resolves it against the page origin (e.g. it POSTs
      // https://www.tiktok.com/shorten/ after appending its own query params).
      // Proxying that again nests the gateway and TikTok answers with its SPA
      // 404 page, so keep it on our origin unchanged.
      var gw = new URL(t, CURRENT);
      if (gw.pathname === GATE && gw.searchParams.get("url")) {
        return gw.pathname + gw.search + gw.hash;
      }
    } catch (e) {}
    try {
      // Resolve against the UPSTREAM page, not location: relative API paths
      // ("/api/...") become upstream URLs the app can sign, then get proxied.
      var abs = new URL(t, CURRENT);
      // Only TikTok-family hosts belong behind the gateway. Everything else
      // (accounts.google.com, terms pages, app stores, ...) must stay exactly
      // as the app asked for it — mapping it would turn a normal link or fetch
      // into a gateway 403, since the server refuses non-TikTok hosts.
      if (!allowed(abs.hostname)) {
        // Our own origin is the exception: app code pins location.host but
        // hardcodes the https: scheme (e.g. https://<host>/ttwid/check/), which
        // would hit the gateway over TLS and fail. Treat it the way the server's
        // masked-navigation fallback does: a default-host upstream page path.
        if (abs.host === location.host) {
          var selfPath = abs.pathname;
          if (selfPath === BASE || selfPath.indexOf(BASE + "/") === 0) {
            selfPath = selfPath.slice(BASE.length) || "/";
          }
          var selfUp = "https://" + NAV_HOST + selfPath + abs.search + abs.hash;
          return GATE + "?url=" + encodeURIComponent(selfUp) +
            "&referer=" + encodeURIComponent(ref || CURRENT) + "&tt=1";
        }
        return raw;
      }
      var r = ref || CURRENT;
      var out =
        GATE +
        "?url=" +
        encodeURIComponent(abs.href) +
        "&referer=" +
        encodeURIComponent(r) +
        "&tt=1";
      return out;
    } catch (e) {
      return raw;
    }
  }

  function toProxyWs(raw) {
    if (!raw || typeof raw !== "string") return raw;
    if (raw.indexOf(WS_GATE + "?url=") !== -1) return raw;
    try {
      var abs = new URL(raw, CURRENT.replace(/^http/, "ws"));
      if (abs.protocol !== "ws:" && abs.protocol !== "wss:") return raw;
      if (!allowed(abs.hostname)) return raw;
      var scheme = location.protocol === "https:" ? "wss" : "ws";
      return scheme + "://" + location.host + WS_GATE + "?url=" + encodeURIComponent(abs.href);
    } catch (e) {
      return raw;
    }
  }

  // Default-host navigations are masked to their real upstream path (/foryou,
  // /@user, ...) because TikTok's router reads location.pathname directly.
  // Those root paths are only claimed by the gateway while the TikTok area is
  // open (its marker cookie is set), so they do not hijack ordinary site
  // routes. Our own boot/popstate code needs the real URL because the app can
  // rewrite the document URL.
  var nativeLocationHref = null;
  try {
    nativeLocationHref = Object.getOwnPropertyDescriptor(window.location, "href");
  } catch (e) {}
  function realURL() {
    try {
      if (nativeLocationHref && nativeLocationHref.get) {
        return new URL(nativeLocationHref.get.call(window.location));
      }
    } catch (e) {}
    return new URL(window.location.href);
  }

  // Localhost-only verbose logging for failed subresource loads (helps tell
  // proxy bugs apart from upstream blocks; silent in any real deployment).
  var DEBUG = /^(127\.0\.0\.1|localhost)$/.test(location.hostname || "");
  function dbgFail(kind, url, err) {
    try {
      if (DEBUG) console.warn("[tt] " + kind + " failed: " + String(url).slice(0, 200) + " :: " + (err && err.message ? err.message : err));
    } catch (e) {}
  }
  try {
    window.__ttProxify = toProxy;
    window.__ttUpstream = toUpstream;
  } catch (e) {}

  // fetch (string | URL | Request)
  var origFetch = window.fetch;
  async function fetchMappedRequest(url, input, init) {
    var request = new Request(input, init);
    var options = {
      method: request.method,
      headers: request.headers,
      mode: request.mode,
      credentials: request.credentials,
      cache: request.cache,
      redirect: request.redirect,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
      integrity: request.integrity,
      keepalive: request.keepalive,
      signal: request.signal,
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      // A Request used as RequestInit can drop the upload body in Firefox.
      var body = await request.arrayBuffer();
      if (body.byteLength) options.body = body;
    }
    return origFetch.call(window, url, options);
  }

  window.fetch = function (input, init) {
    var urlForLog = null;
    try {
      if (typeof input === "string" || input instanceof URL) {
        urlForLog = String(input);
        input = toProxy(String(input));
      } else if (input && typeof input.url === "string") {
        urlForLog = input.url;
        var p = toProxy(input.url);
        if (p !== input.url) return fetchMappedRequest(p, input, init);
      }
    } catch (e) {}
    try {
      var prom = origFetch.call(this, input, init);
      if (prom && prom.catch) {
        prom.catch(function (err) {
          // Log the PRE-proxy URL (what the app asked for) plus the mapped one.
          dbgFail("fetch", urlForLog + "  =>  " + (typeof input === "string" ? input : (input && input.url)), err);
        });
      }
      return prom;
    } catch (e) {
      dbgFail("fetch", urlForLog, e);
      throw e;
    }
  };

  // XHR
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    if (typeof url === "string") args[1] = toProxy(url);
    return origOpen.apply(this, args);
  };

  // sendBeacon
  try {
    var origBeacon = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);
    if (origBeacon) {
      navigator.sendBeacon = function (url, data) {
        return origBeacon(toProxy(String(url)), data);
      };
    }
  } catch (e) {}

  // WebSocket -> relay
  try {
    var OrigWS = window.WebSocket;
    window.WebSocket = function (url, proto) {
      var mapped = toProxyWs(String(url));
      return proto === undefined ? new OrigWS(mapped) : new OrigWS(mapped, proto);
    };
    window.WebSocket.prototype = OrigWS.prototype;
    window.WebSocket.CONNECTING = OrigWS.CONNECTING;
    window.WebSocket.OPEN = OrigWS.OPEN;
    window.WebSocket.CLOSING = OrigWS.CLOSING;
    window.WebSocket.CLOSED = OrigWS.CLOSED;
  } catch (e) {}

  // EventSource
  try {
    var OrigES = window.EventSource;
    if (OrigES) {
      window.EventSource = function (url, cfg) {
        return new OrigES(toProxy(String(url)), cfg);
      };
      window.EventSource.prototype = OrigES.prototype;
    }
  } catch (e) {}

  // iframe / media / source / link / script / anchor targets set from JS
  // (covers JSONP loaders such as the PNS core.js injector)
  function proxySrcset(value) {
    // The URL token can contain commas (including in data URLs).
    return String(value).replace(/(?:^|,)\s*([^\s,][^\s]*?)(?=\s|,\s|$)([^,]*)/g,
      function (candidate, url, descriptor) {
        return candidate.slice(0, candidate.length - url.length - descriptor.length) +
          toProxy(url) + descriptor;
      });
  }

  function patchProp(proto, prop, map) {
    try {
      map = map || toProxy;
      var d = Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.set) return;
      Object.defineProperty(proto, prop, {
        get: function () { return d.get.call(this); },
        set: function (v) { d.set.call(this, map(v)); },
        configurable: true,
        enumerable: true,
      });
    } catch (e) {}
  }
  try {
    patchProp(HTMLIFrameElement.prototype, "src");
    patchProp(HTMLMediaElement.prototype, "src");
    patchProp(HTMLMediaElement.prototype, "poster");
    patchProp(HTMLSourceElement.prototype, "src");
    patchProp(HTMLLinkElement.prototype, "href");
    patchProp(HTMLScriptElement.prototype, "src");
    patchProp(HTMLImageElement.prototype, "src");
    patchProp(HTMLAnchorElement.prototype, "href");
    patchProp(HTMLImageElement.prototype, "srcset", proxySrcset);
    patchProp(HTMLSourceElement.prototype, "srcset", proxySrcset);
    var origSetAttr = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, val) {
      var attr = String(name).toLowerCase();
      if (attr === "src" && /^(SCRIPT|IFRAME|IMG|SOURCE|VIDEO|AUDIO)$/.test(this.tagName)) {
        val = toProxy(String(val));
      } else if (attr === "srcset" && /^(IMG|SOURCE)$/.test(this.tagName)) {
        val = proxySrcset(val);
      } else if (attr === "href" && /^(A|LINK)$/.test(this.tagName) && /^https?:|^\/\//i.test(val)) {
        val = toProxy(String(val));
      }
      return origSetAttr.call(this, name, val);
    };
  } catch (e) {}

  // Web workers (TikTok ships multiple.worker-*.js): map allowed URLs to the
  // gateway so worker scripts load instead of 404ing on our origin.
  try {
    if (typeof Worker === "function") {
      var OrigWorker = Worker;
      window.Worker = function (url, opts) {
        return new OrigWorker(toProxy(String(url)), opts);
      };
      window.Worker.prototype = OrigWorker.prototype;
    }
    if (typeof SharedWorker === "function") {
      var OrigShared = SharedWorker;
      window.SharedWorker = function (url, opts) {
        return new OrigShared(toProxy(String(url)), opts);
      };
      window.SharedWorker.prototype = OrigShared.prototype;
    }
  } catch (e) {}

  function rewriteNode(node) {
    try {
      if (!node || node.nodeType !== 1) return;
      var tag = node.tagName;
      if (tag === "SCRIPT" && node.src) node.src = toProxy(node.getAttribute("src"));
      else if (tag === "LINK" && node.href) node.href = toProxy(node.getAttribute("href"));
      else if (tag === "IMG" && node.src) node.src = toProxy(node.getAttribute("src"));
      else if ((tag === "VIDEO" || tag === "AUDIO") && node.src) node.src = toProxy(node.getAttribute("src"));
      else if (tag === "SOURCE" && node.src) node.src = toProxy(node.getAttribute("src"));
      else if (tag === "IFRAME" && node.src) node.src = toProxy(node.getAttribute("src"));
      else if (tag === "A" && node.href) {
        var h = node.getAttribute("href");
        if (h && /^https?:\/\//i.test(h)) node.href = toProxy(h);
      }
      if (node.querySelectorAll) {
        var els = node.querySelectorAll("script[src],link[href],img[src],video[src],audio[src],source[src],iframe[src]");
        for (var i = 0; i < els.length; i++) rewriteNode(els[i]);
      }
    } catch (e) {}
  }

  try {
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) rewriteNode(added[j]);
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}

  // popups/shares: keep them on the proxy instead of breaking out
  try {
    var origOpen2 = window.open;
    window.open = function (url, target, feats) {
      if (typeof url === "string") url = toProxy(url);
      return origOpen2.call(window, url, target, feats);
    };
  } catch (e) {}

  // ---- SPA navigation: the app thinks it lives on tiktok.com --------------
  // Resolve an app-visible URL to its upstream absolute form, or null when the
  // link should behave normally (external hosts like accounts.google.com).
  function toUpstream(raw) {
    if (!raw || typeof raw !== "string") return null;
    var t = raw.trim();
    if (
      t === "" || t.charAt(0) === "#" ||
      t.indexOf("data:") === 0 || t.indexOf("blob:") === 0 ||
      t.indexOf("javascript:") === 0 || t.indexOf("about:") === 0
    ) return null;
    if (t.indexOf(GATE + "?url=") !== -1) return null; // already proxied
    try {
      var abs = new URL(t, CURRENT);
      if (abs.protocol !== "http:" && abs.protocol !== "https:") return null;
      if (!allowed(abs.hostname)) return null;
      return abs.href;
    } catch (e) {
      return null;
    }
  }
  function gatewayFor(up) {
    return GATE + "?url=" + encodeURIComponent(up) + "&referer=" + encodeURIComponent(CURRENT) + "&tt=1";
  }

  // history router calls (video modal open/close, tab switches): keep them
  // same-document by mapping the URL into masked-path form (default host) or
  // the gateway (other hosts), and track the upstream page so later relative
  // fetches still resolve/sign correctly.
  try {
    var origPush = history.pushState;
    var origReplace = history.replaceState;
    history.pushState = function (state, title, url) {
      if (typeof url === "string") {
        var up = toUpstream(url);
        if (up) {
          CURRENT = up;
          window.__TT_TARGET__ = up;
          url = maskedFor(up) || gatewayFor(up);
        }
      }
      return origPush.call(this, state, title, url);
    };
    history.replaceState = function (state, title, url) {
      if (typeof url === "string") {
        var up = toUpstream(url);
        if (up) {
          CURRENT = up;
          window.__TT_TARGET__ = up;
          url = maskedFor(up) || gatewayFor(up);
        }
      }
      return origReplace.call(this, state, title, url);
    };
    window.addEventListener("popstate", function () {
      try {
        var u = realURL();
        if (u.pathname === GATE) {
          var inner = u.searchParams.get("url");
          if (inner) {
            CURRENT = inner;
            window.__TT_TARGET__ = inner;
            return;
          }
        }
        // Masked path: assume the default host (mirrors server fallback).
        var maskedPath = u.pathname;
        if (maskedPath === BASE || maskedPath.indexOf(BASE + "/") === 0) {
          maskedPath = maskedPath.slice(BASE.length) || "/";
        }
        CURRENT = "https://" + NAV_HOST + maskedPath + u.search + u.hash;
        window.__TT_TARGET__ = CURRENT;
      } catch (e) {}
    });
    // Boot: we arrived via /tiktok/tt?url=<page> (or the server fallback). Mask the
    // address bar to the upstream path so the router boots on a real route
    // instead of redirecting /tt to its 404 page. Same-document, no reload.
    try {
      var bootU = realURL();
      if (bootU.pathname === GATE && CURRENT) {
        var masked = maskedFor(CURRENT);
        if (masked && masked !== bootU.pathname + bootU.search + bootU.hash) {
          origReplace.call(history, history.state, document.title, masked);
        }
      }
    } catch (e) {}
  } catch (e) {}

  // Relative in-app links (<a href="/@user/...">): full-navigate (masked path
  // for the default host so the server boots that page's SSR doc, gateway
  // form otherwise). Absolute TikTok links are already rewritten server-side;
  // external links pass through untouched.
  try {
    document.addEventListener("click", function (ev) {
      if (ev.defaultPrevented || ev.button !== 0) return;
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      var el = ev.target && ev.target.closest ? ev.target.closest("a[href]") : null;
      if (!el) return;
      var up = toUpstream(el.getAttribute("href"));
      if (!up) return;
      ev.preventDefault();
      var dest = maskedFor(up) || gatewayFor(up);
      var t = el.getAttribute("target");
      if (t === "_blank") window.open(dest, "_blank");
      else location.href = dest;
    }, true);
  } catch (e) {}

  // Form posts (search, login): point the action at the proxy (masked path
  // for the default host). GET forms keep working because the query string
  // rides along.
  try {
    document.addEventListener("submit", function (ev) {
      var f = ev.target;
      if (!f || !f.action) return;
      var up = toUpstream(f.getAttribute("action") || f.action);
      if (!up) return;
      f.action = maskedFor(up) || gatewayFor(up);
    }, true);
  } catch (e) {}

  // A TikTok service worker registered on OUR origin would intercept gateway
  // traffic for the whole site — block upstream registrations, allow ours.
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.register) {
      var origReg = navigator.serviceWorker.register.bind(navigator.serviceWorker);
      navigator.serviceWorker.register = function (scriptURL, opts) {
        try {
          var abs = new URL(String(scriptURL), CURRENT);
          if ((abs.protocol === "http:" || abs.protocol === "https:") && allowed(abs.hostname)) {
            if (window.__TT_DEBUG__) console.warn("[tt] blocked worker registration:", scriptURL);
            return Promise.reject(new Error("workers disabled in proxy"));
          }
        } catch (e) {}
        return origReg(scriptURL, opts);
      };
    }
  } catch (e) {}
})();

(function () {
  if (window.__MOVIE_PROXY_INIT__) return;
  window.__MOVIE_PROXY_INIT__ = true;

  var PROXY_ROUTE = "/movie-proxy";
  var targetUrl = window.__MOVIE_PROXY_TARGET__ || location.href;
  // Never resolve provider URLs against our own origin: a stale cached page
  // can miss __MOVIE_PROXY_ORIGIN__, and resolving its <base href="/"> then
  // sends provider API calls back to us (our /api.php 404s) instead of
  // upstream. Derive the origin from the target URL whenever the declared
  // one is absent or points at ourselves.
  var declaredOrigin = window.__MOVIE_PROXY_ORIGIN__ || "";
  var targetOrigin = (function () {
    if (declaredOrigin && declaredOrigin !== location.origin)
      return declaredOrigin;
    try {
      return new URL(targetUrl).origin;
    } catch (e) {
      return location.origin;
    }
  })();

  // Providers such as Videm serve their player with `<base href="/">`, so a
  // request for `api.php` means the site root in their own context. Resolving
  // only against the proxied document URL would send it to
  // /embed/.../api.php instead, which answers with an HTML error page rather
  // than JSON — and the player then reports "No content available". Mirror
  // the provider's own resolution by honoring their base tag (anchored on
  // the upstream origin); pages without one keep document-URL resolution.
  // The negative lookup is deliberately NOT cached: this script is injected
  // right after <head>, so the provider's <base> tag may not be parsed yet
  // on the first call. Re-query until one is found, then pin it.
  var upstreamBase = null;
  var baseResolved = false;
  function resolveBase() {
    if (!baseResolved) {
      try {
        var baseEl = document.querySelector("base[href]");
        var baseHref = baseEl && baseEl.getAttribute("href");
        if (baseHref) {
          var resolved = new URL(baseHref, targetOrigin).href;
          // A stale cached page may carry a base pointing at ourselves
          // (older relay versions proxied <base>); never honor those, or
          // every relative provider URL collapses onto Aetheris and 404s.
          if (new URL(resolved).origin !== location.origin) {
            upstreamBase = resolved;
            baseResolved = true;
          }
        }
      } catch (e) {
        upstreamBase = null;
      }
    }
    return upstreamBase || targetUrl;
  }

  // One-shot diagnostic beacon: reports which client version is executing
  // and how it resolves provider URLs, so relay sessions can be diagnosed
  // from `pm2 logs`. Same-origin image ping; any failure stays silent.
  try {
    var pingSample = "";
    try {
      pingSample = new URL("api.php?a=ping", resolveBase()).href;
    } catch (e) {}
    var pingImg = new Image();
    pingImg.src =
      "/movie-ping?v=20260907.8&origin=" +
      encodeURIComponent(targetOrigin || "none") +
      "&sample=" +
      encodeURIComponent(pingSample);
  } catch (e) {}

  // Temporary playback diagnostic: beacon browser-side script errors back
  // so a silently-stuck provider player (page loads, assets 200, but no
  // media requests) can be diagnosed from `pm2 logs` without devtools
  // access on the viewer's device. Same-origin image ping, no loop risk
  // (Image src is not hooked below). Remove once playback is stable.
  try {
    var errBeacon = function (msg) {
      try {
        var img = new Image();
        img.src =
          "/movie-ping?v=20260907.8&origin=" +
          encodeURIComponent(targetOrigin || "none") +
          "&err=" +
          encodeURIComponent(String(msg).slice(0, 300));
      } catch (e) {}
    };
    window.addEventListener("error", function (e) {
      errBeacon(
        (e.message || "error") +
          " @ " +
          (e.filename || "?") +
          ":" +
          (e.lineno || "?"),
      );
    });
    window.addEventListener("unhandledrejection", function (e) {
      var reason = e.reason;
      errBeacon(
        "rejection: " +
          String((reason && reason.message) || reason || "?").slice(0, 200),
      );
    });
  } catch (e) {}

  function debug(label, url, out) {
    try {
      if (window.__MOVIE_PROXY_DEBUG__)
        console.log("[mp-debug] " + label, url, out ? "-> " + out : "");
    } catch (e) {}
  }

  function decodeEntities(str) {
    if (!str) return str;
    return str
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  function toProxyUrl(rawUrl, ref) {
    if (!rawUrl || typeof rawUrl !== "string") return rawUrl;
    var trimmed = decodeEntities(rawUrl.trim());
    // Some embed scripts blindly prepend their CDN base to an iframe URL.
    // Recover our absolute relay URL from values such as
    // https://cdn.example/e/https://aetheris.win/movie-proxy?url=...
    var absoluteProxy = location.origin + PROXY_ROUTE;
    var embeddedProxyIndex = trimmed.indexOf(absoluteProxy);
    if (embeddedProxyIndex > 0) {
      var providerPrefix = trimmed.slice(0, embeddedProxyIndex);
      var embeddedProxy = trimmed.slice(embeddedProxyIndex);
      try {
        // Preserve intentional transformations such as
        // https://2vcdn.skin/e/ + /token while removing the accidentally
        // embedded Aetheris relay wrapper around that original token path.
        var embeddedTarget = new URL(embeddedProxy).searchParams.get("url");
        var originalTarget = new URL(embeddedTarget);
        var transformedTarget =
          providerPrefix +
          originalTarget.pathname.replace(/^\/+/, "") +
          originalTarget.search +
          originalTarget.hash;
        return toProxyUrl(transformedTarget, ref);
      } catch (e) {
        return embeddedProxy;
      }
    }
    if (
      trimmed.startsWith("data:") ||
      trimmed.startsWith("blob:") ||
      trimmed.startsWith("javascript:")
    ) {
      return rawUrl;
    }
    if (
      trimmed.startsWith(PROXY_ROUTE) ||
      trimmed.includes("/movie-proxy?url=") ||
      trimmed.includes(location.host + PROXY_ROUTE)
    ) {
      return rawUrl;
    }
    if (trimmed === "about:blank" || trimmed.charAt(0) === "#") return rawUrl;

    try {
      var absUrl = new URL(trimmed, resolveBase()).href;
      var r = ref || targetUrl;
      var out =
        location.origin +
        PROXY_ROUTE +
        "?url=" +
        encodeURIComponent(absUrl) +
        "&referer=" +
        encodeURIComponent(r);
      debug("proxy", trimmed, out);
      return out;
    } catch (e) {
      return rawUrl;
    }
  }

  // Overwrite fetch
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    init = init || {};
    var isUrl = typeof input === "string" || input instanceof URL;
    var url = isUrl ? String(input) : input && input.url;
    if (url) {
      var proxied = toProxyUrl(url);
      if (isUrl) {
        input = proxied;
      } else if (input && input.url) {
        input = new Request(proxied, input);
      }
    }
    return origFetch.call(this, input, init);
  };

  // Overwrite XMLHttpRequest
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    if (url && typeof url === "string") {
      args[1] = toProxyUrl(url);
    }
    return origOpen.apply(this, args);
  };

  // Overwrite iframe.src & setAttribute
  try {
    var iframeProto = HTMLIFrameElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(iframeProto, "src");
    if (desc && desc.set) {
      Object.defineProperty(iframeProto, "src", {
        get: function () {
          return desc.get.call(this);
        },
        set: function (val) {
          desc.set.call(this, toProxyUrl(val));
        },
        configurable: true,
        enumerable: true,
      });
    }
    var origSetAttr = iframeProto.setAttribute;
    iframeProto.setAttribute = function (name, val) {
      if (String(name).toLowerCase() === "src" && val) {
        val = toProxyUrl(val);
      }
      return origSetAttr.call(this, name, val);
    };
  } catch (e) {}

  // Overwrite video/audio src
  try {
    var mediaProto = HTMLMediaElement.prototype;
    var mediaDesc = Object.getOwnPropertyDescriptor(mediaProto, "src");
    if (mediaDesc && mediaDesc.set) {
      Object.defineProperty(mediaProto, "src", {
        get: function () {
          return mediaDesc.get.call(this);
        },
        set: function (val) {
          mediaDesc.set.call(this, toProxyUrl(val));
        },
        configurable: true,
        enumerable: true,
      });
    }
  } catch (e) {}

  // Overwrite subtitle track and source src. Videm assigns track URLs
  // directly (`tr.src = 'api.php?a=sub&ref=...'`); without this the URL
  // resolves natively against the proxy document and 404s on Aetheris
  // instead of reaching the provider.
  try {
    ["HTMLTrackElement", "HTMLSourceElement"].forEach(function (name) {
      var ctor = window[name];
      if (!ctor || !ctor.prototype) return;
      var desc = Object.getOwnPropertyDescriptor(ctor.prototype, "src");
      if (!desc || !desc.set) return;
      Object.defineProperty(ctor.prototype, "src", {
        get: function () {
          return desc.get.call(this);
        },
        set: function (val) {
          desc.set.call(this, toProxyUrl(val));
        },
        configurable: true,
        enumerable: true,
      });
    });
  } catch (e) {}

  // Prevent popups
  window.open = function () {
    return null;
  };
})();

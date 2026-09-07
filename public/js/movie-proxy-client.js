(function () {
  if (window.__MOVIE_PROXY_INIT__) return;
  window.__MOVIE_PROXY_INIT__ = true;

  var PROXY_ROUTE = "/movie-proxy";
  var targetUrl = window.__MOVIE_PROXY_TARGET__ || location.href;
  var targetOrigin = window.__MOVIE_PROXY_ORIGIN__ || location.origin;

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
      return trimmed.slice(embeddedProxyIndex);
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
      var absUrl = new URL(trimmed, targetUrl).href;
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

  // Prevent popups
  window.open = function () {
    return null;
  };
})();

(function () {
  if (window.__MOVIE_PROXY_INIT__) return;
  window.__MOVIE_PROXY_INIT__ = true;

  var PROXY_ROUTE = "/movie-proxy";
  var CLIENT_VERSION = "20261007.1";
  // Cap error beacons so a provider stuck in an error loop can't flood us.
  var MAX_ERROR_BEACONS = 25;
  var errorBeacons = 0;
  var targetUrl = window.__MOVIE_PROXY_TARGET__ || location.href;
  // Never resolve provider URLs against our own origin, even if a stale page
  // lacks __MOVIE_PROXY_ORIGIN__.
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

  // Defined first so hook failures can be reported too (Safari rejects some
  // prototype redefinitions that work in Chromium).
  function beaconErr(msg) {
    if (errorBeacons >= MAX_ERROR_BEACONS) return;
    errorBeacons++;
    try {
      var img = new Image();
      img.src =
        "/movie-ping?v=" +
        CLIENT_VERSION +
        "&origin=" +
        encodeURIComponent(targetOrigin || "none") +
        "&err=" +
        encodeURIComponent(String(msg).slice(0, 300));
    } catch (e) {}
  }

  // SPA providers route on location.pathname, which here is /movie-proxy.
  // Show them the upstream path instead; the hooks below never resolve
  // against location.href.
  try {
    var upstreamUrl = new URL(targetUrl);
    var upstreamPath =
      upstreamUrl.pathname + upstreamUrl.search + upstreamUrl.hash;
    if (
      upstreamUrl.protocol.indexOf("http") === 0 &&
      location.pathname.indexOf(PROXY_ROUTE) === 0 &&
      location.pathname + location.search + location.hash !== upstreamPath
    ) {
      history.replaceState(null, "", upstreamPath);
    }
  } catch (e) {
    beaconErr("hook:replaceState:" + ((e && e.message) || e));
  }

  // Honour the provider's <base> tag (Videm uses <base href="/">). A miss is
  // not cached because this script runs before the tag is parsed.
  var upstreamBase = null;
  var baseResolved = false;
  function resolveBase() {
    if (!baseResolved) {
      try {
        var baseEl = document.querySelector("base[href]");
        var baseHref = baseEl && baseEl.getAttribute("href");
        if (baseHref) {
          var resolved = new URL(baseHref, targetOrigin).href;
          // Ignore a base that points at us (stale cached pages).
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

  // Startup beacon: client version and how it resolves provider URLs.
  try {
    var pingSample = "";
    try {
      pingSample = new URL("api.php?a=ping", resolveBase()).href;
    } catch (e) {}
    var pingImg = new Image();
    pingImg.src =
      "/movie-ping?v=" +
      CLIENT_VERSION +
      "&origin=" +
      encodeURIComponent(targetOrigin || "none") +
      "&sample=" +
      encodeURIComponent(pingSample);
  } catch (e) {}

  // Report script errors so stuck players can be debugged from server logs.
  // Image src isn't hooked, so this can't loop.
  try {
    window.addEventListener("error", function (e) {
      beaconErr(
        (e.message || "error") +
          " @ " +
          (e.filename || "?") +
          ":" +
          (e.lineno || "?"),
      );
    });
    window.addEventListener("unhandledrejection", function (e) {
      var reason = e.reason;
      beaconErr(
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

  // Provider code can pass an already-proxied URL as a query param of its own
  // API (/api/subtitle?url=/movie-proxy?url=...). Swap those back to the
  // upstream URL; other params are kept byte-for-byte so signatures hold.
  function unnestRelayUrls(raw) {
    var RELAY_MARK = PROXY_ROUTE + "?url=";
    if (
      raw.indexOf(RELAY_MARK) === -1 &&
      raw.indexOf(encodeURIComponent(RELAY_MARK)) === -1
    )
      return raw;
    try {
      var u = new URL(raw, resolveBase());
      var query = u.search ? u.search.slice(1) : "";
      if (!query) return raw;
      var out = [];
      var changed = false;
      query.split("&").forEach(function (pair) {
        var eq = pair.indexOf("=");
        var key = eq === -1 ? pair : pair.slice(0, eq);
        var val = eq === -1 ? "" : pair.slice(eq + 1);
        var decoded = null;
        try {
          decoded = decodeURIComponent(val.replace(/\+/g, " "));
        } catch (e) {}
        if (decoded && decoded.indexOf(RELAY_MARK) !== -1) {
          try {
            var inner = new URL(decoded, resolveBase()).searchParams.get(
              "url",
            );
            if (inner) {
              val = encodeURIComponent(inner);
              changed = true;
            }
          } catch (e) {}
        }
        out.push(eq === -1 ? key : key + "=" + val);
      });
      if (!changed) return raw;
      var rebuilt =
        u.origin +
        u.pathname +
        (out.length ? "?" + out.join("&") : "") +
        u.hash;
      // Triple-nested wrappers collapse one level per pass.
      return unnestRelayUrls(rebuilt);
    } catch (e) {}
    return raw;
  }

  function toProxyUrl(rawUrl, ref) {
    if (!rawUrl || typeof rawUrl !== "string") return rawUrl;
    var trimmed = decodeEntities(rawUrl.trim());
    // Vite's preload helper prefixes "/", turning our path into
    // "//movie-proxy?..." (a hostname).
    if (/^\/\/movie-proxy(?=\/|\?|$)/.test(trimmed))
      trimmed = trimmed.slice(1);
    // Must run before the already-proxied check below.
    trimmed = unnestRelayUrls(trimmed);
    // Some embeds prepend their CDN base to our URL, e.g.
    // https://cdn.example/e/https://aetheris.win/movie-proxy?url=...
    var absoluteProxy = location.origin + PROXY_ROUTE;
    var embeddedProxyIndex = trimmed.indexOf(absoluteProxy);
    if (embeddedProxyIndex > 0) {
      var providerPrefix = trimmed.slice(0, embeddedProxyIndex);
      var embeddedProxy = trimmed.slice(embeddedProxyIndex);
      try {
        // Keep their prefix + the original path, drop our wrapper.
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

    // Our own endpoints stay local; every other path belongs to upstream.
    try {
      var localCandidate = new URL(trimmed, location.href);
      if (
        localCandidate.origin === location.origin &&
        (localCandidate.pathname === "/movie-ping" ||
          localCandidate.pathname === "/js/movie-proxy-client.js")
      ) {
        return rawUrl;
      }
    } catch (e) {}

    try {
      var absUrl = new URL(trimmed, resolveBase()).href;
      // URLs built from script.src or document.baseURI land on our origin;
      // move them back to the upstream origin.
      if (targetOrigin && targetOrigin !== location.origin) {
        var parsedAbs = new URL(absUrl);
        if (parsedAbs.origin === location.origin) {
          absUrl =
            targetOrigin +
            parsedAbs.pathname +
            parsedAbs.search +
            parsedAbs.hash;
        }
      }
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

  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    if (url && typeof url === "string") {
      args[1] = toProxyUrl(url);
    }
    return origOpen.apply(this, args);
  };

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
  } catch (e) {
    beaconErr("hook:iframe-src:" + ((e && e.message) || e));
  }

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
    var mediaSetAttr = Element.prototype.setAttribute;
    mediaProto.setAttribute = function (attrName, val) {
      if (String(attrName).toLowerCase() === "src" && val) {
        val = toProxyUrl(val);
      }
      return mediaSetAttr.call(this, attrName, val);
    };
    // Safari aborts a pending play() when the player swaps src mid-load and
    // providers don't retry, so retry a few times with backoff. Also report
    // play rejections and media errors once per element.
    function retryPlay(el, attempt) {
      var delays = [1000, 2500, 5000, 10000];
      if (attempt >= delays.length) return;
      setTimeout(function () {
        try {
          if (!el.isConnected || !el.paused) return;
          var pN = origPlay.call(el);
          if (pN && pN.catch) {
            pN.catch(function (retryErr) {
              try {
                beaconErr(
                  "video:play-retry-" +
                    (attempt + 1) +
                    "-failed:" +
                    ((retryErr && retryErr.name) || "?") +
                    ":" +
                    ((retryErr && retryErr.message) || retryErr),
                );
              } catch (e) {}
              if (retryErr && retryErr.name === "AbortError")
                retryPlay(el, attempt + 1);
            });
          }
        } catch (e) {}
      }, delays[attempt]);
    }
    try {
      var origPlay = mediaProto.play;
      if (origPlay) {
        mediaProto.play = function () {
          try {
            var p = origPlay.apply(this, arguments);
            if (p && p.catch) {
              var el = this;
              p.catch(function (playErr) {
                try {
                  if (!el.__mpPlayBeacon) {
                    el.__mpPlayBeacon = true;
                    beaconErr(
                      "video:play-rejected:" +
                        ((playErr && playErr.name) || "?") +
                        ":" +
                        ((playErr && playErr.message) || playErr),
                    );
                  }
                  if (playErr && playErr.name === "AbortError")
                    retryPlay(el, 0);
                } catch (e) {}
              });
            }
            return p;
          } catch (e) {
            return origPlay.apply(this, arguments);
          }
        };
      }
    } catch (e) {
      beaconErr("hook:media-play:" + ((e && e.message) || e));
    }
    try {
      document.addEventListener(
        "error",
        function (ev) {
          try {
            var t = ev.target;
            if (
              t &&
              (t.tagName === "VIDEO" ||
                t.tagName === "AUDIO" ||
                t.tagName === "SOURCE")
            ) {
              if (t.__mpErrBeacon) return;
              t.__mpErrBeacon = true;
              var code =
                t.error && typeof t.error.code !== "undefined"
                  ? t.error.code
                  : "?";
              var srcHost = "?";
              try {
                srcHost = new URL(
                  t.currentSrc || t.src || "",
                  location.href,
                ).host;
              } catch (e) {}
              beaconErr("video:error:" + t.tagName + ":code=" + code + ":host=" + srcHost);
            }
          } catch (e) {}
        },
        true,
      );
    } catch (e) {
      beaconErr("hook:media-error:" + ((e && e.message) || e));
    }
  } catch (e) {
    beaconErr("hook:media-src:" + ((e && e.message) || e));
  }

  // <track>/<source> src, as property or attribute (Videm sets track.src;
  // native-HLS players on iOS use setAttribute).
  try {
    ["HTMLTrackElement", "HTMLSourceElement"].forEach(function (name) {
      var ctor = window[name];
      if (!ctor || !ctor.prototype) return;
      var desc = Object.getOwnPropertyDescriptor(ctor.prototype, "src");
      if (desc && desc.set) {
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
      }
      var protoSetAttr = Element.prototype.setAttribute;
      ctor.prototype.setAttribute = function (attrName, val) {
        if (String(attrName).toLowerCase() === "src" && val) {
          val = toProxyUrl(val);
        }
        return protoSetAttr.call(this, attrName, val);
      };
    });
  } catch (e) {
    beaconErr("hook:track-source:" + ((e && e.message) || e));
  }

  // Dynamically created elements; static HTML rewriting can't see these.
  // `properties` are attribute names; formaction's IDL name is formAction.
  function hookUrlElement(constructorName, properties) {
    try {
      var ctor = window[constructorName];
      if (!ctor || !ctor.prototype) return;
      properties.forEach(function (attr) {
        var property = attr === "formaction" ? "formAction" : attr;
        var descriptor = Object.getOwnPropertyDescriptor(
          ctor.prototype,
          property,
        );
        if (descriptor && descriptor.set) {
          Object.defineProperty(ctor.prototype, property, {
            get: descriptor.get
              ? function () {
                  return descriptor.get.call(this);
                }
              : undefined,
            set: function (val) {
              descriptor.set.call(this, toProxyUrl(val));
            },
            configurable: true,
            enumerable: descriptor.enumerable,
          });
        }
      });
      var originalSetAttribute = Element.prototype.setAttribute;
      ctor.prototype.setAttribute = function (name, val) {
        if (properties.indexOf(String(name).toLowerCase()) !== -1 && val) {
          val = toProxyUrl(val);
        }
        return originalSetAttribute.call(this, name, val);
      };
    } catch (e) {
      beaconErr("hook:" + constructorName + ":" + ((e && e.message) || e));
    }
  }

  [
    ["HTMLScriptElement", ["src"]],
    ["HTMLImageElement", ["src"]],
    ["HTMLLinkElement", ["href"]],
    ["HTMLAnchorElement", ["href"]],
    ["HTMLAreaElement", ["href"]],
    ["HTMLObjectElement", ["data"]],
    ["HTMLEmbedElement", ["src"]],
    ["HTMLFormElement", ["action"]],
    ["HTMLInputElement", ["src", "formaction"]],
    ["HTMLButtonElement", ["formaction"]],
  ].forEach(function (entry) {
    hookUrlElement(entry[0], entry[1]);
  });

  // Inline module scripts built at runtime (flixer) import absolute upstream
  // URLs that no network hook sees and the CSP blocks. Rewrite only import
  // specifiers when the script text is assigned.
  function rewriteInlineModuleText(text) {
    if (typeof text !== "string" || text.indexOf("import") === -1)
      return text;
    return text.replace(
      /(from\s*["']|import\s*["']|import\(\s*["'])(https?:\/\/[^"'\s]+)(["'])/g,
      function (match, prefix, url, suffix) {
        try {
          if (new URL(url).origin === location.origin) return match;
          return prefix + toProxyUrl(url) + suffix;
        } catch (e) {
          return match;
        }
      },
    );
  }

  function maybeRewriteModuleText(el, value) {
    try {
      if (
        el &&
        el.tagName === "SCRIPT" &&
        String(el.type || "").toLowerCase() === "module" &&
        typeof value === "string"
      ) {
        return rewriteInlineModuleText(value);
      }
    } catch (e) {}
    return value;
  }

  // Re-read both inline-script properties so the type hook below can
  // re-process whichever one the provider assigned first.
  function rewriteScriptBody(el) {
    try {
      if (
        !el ||
        el.tagName !== "SCRIPT" ||
        String(el.type || "").toLowerCase() !== "module"
      )
        return;
      var cur = nodeTextDesc.get.call(el);
      var rew = rewriteInlineModuleText(cur);
      if (rew !== cur) nodeTextDesc.set.call(el, rew);
      if (scriptInnerHtmlDesc) {
        var curHtml = scriptInnerHtmlDesc.get.call(el);
        var rewHtml = rewriteInlineModuleText(curHtml);
        if (rewHtml !== curHtml) scriptInnerHtmlDesc.set.call(el, rewHtml);
      }
    } catch (e) {}
  }

  try {
    var scriptProto = window.HTMLScriptElement
      ? window.HTMLScriptElement.prototype
      : null;
    var nodeTextDesc =
      scriptProto &&
      Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
    if (scriptProto && nodeTextDesc && nodeTextDesc.set) {
      Object.defineProperty(scriptProto, "textContent", {
        get: nodeTextDesc.get
          ? function () {
              return nodeTextDesc.get.call(this);
            }
          : undefined,
        set: function (val) {
          nodeTextDesc.set.call(this, maybeRewriteModuleText(this, val));
        },
        configurable: true,
        enumerable: nodeTextDesc.enumerable,
      });
    }
    var scriptTextDesc =
      scriptProto && Object.getOwnPropertyDescriptor(scriptProto, "text");
    if (scriptProto && scriptTextDesc && scriptTextDesc.set) {
      Object.defineProperty(scriptProto, "text", {
        get: scriptTextDesc.get
          ? function () {
              return scriptTextDesc.get.call(this);
            }
          : undefined,
        set: function (val) {
          scriptTextDesc.set.call(this, maybeRewriteModuleText(this, val));
        },
        configurable: true,
        enumerable: scriptTextDesc.enumerable,
      });
    }
    // flixer's WASM loader fills its script via innerHTML.
    var scriptInnerHtmlDesc =
      scriptProto &&
      Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
    if (scriptProto && scriptInnerHtmlDesc && scriptInnerHtmlDesc.set) {
      Object.defineProperty(scriptProto, "innerHTML", {
        get: scriptInnerHtmlDesc.get
          ? function () {
              return scriptInnerHtmlDesc.get.call(this);
            }
          : undefined,
        set: function (val) {
          scriptInnerHtmlDesc.set.call(this, maybeRewriteModuleText(this, val));
        },
        configurable: true,
        enumerable: scriptInnerHtmlDesc.enumerable,
      });
    }
    // type may be set after the text.
    var scriptTypeDesc =
      scriptProto && Object.getOwnPropertyDescriptor(scriptProto, "type");
    if (
      scriptProto &&
      scriptTypeDesc &&
      scriptTypeDesc.set &&
      nodeTextDesc &&
      nodeTextDesc.get &&
      nodeTextDesc.set
    ) {
      Object.defineProperty(scriptProto, "type", {
        get: scriptTypeDesc.get
          ? function () {
              return scriptTypeDesc.get.call(this);
            }
          : undefined,
        set: function (val) {
          scriptTypeDesc.set.call(this, val);
          try {
            if (String(val || "").toLowerCase() === "module")
              rewriteScriptBody(this);
          } catch (e) {}
        },
        configurable: true,
        enumerable: scriptTypeDesc.enumerable,
      });
    }
  } catch (e) {
    beaconErr("hook:script-text:" + ((e && e.message) || e));
  }

  try {
    var originalSendBeacon = navigator.sendBeacon;
    if (originalSendBeacon) {
      navigator.sendBeacon = function (url, data) {
        return originalSendBeacon.call(this, toProxyUrl(String(url)), data);
      };
    }
  } catch (e) {
    beaconErr("hook:sendBeacon:" + ((e && e.message) || e));
  }

  function hookUrlConstructor(name) {
    try {
      var Original = window[name];
      if (!Original) return;
      var Wrapped = function (url, options) {
        return new Original(toProxyUrl(String(url)), options);
      };
      Wrapped.prototype = Original.prototype;
      window[name] = Wrapped;
    } catch (e) {
      beaconErr("hook:" + name + ":" + ((e && e.message) || e));
    }
  }
  ["Worker", "SharedWorker", "EventSource"].forEach(hookUrlConstructor);

  // Block popup ads.
  window.open = function () {
    return null;
  };
})();

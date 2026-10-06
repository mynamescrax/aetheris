(function () {
  "use strict";

  if (window.parent !== window)
    document.documentElement.classList.add("in-iframe");

  // Small shared helpers. No changes to existing storage keys or asset paths.
  var memory = Object.create(null);
  var storage = {
    getItem: function (key) {
      try {
        return localStorage.getItem(key);
      } catch (_) {
        return memory[key] === undefined ? null : memory[key];
      }
    },
    setItem: function (key, value) {
      memory[key] = String(value);
      try {
        localStorage.setItem(key, String(value));
        return true;
      } catch (_) {
        return false;
      }
    },
    removeItem: function (key) {
      delete memory[key];
      try {
        localStorage.removeItem(key);
      } catch (_) {}
    },
  };

  function readList(key) {
    try {
      var value = JSON.parse(storage.getItem(key) || "[]");
      return Array.isArray(value)
        ? Array.from(
            new Set(
              value
                .filter(function (id) {
                  return typeof id === "string" || typeof id === "number";
                })
                .map(String),
            ),
          )
        : [];
    } catch (_) {
      return [];
    }
  }
  function getToken() {
    var session = "";
    try {
      session = sessionStorage.getItem("dmToken") || "";
    } catch (_) {}
    return storage.getItem("dmAutoLogin") !== "false"
      ? storage.getItem("dmToken") || session
      : session;
  }

  // Keep the supplied asset URLs. If optional UI artwork is unavailable,
  // leave a clean label/monogram rather than a broken-image box.
  document.addEventListener(
    "error",
    function (event) {
      var image = event.target;
      if (!image || image.tagName !== "IMG") return;
      if (image.matches(".navitem img")) {
        image.style.visibility = "hidden";
      } else if (image.matches(".tile-icon img")) {
        image.hidden = true;
        var tile = image.closest(".tile-item");
        var tileLabel = tile && tile.querySelector(".tile-label");
        var initial = document.createElement("span");
        initial.textContent = (tileLabel ? tileLabel.textContent : image.alt)
          .trim()
          .slice(0, 1)
          .toUpperCase();
        initial.style.fontSize = "22px";
        initial.setAttribute("aria-hidden", "true");
        image.parentElement.appendChild(initial);
      } else if (image.matches(".action-buttons img")) {
        image.hidden = true;
        var symbol = document.createElement("span");
        symbol.textContent = "<>";
        symbol.setAttribute("aria-hidden", "true");
        image.parentElement.appendChild(symbol);
      } else if (image.matches(".logo-img")) {
        image.hidden = true;
        image.parentElement.classList.add("logo-fallback");
      } else if (image.matches(".discord-icon img")) {
        image.hidden = true;
        var link = image.parentElement;
        if (!link.querySelector(".discord-fallback")) {
          var label = document.createElement("span");
          label.className = "discord-fallback";
          label.textContent = "Discord ↗";
          link.appendChild(label);
        }
      }
    },
    true,
  );

  function httpUrl(value, base) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      var url = new URL(value, base || location.href);
      return /^(https?:)$/.test(url.protocol) && !url.username && !url.password
        ? url.href
        : null;
    } catch (_) {
      return null;
    }
  }

  // Remote images (game covers, movie posters, ...) go through the same-origin
  // /img relay so they still load when a school filter blocks the source host.
  // Same-origin paths, data: and blob: URLs pass through untouched.
  function imageUrl(value) {
    if (typeof value !== "string" || !value.trim()) return value;
    var trimmed = value.trim();
    if (/^(data:|blob:)/i.test(trimmed)) return trimmed;
    var absolute = httpUrl(trimmed);
    if (!absolute) return value;
    if (absolute.indexOf(location.origin + "/") === 0) return absolute;
    return "/img?url=" + encodeURIComponent(absolute);
  }

  var pages = {
    home: "home.html",
    maths: "maths.html",
    apps: "apps.html",
    cheats: "cheats.html",
    chat: "chat.html",
    ai: "ai.html",
    movies: "movies.html",
    search: "search.html",
    settings: "settings.html",
    about: "about.html",
    load: "load.html",
  };
  // Old #games bookmarks keep working by aliasing to the renamed route.
  var routeAliases = { games: "maths" };
  function parseRoute(value) {
    var route = String(value || "home").replace(/^#/, "");
    var split = route.indexOf("?");
    var name = split === -1 ? route : route.slice(0, split);
    if (Object.prototype.hasOwnProperty.call(routeAliases, name))
      name = routeAliases[name];
    if (!Object.prototype.hasOwnProperty.call(pages, name)) return null;
    var query =
      split === -1
        ? ""
        : "?" + new URLSearchParams(route.slice(split + 1)).toString();
    return { name: name, route: name + query, url: pages[name] + query };
  }
  function routeForUrl(value) {
    try {
      var url = new URL(value, location.href);
      if (url.origin !== location.origin) return null;
      var name = Object.keys(pages).find(function (key) {
        return url.pathname === "/" + pages[key];
      });
      return name ? parseRoute(name + url.search) : null;
    } catch (_) {
      return null;
    }
  }

  var expanded = null;
  var exitButton = null;
  var previousOverflow = "";
  var previousFocus = null;

  function notifyExpanded(active) {
    if (window.parent !== window) {
      window.parent.postMessage(
        { type: "immersive-mode", active: active },
        location.origin,
      );
    }
  }

  function exitExpanded() {
    if (!expanded) return;
    expanded.classList.remove("aetheris-expanded");
    expanded = null;
    if (exitButton) exitButton.remove();
    exitButton = null;
    document.body.style.overflow = previousOverflow;
    notifyExpanded(false);
    if (previousFocus && previousFocus.isConnected) previousFocus.focus();
  }

  function expandInPage(element) {
    exitExpanded();
    previousFocus = document.activeElement;
    previousOverflow = document.body.style.overflow;
    expanded = element;
    element.classList.add("aetheris-expanded");
    document.body.style.overflow = "hidden";
    exitButton = document.createElement("button");
    exitButton.type = "button";
    exitButton.className = "aetheris-exit-expanded";
    exitButton.textContent = "Exit expanded view";
    exitButton.addEventListener("click", exitExpanded);
    element.appendChild(exitButton);
    exitButton.focus();
    notifyExpanded(true);
  }

  async function fullscreen(element) {
    if (!element) return;
    if (expanded) {
      exitExpanded();
      return;
    }
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        var exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) await exit.call(document);
        return;
      }
      var request =
        element.requestFullscreen || element.webkitRequestFullscreen;
      if (!request) {
        expandInPage(element);
        return;
      }
      await request.call(element);
    } catch (_) {
      // iPad Safari, embedded browsers and denied fullscreen permissions.
      // This is an in-page expanded view, not a claim of native fullscreen.
      expandInPage(element);
    }
  }

  function quickExit() {
    var url = httpUrl(
      storage.getItem("panicurl") || "https://classroom.google.com/",
    );
    if (!url) url = "https://classroom.google.com/";
    try {
      window.top.location.replace(url);
    } catch (_) {
      location.replace(url);
    }
  }

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && expanded) {
      event.preventDefault();
      event.stopImmediatePropagation();
      exitExpanded();
    }
  });

  // Also used in iframe pages: 100vh alone does not follow Safari's keyboard.
  function updateViewport() {
    var viewport = window.visualViewport;
    var height =
      viewport && viewport.scale === 1 ? viewport.height : window.innerHeight;
    document.documentElement.style.setProperty(
      "--app-height",
      Math.round(height) + "px",
    );
  }
  updateViewport();
  window.addEventListener("resize", updateViewport);
  if (window.visualViewport)
    window.visualViewport.addEventListener("resize", updateViewport);

  window.Aetheris = {
    storage: storage,
    readList: readList,
    getToken: getToken,
    httpUrl: httpUrl,
    imageUrl: imageUrl,
    parseRoute: parseRoute,
    routeForUrl: routeForUrl,
    fullscreen: fullscreen,
    exitExpanded: exitExpanded,
    quickExit: quickExit,
    placeholder: "/assets/ui/placeholder.svg",
  };
})();

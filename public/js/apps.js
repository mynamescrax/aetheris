(function () {
  "use strict";
  var PAGE_SIZE = 120;
  var APP_PLACEHOLDER = Aetheris.placeholder;
  var STATE_KEY = "aetheris-apps-state";
  var SCROLL_KEY = "aetheris-apps-scroll";

  var catalog = [];
  var filtered = [];
  var byId = Object.create(null);
  var favorites = [];
  var limit = PAGE_SIZE;
  var restoredScroll = null;

  var grid = document.querySelector("#appcards");
  var favgrid = document.querySelector("#favoritedapps");
  var favlabel = document.querySelector("#favorited-apps-label");
  var status = document.getElementById("apps-status");
  var searchbox = document.querySelector("#search-box");
  var more = document.getElementById("apps-more");
  var retry = document.getElementById("apps-retry");
  var clearBtn = document.getElementById("apps-clear");
  var random = document.getElementById("random-app-btn");

  function getapps() {
    if (Array.isArray(window.apps)) return window.apps;
    if (typeof apps !== "undefined" && Array.isArray(apps)) return apps;
    return [];
  }

  function fiximagepath(raw, fallback) {
    if (!fallback) fallback = APP_PLACEHOLDER;
    if (!raw || typeof raw !== "string") return fallback;
    var p = raw.trim();
    if (!p) return fallback;
    if (/^(https?:|data:|blob:)/i.test(p)) return p;
    if (p.charAt(0) === "." || p.charAt(0) === "/") return p;
    return "./" + p.replace(/^\/+/, "");
  }

  function saveState() {
    try {
      sessionStorage.setItem(
        STATE_KEY,
        JSON.stringify({ q: searchbox ? searchbox.value : "", limit: limit }),
      );
    } catch (_) {}
  }

  function restoreState() {
    var s = null;
    try {
      s = JSON.parse(sessionStorage.getItem(STATE_KEY) || "null");
    } catch (_) {
      s = null;
    }
    if (s && typeof s === "object") {
      if (typeof s.q === "string" && searchbox) searchbox.value = s.q;
      if (Number.isInteger(s.limit))
        limit = Math.min(Math.max(s.limit, PAGE_SIZE), 2000);
    }
    try {
      var y = Number(sessionStorage.getItem(SCROLL_KEY));
      if (Number.isFinite(y) && y > 0) restoredScroll = y;
    } catch (_) {}
  }

  function saveScroll() {
    try {
      sessionStorage.setItem(SCROLL_KEY, String(window.scrollY || 0));
    } catch (_) {}
  }

  function isFavorite(app) {
    return favorites.indexOf(String(app.id)) !== -1;
  }

  function makeCard(app) {
    var card = document.createElement("a");
    var img = document.createElement("img");
    var label = document.createElement("h4");
    var title = app.title || "Untitled";

    card.classList.add("card-item");
    card.dataset.id = String(app.id || "");
    card.href = "/load.html?app=" + encodeURIComponent(app.id);
    card.title = title;

    img.loading = "lazy";
    img.decoding = "async";
    img.alt = title;

    var src = fiximagepath(app.image || app.icon || app.img || "");
    // <img> can display cross-origin images without CORS. Fetching them as
    // no-cors yielded an unreadable empty Blob and broke otherwise valid icons.
    img.referrerPolicy = "no-referrer";
    img.src = src;
    img.onerror = (function (imgref) {
      return function () {
        if (imgref.dataset.fallbackApplied === "true") return;
        imgref.dataset.fallbackApplied = "true";
        imgref.src = APP_PLACEHOLDER;
      };
    })(img);

    label.textContent = title;
    card.appendChild(img);
    card.appendChild(label);

    return card;
  }

  function applyFilters(reset) {
    if (reset !== false) limit = PAGE_SIZE;
    var q = searchbox ? searchbox.value.trim().toLowerCase() : "";
    filtered = catalog.filter(function (app) {
      if (!q) return true;
      return String(app.title || "")
        .toLowerCase()
        .includes(q);
    });
    render();
  }

  function render() {
    if (!grid) return;
    var favs = filtered.filter(isFavorite);
    var others = filtered.filter(function (app) {
      return !isFavorite(app);
    });
    var visibleFavorites = favs.slice(0, limit);
    var visibleOthers = others.slice(
      0,
      Math.max(0, limit - visibleFavorites.length),
    );
    grid.replaceChildren();
    if (favgrid) favgrid.replaceChildren();
    var favFrag = document.createDocumentFragment();
    var mainFrag = document.createDocumentFragment();
    visibleFavorites.forEach(function (app) {
      favFrag.appendChild(makeCard(app));
    });
    visibleOthers.forEach(function (app) {
      mainFrag.appendChild(makeCard(app));
    });
    if (favgrid) favgrid.appendChild(favFrag);
    grid.appendChild(mainFrag);
    if (favlabel && favgrid) {
      favlabel.style.display = visibleFavorites.length ? "block" : "none";
    }
    var visible = visibleFavorites.length + visibleOthers.length;
    if (status) {
      status.classList.toggle("library-error", !catalog.length);
      if (!catalog.length) {
        status.textContent = window.appsLoadError
          ? "Apps could not be loaded. Check your connection and try again."
          : "No apps are available.";
      } else if (filtered.length) {
        status.textContent =
          "Showing " +
          visible.toLocaleString() +
          " of " +
          filtered.length.toLocaleString() +
          " apps";
      } else {
        status.textContent = "No apps match. Try another search.";
      }
    }
    if (retry)
      retry.hidden =
        !(window.appsLoadError && !catalog.length) && !!catalog.length;
    if (more) more.hidden = visible >= filtered.length;
    if (clearBtn) clearBtn.hidden = !(catalog.length && !filtered.length);
    if (random) random.disabled = !filtered.length;
    saveState();
  }

  function build() {
    catalog = getapps();
    favorites = Aetheris.readList("favoritedApps");
    byId = Object.create(null);
    catalog.forEach(function (app) {
      byId[String(app.id)] = app;
    });
    restoreState();
    applyFilters(false);
    if (restoredScroll !== null) {
      requestAnimationFrame(function () {
        window.scrollTo(0, restoredScroll);
        restoredScroll = null;
      });
    }
  }

  var searchTimer = null;
  if (searchbox) {
    searchbox.addEventListener("input", function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        applyFilters(false);
      }, 120);
    });
  }
  if (more) {
    more.addEventListener("click", function () {
      limit += PAGE_SIZE;
      render();
    });
  }
  if (retry) {
    retry.addEventListener("click", function () {
      if (getapps().length) build();
      else location.reload();
    });
  }
  if (clearBtn) {
    clearBtn.addEventListener("click", function () {
      if (searchbox) searchbox.value = "";
      limit = PAGE_SIZE;
      applyFilters(false);
      if (searchbox) searchbox.focus();
    });
  }
  if (random) {
    random.addEventListener("click", function () {
      applyFilters(false);
      if (filtered.length) {
        location.href =
          "/load.html?app=" +
          encodeURIComponent(
            filtered[Math.floor(Math.random() * filtered.length)].id,
          );
      }
    });
  }

  document.addEventListener("click", function (event) {
    if (event.target.closest(".card-item")) {
      saveState();
      saveScroll();
    }
  });
  var scrollTimer = null;
  window.addEventListener(
    "scroll",
    function () {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(saveScroll, 200);
    },
    { passive: true },
  );
  window.addEventListener("pagehide", function () {
    saveState();
    saveScroll();
  });
  window.addEventListener("storage", function (event) {
    if (event.key === "favoritedApps") {
      favorites = Aetheris.readList("favoritedApps");
      applyFilters(false);
    }
  });

  window.addEventListener("appsloaded", build, { once: true });
  if (getapps().length) build();
})();

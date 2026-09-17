(function () {
  "use strict";
  var PAGE_SIZE = 120;
  var catalog = [];
  var filtered = [];
  var byId = Object.create(null);
  var favorites = [];
  var limit = PAGE_SIZE;
  var sortByPlays = false;
  var playCounts = null;
  var popularIds = [];
  var activeTags = new Set();
  var search = document.getElementById("search-box");
  var source = document.getElementById("source-filter");
  var main = document.getElementById("gamecards");
  var favGrid = document.getElementById("favoritedgames");
  var popular = document.getElementById("populargames");
  var status = document.getElementById("games-status");
  var more = document.getElementById("games-more");
  var retry = document.getElementById("games-retry");
  var clearBtn = document.getElementById("games-clear");
  var random = document.getElementById("random-game-btn");
  var sort = document.getElementById("sort-plays-btn");
  var tagContainer = document.getElementById("tag-container");
  var STATE_KEY = "aetheris-games-state";
  var SCROLL_KEY = "aetheris-games-scroll";
  var restoredScroll = null;

  function saveState() {
    try {
      sessionStorage.setItem(
        STATE_KEY,
        JSON.stringify({
          q: search.value,
          src: source.value,
          tags: Array.from(activeTags),
          sort: sortByPlays,
          limit: limit,
        }),
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
    if (!s || typeof s !== "object") return;
    if (typeof s.q === "string") search.value = s.q;
    if (
      typeof s.src === "string" &&
      Array.from(source.options).some(function (o) {
        return o.value === s.src;
      })
    )
      source.value = s.src;
    if (Array.isArray(s.tags))
      activeTags = new Set(
        s.tags.filter(function (t) {
          return typeof t === "string";
        }),
      );
    if (typeof s.sort === "boolean") {
      sortByPlays = s.sort;
      sort.classList.toggle("sort-active", sortByPlays);
      sort.setAttribute("aria-pressed", String(sortByPlays));
    }
    if (Number.isInteger(s.limit))
      limit = Math.min(Math.max(s.limit, PAGE_SIZE), 2000);
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

  function toggleFavorite(game) {
    var key = "favoritedGames";
    var favs = Aetheris.readList(key);
    var id = String(game.id);
    var raw = game.rawid != null ? String(game.rawid) : null;
    var has =
      favs.indexOf(id) !== -1 || (raw !== null && favs.indexOf(raw) !== -1);
    if (has) {
      favs = favs.filter(function (favId) {
        return favId !== id && (raw === null || favId !== raw);
      });
    } else {
      favs.push(id);
    }
    if (!Aetheris.storage.setItem(key, JSON.stringify(favs))) {
      status.textContent =
        "Favorites could not be saved. Browser storage may be full or disabled.";
      return;
    }
    favorites = favs;
    var y = window.scrollY;
    applyFilters(false);
    if (typeof y === "number") window.scrollTo(0, y);
  }

  function makeCard(game) {
    var card = document.createElement("a");
    card.className = "card-item";
    card.href = "/load.html?game=" + encodeURIComponent(game.id);
    card.dataset.id = String(game.id);
    card.dataset.source = game.source || "aetheris";
    var title = game.title || game.name || "Untitled";
    var img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.alt = title;
    img.src = game.image || game.img || Aetheris.placeholder;
    img.onerror = function () {
      img.onerror = null;
      img.src = Aetheris.placeholder;
    };
    var label = document.createElement("h4");
    label.textContent = title;
    card.title = label.textContent;
    card.append(img, label);
    var fav = isFavorite(game);
    var favBtn = document.createElement("button");
    favBtn.type = "button";
    favBtn.className = "card-fav";
    favBtn.textContent = fav ? "★" : "☆";
    favBtn.setAttribute("aria-pressed", String(fav));
    favBtn.setAttribute(
      "aria-label",
      (fav ? "Remove from favorites: " : "Add to favorites: ") + title,
    );
    favBtn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggleFavorite(game);
    });
    card.appendChild(favBtn);
    return card;
  }

  function isFavorite(game) {
    return (
      favorites.indexOf(String(game.id)) !== -1 ||
      (game.rawid != null && favorites.indexOf(String(game.rawid)) !== -1)
    );
  }

  function renderPopular() {
    if (!popular) return;
    var show =
      !search.value.trim() &&
      !activeTags.size &&
      (source.value === "aetheris" || source.value === "all");
    popular.replaceChildren();
    if (show)
      popularIds.forEach(function (id) {
        if (byId[id]) popular.appendChild(makeCard(byId[id]));
      });
    document.getElementById("popular-label").style.display = popular.children
      .length
      ? "block"
      : "none";
  }

  function render() {
    if (!main) return;
    var favs = filtered.filter(isFavorite);
    var others = filtered.filter(function (game) {
      return !isFavorite(game);
    });
    // Filter/sort DATA first. Never create 15k hidden DOM nodes on an iPad.
    var visibleFavorites = favs.slice(0, limit);
    var visibleOthers = others.slice(
      0,
      Math.max(0, limit - visibleFavorites.length),
    );
    favGrid.replaceChildren();
    main.replaceChildren();
    var favFrag = document.createDocumentFragment();
    var mainFrag = document.createDocumentFragment();
    visibleFavorites.forEach(function (game) {
      favFrag.appendChild(makeCard(game));
    });
    visibleOthers.forEach(function (game) {
      mainFrag.appendChild(makeCard(game));
    });
    favGrid.appendChild(favFrag);
    main.appendChild(mainFrag);
    document.getElementById("favorites-label").style.display =
      visibleFavorites.length ? "block" : "none";
    var visible = visibleFavorites.length + visibleOthers.length;
    status.classList.toggle("library-error", !catalog.length);
    status.textContent = catalog.length
      ? filtered.length
        ? "Showing " +
          visible.toLocaleString() +
          " of " +
          filtered.length.toLocaleString() +
          " games"
        : "No games match. Try another search, source, or tag."
      : "The game catalog could not be loaded. Check your connection and try again.";
    if (
      catalog.length &&
      window.gamesLoadErrors &&
      window.gamesLoadErrors.length
    ) {
      status.textContent += " · Some sources are unavailable.";
    }
    retry.hidden =
      !(window.gamesLoadErrors && window.gamesLoadErrors.length) &&
      !!catalog.length;
    more.hidden = visible >= filtered.length;
    if (clearBtn)
      clearBtn.hidden = !(catalog.length && !filtered.length);
    random.disabled = !filtered.length;
    renderPopular();
    saveState();
  }

  function applyFilters(reset) {
    if (reset !== false) limit = PAGE_SIZE;
    var query = search.value.trim().toLowerCase();
    var selectedSource = source.value || "all";
    var tags = Array.from(activeTags);
    filtered = catalog.filter(function (game) {
      return (
        (!query ||
          String(game.title || game.name || "")
            .toLowerCase()
            .includes(query)) &&
        (selectedSource === "all" || game.source === selectedSource) &&
        (!tags.length ||
          tags.some(function (tag) {
            return Array.isArray(game.tags) && game.tags.includes(tag);
          }))
      );
    });
    if (sortByPlays && playCounts) {
      filtered.sort(function (a, b) {
        return (
          (playCounts[b.id] || 0) - (playCounts[a.id] || 0) ||
          String(a.title || "").localeCompare(String(b.title || ""))
        );
      });
    }
    render();
  }

  function renderTags() {
    var tags = new Set();
    catalog.forEach(function (game) {
      if (source.value !== "all" && game.source !== source.value) return;
      if (Array.isArray(game.tags))
        game.tags.forEach(function (tag) {
          if (typeof tag !== "string") return;
          if (tag.toLowerCase() === "epstein") return;
          tags.add(tag);
        });
    });
    activeTags.forEach(function (tag) {
      if (!tags.has(tag)) activeTags.delete(tag);
    });
    tagContainer.replaceChildren();
    Array.from(tags)
      .sort(function (a, b) {
        return a.localeCompare(b);
      })
      .forEach(function (tag) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "tag-chip";
        button.classList.toggle("active", activeTags.has(tag));
        button.setAttribute("aria-pressed", String(activeTags.has(tag)));
        button.textContent = tag;
        button.addEventListener("click", function () {
          if (activeTags.has(tag)) activeTags.delete(tag);
          else activeTags.add(tag);
          button.classList.toggle("active", activeTags.has(tag));
          button.setAttribute("aria-pressed", String(activeTags.has(tag)));
          document.getElementById("clear-all-tags-btn").style.display =
            activeTags.size ? "" : "none";
          applyFilters();
        });
        tagContainer.appendChild(button);
      });
    if (!tags.size) tagContainer.textContent = "No tags for this source";
    document.getElementById("clear-all-tags-btn").style.display =
      activeTags.size ? "" : "none";
  }

  function build() {
    catalog = Array.isArray(window.games) ? window.games : [];
    favorites = Aetheris.readList("favoritedGames");
    byId = Object.create(null);
    catalog.forEach(function (game) {
      byId[game.id] = game;
    });
    restoreState();
    renderTags();
    if (sortByPlays && !playCounts) {
      fetchPlayCounts().then(
        function () {
          applyFilters();
        },
        function () {
          applyFilters();
        },
      );
      applyFilters();
    } else {
      applyFilters();
    }
    if (restoredScroll !== null) {
      requestAnimationFrame(function () {
        window.scrollTo(0, restoredScroll);
        restoredScroll = null;
      });
    }
    document.dispatchEvent(new Event("gamesrendered"));
  }

  async function fetchPlayCounts() {
    var response = await fetch("/api/plays/counts");
    if (!response.ok) throw new Error("Could not load play counts.");
    playCounts = await response.json();
  }

  async function loadPopular() {
    try {
      var response = await fetch("/api/plays/top");
      if (!response.ok) return;
      var data = await response.json();
      popularIds = Array.isArray(data) ? data.slice(0, 10).map(String) : [];
      renderPopular();
    } catch (_) {}
  }

  var searchTimer;
  search.addEventListener("input", function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(applyFilters, 120);
  });
  source.addEventListener("change", function () {
    renderTags();
    applyFilters();
    closeFilters();
  });
  more.addEventListener("click", function () {
    limit += PAGE_SIZE;
    render();
  });
  retry.addEventListener("click", function () {
    if (Array.isArray(window.games) && window.games.length) build();
    else location.reload();
  });
  if (clearBtn)
    clearBtn.addEventListener("click", function () {
      search.value = "";
      activeTags.clear();
      source.value = "aetheris";
      sortByPlays = false;
      sort.classList.remove("sort-active");
      sort.setAttribute("aria-pressed", "false");
      limit = PAGE_SIZE;
      renderTags();
      applyFilters();
      search.focus();
    });
  random.addEventListener("click", function () {
    // Use ALL matching records, not just the first rendered page.
    applyFilters(false);
    if (filtered.length)
      location.href =
        "/load.html?game=" +
        encodeURIComponent(
          filtered[Math.floor(Math.random() * filtered.length)].id,
        );
  });
  sort.addEventListener("click", async function () {
    sort.disabled = true;
    sort.setAttribute("aria-busy", "true");
    var prevSort = sortByPlays;
    try {
      if (!playCounts) {
        status.textContent = "Loading play counts…";
        await fetchPlayCounts();
      }
      sortByPlays = !sortByPlays;
      sort.classList.toggle("sort-active", sortByPlays);
      sort.setAttribute("aria-pressed", String(sortByPlays));
      applyFilters();
    } catch (_) {
      sortByPlays = prevSort;
      sort.classList.toggle("sort-active", sortByPlays);
      sort.setAttribute("aria-pressed", String(sortByPlays));
      status.textContent = "Play counts are unavailable. Please try again.";
    } finally {
      sort.disabled = false;
      sort.removeAttribute("aria-busy");
    }
  });
  document
    .getElementById("clear-all-tags-btn")
    .addEventListener("click", function () {
      activeTags.clear();
      renderTags();
      applyFilters();
    });

  var toggle = document.getElementById("filter-toggle");
  var popover = document.getElementById("filters-popover");
  function closeFilters() {
    popover.classList.remove("open");
    popover.inert = true;
    toggle.setAttribute("aria-expanded", "false");
  }
  closeFilters();
  toggle.addEventListener("click", function () {
    var open = popover.classList.toggle("open");
    popover.inert = !open;
    toggle.setAttribute("aria-expanded", String(open));
    if (open) source.focus();
  });
  document.addEventListener("click", function (event) {
    if (!popover.contains(event.target) && !toggle.contains(event.target))
      closeFilters();
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && popover.classList.contains("open")) {
      closeFilters();
      toggle.focus();
    }
  });

  window.closegamepopup = function () {
    document.getElementById("game-popup").classList.remove("show");
    if (document.getElementById("dont-show-again").checked)
      Aetheris.storage.setItem("popupDismissed", "1");
    try {
      sessionStorage.setItem("popupDismissed", "1");
    } catch (_) {}
  };
  var dismissed = Aetheris.storage.getItem("popupDismissed");
  try {
    dismissed = dismissed || sessionStorage.getItem("popupDismissed");
  } catch (_) {}
  if (!dismissed)
    setTimeout(function () {
      document.getElementById("game-popup").classList.add("show");
    }, 800);

  window.addEventListener("storage", function (event) {
    if (event.key === "favoritedGames") {
      favorites = Aetheris.readList("favoritedGames");
      applyFilters(false);
    }
  });
  // Keep scroll + filter state so Back from the player restores position.
  var scrollTimer = null;
  window.addEventListener(
    "scroll",
    function () {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(saveScroll, 200);
    },
    { passive: true },
  );
  document.addEventListener("click", function (event) {
    if (event.target.closest(".card-item")) {
      saveState();
      saveScroll();
    }
  });
  window.addEventListener("pagehide", function () {
    saveState();
    saveScroll();
  });
  if (window.gamesloaded) build();
  else window.addEventListener("gamesloaded", build, { once: true });
  loadPopular();
})();

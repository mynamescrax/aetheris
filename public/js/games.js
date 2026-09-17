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
  var random = document.getElementById("random-game-btn");
  var sort = document.getElementById("sort-plays-btn");
  var tagContainer = document.getElementById("tag-container");

  function makeCard(game) {
    var card = document.createElement("a");
    card.className = "card-item";
    card.href = "/load.html?game=" + encodeURIComponent(game.id);
    card.dataset.id = String(game.id);
    card.dataset.source = game.source || "aetheris";
    var img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.alt = "";
    img.src = game.image || game.img || Aetheris.placeholder;
    img.onerror = function () {
      img.onerror = null;
      img.src = Aetheris.placeholder;
    };
    var label = document.createElement("h4");
    label.textContent = game.title || game.name || "Untitled";
    card.title = label.textContent;
    card.append(img, label);
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
    random.disabled = !filtered.length;
    renderPopular();
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
    renderTags();
    applyFilters();
    document.dispatchEvent(new Event("gamesrendered"));
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
    location.reload();
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
    try {
      if (!playCounts) {
        var response = await fetch("/api/plays/counts");
        if (!response.ok) throw new Error("Could not load play counts.");
        playCounts = await response.json();
      }
      sortByPlays = !sortByPlays;
      sort.classList.toggle("sort-active", sortByPlays);
      sort.setAttribute("aria-pressed", String(sortByPlays));
      applyFilters();
    } catch (_) {
      status.textContent = "Play counts are unavailable. Please try again.";
    } finally {
      sort.disabled = false;
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
  if (window.gamesloaded) build();
  else window.addEventListener("gamesloaded", build, { once: true });
  loadPopular();
})();

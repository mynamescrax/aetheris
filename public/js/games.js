(function () {
  "use strict";
  var PAGE_SIZE = 120;
  var catalog = [];
  var filtered = [];
  var byId = Object.create(null);
  var favorites = [];
  var favoriteMatches = new WeakMap();
  var searchIndex = new WeakMap();
  var rendered = new WeakMap();
  var filterKey = null;
  var limit = PAGE_SIZE;
  var sortByPlays = false;
  var playCounts = null;
  var cardPlays = new Map();
  var popularGames = [];
  var activeTags = new Set();
  var search = document.getElementById("search-box");
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
  var built = false;
  var queuedupdate = null;

  function saveState() {
    try {
      sessionStorage.setItem(
        STATE_KEY,
        JSON.stringify({
          q: search.value,
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
    if (Array.isArray(s.tags))
      activeTags = new Set(
        s.tags
          .filter(function (t) {
            return typeof t === "string";
          })
          .map(function (t) {
            return t.toLowerCase();
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
    img.src = Aetheris.imageUrl(game.image || game.img || Aetheris.placeholder);
    img.onerror = function () {
      img.onerror = null;
      img.src = Aetheris.placeholder;
    };
    var label = document.createElement("h4");
    label.textContent = title;
    card.title = label.textContent;
    card.append(img, label);
    return card;
  }

  // Retain existing cards on pagination and provider updates. This preserves
  // decoded artwork and keyboard focus instead of rebuilding the entire grid.
  function syncGrid(grid, games) {
    if (!grid) return;
    var previous = rendered.get(grid) || [];
    if (
      previous.length === games.length &&
      games.every(function (game, i) {
        return previous[i].game === game;
      }) &&
      rendered.has(grid)
    )
      return;
    var appendOnly =
      previous.length <= games.length &&
      previous.every(function (entry, i) {
        return entry.game === games[i];
      });
    var next;
    if (appendOnly) {
      // Pagination only allocates records and cards for the new page.
      next = previous.concat(
        games.slice(previous.length).map(function (game) {
          return { game: game, node: makeCard(game) };
        }),
      );
    } else {
      var existing = new Map(
        previous.map(function (entry) {
          return [entry.game, entry.node];
        }),
      );
      next = games.map(function (game) {
        return { game: game, node: existing.get(game) || makeCard(game) };
      });
    }
    var fragment = document.createDocumentFragment();
    next.slice(appendOnly ? previous.length : 0).forEach(function (entry) {
      fragment.appendChild(entry.node);
    });
    if (!appendOnly || !rendered.has(grid)) grid.replaceChildren();
    grid.appendChild(fragment);
    rendered.set(grid, next);
  }

  // A game can be favorited under its primary id or any provider's own id.
  function isFavorite(game) {
    if (favoriteMatches.has(game)) return favoriteMatches.get(game);
    var match = favorites.some(function (id) {
      return typeof window.gamehasid === "function"
        ? window.gamehasid(game, id)
        : String(game.id) === String(id);
    });
    favoriteMatches.set(game, match);
    return match;
  }

  function renderPopular() {
    if (!popular) return;
    var show = !search.value.trim() && !activeTags.size;
    var games = show ? popularGames : [];
    syncGrid(popular, games);
    document.getElementById("popular-label").style.display = games.length
      ? "block"
      : "none";
  }

  function render() {
    if (!main) return;
    var favs = [];
    var others = [];
    filtered.forEach(function (game) {
      (isFavorite(game) ? favs : others).push(game);
    });
    // Filter/sort DATA first. Never create 15k hidden DOM nodes on an iPad.
    var visibleFavorites = favs.slice(0, limit);
    var visibleOthers = others.slice(
      0,
      Math.max(0, limit - visibleFavorites.length),
    );
    syncGrid(favGrid, visibleFavorites);
    syncGrid(main, visibleOthers);
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
          " items"
        : "No matches. Try another search or tag."
      : "The catalog could not be loaded. Check your connection and try again.";
    if (
      catalog.length &&
      window.gamesLoadErrors &&
      window.gamesLoadErrors.length
    ) {
      status.textContent += " · Some sources are unavailable.";
    }
    if (window.gamesLoading && catalog.length) {
      status.textContent += " · Loading more sources…";
    }
    retry.hidden =
      !(window.gamesLoadErrors && window.gamesLoadErrors.length) &&
      !!catalog.length;
    more.hidden = visible >= filtered.length;
    if (clearBtn) clearBtn.hidden = !(catalog.length && !filtered.length);
    random.disabled = !filtered.length;
    renderPopular();
    saveState();
  }

  function applyFilters(reset, redraw) {
    if (reset !== false) limit = PAGE_SIZE;
    var query = search.value.trim().toLowerCase();
    var tags = Array.from(activeTags);
    var key = JSON.stringify([query, tags, sortByPlays]);
    if (key === filterKey) {
      if (redraw !== false) render();
      return;
    }
    filterKey = key;
    filtered = catalog.filter(function (game) {
      var indexed = searchIndex.get(game);
      return (
        (!query || indexed.title.includes(query)) &&
        (!tags.length ||
          tags.some(function (tag) {
            return indexed.tags.has(tag);
          }))
      );
    });
    if (sortByPlays && playCounts) {
      filtered.sort(function (a, b) {
        return (
          (cardPlays.get(b) || 0) - (cardPlays.get(a) || 0) ||
          String(a.title || "").localeCompare(String(b.title || ""))
        );
      });
    }
    if (redraw !== false) render();
  }

  function indexCatalog() {
    filterKey = null;
    searchIndex = new WeakMap();
    byId = Object.create(null);
    catalog.forEach(function (game) {
      // The server counts launches by local source ID. A merged card may
      // have several of these, even when its primary copy is external.
      (game.sources || [{ name: game.source || "aetheris", id: game.id }]).forEach(function (copy) {
        if (copy.name === "aetheris" && copy.id != null) byId[copy.id] = game;
      });
      searchIndex.set(game, {
        title: String(game.title || game.name || "").toLowerCase(),
        tags: new Set(
          (Array.isArray(game.tags) ? game.tags : [])
            .filter(function (tag) {
              return typeof tag === "string";
            })
            .map(function (tag) {
              return tag.trim().toLowerCase();
            }),
        ),
      });
    });
    updateCardPlays();
  }

  function updateCardPlays() {
    cardPlays.clear();
    Object.keys(playCounts || {}).forEach(function (id) {
      var game = byId[id];
      var count = playCounts[id];
      if (game && Number.isFinite(count) && count > 0)
        cardPlays.set(game, (cardPlays.get(game) || 0) + count);
    });
    popularGames = Array.from(cardPlays.keys()).sort(function (a, b) {
      return cardPlays.get(b) - cardPlays.get(a) || a.title.localeCompare(b.title);
    }).slice(0, 10);
  }

  function renderTags() {
    // Sources spell tags differently ("Action" / "action"). One chip per tag,
    // matched case-insensitively: activeTags holds the lowercase keys.
    var tags = new Map();
    catalog.forEach(function (game) {
      if (Array.isArray(game.tags))
        game.tags.forEach(function (tag) {
          if (typeof tag !== "string") return;
          var key = tag.trim().toLowerCase();
          if (!key || key === "epstein" || tags.has(key)) return;
          tags.set(key, tag);
        });
    });
    activeTags.forEach(function (tag) {
      if (!tags.has(tag)) activeTags.delete(tag);
    });
    tagContainer.replaceChildren();
    Array.from(tags.entries())
      .sort(function (a, b) {
        return a[1].localeCompare(b[1]);
      })
      .forEach(function (entry) {
        var key = entry[0];
        var label = entry[1];
        var button = document.createElement("button");
        button.type = "button";
        button.className = "tag-chip";
        button.classList.toggle("active", activeTags.has(key));
        button.setAttribute("aria-pressed", String(activeTags.has(key)));
        button.textContent = label;
        button.addEventListener("click", function () {
          if (activeTags.has(key)) activeTags.delete(key);
          else activeTags.add(key);
          button.classList.toggle("active", activeTags.has(key));
          button.setAttribute("aria-pressed", String(activeTags.has(key)));
          document.getElementById("clear-all-tags-btn").style.display =
            activeTags.size ? "" : "none";
          applyFilters();
        });
        tagContainer.appendChild(button);
      });
    if (!tags.size) tagContainer.textContent = "No tags yet";
    document.getElementById("clear-all-tags-btn").style.display =
      activeTags.size ? "" : "none";
  }

  function build() {
    built = true;
    catalog = Array.isArray(window.games) ? window.games : [];
    favorites = Aetheris.readList("favoritedGames");
    favoriteMatches = new WeakMap();
    indexCatalog();
    restoreState();
    renderTags();
    applyFilters(false);
    if (restoredScroll !== null) {
      requestAnimationFrame(function () {
        window.scrollTo(0, restoredScroll);
        restoredScroll = null;
      });
    }
    document.dispatchEvent(new Event("gamesrendered"));
  }

  var countsRequest;
  function fetchPlayCounts() {
    if (countsRequest) return countsRequest;
    countsRequest = fetch("/api/plays/counts").then(function (response) {
      if (!response.ok) throw new Error("Could not load play counts.");
      return response.json();
    }).then(function (data) {
      playCounts = data;
      updateCardPlays();
      filterKey = null;
    }).finally(function () { countsRequest = null; });
    return countsRequest;
  }

  var searchTimer;
  search.addEventListener("input", function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(applyFilters, 80);
  });
  more.addEventListener("click", function () {
    limit += PAGE_SIZE;
    render();
  });
  retry.addEventListener("click", function () {
    if (typeof window.gamesretryfailed === "function") {
      status.textContent = "Retrying failed sources…";
      window.gamesretryfailed().then(function () {
        refresh();
        if (window.gamesLoadErrors && window.gamesLoadErrors.length)
          status.textContent = "Some sources are still unavailable.";
      });
      return;
    }
    if (Array.isArray(window.games) && window.games.length) build();
    else location.reload();
  });
  if (clearBtn)
    clearBtn.addEventListener("click", function () {
      search.value = "";
      activeTags.clear();
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
    applyFilters(false, false);
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
      favoriteMatches = new WeakMap();
      filterKey = null;
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
  // Progressive catalog loading: the first source renders immediately and the
  // rest merge in as they download. ids are re-keyed per merge, so refresh()
  // rebuilds the lookup and re-renders without resetting filters or scroll.
  function refresh() {
    catalog = Array.isArray(window.games) ? window.games : [];
    favoriteMatches = new WeakMap();
    indexCatalog();
    renderTags();
    applyFilters(false);
  }

  function onupdate() {
    if (!built) {
      build();
      return;
    }
    if (queuedupdate) return;
    queuedupdate = setTimeout(function () {
      queuedupdate = null;
      refresh();
    }, 120);
  }

  if (window.gamesloaded) build();
  else {
    window.addEventListener("gamesupdated", onupdate);
    window.addEventListener("gamesloaded", onupdate);
  }
  fetchPlayCounts().then(function () {
    if (built) applyFilters(false);
  }).catch(function () {});
})();

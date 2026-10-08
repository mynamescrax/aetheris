// Provider definitions are loaded immediately before this script.
(function () {
  "use strict";
  var grid = document.getElementById("grid");
  var status = document.getElementById("status");
  var search = document.getElementById("search");
  var more = document.getElementById("movies-more");
  var retry = document.getElementById("movies-retry");
  var modal = document.getElementById("modal");
  var player = document.getElementById("player");
  var playerStatus = document.getElementById("playerStatus");
  var hint = document.getElementById("playerHint");
  var source = document.getElementById("sourceSel");
  var season = document.getElementById("seasonSel");
  var episodes = document.getElementById("epBtns");
  var currentType = "all";
  var items = [];
  var nextPage = 1;
  var hasMore = true;
  var listingVersion = 0;
  var listingController = null;
  var isLoading = false;
  var searchTimer = null;
  var currentItem = null;
  var currentEpisode = null;
  var playerVersion = 0;
  var seasonVersion = 0;
  var detailsController = null;
  var seasonController = null;
  var playerTimer = null;
  var focusBeforeModal = null;
  var overflowBeforeModal = "";

  // Console logging, plus /movie-ping beacons for key moments. Beacons only
  // carry TMDB ids, the source index and hostnames.
  function dbg() {
    try {
      console.log.apply(console, ["[movies]"].concat([].slice.call(arguments)));
    } catch (e) {}
  }

  function uiBeacon(params) {
    try {
      var q = "?ui=1";
      for (var k in params) {
        if (Object.prototype.hasOwnProperty.call(params, k))
          q += "&" + k + "=" + encodeURIComponent(params[k]);
      }
      new Image().src = "/movie-ping" + q;
    } catch (e) {}
  }

  function urlHost(url) {
    try {
      return new URL(url, location.href).host;
    } catch (e) {
      return "?";
    }
  }

  // Capture-phase: resource load failures (broken posters, dead provider
  // assets — Safari renders those as "?") never reach window.onerror.
  window.addEventListener(
    "error",
    function (e) {
      var t = e.target;
      if (t && t !== window && (t.src || t.href))
        dbg("resource failed:", t.tagName, (t.src || t.href).slice(0, 160));
    },
    true,
  );

  async function json(url, controller) {
    var timer = setTimeout(function () {
      controller.abort();
    }, 15000);
    try {
      var response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        var error = new Error("HTTP " + response.status);
        // 502/503 carry a readable reason (e.g. search not configured).
        if (response.status === 502 || response.status === 503) {
          try {
            var body = await response.json();
            if (body && typeof body.error === "string" && body.error)
              error.serverMessage = body.error;
          } catch (_) {}
        }
        throw error;
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function render() {
    var fragment = document.createDocumentFragment();
    items.forEach(function (item) {
      var title = String(item.title || item.name || "Untitled");
      var year = String(item.release_date || item.first_air_date || "").slice(
        0,
        4,
      );
      var type = item.media_type || (item.title ? "movie" : "tv");
      var rating =
        Number.isFinite(item.vote_average) && item.vote_average > 0
          ? item.vote_average.toFixed(1)
          : "N/A";
      var card = document.createElement("button");
      card.type = "button";
      card.className = "card";
      card.setAttribute(
        "aria-label",
        title +
          (year ? " (" + year + ")" : "") +
          (type === "tv" ? ", TV show" : ", movie"),
      );
      var image = document.createElement("img");
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      image.src = Aetheris.imageUrl(
        typeof item.poster_path === "string" &&
          item.poster_path.startsWith("/")
          ? TMDB_IMG + item.poster_path
          : Aetheris.placeholder,
      );
      image.onerror = function () {
        image.onerror = null;
        image.src = Aetheris.placeholder;
      };
      var info = document.createElement("div");
      info.className = "info";
      var name = document.createElement("div");
      name.className = "card-title";
      name.textContent = title;
      var meta = document.createElement("div");
      meta.className = "card-meta";
      meta.textContent =
        (year || "—") +
        " · " +
        (rating === "N/A" ? "Not rated" : rating + "/10");
      info.append(name, meta);
      card.append(image, info);
      if (type === "tv") {
        var badge = document.createElement("span");
        badge.className = "card-badge";
        badge.textContent = "TV";
        card.appendChild(badge);
      }
      card.addEventListener("click", function () {
        openPlayer(item.id, type, title, year, rating);
      });
      fragment.appendChild(card);
    });
    grid.replaceChildren(fragment);
    more.hidden = !hasMore;
  }

  function invalidateListing() {
    listingVersion++;
    if (listingController) listingController.abort();
    isLoading = false;
    more.disabled = true;
  }

  async function loadListing(append) {
    if (append && (isLoading || !hasMore)) return;
    if (!append) {
      invalidateListing();
      items = [];
      nextPage = 1;
      hasMore = true;
      grid.replaceChildren();
    }
    var version = listingVersion;
    var query = search.value.trim();
    var page = nextPage;
    var endpoint = query
      ? "/search/" + (currentType === "all" ? "multi" : currentType)
      : "/trending/" + currentType + "/week";
    var url =
      TMDB_API +
      endpoint +
      "?page=" +
      page +
      (query ? "&query=" + encodeURIComponent(query) : "");
    var controller = new AbortController();
    listingController = controller;
    isLoading = true;
    more.disabled = true;
    more.textContent = "Loading…";
    retry.hidden = true;
    status.textContent = query ? "Searching…" : "Loading…";
    dbg(
      "listing:",
      currentType,
      query ? "q=" + query : "trending",
      "page=" + page,
    );
    try {
      var data = await json(url, controller);
      if (version !== listingVersion) return;
      var rows = Array.isArray(data.results) ? data.results : [];
      dbg("listing ok:", rows.length, "raw,", data.total_pages + " pages");
      rows = rows.filter(function (item) {
        return item && item.id && item.media_type !== "person";
      });
      var seen = new Set(
        items.map(function (item) {
          return (item.media_type || currentType) + ":" + item.id;
        }),
      );
      rows.forEach(function (item) {
        var key = (item.media_type || currentType) + ":" + item.id;
        if (!seen.has(key)) {
          items.push(item);
          seen.add(key);
        }
      });
      hasMore = page < Math.min(Number(data.total_pages) || 1, 500);
      nextPage = page + 1;
      render();
      status.textContent = items.length
        ? ""
        : "No results found. Try a different search.";
    } catch (err) {
      if (version !== listingVersion) return;
      dbg("listing FAILED:", currentType, query || "(trending)");
      status.textContent =
        (err && err.serverMessage) ||
        "Could not load " +
          (query ? "search results" : "titles") +
          ". Check your connection and try again.";
      retry.hidden = false;
      more.hidden = !append;
    } finally {
      if (version === listingVersion) {
        isLoading = false;
        more.disabled = false;
        more.textContent = "Load more";
      }
    }
  }

  function stopPlayer() {
    clearTimeout(playerTimer);
    attempt = null;
    player.onload = null;
    player.src = "about:blank";
    playerStatus.classList.add("hidden");
  }

  function showEpisodeError(message, retryAction) {
    episodes.replaceChildren();
    var text = document.createElement("span");
    text.textContent = message;
    var button = document.createElement("button");
    button.type = "button";
    button.className = "ep-btn";
    button.textContent = "Retry";
    button.addEventListener("click", retryAction);
    episodes.append(text, button);
  }

  async function loadTvDetails() {
    var item = currentItem;
    var version = playerVersion;
    if (!item) return;
    if (detailsController) detailsController.abort();
    var controller = (detailsController = new AbortController());
    season.replaceChildren();
    season.disabled = true;
    source.disabled = true;
    episodes.textContent = "Loading seasons…";
    try {
      var data = await json(TMDB_API + "/tv/" + item.id, controller);
      if (version !== playerVersion || currentItem !== item) return;
      var seasons = Array.isArray(data.seasons)
        ? data.seasons.filter(function (s) {
            return (
              Number.isInteger(s.season_number) &&
              s.season_number >= 0 &&
              s.episode_count !== 0
            );
          })
        : [];
      if (!seasons.length && Number.isInteger(data.number_of_seasons)) {
        for (var n = 1; n <= Math.min(data.number_of_seasons, 100); n++)
          seasons.push({ season_number: n });
      }
      if (!seasons.length) throw new Error("No seasons available.");
      seasons.forEach(function (s) {
        var option = document.createElement("option");
        option.value = s.season_number;
        option.textContent =
          s.season_number === 0 ? "Specials" : "Season " + s.season_number;
        season.appendChild(option);
      });
      season.value = seasons.some(function (s) {
        return s.season_number === 1;
      })
        ? "1"
        : String(seasons[0].season_number);
      season.disabled = false;
      loadSeason();
    } catch (_) {
      if (version === playerVersion && currentItem === item) {
        dbg("seasons FAILED for tmdb=" + item.id);
        showEpisodeError("Could not load seasons.", loadTvDetails);
      }
    }
  }

  async function loadSeason() {
    var item = currentItem;
    if (!item || item.type !== "tv") return;
    var selectedSeason = Number(season.value);
    if (!Number.isInteger(selectedSeason) || selectedSeason < 0) return;
    var version = ++seasonVersion;
    if (seasonController) seasonController.abort();
    var controller = (seasonController = new AbortController());
    currentEpisode = null;
    source.disabled = true;
    stopPlayer();
    episodes.textContent = "Loading episodes…";
    try {
      var data = await json(
        TMDB_API + "/tv/" + item.id + "/season/" + selectedSeason,
        controller,
      );
      if (version !== seasonVersion || currentItem !== item) return;
      var list = Array.isArray(data.episodes)
        ? data.episodes.filter(function (ep) {
            return Number.isInteger(ep.episode_number) && ep.episode_number > 0;
          })
        : [];
      episodes.replaceChildren();
      list.forEach(function (episode) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "ep-btn";
        button.textContent = episode.episode_number;
        button.title = episode.name || "Episode " + episode.episode_number;
        button.setAttribute(
          "aria-label",
          "Episode " + episode.episode_number + ": " + button.title,
        );
        button.addEventListener("click", function () {
          currentEpisode = {
            season: selectedSeason,
            episode: episode.episode_number,
          };
          episodes.querySelectorAll("button").forEach(function (b) {
            b.classList.toggle("active", b === button);
            b.setAttribute("aria-pressed", String(b === button));
          });
          source.disabled = false;
          setIframe();
        });
        episodes.appendChild(button);
      });
      if (list.length) episodes.querySelector("button").click();
      else {
        dbg("no episodes for tmdb=" + item.id, "season=" + selectedSeason);
        episodes.textContent = "No episodes are available for this season.";
      }
    } catch (_) {
      if (version === seasonVersion && currentItem === item) {
        dbg("episodes FAILED for tmdb=" + item.id, "season=" + selectedSeason);
        showEpisodeError("Could not load episodes.", loadSeason);
      }
    }
  }

  // Auto-fallback. movie-proxy-client.js reports when a feature-length video
  // is ready or playing; a source that hasn't done so within WATCHDOG_MS is
  // swapped for the next untried one for this title/episode. The iframe load
  // event can't be used for this: it fires for error pages too.
  var WATCHDOG_MS = 30000;
  // The user clicked into the player (e.g. a play overlay): give it longer.
  var INTERACTION_MS = 45000;
  // A video with a source is waiting for a tap; let the user get to it.
  var ARMED_MS = 90000;
  var attempt = null;
  var triedSources = {};
  var triedKey = "";

  function playKey() {
    return (
      currentItem.type +
      ":" +
      currentItem.id +
      (currentEpisode
        ? ":" + currentEpisode.season + "x" + currentEpisode.episode
        : "")
    );
  }

  function nextUntriedSource(from) {
    for (var step = 1; step < MOVIES_SOURCES.length; step++) {
      var i = (from + step) % MOVIES_SOURCES.length;
      if (!triedSources[i]) return i;
    }
    return -1;
  }

  function attemptBeacon(ev, current, extra) {
    var params = {
      ev: ev,
      src: String(current.index),
      kind: current.kind,
      id: String(current.id),
    };
    if (extra) params.host = extra;
    uiBeacon(params);
  }

  function armWatchdog(ms) {
    clearTimeout(playerTimer);
    var current = attempt;
    playerTimer = setTimeout(function () {
      if (attempt === current) sourceFailed(current, "timeout");
    }, ms);
  }

  function sourceFailed(failed, reason) {
    if (!failed || failed.ready || attempt !== failed) return;
    var provider = MOVIES_SOURCES[failed.index] || { name: "This source" };
    dbg("source FAILED (" + reason + "):", provider.name);
    attemptBeacon(reason, failed);
    var next = nextUntriedSource(failed.index);
    if (next < 0) {
      playerStatus.classList.add("hidden");
      hint.textContent =
        "No source could play this right now. Try again later, or pick a source to retry it.";
      attemptBeacon("exhausted", failed);
      return;
    }
    source.value = String(next);
    setIframe(true);
    hint.textContent =
      provider.name +
      " didn't start, trying " +
      MOVIES_SOURCES[next].name +
      "…";
  }

  // True when win is the player frame or one of its descendants.
  function fromPlayer(win) {
    var w = win;
    for (var i = 0; i < 10 && w; i++) {
      if (w === player.contentWindow) return true;
      var parent = null;
      try {
        parent = w.parent;
      } catch (e) {
        return false;
      }
      if (!parent || parent === w) return false;
      w = parent;
    }
    return false;
  }

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (
      !data ||
      data.type !== "aetheris-movie-playback" ||
      !attempt ||
      !fromPlayer(event.source)
    )
      return;
    var current = attempt;
    if (data.state === "ready" || data.state === "playing") {
      if (!current.ready) {
        current.ready = true;
        clearTimeout(playerTimer);
        playerStatus.classList.add("hidden");
        hint.textContent =
          data.state === "ready"
            ? "If it doesn't start on its own, press play."
            : "";
        dbg("player ready:", data.host, "duration=" + data.duration);
        attemptBeacon("ready", current, data.host);
      }
      if (data.state === "playing" && !current.playing) {
        current.playing = true;
        hint.textContent = "";
        attemptBeacon("playing", current, data.host);
        // Remember the source that actually worked.
        Aetheris.storage.setItem("movieSourceIdx", String(current.index));
      }
    } else if (data.state === "armed" && !current.ready && !current.armed) {
      current.armed = true;
      playerStatus.classList.add("hidden");
      hint.textContent =
        "Press play to start. Nothing happening? Try another source.";
      dbg("player waiting for play:", data.host);
      armWatchdog(ARMED_MS);
    } else if (data.state === "error" && !current.ready) {
      // Only logged: ad videos error too, and many players retry another
      // server on their own, so this alone doesn't fail the source.
      dbg("player media error:", data.host, data.detail);
    }
  });

  // Focus moving into the iframe means the user clicked the player.
  window.addEventListener("blur", function () {
    setTimeout(function () {
      if (
        document.activeElement === player &&
        attempt &&
        !attempt.ready &&
        !attempt.interacted
      ) {
        attempt.interacted = true;
        armWatchdog(INTERACTION_MS);
      }
    }, 0);
  });

  function setIframe(auto) {
    if (!currentItem || (currentItem.type === "tv" && !currentEpisode)) return;
    var index = Number(source.value);
    var provider = MOVIES_SOURCES[index];
    if (!provider) return;
    var selection = currentEpisode || { season: 1, episode: 1 };
    var url = provider.url(
      currentItem.type,
      currentItem.id,
      selection.season,
      selection.episode,
    );
    var key = playKey();
    // A manual pick (or a new title/episode) starts a fresh fallback round.
    if (auto !== true || key !== triedKey) {
      triedSources = {};
      triedKey = key;
    }
    triedSources[index] = true;
    var current = (attempt = {
      index: index,
      kind: currentItem.type,
      id: currentItem.id,
      ready: false,
      playing: false,
      armed: false,
      interacted: false,
    });
    playerStatus.textContent = "Loading " + provider.name + "…";
    playerStatus.classList.remove("hidden");
    if (auto !== true) hint.textContent = "";
    dbg(
      "play:",
      provider.name,
      currentItem.type,
      "tmdb=" + currentItem.id,
      currentItem.type === "tv"
        ? "s=" + selection.season + "e=" + selection.episode
        : "",
      "via=" + urlHost(url),
      auto === true ? "(auto)" : "",
    );
    attemptBeacon(auto === true ? "autoplay" : "play", current, urlHost(url));
    player.onload = function () {
      if (attempt !== current) return;
      playerStatus.classList.add("hidden");
      dbg("player frame loaded:", urlHost(player.src));
      attemptBeacon("loaded", current);
    };
    player.src = url;
    armWatchdog(WATCHDOG_MS);
  }

  function openPlayer(id, type, title, year, rating) {
    playerVersion++;
    seasonVersion++;
    if (detailsController) detailsController.abort();
    if (seasonController) seasonController.abort();
    stopPlayer();
    currentItem = { id: id, type: type };
    currentEpisode = null;
    focusBeforeModal = document.activeElement;
    overflowBeforeModal = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    modal.classList.add("open");
    var titleEl = document.getElementById("modalTitle");
    titleEl.textContent = title;
    var subtitle = document.createElement("small");
    subtitle.textContent =
      year + (rating !== "N/A" ? " · " + rating + "/10" : "");
    titleEl.appendChild(subtitle);
    source.replaceChildren();
    MOVIES_SOURCES.forEach(function (provider, i) {
      var option = document.createElement("option");
      option.value = i;
      option.textContent = provider.name;
      source.appendChild(option);
    });
    // Bumping sourceDefaultVersion resets everyone's saved source to the
    // default once.
    var defaultIndex = MOVIES_SOURCES.findIndex(function (provider) {
      return /flixer/i.test(provider.name);
    });
    if (defaultIndex < 0) defaultIndex = 0;
    var sourceDefaultVersion = "flixer-default-20260929";
    var savedVersion = Aetheris.storage.getItem("movieSourceVersion");
    var saved = Number(Aetheris.storage.getItem("movieSourceIdx"));
    source.value =
      savedVersion === sourceDefaultVersion &&
      Aetheris.storage.getItem("movieSourceIdx") !== null &&
      Number.isInteger(saved) &&
      MOVIES_SOURCES[saved]
        ? String(saved)
        : String(defaultIndex);
    Aetheris.storage.setItem("movieSourceVersion", sourceDefaultVersion);
    Aetheris.storage.setItem("movieSourceIdx", source.value);
    source.disabled = type === "tv";
    document.getElementById("epBar").classList.toggle("visible", type === "tv");
    hint.textContent = "";
    dbg(
      "open:",
      type,
      "tmdb=" + id,
      JSON.stringify(title),
      "defaultSrc=" + source.value,
    );
    uiBeacon({ ev: "open", kind: type, id: String(id) });
    document.getElementById("modalClose").focus();
    if (type === "tv") loadTvDetails();
    else setIframe();
  }

  function closeModal() {
    playerVersion++;
    seasonVersion++;
    if (detailsController) detailsController.abort();
    if (seasonController) seasonController.abort();
    Aetheris.exitExpanded();
    stopPlayer();
    modal.classList.remove("open");
    document.body.style.overflow = overflowBeforeModal;
    currentItem = null;
    currentEpisode = null;
    if (focusBeforeModal && focusBeforeModal.isConnected)
      focusBeforeModal.focus();
  }

  document.querySelectorAll(".mode-btn").forEach(function (button) {
    button.addEventListener("click", function () {
      currentType = button.dataset.type;
      document.querySelectorAll(".mode-btn").forEach(function (b) {
        b.classList.toggle("active", b === button);
        b.setAttribute("aria-pressed", String(b === button));
      });
      clearTimeout(searchTimer);
      loadListing(false);
    });
  });
  search.addEventListener("input", function () {
    clearTimeout(searchTimer);
    invalidateListing();
    status.textContent = "Searching…";
    searchTimer = setTimeout(function () {
      loadListing(false);
    }, 300);
  });
  more.addEventListener("click", function () {
    loadListing(true);
  });
  retry.addEventListener("click", function () {
    loadListing(items.length > 0);
  });
  source.addEventListener("change", function () {
    Aetheris.storage.setItem("movieSourceIdx", source.value);
    dbg(
      "source switched to:",
      source.value,
      (MOVIES_SOURCES[Number(source.value)] || {}).name,
    );
    setIframe();
  });
  season.addEventListener("change", loadSeason);
  document.getElementById("modalClose").addEventListener("click", closeModal);
  document.getElementById("modalFs").addEventListener("click", function () {
    Aetheris.fullscreen(document.querySelector(".player-wrap"));
  });
  modal.addEventListener("click", function (event) {
    if (event.target === modal) closeModal();
  });
  document.addEventListener("keydown", function (event) {
    if (!modal.classList.contains("open")) return;
    if (event.key === "Escape") closeModal();
    if (event.key !== "Tab") return;
    var controls = Array.from(
      modal.querySelectorAll(
        "button:not(:disabled), select:not(:disabled), iframe",
      ),
    ).filter(function (el) {
      return el.offsetParent !== null;
    });
    var first = controls[0],
      last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  window.addEventListener("pagehide", function () {
    invalidateListing();
    if (detailsController) detailsController.abort();
    if (seasonController) seasonController.abort();
    stopPlayer();
  });
  loadListing(false);
})();

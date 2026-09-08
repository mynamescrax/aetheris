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

  async function json(url, controller) {
    var timer = setTimeout(function () {
      controller.abort();
    }, 15000);
    try {
      var response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error("HTTP " + response.status);
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
      image.src =
        typeof item.poster_path === "string" && item.poster_path.startsWith("/")
          ? TMDB_IMG + item.poster_path
          : Aetheris.placeholder;
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
      "?api_key=" +
      TMDB_KEY +
      "&page=" +
      page +
      (query ? "&query=" + encodeURIComponent(query) : "");
    var controller = new AbortController();
    listingController = controller;
    isLoading = true;
    more.disabled = true;
    more.textContent = "Loading…";
    retry.hidden = true;
    status.textContent = query ? "Searching…" : "Loading…";
    try {
      var data = await json(url, controller);
      if (version !== listingVersion) return;
      var rows = Array.isArray(data.results) ? data.results : [];
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
    } catch (_) {
      if (version !== listingVersion) return;
      status.textContent =
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
      var data = await json(
        TMDB_API + "/tv/" + item.id + "?api_key=" + TMDB_KEY,
        controller,
      );
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
      if (version === playerVersion && currentItem === item)
        showEpisodeError("Could not load seasons.", loadTvDetails);
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
        TMDB_API +
          "/tv/" +
          item.id +
          "/season/" +
          selectedSeason +
          "?api_key=" +
          TMDB_KEY,
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
      else episodes.textContent = "No episodes are available for this season.";
    } catch (_) {
      if (version === seasonVersion && currentItem === item)
        showEpisodeError("Could not load episodes.", loadSeason);
    }
  }

  function setIframe() {
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
    clearTimeout(playerTimer);
    playerStatus.textContent = "Loading provider…";
    playerStatus.classList.remove("hidden");
    hint.textContent = provider.direct
      ? "Direct source: this provider receives your IP address and may show ads."
      : "If playback is unavailable, try another source. Provider loading does not confirm playback.";
    player.onload = function () {
      clearTimeout(playerTimer);
      playerStatus.classList.add("hidden");
    };
    player.src = url;
    playerTimer = setTimeout(function () {
      playerStatus.classList.add("hidden");
      hint.textContent =
        "This provider is slow or blocked. You can try another source.";
    }, 20000);
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
    var saved = Number(Aetheris.storage.getItem("movieSourceIdx"));
    source.value =
      Aetheris.storage.getItem("movieSourceIdx") !== null &&
      Number.isInteger(saved) &&
      MOVIES_SOURCES[saved]
        ? String(saved)
        : "3";
    source.disabled = type === "tv";
    document.getElementById("epBar").classList.toggle("visible", type === "tv");
    hint.textContent = "";
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

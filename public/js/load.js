(function () {
  var params = new URLSearchParams(window.location.search);
  var gameid = params.get("game");
  var appid = params.get("app");
  var srcsource = params.get("source");
  var srctitle = params.get("title");

  var backend = null;
  var iframe = null;
  var started = false;
  var item = null;
  // Playable copies of the current game, best first (aetheris, gnmath, …).
  var attempts = [];
  var attemptindex = 0;
  // Bumped on every attempt so a slow failure from a previous source cannot
  // swap the game the player is already watching.
  var attempttoken = 0;
  var playcounted = false;

  var LOAD_TIMEOUT = 15000;
  // How long a proxied frame gets after its load event before an empty
  // document counts as a failure. Long enough that a game still booting is
  // never swapped away from.
  var EXTERNAL_SETTLE_MS = 2000;

  function proxyerrortext(doc) {
    if (!doc || doc.contentType !== "text/plain") return "";
    var text = (doc.body && doc.body.textContent) || "";
    return text.indexOf("Internal Service Worker Error:") === 0 ||
      text.indexOf("Proxy unavailable") === 0 ? text : "";
  }

  function watchblankframe(frame, fail, stale) {
    return setTimeout(function () {
      if (stale()) return;
      try {
        var doc = frame.contentDocument;
        if (doc && doc.URL === "about:blank") {
          fail(new Error("The game page never loaded from this source."));
        }
      } catch (_) { /* cross-origin documents cannot be inspected */ }
    }, LOAD_TIMEOUT);
  }

  var SOURCE_LABELS = {
    aetheris: "Aetheris",
    gnmath: "Gn-Math",
    velara: "Velara",
    truffled: "Truffled",
    selenite: "Selenite",
  };

  function sourcelabel(name) {
    name = String(name || "");
    return SOURCE_LABELS[name] || name || "source";
  }

  function goback() {
    try {
      if (
        window.parent &&
        window.parent !== window &&
        typeof window.parent.navigateApp === "function"
      ) {
        window.parent.navigateApp(appid ? "apps" : "games");
        return;
      }
    } catch (_) {}
    if (window.history.length > 1) {
      window.history.back();
    } else {
      location.href = appid ? "/apps.html" : "/maths.html";
    }
  }
  window.goback = goback;

  function sourceurl(source) {
    if (!source) return null;
    var url = Aetheris.httpUrl(source.url || source.html || source.iframe || "");
    // Keep existing provider bookmarks working after repairing a broken wrapper.
    var repaired = {
      "https://truffled.lol/games/gta/index.html": "/assets/games/gta.html",
      "https://gn-math.github.io/html/410-fix.html": "/assets/games/telekinesisdrive.html",
      "https://velara.my/assets/games/onepiecefighting.html": "/assets/games/onepiecefighting.html",
      "https://velara.my/assets/games/1on1tennis.html": "/assets/games/1on1tennis.html",
    };
    return (repaired[url] ? Aetheris.httpUrl(repaired[url]) : url) || null;
  }

  // Merged catalog records carry every provider that has this game. Fall back
  // to the flat fields for entries loaded from a pre-merge cache.
  function itemsources(entry) {
    var list = [];
    if (entry && Array.isArray(entry.sources))
      list = entry.sources.filter(function (source) {
        return !!sourceurl(source);
      });
    if (!list.length) {
      var flat = {
        name: entry.source || "aetheris",
        id: entry.id,
        url: entry.url,
        html: entry.html,
        iframe: entry.iframe,
      };
      if (sourceurl(flat)) list.push(flat);
    }
    return list;
  }

  function withtimeout(promise, ms, text) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error(text));
      }, ms);
      promise.then(
        function (value) {
          clearTimeout(timer);
          resolve(value);
        },
        function (error) {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  function showLoading(entry, source, note) {
    var container = document.getElementById("game-frame");
    if (!container) return null;
    container.replaceChildren();
    var panel = document.createElement("div");
    panel.className = "player-loading";
    panel.setAttribute("role", "status");
    var spinner = document.createElement("div");
    spinner.className = "player-loading-spinner";
    spinner.setAttribute("aria-hidden", "true");
    var paragraph = document.createElement("p");
    paragraph.textContent =
      note ||
      "Loading " +
        (entry.title || entry.name || (appid ? "app" : "game")) +
        (source ? " from " + sourcelabel(source.name) : "") +
        "…";
    var actions = document.createElement("div");
    actions.className = "player-loading-actions";
    if (attempts.length > 1) {
      var swap = document.createElement("button");
      swap.type = "button";
      swap.textContent = "Swap source";
      swap.addEventListener("click", function () {
        window.swapsource();
      });
      actions.appendChild(swap);
    }
    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = appid ? "Back to apps" : "Back to games";
    cancel.addEventListener("click", goback);
    actions.appendChild(cancel);
    panel.append(spinner, paragraph, actions);
    container.appendChild(panel);
    return panel;
  }

  function message(text, error, opts) {
    var container = document.getElementById("game-frame");
    if (!container) return;
    container.replaceChildren();
    var panel = document.createElement("div");
    panel.className = "player-message";
    panel.setAttribute("role", error ? "alert" : "status");
    var paragraph = document.createElement("p");
    paragraph.textContent = text;
    panel.appendChild(paragraph);
    if (error) {
      var retry = document.createElement("button");
      retry.textContent = "Try again";
      retry.addEventListener("click", function () {
        if (opts && opts.reload) {
          // one-shot promises (the catalog loader) can't retry in place —
          // the same rejection would just re-render. a reload re-runs them.
          location.reload();
          return;
        }
        // Rebuild the backend transport before retrying: the previous failure
        // may have been a dead transport (backgrounded iPad, flaky school
        // wifi) rather than anything wrong with the game.
        try {
          if (window.aetherisProxy) window.aetherisProxy.reset();
        } catch (_) {}
        backend = null;
        // Start over at the best source instead of retrying the one that was
        // already exhausted.
        attemptindex = 0;
        attempt();
      });
      var back = document.createElement("button");
      back.type = "button";
      back.textContent = appid ? "Back to apps" : "Back to games";
      back.addEventListener("click", goback);
      panel.append(retry, back);
    }
    container.appendChild(panel);
  }

  function wantsdesktopua() {
    return Aetheris.storage.getItem("spoofDesktopUA") === "true";
  }

  function syncuaspoof() {
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: "aetheris-set-desktop-ua-spoof",
          enabled: wantsdesktopua(),
        });
        // the SW persists this too; resent in case its cache was cleared
        navigator.serviceWorker.controller.postMessage({
          type: "aetheris-set-adblock",
          enabled: Aetheris.storage.getItem("proxyAdblock") !== "false",
        });
      }
    } catch (e) {}
  }

  function slugify(str) {
    return String(str || "")
      .toLowerCase()
      .trim()
      .replace(/['\"]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function finditem() {
    if (appid) {
      var apps = Array.isArray(window.apps) ? window.apps : [];
      return (
        apps.find(function (a) {
          return String(a.id) === String(appid);
        }) || null
      );
    }

    var games = Array.isArray(window.games) ? window.games : [];

    if (gameid) {
      var byid =
        games.find(function (g) {
          return String(g.id) === String(gameid);
        }) || null;
      if (byid) return byid;
      if (/^https?:\/\//i.test(gameid)) {
        var requested = sourceurl({ url: gameid });
        var byurl = games.find(function (game) {
          return itemsources(game).some(function (source) {
            return sourceurl(source) === requested;
          });
        });
        if (byurl) return byurl;
      }
      // A card id can be re-keyed when later sources merge (a provider id that
      // collided, or a new source becoming primary). Favorites already match
      // any of those ids; a deep link should too.
      if (typeof window.gamehasid === "function")
        return (
          games.find(function (g) {
            return window.gamehasid(g, gameid);
          }) || null
        );
      return null;
    }

    if (srcsource && srctitle) {
      return (
        games.find(function (g) {
          return (
            g.source === srcsource &&
            slugify(g.title || g.name || "") === srctitle
          );
        }) || null
      );
    }

    return null;
  }

  function setgameinfo(entry) {
    var titleel = document.getElementById("game-title");
    var descel = document.getElementById("game-desc");
    var imgel = document.getElementById("game-img");

    if (titleel) titleel.textContent = entry.title || entry.name || "";
    if (descel) descel.textContent = entry.description || "";
    if (imgel) {
      imgel.onerror = function () {
        imgel.onerror = null;
        imgel.src = Aetheris.placeholder;
      };
      imgel.src = Aetheris.imageUrl(
        entry.image || entry.img || Aetheris.placeholder,
      );
    }
  }

  async function startbackend() {
    if (!window.aetherisProxy) {
      await new Promise(function (resolve, reject) {
        var waited = 0;
        var t = setInterval(function () {
          waited += 100;
          if (window.aetherisProxy) {
            clearInterval(t);
            resolve();
          } else if (waited >= 10000) {
            clearInterval(t);
            reject(new Error("Scramjet failed to load"));
          }
        }, 100);
      });
    }

    // getController() caches and resets itself; a local cache would pin a dead transport.
    backend = await window.aetherisProxy.getController();
    syncuaspoof();
  }

  // Only aetheris-served games are in the play-count allowlist.
  function countplay(source) {
    if (playcounted || appid || !source || source.name !== "aetheris") return;
    playcounted = true;
    var deviceid = Aetheris.storage.getItem("dmDeviceId") || "";
    fetch(
      "/api/plays/" +
        encodeURIComponent(source.id != null ? source.id : item.id),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: deviceid }),
      },
    ).catch(function () {});
  }

  function updateswapbutton() {
    var button = document.getElementById("swap-source-btn");
    if (!button) return;
    var source = attempts[attemptindex];
    var more = attempts.length > 1;
    button.disabled = !more;
    button.title = !source
      ? "Change source"
      : more
        ? "Source: " +
          sourcelabel(source.name) +
          " — click to switch to " +
          sourcelabel(attempts[(attemptindex + 1) % attempts.length].name)
        : "Only one source for this game (" + sourcelabel(source.name) + ")";
    button.setAttribute("aria-label", button.title);

    // The corner hint is only worth showing when a swap is actually possible.
    var hint = document.getElementById("swap-hint");
    if (hint) {
      hint.hidden =
        !more || Aetheris.storage.getItem("swapHintDismissed") === "true";
    }
  }

  // The catalogs merge in after the player opens (the first source is enough
  // to start), so a card can gain provider copies later. Re-read the card from
  // the current list and extend the swap cycle without restarting the frame.
  function refreshsources() {
    if (!started) return;
    var fresh = finditem();
    var next = fresh ? itemsources(fresh) : [];
    if (!next.length) return;
    var current = attempts[attemptindex];
    var currenturl = sourceurl(current);
    item = fresh;
    attempts = next;
    var index = -1;
    if (currenturl)
      for (var i = 0; i < attempts.length; i++)
        if (sourceurl(attempts[i]) === currenturl) {
          index = i;
          break;
        }
    attemptindex = index === -1 ? 0 : index;
    updateswapbutton();
  }
  window.addEventListener("gamesupdated", refreshsources);
  window.addEventListener("gamesloaded", refreshsources);

  // Next playable copy for this game. Wraps around, so a broken source can be
  // cycled past and a better one picked back up later.
  window.swapsource = function () {
    if (!started) return false;
    refreshsources();
    if (attempts.length < 2) return false;
    if (window.dismissshaphint) window.dismissshaphint();
    attemptindex = (attemptindex + 1) % attempts.length;
    attempt("Switching to " + sourcelabel(attempts[attemptindex].name) + "…");
    return true;
  };

  function fail(reason) {
    // A source that failed early may have been the only one loaded so far.
    // Take the copies that arrived since before giving up on the game.
    refreshsources();
    var failed = attempts[attemptindex];
    if (failed) console.warn("Game source failed:", failed.name, reason);
    if (attemptindex + 1 < attempts.length) {
      attemptindex++;
      attempt(
        (failed ? sourcelabel(failed.name) + " did not load. " : "") +
          "Trying " +
          sourcelabel(attempts[attemptindex].name) +
          "…",
      );
      return;
    }
    message(
      "This " +
        (appid ? "app" : "game") +
        " did not load from any source. Try again, or pick another source with the swap button.",
      true,
    );
  }

  async function attempt(note) {
    if (!item) return;
    var container = document.getElementById("game-frame");
    if (!container) {
      console.error("no #game-frame found");
      return;
    }

    var source = attempts[attemptindex];
    var url = sourceurl(source);
    if (!url) {
      fail(new Error("This source has no valid game URL."));
      return;
    }

    var token = ++attempttoken;
    var failed = false;
    function stale() {
      return failed || token !== attempttoken;
    }
    function failattempt(error) {
      if (stale()) return;
      failed = true;
      fail(error);
    }

    setgameinfo(item);
    updateswapbutton();
    var loading = showLoading(item, source, note);
    function hideLoading() {
      if (loading && loading.isConnected) loading.remove();
    }

    try {
      countplay(source);

      // Every source goes through the proxy, aetheris copies included: the
      // game's own network traffic (multiplayer servers, SDKs, CDNs) is then
      // reached by the proxy instead of the visitor's network, so a filtered
      // domain can't take it offline. The local game file itself is still
      // served by the page (see scramjet-init.js), so its cache and shims
      // keep working.
      if (!item.noProxy) {
        // Never probe the provider from the page itself: this network usually
        // can't reach it directly (that is what the proxy is for), so a failed
        // probe would swap away from a copy that proxies perfectly well.
        await startbackend();
        if (stale()) return;
        var frameel = document.createElement("iframe");
        frameel.title = item.title || item.name || "Game";
        frameel.allow =
          "autoplay; fullscreen; encrypted-media; picture-in-picture";
        frameel.style.cssText = "width:100%;height:100%;border:0;";
        frameel.addEventListener("load", hideLoading, { once: true });
        frameel.addEventListener("load", function () {
          if (!stale()) frameel.focus();
        });
        iframe = backend.createFrame(frameel);
        container.appendChild(frameel);
        // Frame#go() returns void, so a failure is a thrown error or a frame
        // that never navigates — never a rejected promise. Wrapping it in a
        // promise timeout marked every proxied game as broken.
        try {
          window.aetherisProxy.go(iframe, url);
        } catch (error) {
          failattempt(error);
          return;
        }
        if (stale()) return;
        watchblankframe(frameel, failattempt, stale);
        // Initial about:blank load events are normal; only the navigation
        // deadline above can declare that a frame never left its blank page.
        // go() reports nothing: when the upstream is blocked or missing the
        // proxy leaves the frame on about:blank rather than raising, so this
        // copy would silently show an empty page instead of falling through to
        // the next source. Judge only a frame that has loaded and still has no
        // document, and only after a grace period, so a slow proxied game is
        // never swapped away from.
        frameel.addEventListener("load", function () {
          if (stale()) return;
          setTimeout(function () {
            if (stale()) return;
            var doc = null;
            try {
              doc = frameel.contentDocument;
            } catch (_) {
              return;
            }
            // no document means it navigated somewhere cross-origin, which is
            // not something this can judge
            if (!doc) return;
            if (doc.URL === "about:blank") {
              return;
            }
            // A missing aetheris game reaches the proxy as the site's 404
            // page; treat it like the direct branch does.
            try {
              if (
                doc.querySelector('meta[name="aetheris-error"][content="404"]')
              )
                failattempt(
                  new Error("The game file was not found on this source."),
                );
            } catch (_) {
              /* an uninspectable document is not something to fail on */
            }
            // A cached copy of the proxy engine from before the same-origin
            // guard was patched refuses local games; the controller answers
            // with a text/plain "Internal Service Worker Error: …" document.
            // The engine URL carries a version now, so one reload picks up the
            // current bundle; only give up (or loop) if it happens again.
            if (doc.contentType === "text/plain") {
              try {
                var text = (doc.body && doc.body.textContent) || "";
                if (
                  text.indexOf("attempted to fetch from same origin") !== -1
                ) {
                  try {
                    var last = Number(
                      sessionStorage.getItem("proxyEngineReload") || 0,
                    );
                    if (!last || Date.now() - last > 60000) {
                      sessionStorage.setItem(
                        "proxyEngineReload",
                        String(Date.now()),
                      );
                      location.reload();
                      return;
                    }
                  } catch (_) {
                    /* storage is optional; fall through to the message */
                  }
                  failattempt(
                    new Error(
                      "The proxy engine is out of date. Reload the page to update it.",
                    ),
                  );
                } else if (proxyerrortext(doc)) {
                  failattempt(new Error(proxyerrortext(doc).slice(0, 300)));
                }
              } catch (_) {
                /* a body that can't be read is not a proxy error */
              }
            }
          }, EXTERNAL_SETTLE_MS);
        });
        // Proxied frames don't always fire load after go(); fall back to
        // hiding the spinner once navigation was accepted.
        setTimeout(hideLoading, 3000);
        return;
      }

      var frame = document.createElement("iframe");
      frame.title = item.title || item.name || "Game";
      frame.referrerPolicy = "no-referrer";
      frame.style.cssText = "width:100%;height:100%;border:0;";
      frame.allow = "autoplay; fullscreen";
      frame.setAttribute(
        "sandbox",
        "allow-scripts allow-same-origin allow-forms allow-popups " +
          "allow-pointer-lock allow-downloads allow-modals allow-orientation-lock " +
          "allow-presentation allow-storage-access-by-user-activation",
      );

      var loaded = new Promise(function (resolve, reject) {
        frame.addEventListener("load", resolve, { once: true });
        frame.addEventListener(
          "error",
          function () {
            reject(new Error("The game file could not be loaded."));
          },
          { once: true },
        );
      });

      container.appendChild(frame);
      frame.addEventListener("load", function () {
        if (!stale()) frame.focus();
      });
      syncuaspoof();

      if (wantsdesktopua()) {
        try {
          var nav = frame.contentWindow.navigator;
          var DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
          Object.defineProperty(nav, "userAgent", {
            get: function () {
              return DESKTOP_UA;
            },
            configurable: true,
          });
          Object.defineProperty(nav, "platform", {
            get: function () {
              return "Win32";
            },
            configurable: true,
          });
          Object.defineProperty(nav, "maxTouchPoints", {
            get: function () {
              return 0;
            },
            configurable: true,
          });
        } catch (e) {}
      }

      frame.src = url;
      await withtimeout(
        loaded,
        LOAD_TIMEOUT,
        "The game file took too long to load.",
      );
      if (stale()) return;
      hideLoading();

      try {
        if (
          frame.contentDocument.querySelector(
            'meta[name="aetheris-error"][content="404"]',
          )
        ) {
          failattempt(new Error("The game file was not found on this source."));
          return;
        }
      } catch (_) {
        /* external frames cannot be inspected */
      }
    } catch (error) {
      if (stale()) return;
      failattempt(error);
    }
  }

  async function loaditem(entry) {
    // Catalogs can point an app at its own page instead of a proxied URL
    // (TikTok has a dedicated gateway page). Old /load.html?app=<id> links
    // still work by handing off here.
    if (entry && typeof entry.href === "string" && entry.href) {
      location.replace(entry.href);
      return;
    }
    item = entry;
    attempts = itemsources(entry);
    attemptindex = 0;
    playcounted = false;
    setgameinfo(entry);
    setupfavoritebutton(entry);
    if (!attempts.length)
      throw new Error("This item does not have a valid game/app URL.");
    await attempt();
  }

  function setupfavoritebutton(entry) {
    var starbtn = document.querySelector("#fav-btn");
    if (!starbtn) return;

    var storagekey = appid ? "favoritedApps" : "favoritedGames";
    var itemid = String(entry.id);

    function matches(value) {
      if (typeof window.gamehasid === "function")
        return window.gamehasid(entry, value);
      return String(value) === itemid;
    }

    function refreshstar() {
      var saved = Aetheris.readList(storagekey);
      var active = saved.some(matches);
      starbtn.textContent = active ? "★" : "☆";
      starbtn.setAttribute("aria-pressed", String(active));
      starbtn.setAttribute(
        "aria-label",
        active ? "Remove from favorites" : "Add to favorites",
      );
    }

    starbtn.onclick = function () {
      var favs = Aetheris.readList(storagekey);
      if (favs.some(matches))
        favs = favs.filter(function (id) {
          return !matches(id);
        });
      else favs.push(itemid);

      if (!Aetheris.storage.setItem(storagekey, JSON.stringify(favs)))
        alert(
          "Favorites could not be saved. Browser storage may be full or disabled.",
        );
      refreshstar();
    };

    refreshstar();
  }

  function tryload() {
    if (started) return true;
    var found = finditem();
    if (!found) return false;
    started = true;
    loaditem(found).catch(function (error) {
      console.error(error);
      message(
        error.message || "The game could not be loaded. Please try again.",
        true,
      );
    });
    return true;
  }

  // Watch the catalogs that are still merging in. The loader publishes each
  // source as it arrives (and the player's promise resolves with the first
  // one), so a deep link to a provider game may arrive a moment later.
  function watchcatalogs() {
    var done = false;
    var ticks = 0;
    var poll = null;
    function notfound() {
      return (
        "This " +
        (appid ? "app" : "game") +
        " could not be found in the catalog. Check the link or retry loading."
      );
    }
    function stopevents() {
      window.removeEventListener("gamesupdated", check);
      window.removeEventListener("gamesloaded", check);
      window.removeEventListener("appsloaded", check);
    }
    function stop() {
      if (done) return;
      done = true;
      if (poll) clearInterval(poll);
      stopevents();
    }
    function check() {
      if (done) return;
      if (tryload()) {
        stop();
        return;
      }
      // Every catalog has settled and the item is still not here: no amount
      // of waiting will help. (The library's retry button can reload them.)
      if (appid ? window.appsloaded : window.gamesloaded) {
        stop();
        if (!started) message(notfound(), true);
      }
    }
    window.addEventListener("gamesupdated", check);
    window.addEventListener("gamesloaded", check);
    window.addEventListener("appsloaded", check);
    poll = setInterval(function () {
      ticks++;
      check();
      if (done) return;
      if (ticks > 200) {
        stop();
        if (!started) message(notfound(), true);
      }
    }, 100);
    check();
  }

  async function boot() {
    message("Loading " + (appid ? "app" : "game") + "…");
    if (window.playerDataReady) {
      try {
        await window.playerDataReady;
      } catch (error) {
        // playerDataReady is created once and never recreated: once the
        // catalog loader fails, boot() would just await the same rejection
        // forever. Only a reload re-downloads it.
        message(error.message, true, { reload: true });
        return;
      }
      if (tryload()) return;
      watchcatalogs();
      return;
    }

    var pending = [];
    if (window.gamesready && typeof window.gamesready.then === "function")
      pending.push(window.gamesready);
    if (window.appsready && typeof window.appsready.then === "function")
      pending.push(window.appsready);

    if (pending.length) {
      try {
        await Promise.allSettled(pending);
      } catch (e) {}
      if (tryload()) return;
    }

    watchcatalogs();
  }

  boot();
})();

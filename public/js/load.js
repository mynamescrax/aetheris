(function () {
  var params = new URLSearchParams(window.location.search);
  var gameid = params.get("game");
  var appid = params.get("app");
  var srcsource = params.get("source");
  var srctitle = params.get("title");

  var proxy = null;
  var iframe = null;
  var started = false;

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

  function showLoading(item) {
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
      "Loading " + (item.title || item.name || (appid ? "app" : "game")) + "…";
    var actions = document.createElement("div");
    actions.className = "player-loading-actions";
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
        started = false;
        boot();
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
    return localStorage.getItem("spoofDesktopUA") === "true";
  }

  function syncuaspoof() {
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: "aetheris-set-desktop-ua-spoof",
          enabled: wantsdesktopua(),
        });
      }
    } catch (e) {}
  }

  function slugify(str) {
    return String(str || "")
      .toLowerCase()
      .trim()
      .replace(/['"]/g, "")
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
      return (
        games.find(function (g) {
          return String(g.id) === String(gameid);
        }) || null
      );
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

  function setgameinfo(item) {
    var titleel = document.getElementById("game-title");
    var descel = document.getElementById("game-desc");
    var imgel = document.getElementById("game-img");

    if (titleel) titleel.textContent = item.title || item.name || "";
    if (descel) descel.textContent = item.description || "";
    if (imgel) {
      imgel.onerror = function () {
        imgel.onerror = null;
        imgel.src = Aetheris.placeholder;
      };
      imgel.src = item.image || item.img || Aetheris.placeholder;
    }
  }

  async function startproxy() {
    if (proxy) return;

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

    proxy = await window.aetherisProxy.getController();
    syncuaspoof();
  }

  async function loaditem(item) {
    var container = document.getElementById("game-frame");
    var url = Aetheris.httpUrl(item.url || item.html || "");

    if (!container) {
      console.error("no #game-frame found");
      return;
    }
    if (!url || (!item.url && !item.html))
      throw new Error("This item does not have a valid game/app URL.");

    setgameinfo(item);

    if (!appid && (item.source || "aetheris") === "aetheris") {
      var deviceid = localStorage.getItem("dmDeviceId") || "";
      fetch("/api/plays/" + encodeURIComponent(item.id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: deviceid }),
      }).catch(function () {});
    }

    setupfavoritebutton(item);
    // Keep a visible loading state until the frame reports back. Clearing
    // the container first is what made slow proxy boots look crashed.
    var loading = showLoading(item);

    function hideLoading() {
      if (loading && loading.isConnected) loading.remove();
    }

    var isexternal = new URL(url).origin !== location.origin;

    if (isexternal && !item.noProxy) {
      await startproxy();
      var frameel = document.createElement("iframe");
      frameel.title = item.title || item.name || "Game";
      frameel.allowFullscreen = true;
      frameel.allow =
        "autoplay; fullscreen; encrypted-media; picture-in-picture";
      frameel.style.cssText = "width:100%;height:100%;border:0;";
      frameel.addEventListener("load", hideLoading, { once: true });
      iframe = proxy.createFrame(frameel);
      container.appendChild(frameel);
      await window.aetherisProxy.go(iframe, url);
      // Proxied frames don't always fire load after go(); fall back to
      // hiding the spinner once navigation was accepted.
      setTimeout(hideLoading, 3000);
    } else {
      var frame = document.createElement("iframe");
      frame.allowFullscreen = true;
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

      container.appendChild(frame);
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
      frame.addEventListener("load", function () {
        hideLoading();
        try {
          if (
            frame.contentDocument.querySelector(
              'meta[name="aetheris-error"][content="404"]',
            )
          ) {
            message(
              "The game file was not found on this server. Restore the matching public/assets/games files and try again.",
              true,
            );
          }
        } catch (_) {
          /* external frames cannot be inspected */
        }
      });
    }
  }

  function setupfavoritebutton(item) {
    var starbtn = document.querySelector("#fav-btn");
    if (!starbtn) return;

    var storagekey = appid ? "favoritedApps" : "favoritedGames";
    var itemid = String(item.id);

    function refreshstar() {
      var saved = Aetheris.readList(storagekey);
      var active = isfavorited(saved, item);
      starbtn.textContent = active ? "★" : "☆";
      starbtn.setAttribute("aria-pressed", String(active));
      starbtn.setAttribute(
        "aria-label",
        active ? "Remove from favorites" : "Add to favorites",
      );
    }

    function isfavorited(saved, it) {
      if (saved.indexOf(String(it.id)) !== -1) return true;
      // favorites saved before id deduping may hold the raw shared id
      return it.rawid != null && saved.indexOf(String(it.rawid)) !== -1;
    }

    starbtn.onclick = function () {
      var favs = Aetheris.readList(storagekey);
      if (isfavorited(favs, item))
        favs = favs.filter(function (id) {
          return (
            id !== itemid && (item.rawid == null || id !== String(item.rawid))
          );
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
    var item = finditem();
    if (!item) return false;
    started = true;
    loaditem(item).catch(function (error) {
      console.error(error);
      message(
        error.message || "The game could not be loaded. Please try again.",
        true,
      );
    });
    return true;
  }

  async function boot() {
    message("Loading " + (appid ? "app" : "game") + "…");
    if (window.playerDataReady) {
      try {
        await window.playerDataReady;
        if (!tryload())
          message(
            "This " +
              (appid ? "app" : "game") +
              " could not be found in the catalog. Check the link or retry loading.",
            true,
          );
      } catch (error) {
        // playerDataReady is created once and never recreated: once the
        // catalog loader fails, boot() would just await the same rejection
        // forever. Only a reload re-downloads it.
        message(error.message, true, { reload: true });
      }
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

    window.addEventListener("gamesloaded", tryload, { once: true });
    window.addEventListener("appsloaded", tryload, { once: true });

    var ticks = 0;
    var poll = setInterval(function () {
      ticks++;
      if (tryload() || ticks > 100) {
        clearInterval(poll);
        if (!started)
          message(
            "This item could not be found. Check the link or retry loading.",
            true,
          );
      }
    }, 100);
  }

  boot();
})();

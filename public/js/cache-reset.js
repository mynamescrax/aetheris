(function () {
  "use strict";
  // Never derive this list from idbNames: it also includes real game saves.
  var databases = [
    "$scramjet",
    "__scramjet_controller",
    "scramjet-config",
    "aetheris-games-cache",
  ];
  // Disposable game-file stores. Mirrors the SKIP_DBS list in
  // data-transfer.js (excluded from backups because they are re-downloadable)
  // plus gameFilesDB, which holds downloaded bundles — never game saves.
  // /idbfs and /userfs are deliberately NOT listed: Emscripten IDBFS mounts
  // there mix downloadable assets with real save files.
  var downloadDatabases = [
    "UnityCache",
    "CachedXMLHttpRequests",
    "gameFilesDB",
  ];
  function isProtectedCacheKey(key) {
    return key === "__sw_meta__" || /^aetheris[-_]/i.test(key);
  }
  function deleteDatabase(name) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(
          new Error(
            name + " is still in use. Close other site tabs and retry.",
          ),
        );
      }, 4000);
      try {
        var req = indexedDB.deleteDatabase(name);
        req.onsuccess = function () {
          clearTimeout(timer);
          resolve();
        };
        req.onerror = function () {
          clearTimeout(timer);
          reject(req.error || new Error("Could not clear " + name));
        };
        req.onblocked = function () {
          clearTimeout(timer);
          reject(
            new Error(name + " is open in another tab. Close it and retry."),
          );
        };
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  }
  function readTrackedNames() {
    try {
      var known = JSON.parse(localStorage.getItem("idbNames") || "[]");
      return Array.isArray(known)
        ? known.filter(function (name) {
            return typeof name === "string" && name;
          })
        : [];
    } catch (_) {
      return [];
    }
  }
  async function listAllDatabaseNames() {
    var names = [];
    // idbNames tracks every opened database including the proxy ones above,
    // so concat would queue the same name twice and report two conflicting
    // errors for one database — dedupe here.
    databases.concat(readTrackedNames()).forEach(function (name) {
      if (names.indexOf(name) === -1) names.push(name);
    });
    if (window.indexedDB && typeof indexedDB.databases === "function") {
      try {
        var infos = await indexedDB.databases();
        infos.forEach(function (info) {
          if (info && info.name && names.indexOf(info.name) === -1)
            names.push(info.name);
        });
      } catch (_) {}
    }
    return names;
  }
  async function reset() {
    var work = [];
    if (navigator.serviceWorker) {
      work.push(
        navigator.serviceWorker
          .getRegistrations()
          .then(function (registrations) {
            return Promise.all(
              registrations
                .filter(function (reg) {
                  var worker = reg.active || reg.waiting || reg.installing;
                  return (
                    worker &&
                    // endsWith, not ===: the site can be deployed under a
                    // sub-path and the caches below are still ours.
                    new URL(worker.scriptURL).pathname.endsWith("/sw.js")
                  );
                })
                .map(function (reg) {
                  return reg.unregister();
                }),
            );
          }),
      );
    }
    if (window.caches) {
      work.push(
        caches.keys().then(function (keys) {
          return Promise.all(
            keys
              .filter(function (key) {
                return isProtectedCacheKey(key);
              })
              .map(function (key) {
                return caches.delete(key);
              }),
          );
        }),
      );
    }
    if (window.indexedDB)
      databases.forEach(function (name) {
        work.push(deleteDatabase(name));
      });
    var results = await Promise.allSettled(work);
    var failures = results.filter(function (result) {
      return result.status === "rejected";
    });
    if (failures.length)
      throw new Error(
        "Reset was incomplete. " +
          failures
            .map(function (result) {
              return (
                (result.reason && result.reason.message) || String(result.reason)
              );
            })
            .join(" "),
      );
  }
  // Full wipe: every service worker, cache, database, and web storage entry
  // for this origin. Unlike reset(), this deletes game saves, favorites,
  // settings, and chat sign-ins. Callers must confirm + suggest an export.
  async function resetSiteData() {
    var names = await listAllDatabaseNames();
    var work = [];
    if (navigator.serviceWorker) {
      work.push(
        navigator.serviceWorker.getRegistrations().then(function (regs) {
          return Promise.all(
            regs.map(function (reg) {
              return reg.unregister();
            }),
          );
        }),
      );
    }
    if (window.caches) {
      work.push(
        caches.keys().then(function (keys) {
          return Promise.all(
            keys.map(function (key) {
              return caches.delete(key);
            }),
          );
        }),
      );
    }
    if (window.indexedDB)
      names.forEach(function (name) {
        work.push(deleteDatabase(name));
      });
    var results = await Promise.allSettled(work);
    try {
      localStorage.clear();
    } catch (error) {
      results.push({ status: "rejected", reason: error });
    }
    try {
      sessionStorage.clear();
    } catch (error) {
      results.push({ status: "rejected", reason: error });
    }
    var failures = results.filter(function (result) {
      return result.status === "rejected";
    });
    if (failures.length)
      throw new Error(
        "Reset was incomplete. " +
          failures
            .map(function (result) {
              return (
                (result.reason && result.reason.message) || String(result.reason)
              );
            })
            .join(" "),
      );
  }
  // Wipe downloaded game files only. Deletes per-game Cache Storage entries
  // (Unity packs, offline bundles like "hksilksongcache-v2") and disposable
  // game-file IndexedDBs. Keeps settings, favorites, game saves, chat
  // sign-ins, localStorage/sessionStorage, the service worker, and the
  // proxy/catalog caches (aetheris-*) so the library still loads fast.
  async function resetDownloadedGames() {
    var deletedCaches = 0;
    var deletedDatabases = 0;
    var work = [];
    if (window.caches) {
      work.push(
        caches.keys().then(function (keys) {
          var targets = keys.filter(function (key) {
            return !isProtectedCacheKey(key);
          });
          return Promise.all(
            targets.map(function (key) {
              return caches.delete(key).then(function (deleted) {
                if (deleted) deletedCaches++;
              });
            }),
          );
        }),
      );
    }
    if (window.indexedDB)
      downloadDatabases.forEach(function (name) {
        work.push(
          deleteDatabase(name).then(
            function () {
              deletedDatabases++;
            },
            function (error) {
              // Missing databases reject on some browsers ("not found") —
              // they simply were never downloaded, so don't fail the wipe.
              if (
                error &&
                (error.name === "NotFoundError" ||
                  /not found|does not exist/i.test(
                    error.message || String(error),
                  ))
              )
                return;
              throw error;
            },
          ),
        );
      });
    var results = await Promise.allSettled(work);
    var failures = results.filter(function (result) {
      return result.status === "rejected";
    });
    if (failures.length)
      throw new Error(
        "Could not delete every download. " +
          failures
            .map(function (result) {
              return (
                (result.reason && result.reason.message) || String(result.reason)
              );
            })
            .join(" "),
      );
    return { caches: deletedCaches, databases: deletedDatabases };
  }
  window.AetherisCache = {
    reset: reset,
    resetDownloadedGames: resetDownloadedGames,
    resetSiteData: resetSiteData,
    databaseNames: databases.slice(),
    downloadDatabaseNames: downloadDatabases.slice(),
  };
})();

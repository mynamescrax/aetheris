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
  // Generic download-cache detection, so newly added games are handled
  // without editing this file. Keep in sync with data-transfer.js.
  //  - Any database whose name contains "cache" (UnityCache,
  //    amongus-web-cache, cachedb, ...) is deleted whole.
  //  - In every other game database, records that are huge or are binary
  //    data keyed by a URL are downloaded files and are deleted; small
  //    records (saves) are kept.
  var CACHE_DB_NAME = /cache/i;
  var MAX_RECORD_BYTES = 16 * 1024 * 1024;
  var URL_KEYED_BINARY_BYTES = 256 * 1024;
  function isDownloadCacheDb(name) {
    return downloadDatabases.indexOf(name) !== -1 || CACHE_DB_NAME.test(name);
  }
  function recordSize(value, depth, seen, acc) {
    acc = acc || { bytes: 0, binary: 0 };
    if (value === null || value === undefined) return acc;
    if (typeof value === "string") {
      acc.bytes += value.length;
      return acc;
    }
    if (typeof value !== "object") {
      acc.bytes += 8;
      return acc;
    }
    var bin =
      value instanceof Blob
        ? value.size
        : value instanceof ArrayBuffer || ArrayBuffer.isView(value)
          ? value.byteLength
          : -1;
    if (bin >= 0) {
      acc.bytes += bin;
      acc.binary += bin;
      return acc;
    }
    depth = depth || 0;
    if (depth > 8) return acc;
    seen = seen || new WeakSet();
    if (seen.has(value)) return acc;
    seen.add(value);
    if (value instanceof Map) {
      value.forEach(function (v, k) {
        recordSize(k, depth + 1, seen, acc);
        recordSize(v, depth + 1, seen, acc);
      });
    } else if (value instanceof Set || Array.isArray(value)) {
      value.forEach(function (v) {
        recordSize(v, depth + 1, seen, acc);
      });
    } else {
      for (var key of Object.keys(value)) {
        acc.bytes += key.length;
        recordSize(value[key], depth + 1, seen, acc);
      }
    }
    return acc;
  }
  function isDownloadRecord(key, size) {
    return (
      size.bytes > MAX_RECORD_BYTES ||
      (typeof key === "string" &&
        key.indexOf("://") !== -1 &&
        size.binary >= URL_KEYED_BINARY_BYTES)
    );
  }
  // Delete downloaded-file records from a mixed database (e.g. an
  // Emscripten /idbfs mount holding both assets and saves). Never creates a
  // database that does not exist. Resolves with the number deleted.
  function pruneDownloadRecords(name) {
    return new Promise(function (resolve, reject) {
      var req;
      try {
        req = indexedDB.open(name);
      } catch (error) {
        reject(error);
        return;
      }
      req.onupgradeneeded = function () {
        req.transaction.abort(); // didn't exist: don't create it
      };
      req.onerror = function (event) {
        if (req.error && req.error.name === "AbortError") {
          if (event && event.preventDefault) event.preventDefault();
          resolve(0);
        } else reject(req.error || new Error("Could not open " + name));
      };
      req.onblocked = function () {
        reject(new Error(name + " is open in another tab. Close it and retry."));
      };
      req.onsuccess = function () {
        var db = req.result;
        var stores = Array.from(db.objectStoreNames);
        if (!stores.length) {
          db.close();
          resolve(0);
          return;
        }
        var deleted = 0;
        var tx;
        try {
          tx = db.transaction(stores, "readwrite");
        } catch (error) {
          db.close();
          reject(error);
          return;
        }
        tx.oncomplete = function () {
          db.close();
          resolve(deleted);
        };
        tx.onerror = tx.onabort = function () {
          db.close();
          reject(tx.error || new Error("Could not clean " + name));
        };
        stores.forEach(function (storeName) {
          var cursorReq = tx.objectStore(storeName).openCursor();
          cursorReq.onsuccess = function () {
            var cursor = cursorReq.result;
            if (!cursor) return;
            if (isDownloadRecord(cursor.primaryKey, recordSize(cursor.value))) {
              cursor.delete();
              deleted++;
            }
            cursor.continue();
          };
        });
      };
    });
  }
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
    var deletedFiles = 0;
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
    if (window.indexedDB) {
      var names = await listAllDatabaseNames();
      // Known names are tried even if the browser can't list databases.
      downloadDatabases.forEach(function (name) {
        if (names.indexOf(name) === -1) names.push(name);
      });
      names.forEach(function (name) {
        // Proxy/catalog databases are handled by reset(), not here.
        if (databases.indexOf(name) !== -1) return;
        if (isDownloadCacheDb(name)) {
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
        } else {
          work.push(
            pruneDownloadRecords(name).then(function (count) {
              deletedFiles += count;
            }),
          );
        }
      });
    }
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
    return {
      caches: deletedCaches,
      databases: deletedDatabases,
      files: deletedFiles,
    };
  }
  window.AetherisCache = {
    reset: reset,
    resetDownloadedGames: resetDownloadedGames,
    resetSiteData: resetSiteData,
    databaseNames: databases.slice(),
    downloadDatabaseNames: downloadDatabases.slice(),
  };
})();

(function () {
  "use strict";
  // Never derive this list from idbNames: it also includes real game saves.
  var databases = [
    "$scramjet",
    "__scramjet_controller",
    "scramjet-config",
    "aetheris-games-cache",
  ];

  // The scramjet Controller opens "__scramjet_controller" once per proxy tab
  // and never closes it (the connection is cached in module scope with no
  // close API and no versionchange handler). So indexedDB.deleteDatabase()
  // for that name is always blocked while any other Aetheris window/tab is
  // open — the browser fires `blocked` and the old code surfaced that as a
  // "close it and retry" error, which made Reset cache fail in exactly the
  // situation users hit it (a game tab sitting open in another window).
  // Deleting a whole database needs an exclusive lock, but clearing every
  // object store does not: opening the DB at its current version and running
  // clear() on each store succeeds while other tabs hold connections open,
  // and leaves the same end state (no cached data). So try the delete first,
  // and when it is blocked fall back to clearing the stores.
  function deleteDatabase(name) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) {
          settled = true;
          reject(new Error(name + " timed out"));
        }
      }, 3000);
      function done(fn, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      }
      try {
        var req = indexedDB.deleteDatabase(name);
        req.onsuccess = function () {
          done(resolve);
        };
        req.onerror = function () {
          done(reject, req.error || new Error("Could not clear " + name));
        };
        req.onblocked = function () {
          done(reject, new Error(name + " is blocked by another open tab"));
        };
      } catch (error) {
        done(reject, error);
      }
    });
  }

  function clearDatabaseStores(name) {
    return new Promise(function (resolve, reject) {
      var created = false;
      var req;
      try {
        req = indexedDB.open(name);
      } catch (error) {
        reject(error);
        return;
      }
      req.onupgradeneeded = function () {
        // The database did not exist — this open just created an empty
        // shell, so there is nothing cached to clear.
        created = true;
      };
      req.onsuccess = function () {
        var db = req.result;
        function finish(fn, value) {
          try {
            db.close();
          } catch (_) {}
          fn(value);
        }
        try {
          // Never be the connection that blocks a future delete.
          db.onversionchange = function () {
            try {
              db.close();
            } catch (_) {}
          };
        } catch (_) {}
        if (created) {
          // Drop the empty shell so reset() leaves no residue behind.
          finish(resolve);
          try {
            indexedDB.deleteDatabase(name);
          } catch (_) {}
          return;
        }
        var stores = [];
        try {
          for (var i = 0; i < db.objectStoreNames.length; i++)
            stores.push(db.objectStoreNames[i]);
        } catch (error) {
          finish(reject, error);
          return;
        }
        if (!stores.length) {
          finish(resolve);
          return;
        }
        var tx;
        try {
          tx = db.transaction(stores, "readwrite");
        } catch (error) {
          finish(reject, error);
          return;
        }
        tx.oncomplete = function () {
          finish(resolve);
        };
        tx.onerror = function () {
          finish(reject, tx.error || new Error("Could not clear " + name));
        };
        tx.onabort = function () {
          finish(reject, tx.error || new Error("Could not clear " + name));
        };
        stores.forEach(function (storeName) {
          try {
            tx.objectStore(storeName).clear();
          } catch (_) {}
        });
      };
      req.onerror = function () {
        reject(req.error || new Error("Could not open " + name));
      };
      // No onblocked handler: opening at the current version never blocks on
      // other tabs' connections (only version upgrades do).
    });
  }

  function resetDatabase(name) {
    return deleteDatabase(name).catch(function () {
      return clearDatabaseStores(name);
    });
  }
  function failureMessage(results) {
    return results
      .filter(function (result) {
        return result.status === "rejected";
      })
      .map(function (result) {
        return result.reason && result.reason.message
          ? result.reason.message
          : String(result.reason);
      })
      .join(" ");
  }
  // Every browser API touched here (service-worker lookup, cache keys,
  // IndexedDB open/transactions) can hang forever in a wedged profile or a
  // cross-tab deadlock instead of resolving or rejecting — and a single
  // never-settling promise used to stick the UI on "Clearing…" with no
  // feedback at all. So every stage races against a timeout and names
  // itself in the error, and reset()/clearSiteData() run their stages
  // sequentially while reporting progress. They always settle.
  function withTimeout(promise, ms, message) {
    var timer;
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        reject(new Error(message));
      }, ms);
    });
    return Promise.race([promise, timeout]).then(
      function (value) {
        clearTimeout(timer);
        return value;
      },
      function (error) {
        clearTimeout(timer);
        throw error;
      },
    );
  }

  function notify(progress, stage) {
    try {
      if (typeof progress === "function") progress(stage);
    } catch (_) {}
  }

  function unregisterServiceWorkers(all) {
    return navigator.serviceWorker.getRegistrations().then(function (regs) {
      return Promise.all(
        regs
          .filter(function (reg) {
            if (all) return true;
            var worker = reg.active || reg.waiting || reg.installing;
            return (
              worker && new URL(worker.scriptURL).pathname === "/sw.js"
            );
          })
          .map(function (reg) {
            return reg.unregister();
          }),
      );
    });
  }

  function deleteCaches(all) {
    return caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (key) {
            if (all) return true;
            return key === "__sw_meta__" || /^aetheris[-_]/i.test(key);
          })
          .map(function (key) {
            return caches.delete(key);
          }),
      );
    });
  }

  function resetDatabases(names) {
    return Promise.allSettled(
      names.map(function (name) {
        return withTimeout(resetDatabase(name), 10000, name + " timed out");
      }),
    ).then(function (results) {
      var message = failureMessage(results);
      if (message) throw new Error(message);
    });
  }

  async function reset(progress) {
    var failures = [];
    if (navigator.serviceWorker) {
      notify(progress, "Clearing service worker…");
      try {
        await withTimeout(
          unregisterServiceWorkers(false),
          8000,
          "Service worker lookup timed out",
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (window.caches) {
      notify(progress, "Clearing caches…");
      try {
        await withTimeout(deleteCaches(false), 8000, "Cache lookup timed out");
      } catch (error) {
        failures.push(error);
      }
    }
    if (window.indexedDB) {
      notify(progress, "Clearing databases…");
      try {
        await resetDatabases(databases);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new Error(
        "Reset was incomplete. " +
          failures
            .map(function (error) {
              return error && error.message ? error.message : String(error);
            })
            .join(" ") +
          " Close other site tabs and retry.",
      );
  }

  // Full wipe: every service worker, cache, IndexedDB database, storage
  // area, and accessible cookie. Unlike reset() above this deliberately
  // deletes game saves, favorites, and settings too — the settings page
  // confirms twice and points at Export first.
  function listAllDatabaseNames() {
    var known = databases.slice();
    if (!window.indexedDB || typeof indexedDB.databases !== "function")
      return Promise.resolve(known);
    return indexedDB
      .databases()
      .then(function (infos) {
        (infos || []).forEach(function (info) {
          if (info && info.name && known.indexOf(info.name) === -1)
            known.push(info.name);
        });
        return known;
      })
      .catch(function () {
        return known;
      });
  }

  function clearWebStorage() {
    try {
      localStorage.clear();
    } catch (_) {}
    try {
      sessionStorage.clear();
    } catch (_) {}
  }

  function clearCookies() {
    try {
      var cookies = document.cookie ? document.cookie.split(";") : [];
      cookies.forEach(function (cookie) {
        var name = cookie.split("=")[0].replace(/^\s+|\s+$/g, "");
        if (!name) return;
        var expired =
          name + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0;";
        try {
          document.cookie = expired + " path=/";
        } catch (_) {}
        try {
          document.cookie = expired + " path=" + location.pathname;
        } catch (_) {}
      });
    } catch (_) {}
  }

  async function clearSiteData(progress) {
    var failures = [];
    if (navigator.serviceWorker) {
      notify(progress, "Removing service workers…");
      try {
        await withTimeout(
          unregisterServiceWorkers(true),
          8000,
          "Service worker lookup timed out",
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (window.caches) {
      notify(progress, "Deleting caches…");
      try {
        await withTimeout(deleteCaches(true), 8000, "Cache lookup timed out");
      } catch (error) {
        failures.push(error);
      }
    }
    if (window.indexedDB) {
      notify(progress, "Deleting databases…");
      try {
        await withTimeout(
          listAllDatabaseNames().then(resetDatabases),
          15000,
          "Database lookup timed out",
        );
      } catch (error) {
        failures.push(error);
      }
    }
    notify(progress, "Clearing storage…");
    clearWebStorage();
    clearCookies();
    if (failures.length)
      throw new Error(
        "Clear was incomplete. " +
          failures
            .map(function (error) {
              return error && error.message ? error.message : String(error);
            })
            .join(" ") +
          " Close other site tabs and retry.",
      );
  }
  window.AetherisCache = {
    reset: reset,
    clearSiteData: clearSiteData,
    databaseNames: databases.slice(),
  };
})();

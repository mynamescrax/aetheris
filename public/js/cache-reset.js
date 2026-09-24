(function () {
  "use strict";
  // Never derive this list from idbNames: it also includes real game saves.
  var databases = [
    "$scramjet",
    "__scramjet_controller",
    "scramjet-config",
    "aetheris-games-cache",
  ];
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
    var names = databases.slice().concat(readTrackedNames());
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
                    worker && new URL(worker.scriptURL).pathname === "/sw.js"
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
                return key === "__sw_meta__" || /^aetheris[-_]/i.test(key);
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
              return result.reason.message;
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
  window.AetherisCache = {
    reset: reset,
    resetSiteData: resetSiteData,
    databaseNames: databases.slice(),
  };
})();

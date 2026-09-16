(function () {
  "use strict";
  // Backup reminder + local backup/restore for game data.
  //
  // Shows a blocking modal at most once every 3 days (sooner never — later
  // whenever the stored timestamp ages out; a missing timestamp means it
  // shows immediately). The close button stays locked for 5 seconds so the
  // warning actually gets read. Export covers all of localStorage plus every
  // IndexedDB database except the proxy's internal ones (restoring those
  // would corrupt the browsing proxy — see cache-reset.js for the list).

  var REMIND_KEY = "backupReminderLast";
  var REMIND_EVERY_MS = 3 * 24 * 60 * 60 * 1000;
  var CLOSE_DELAY_S = 5;
  // Same internal databases cache-reset.js deletes — never back these up.
  var INTERNAL_DBS = [
    "$scramjet",
    "__scramjet_controller",
    "scramjet-config",
    "aetheris-games-cache",
  ];

  function $(id) {
    return document.getElementById(id);
  }

  // --- binary-safe (de)serialization -------------------------------------

  function bufToB64(buf) {
    var bytes = new Uint8Array(buf);
    var s = "";
    for (var i = 0; i < bytes.length; i++)
      s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function b64ToBuf(b64) {
    var s = atob(b64);
    var bytes = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes.buffer;
  }

  async function wrapValue(value) {
    if (value instanceof ArrayBuffer)
      return { __aetheris_bin: 1, kind: "buffer", data: bufToB64(value) };
    if (value instanceof Blob) {
      var buf = await value.arrayBuffer();
      return {
        __aetheris_bin: 1,
        kind: "blob",
        mime: value.type || "application/octet-stream",
        data: bufToB64(buf),
      };
    }
    if (Array.isArray(value)) {
      var arr = [];
      for (var i = 0; i < value.length; i++) arr.push(await wrapValue(value[i]));
      return arr;
    }
    if (value !== null && typeof value === "object") {
      var obj = {};
      for (var k in value) {
        if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
        try {
          obj[k] = await wrapValue(value[k]);
        } catch (e) {
          obj[k] = { __aetheris_bin: 0, skipped: true };
        }
      }
      return obj;
    }
    return value;
  }

  function unwrapValue(value) {
    if (Array.isArray(value)) return value.map(unwrapValue);
    if (value !== null && typeof value === "object") {
      if (value.__aetheris_bin === 1) {
        if (value.kind === "blob")
          return new Blob([b64ToBuf(value.data)], { type: value.mime });
        return b64ToBuf(value.data);
      }
      var obj = {};
      for (var k in value) {
        if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
        if (value[k] && value[k].__aetheris_bin === 0) continue;
        obj[k] = unwrapValue(value[k]);
      }
      return obj;
    }
    return value;
  }

  // --- IndexedDB dump/restore --------------------------------------------

  function openDb(name, version, upgrade) {
    return new Promise(function (resolve, reject) {
      var req = version
        ? indexedDB.open(name, version)
        : indexedDB.open(name);
      if (upgrade) {
        req.onupgradeneeded = function () {
          upgrade(req.result);
        };
      }
      req.onsuccess = function () {
        resolve(req.result);
      };
      req.onerror = function () {
        reject(req.error || new Error("Could not open " + name));
      };
      req.onblocked = function () {
        reject(new Error(name + " is open in another tab. Close it and retry."));
      };
    });
  }

  function deleteDb(name) {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.deleteDatabase(name);
      req.onsuccess = function () {
        resolve();
      };
      req.onerror = function () {
        reject(req.error || new Error("Could not delete " + name));
      };
      req.onblocked = function () {
        reject(new Error(name + " is open in another tab. Close it and retry."));
      };
    });
  }

  function listDbs() {
    if (!window.indexedDB) return Promise.resolve([]);
    if (typeof indexedDB.databases === "function")
      return indexedDB
        .databases()
        .then(function (infos) {
          return infos
            .map(function (info) {
              return info && info.name;
            })
            .filter(function (name) {
              return name && INTERNAL_DBS.indexOf(name) === -1;
            });
        })
        .catch(function () {
          return [];
        });
    return Promise.resolve([]);
  }

  async function dumpDb(name) {
    var db = await openDb(name);
    try {
      var out = { version: db.version || 1, stores: [] };
      for (var i = 0; i < db.objectStoreNames.length; i++) {
        var sname = db.objectStoreNames[i];
        var schema;
        var records = await new Promise(function (resolve, reject) {
          var tx = db.transaction(sname, "readonly");
          var store = tx.objectStore(sname);
          schema = {
            name: sname,
            keyPath: store.keyPath,
            autoIncrement: store.autoIncrement,
            indexes: [],
          };
          for (var j = 0; j < store.indexNames.length; j++) {
            var ix = store.index(store.indexNames[j]);
            schema.indexes.push({
              name: ix.name,
              keyPath: ix.keyPath,
              unique: ix.unique,
              multiEntry: ix.multiEntry,
            });
          }
          var rows = [];
          var cursorReq = store.openCursor();
          cursorReq.onsuccess = function () {
            var cursor = cursorReq.result;
            if (!cursor) {
              resolve(rows);
              return;
            }
            rows.push({ k: cursor.primaryKey, v: cursor.value });
            cursor.continue();
          };
          cursorReq.onerror = function () {
            reject(cursorReq.error || new Error("Could not read " + sname));
          };
        });
        var wrapped = [];
        for (var r = 0; r < records.length; r++) {
          wrapped.push({ k: records[r].k, v: await wrapValue(records[r].v) });
        }
        out.stores.push({ schema: schema, records: wrapped });
      }
      return out;
    } finally {
      db.close();
    }
  }

  async function restoreDb(name, dump) {
    await deleteDb(name).catch(function () {});
    var db = await openDb(name, dump.version || 1, function (fresh) {
      dump.stores.forEach(function (entry) {
        var s = entry.schema;
        var store = fresh.createObjectStore(s.name, {
          keyPath: s.keyPath,
          autoIncrement: !!s.autoIncrement,
        });
        s.indexes.forEach(function (ix) {
          store.createIndex(ix.name, ix.keyPath, {
            unique: !!ix.unique,
            multiEntry: !!ix.multiEntry,
          });
        });
      });
    });
    try {
      for (var i = 0; i < dump.stores.length; i++) {
        var entry = dump.stores[i];
        await new Promise(function (resolve, reject) {
          var tx = db.transaction(entry.schema.name, "readwrite");
          var store = tx.objectStore(entry.schema.name);
          entry.records.forEach(function (row) {
            var v = unwrapValue(row.v);
            if (entry.schema.keyPath) store.put(v);
            else {
              try {
                store.put(v, row.k);
              } catch (e) {
                store.add(v);
              }
            }
          });
          tx.oncomplete = function () {
            resolve();
          };
          tx.onerror = function () {
            reject(tx.error || new Error("Could not write " + entry.schema.name));
          };
        });
      }
    } finally {
      db.close();
    }
  }

  // --- export / import ----------------------------------------------------

  async function exportBackup() {
    var data = {
      app: "aetheris-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      localStorage: {},
      indexedDB: {},
    };
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      try {
        data.localStorage[key] = localStorage.getItem(key);
      } catch (e) {}
    }
    var names = await listDbs();
    for (var n = 0; n < names.length; n++) {
      try {
        data.indexedDB[names[n]] = await dumpDb(names[n]);
      } catch (e) {
        data.indexedDB[names[n]] = { error: String((e && e.message) || e) };
      }
    }
    return data;
  }

  async function importBackup(data) {
    if (!data || data.app !== "aetheris-backup")
      throw new Error("That file is not an Aetheris backup.");
    var ls = data.localStorage || {};
    Object.keys(ls).forEach(function (key) {
      try {
        if (typeof ls[key] === "string") localStorage.setItem(key, ls[key]);
      } catch (e) {}
    });
    var dbs = data.indexedDB || {};
    var names = Object.keys(dbs);
    for (var i = 0; i < names.length; i++) {
      if (INTERNAL_DBS.indexOf(names[i]) !== -1) continue;
      if (!dbs[names[i]] || !dbs[names[i]].stores) continue;
      await restoreDb(names[i], dbs[names[i]]);
    }
  }

  function downloadBackup(data) {
    var stamp = (data.exportedAt || new Date().toISOString()).slice(0, 10);
    var blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    var link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "aetheris-backup-" + stamp + ".json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () {
      URL.revokeObjectURL(link.href);
    }, 60000);
  }

  function stampReminded() {
    try {
      localStorage.setItem(REMIND_KEY, String(Date.now()));
    } catch (e) {}
  }

  function notifyParent(active) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(
          { type: "backup-modal", active: active === true },
          location.origin,
        );
      }
    } catch (e) {}
  }

  // --- modal --------------------------------------------------------------

  function showBackupModal() {
    var backdrop = $("backupmodal");
    var closebtn = $("backupmodalclose");
    if (!backdrop) return;

    backdrop.style.display = "flex";
    notifyParent(true);

    var remaining = CLOSE_DELAY_S;
    function tick() {
      if (remaining <= 0) {
        if (closebtn) {
          closebtn.disabled = false;
          closebtn.textContent = "aight";
        }
        return;
      }
      if (closebtn) closebtn.textContent = "aight (" + remaining + ")";
      remaining--;
      setTimeout(tick, 1000);
    }
    if (closebtn) {
      closebtn.disabled = true;
      closebtn.textContent = "aight (5)";
    }
    tick();

    function dismiss() {
      stampReminded();
      backdrop.style.display = "none";
      notifyParent(false);
    }

    if (closebtn) closebtn.addEventListener("click", dismiss);

    var dlbtn = $("backupdownload");
    if (dlbtn)
      dlbtn.addEventListener("click", async function () {
        dlbtn.disabled = true;
        try {
          var data = await exportBackup();
          downloadBackup(data);
          stampReminded();
          dlbtn.textContent = "saved. dont lose it.";
        } catch (e) {
          alert("Backup failed: " + ((e && e.message) || e));
        } finally {
          dlbtn.disabled = false;
        }
      });

    var drivebtn = $("backupdrive");
    if (drivebtn)
      drivebtn.addEventListener("click", async function () {
        // No Drive API keys on this project, so a direct upload is not
        // possible — grab the file and drop it in Drive yourself.
        try {
          var data = await exportBackup();
          downloadBackup(data);
          stampReminded();
        } catch (e) {
          alert("Backup failed: " + ((e && e.message) || e));
          return;
        }
        window.open("https://drive.google.com/drive/my-drive", "_blank");
      });

    var restorebtn = $("backuprestore");
    var fileinput = $("backupfile");
    if (restorebtn && fileinput) {
      restorebtn.addEventListener("click", function () {
        fileinput.click();
      });
      fileinput.addEventListener("change", async function () {
        if (!fileinput.files || !fileinput.files[0]) return;
        try {
          var text = await fileinput.files[0].text();
          await importBackup(JSON.parse(text));
          stampReminded();
          alert("Backup restored. Reloading.");
          location.reload();
        } catch (e) {
          alert("Restore failed: " + ((e && e.message) || e));
        } finally {
          fileinput.value = "";
        }
      });
    }
  }

  function maybeShow() {
    var last = 0;
    try {
      last = parseInt(localStorage.getItem(REMIND_KEY) || "0", 10) || 0;
    } catch (e) {}
    if (Date.now() - last < REMIND_EVERY_MS) return;
    showBackupModal();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", maybeShow, { once: true });
  } else {
    maybeShow();
  }
})();

(function () {
  "use strict";
  var busy = false;
  var downloadUrl = null;
  var SKIP_DBS = new Set([
    "$scramjet",
    "__scramjet_controller",
    "scramjet-config",
    "aetheris-games-cache",
    "UnityCache",
    "CachedXMLHttpRequests",
  ]);
  // Generic download-cache detection, so newly added games are handled
  // without editing this file. Keep in sync with cache-reset.js.
  //  - Any database whose name contains "cache" holds re-downloadable game
  //    files (UnityCache, amongus-web-cache, cachedb, ...), never saves.
  //  - In other databases, a record is a downloaded file (not a save) when
  //    it is huge, or when it is binary data keyed by a URL.
  var CACHE_DB_NAME = /cache/i;
  // Saves are tiny; a single record this large is a downloaded game asset
  // (e.g. a Unity bundle inside an Emscripten /idbfs mount).
  var MAX_RECORD_BYTES = 16 * 1024 * 1024;
  var URL_KEYED_BINARY_BYTES = 256 * 1024;
  // Raw data budget for a whole backup. Base64 inflates binary by 4/3, so
  // this keeps the file under the 128 MB import limit.
  var MAX_EXPORT_BYTES = 90 * 1024 * 1024;
  var BATCH_RECORDS = 200;
  var BATCH_BYTES = 8 * 1024 * 1024;
  var SKIP_KEYS = new Set([
    "dmToken",
    "dmDeviceId",
    "dmUsername",
    "idbNames",
    "__popularGames",
    "__popularGames_ts",
  ]);
  var TYPED = [
    "Int8Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "Int16Array",
    "Uint16Array",
    "Int32Array",
    "Uint32Array",
    "Float32Array",
    "Float64Array",
    "BigInt64Array",
    "BigUint64Array",
    "DataView",
  ];
  // A crafted/corrupt backup could declare version 2^53 and permanently
  // brick a game database whose code opens it with a fixed version.
  var MAX_DB_VERSION = 10000;
  var own = function (object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  };

  function status(text, error) {
    var el = document.getElementById("data-status");
    el.textContent = text;
    el.style.color = error ? "#fca5a5" : "";
  }
  function setBusy(value) {
    busy = value;
    document.querySelectorAll("[data-transfer]").forEach(function (button) {
      button.disabled = value;
    });
  }
  function base64(buffer) {
    var bytes = new Uint8Array(buffer),
      text = "";
    for (var i = 0; i < bytes.length; i += 32768)
      text += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
    return btoa(text);
  }
  function unbase64(text) {
    var decoded = atob(text),
      bytes = new Uint8Array(decoded.length);
    for (var i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
    return bytes.buffer;
  }
  function packed(type, value, extra) {
    return Object.assign({ $aetheris: type, value: value }, extra);
  }

  // Wrap plain objects too, so a game's own marker-named fields round-trip.
  async function encode(value, seen) {
    if (value === undefined) return packed("Undefined", null);
    if (typeof value === "bigint") return packed("BigInt", String(value));
    if (typeof value === "number" && !Number.isFinite(value))
      return packed("Number", String(value));
    if (value === null || typeof value !== "object") return value;
    seen = seen || new WeakSet();
    if (seen.has(value))
      throw new Error(
        "A save contains circular references and cannot be exported safely.",
      );
    seen.add(value);
    try {
      if (value instanceof Date) return packed("Date", value.toISOString());
      if (value instanceof RegExp)
        return packed("RegExp", value.source, { flags: value.flags });
      if (value instanceof Blob)
        return packed(
          value instanceof File ? "File" : "Blob",
          base64(await value.arrayBuffer()),
          { mime: value.type, name: value.name, modified: value.lastModified },
        );
      if (value instanceof ArrayBuffer)
        return packed("ArrayBuffer", base64(value));
      if (ArrayBuffer.isView(value))
        return packed(
          "TypedArray",
          base64(
            value.buffer.slice(
              value.byteOffset,
              value.byteOffset + value.byteLength,
            ),
          ),
          { ctor: value.constructor.name },
        );
      if (Array.isArray(value)) {
        var array = [];
        for (var child of value) array.push(await encode(child, seen));
        return packed("Array", array);
      }
      if (value instanceof Map) {
        var entries = [];
        for (var entry of value)
          entries.push([
            await encode(entry[0], seen),
            await encode(entry[1], seen),
          ]);
        return packed("Map", entries);
      }
      if (value instanceof Set) {
        var members = [];
        for (var member of value) members.push(await encode(member, seen));
        return packed("Set", members);
      }
      var out = [];
      for (var key of Object.keys(value))
        out.push([key, await encode(value[key], seen)]);
      return packed("Object", out);
    } finally {
      seen.delete(value);
    }
  }

  function typed(name, bytes) {
    if (!TYPED.includes(name) || typeof globalThis[name] !== "function")
      throw new Error("Unsupported saved binary type: " + name);
    return new globalThis[name](bytes);
  }
  function decode(value, legacy) {
    if (!value || typeof value !== "object") return value;
    if (legacy) {
      if (value.__aetheris_type === "Blob")
        return new Blob([unbase64(value.data)], { type: value.mime || "" });
      if (value.__aetheris_type === "ArrayBuffer") return unbase64(value.data);
      if (value.__aetheris_type === "TypedArray")
        return typed(value.ctor, unbase64(value.data));
      if (Array.isArray(value))
        return value.map(function (v) {
          return decode(v, true);
        });
      return Object.fromEntries(
        Object.entries(value).map(function (entry) {
          return [entry[0], decode(entry[1], true)];
        }),
      );
    }
    switch (value.$aetheris) {
      case "Undefined":
        return undefined;
      case "BigInt":
        return BigInt(value.value);
      case "Number":
        return Number(value.value);
      case "Date":
        return new Date(value.value);
      case "RegExp":
        return new RegExp(value.value, value.flags);
      case "ArrayBuffer":
        return unbase64(value.value);
      case "TypedArray":
        return typed(value.ctor, unbase64(value.value));
      case "Blob":
        return new Blob([unbase64(value.value)], { type: value.mime || "" });
      case "File":
        return new File([unbase64(value.value)], value.name, {
          type: value.mime || "",
          lastModified: value.modified,
        });
      case "Array":
        return value.value.map(function (v) {
          return decode(v);
        });
      case "Map":
        return new Map(
          value.value.map(function (entry) {
            return [decode(entry[0]), decode(entry[1])];
          }),
        );
      case "Set":
        return new Set(
          value.value.map(function (v) {
            return decode(v);
          }),
        );
      case "Object":
        return Object.fromEntries(
          value.value.map(function (entry) {
            return [entry[0], decode(entry[1])];
          }),
        );
      default:
        throw new Error("Unknown backup value format.");
    }
  }

  function openDatabase(name, version, upgrade) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        finish(
          new Error(
            "Timed out opening " + name + ". Close other site tabs and retry.",
          ),
        );
      }, 5000);
      var req;
      function finish(error, db) {
        if (settled) {
          if (db) db.close();
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(db);
      }
      try {
        req = version ? indexedDB.open(name, version) : indexedDB.open(name);
        req.onupgradeneeded = function () {
          if (settled) {
            req.transaction.abort();
            return;
          }
          if (!upgrade) {
            req.transaction.abort();
            return;
          } // read: do not create phantom DBs
          try {
            upgrade(req.result, req.transaction);
          } catch (error) {
            req.transaction.abort();
            finish(error);
          }
        };
        req.onsuccess = function () {
          finish(null, req.result);
        };
        req.onerror = function () {
          finish(req.error || new Error("Could not open " + name));
        };
        req.onblocked = function () {
          finish(
            new Error(name + " is open in another tab. Close it and retry."),
          );
        };
      } catch (error) {
        finish(error);
      }
    });
  }

  async function listDatabases() {
    var known = Aetheris.readList("idbNames");
    var names;
    try {
      names = (await indexedDB.databases()).map(function (db) {
        return db.name;
      });
    } catch (_) {
      names = known.concat(["/idbfs", "/userfs", "localforage", "gameFilesDB"]);
    }
    return Array.from(new Set(known.concat(names))).filter(function (name) {
      return name && !isDownloadCacheDb(name);
    });
  }

  function isDownloadCacheDb(name) {
    return SKIP_DBS.has(name) || CACHE_DB_NAME.test(name);
  }

  // Rough in-memory size of a stored value: total bytes and the part that is
  // binary (Blob/ArrayBuffer/typed arrays). Used to classify downloaded
  // files and enforce the export budget.
  function measure(value, depth, seen, acc) {
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
        measure(k, depth + 1, seen, acc);
        measure(v, depth + 1, seen, acc);
      });
    } else if (value instanceof Set || Array.isArray(value)) {
      value.forEach(function (v) {
        measure(v, depth + 1, seen, acc);
      });
    } else {
      for (var key of Object.keys(value)) {
        acc.bytes += key.length;
        measure(value[key], depth + 1, seen, acc);
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

  // Read one bounded batch with a cursor instead of getAll(), so a huge
  // store is never fully materialized in memory at once.
  function readBatch(db, storeName, afterKey, hasAfter) {
    return new Promise(function (resolve, reject) {
      var result = { keys: [], values: [], bytes: 0, skipped: 0, done: true };
      var tx = db.transaction(storeName, "readonly");
      tx.oncomplete = function () {
        resolve(result);
      };
      tx.onerror = tx.onabort = function () {
        reject(tx.error || new Error("Could not read " + storeName));
      };
      var range = hasAfter ? IDBKeyRange.lowerBound(afterKey, true) : null;
      var req = tx.objectStore(storeName).openCursor(range);
      req.onsuccess = function () {
        var cursor = req.result;
        if (!cursor) return;
        result.lastKey = cursor.primaryKey;
        var size = measure(cursor.value);
        if (isDownloadRecord(cursor.primaryKey, size)) {
          result.skipped++;
        } else {
          result.keys.push(cursor.primaryKey);
          result.values.push(cursor.value);
          result.bytes += size.bytes;
        }
        if (
          result.values.length >= BATCH_RECORDS ||
          result.bytes >= BATCH_BYTES
        ) {
          result.done = false;
          return;
        }
        cursor.continue();
      };
    });
  }

  async function dumpDatabase(name, budget) {
    budget = budget || { bytes: 0, skipped: 0 };
    var db;
    try {
      db = await openDatabase(name);
    } catch (error) {
      if (error.name === "AbortError") return null;
      throw error;
    }
    try {
      var stores = Array.from(db.objectStoreNames);
      var out = { version: db.version, stores: Object.create(null) };
      if (!stores.length) return out;
      var schemaTx = db.transaction(stores, "readonly");
      stores.forEach(function (storeName) {
        var store = schemaTx.objectStore(storeName);
        out.stores[storeName] = {
          keyPath: store.keyPath,
          autoIncrement: store.autoIncrement,
          indexes: Array.from(store.indexNames).map(function (key) {
            var index = store.index(key);
            return {
              name: key,
              keyPath: index.keyPath,
              unique: index.unique,
              multiEntry: index.multiEntry,
            };
          }),
          keys: [],
          values: [],
        };
      });
      for (var storeName of stores) {
        var info = out.stores[storeName];
        var lastKey,
          hasLast = false;
        while (true) {
          var batch = await readBatch(db, storeName, lastKey, hasLast);
          budget.skipped += batch.skipped;
          budget.bytes += batch.bytes;
          if (budget.bytes > MAX_EXPORT_BYTES)
            throw new Error(
              "Save data in " +
                name +
                " is too large to export safely (over " +
                Math.round(MAX_EXPORT_BYTES / 1024 / 1024) +
                " MB). Use \u201cDelete downloaded games\u201d to free space, then retry.",
            );
          // No awaits inside an IDB transaction (especially on Safari):
          // encode only after the batch transaction has completed.
          for (var i = 0; i < batch.values.length; i++) {
            info.keys.push(await encode(batch.keys[i]));
            info.values.push(await encode(batch.values[i]));
            batch.values[i] = null;
          }
          await new Promise(function (r) {
            setTimeout(r, 0);
          });
          if (batch.done || batch.lastKey === undefined) break;
          lastKey = batch.lastKey;
          hasLast = true;
        }
      }
      return out;
    } finally {
      db.close();
    }
  }

  function localSnapshot() {
    var out = Object.create(null);
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      if (!SKIP_KEYS.has(key)) out[key] = localStorage.getItem(key);
    }
    return out;
  }

  window.exportdata = async function () {
    if (busy) return;
    setBusy(true);
    try {
      var header = {
        format: "aetheris-backup",
        version: 2,
        createdAt: new Date().toISOString(),
        localStorage: localSnapshot(),
      };
      // Build the file from per-database parts instead of one giant
      // JSON.stringify string, so peak memory stays near one database.
      var headerJson = JSON.stringify(header);
      var parts = [headerJson.slice(0, -1) + ',"indexedDB":{'];
      var budget = { bytes: 0, skipped: 0 };
      var first = true;
      for (var name of await listDatabases()) {
        status("Exporting " + name + "…");
        var dump = await dumpDatabase(name, budget);
        if (!dump) continue;
        parts.push(
          (first ? "" : ",") + JSON.stringify(name) + ":" + JSON.stringify(dump),
        );
        first = false;
        dump = null;
      }
      parts.push("}}");
      var blob = new Blob(parts, { type: "application/json" });
      parts = null;
      if (blob.size > 128 * 1024 * 1024)
        throw new Error("The backup exceeds the 128 MB safe import limit.");
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      downloadUrl = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = downloadUrl;
      link.download =
        "aetheris-" + new Date().toISOString().slice(0, 10) + ".json";
      link.className = "download-link library-more";
      link.textContent =
        "Download backup (" + (blob.size / 1024 / 1024).toFixed(2) + " MB)";
      status(
        "Backup ready. " +
          (budget.skipped
            ? "Skipped " +
              budget.skipped +
              " downloaded game file" +
              (budget.skipped === 1 ? "" : "s") +
              " (not saves). "
            : "") +
          "On iPad, tap the link or touch and hold to save it to Files. Keep backups private.",
      );
      document.getElementById("data-status").appendChild(link);
      if (
        !/iP(ad|hone|od)/.test(navigator.userAgent) &&
        !(navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
      )
        link.click();
    } catch (error) {
      status("Export failed: " + error.message, true);
    } finally {
      setBusy(false);
    }
  };

  function prepareBackup(data) {
    if (
      !data ||
      Array.isArray(data) ||
      typeof data !== "object" ||
      (!data.localStorage && !data.indexedDB)
    )
      throw new Error("This is not an Aetheris backup.");
    var legacy = data.format === undefined;
    if (!legacy && data.format !== "aetheris-backup")
      throw new Error("This is not an Aetheris backup.");
    if (!legacy && data.version !== 2)
      throw new Error("Unsupported backup version.");
    var settings = Object.create(null);
    if (data.localStorage) {
      if (
        Array.isArray(data.localStorage) ||
        typeof data.localStorage !== "object"
      )
        throw new Error("Invalid settings section.");
      for (var entry of Object.entries(data.localStorage)) {
        if (SKIP_KEYS.has(entry[0])) continue;
        if (typeof entry[1] !== "string")
          throw new Error("Invalid setting: " + entry[0]);
        if (entry[0] === "panicurl" && entry[1] && !Aetheris.httpUrl(entry[1]))
          throw new Error("The backup contains an invalid panic URL.");
        if (entry[0] === "tabIcon" && entry[1] && !Aetheris.httpUrl(entry[1]))
          throw new Error("The backup contains an invalid tab icon URL.");
        if (
          entry[0] === "aetheris-customBg" &&
          entry[1] &&
          !/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i.test(entry[1])
        )
          throw new Error("The backup contains an invalid background image.");
        settings[entry[0]] = entry[1];
      }
    }
    var databases = Object.create(null);
    if (data.indexedDB) {
      if (Array.isArray(data.indexedDB) || typeof data.indexedDB !== "object")
        throw new Error("Invalid database section.");
      for (var pair of Object.entries(data.indexedDB)) {
        if (SKIP_DBS.has(pair[0])) continue;
        var raw = pair[1],
          stores = legacy ? raw : raw.stores;
        if (!stores || typeof stores !== "object" || Array.isArray(stores))
          throw new Error("Invalid database: " + pair[0]);
        var prepared = {
          version: legacy ? 1 : raw.version,
          legacy: legacy,
          stores: Object.create(null),
        };
        if (!Number.isSafeInteger(prepared.version) || prepared.version < 1)
          throw new Error("Invalid database version.");
        if (prepared.version > MAX_DB_VERSION)
          throw new Error(
            "Database version in this backup is unreasonably high (max " +
              MAX_DB_VERSION +
              ").",
          );
        for (var storeName of Object.keys(stores)) {
          var store = stores[storeName];
          if (!store || typeof store !== "object")
            throw new Error("Invalid store: " + storeName);
          var values = Array.isArray(store) ? store : store.values;
          var keys = Array.isArray(store) ? null : store.keys;
          if (
            !Array.isArray(values) ||
            (keys && (!Array.isArray(keys) || keys.length !== values.length))
          )
            throw new Error("Invalid records in " + storeName);
          if (
            !legacy &&
            (!keys ||
              !own(store, "keyPath") ||
              typeof store.autoIncrement !== "boolean" ||
              !Array.isArray(store.indexes))
          )
            throw new Error("Missing store schema: " + storeName);
          prepared.stores[storeName] = {
            keyPath: store.keyPath,
            autoIncrement: store.autoIncrement,
            indexes: store.indexes || [],
            keys:
              keys &&
              keys.map(function (key) {
                return decode(key, legacy);
              }),
            values: values.map(function (value) {
              return decode(value, legacy);
            }),
          };
        }
        databases[pair[0]] = prepared;
      }
    }
    return { settings: settings, databases: databases };
  }

  async function restoreDatabase(name, saved) {
    var db;
    try {
      db = await openDatabase(name);
    } catch (error) {
      if (error.name !== "AbortError") throw error;
    }
    // Never jump straight to a backup-declared version: a version far ahead
    // of the database's own cannot be reopened by game code that calls
    // indexedDB.open(name, <fixed version>) and throws VersionError forever.
    var version = db
      ? Math.min(Math.max(db.version, saved.version), db.version + 1)
      : Math.min(saved.version, MAX_DB_VERSION);
    var needsUpgrade = !db || (db && db.version < version);
    var names = Object.keys(saved.stores);
    if (!names.length) {
      if (db) db.close();
      return;
    }
    try {
      if (
        saved.legacy &&
        (!db ||
          names.some(function (s) {
            return !db.objectStoreNames.contains(s);
          }))
      ) {
        throw new Error(
          "Legacy backup has no schema for " +
            name +
            ". Open the original game first, or create a new-format backup.",
        );
      }
      if (db) {
        var existing = names.filter(function (s) {
          return db.objectStoreNames.contains(s);
        });
        if (existing.length) {
          var tx = db.transaction(existing, "readonly");
          existing.forEach(function (s) {
            var store = tx.objectStore(s),
              schema = saved.stores[s];
            if (
              !saved.legacy &&
              (JSON.stringify(store.keyPath) !==
                JSON.stringify(schema.keyPath) ||
                store.autoIncrement !== schema.autoIncrement)
            ) {
              throw new Error(
                "Store schema differs for " +
                  name +
                  "/" +
                  s +
                  "; existing data was not cleared.",
              );
            }
            schema.indexes.forEach(function (index) {
              if (!store.indexNames.contains(index.name)) needsUpgrade = true;
              else {
                var current = store.index(index.name);
                if (
                  JSON.stringify(current.keyPath) !==
                    JSON.stringify(index.keyPath) ||
                  current.unique !== index.unique ||
                  current.multiEntry !== index.multiEntry
                )
                  throw new Error("Index schema differs for " + name + "/" + s);
              }
            });
          });
        }
        if (
          names.some(function (s) {
            return !db.objectStoreNames.contains(s);
          })
        )
          needsUpgrade = true;
      }
      if (needsUpgrade) {
        if (db) {
          version = Math.max(version, db.version + 1);
          db.close();
        }
        db = await openDatabase(name, version, function (database, tx) {
          names.forEach(function (s) {
            var schema = saved.stores[s];
            var store = database.objectStoreNames.contains(s)
              ? tx.objectStore(s)
              : database.createObjectStore(s, {
                  keyPath: schema.keyPath,
                  autoIncrement: schema.autoIncrement,
                });
            schema.indexes.forEach(function (index) {
              if (!store.indexNames.contains(index.name))
                store.createIndex(index.name, index.keyPath, {
                  unique: index.unique,
                  multiEntry: index.multiEntry,
                });
            });
          });
        });
      }
      await new Promise(function (resolve, reject) {
        var tx = db.transaction(names, "readwrite");
        tx.oncomplete = resolve; // request success is NOT transaction commit
        tx.onerror = tx.onabort = function () {
          reject(tx.error || new Error("Restore rolled back for " + name));
        };
        try {
          names.forEach(function (s) {
            var store = tx.objectStore(s),
              rows = saved.stores[s];
            store.clear();
            rows.values.forEach(function (value, i) {
              if (store.keyPath === null && rows.keys)
                store.put(value, rows.keys[i]);
              else store.put(value);
            });
          });
        } catch (error) {
          tx.abort();
          reject(error);
        }
      });
    } finally {
      if (db) db.close();
    }
  }

  window.importdata = async function (event) {
    var file = event.target.files[0];
    event.target.value = "";
    if (!file || busy) return;
    if (file.size > 128 * 1024 * 1024) {
      status("This backup exceeds the 128 MB safe import limit.", true);
      return;
    }
    setBusy(true);
    var restored = 0;
    try {
      status("Validating backup…");
      var data = prepareBackup(JSON.parse(await file.text()));
      if (
        !confirm(
          "Restore this backup? It will replace records in the included game databases and merge saved settings. Close other Aetheris/game tabs first. Chat sign-ins will not be imported.",
        )
      )
        return;
      for (var name of Object.keys(data.databases)) {
        status("Restoring " + name + "…");
        await restoreDatabase(name, data.databases[name]);
        restored++;
      }
      var previous = Object.create(null);
      try {
        for (var key of Object.keys(data.settings)) {
          previous[key] = localStorage.getItem(key);
          localStorage.setItem(key, data.settings[key]);
        }
      } catch (error) {
        for (var old of Object.keys(previous)) {
          try {
            if (previous[old] === null) localStorage.removeItem(old);
            else localStorage.setItem(old, previous[old]);
          } catch (_) {}
        }
        throw error;
      }
      status(
        "Import complete (" +
          restored +
          " databases). Reload the page to apply settings.",
      );
    } catch (error) {
      status(
        "Import stopped: " +
          error.message +
          (restored
            ? " " +
              restored +
              " earlier databases were already restored; import is not atomic across databases."
            : ""),
        true,
      );
    } finally {
      setBusy(false);
    }
  };
  window.addEventListener("pagehide", function () {
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  });
  // Exposed solely for local regression tests; never sent to a remote service.
  window.AetherisBackup = {
    encode: encode,
    decode: decode,
    prepare: prepareBackup,
    dump: dumpDatabase,
    restore: restoreDatabase,
  };
})();

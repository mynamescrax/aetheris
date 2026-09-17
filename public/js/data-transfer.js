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
  var SKIP_KEYS = new Set([
    "dmToken",
    "dmDeviceId",
    "dmUsername",
    "idbNames",
    "__popularGames",
    "__popularGames_ts",
  ]);
  // Wiping game saves is the inverse of a backup: delete every database
  // except the proxy/catalog/file caches (those hold no saves and would
  // only force multi-GB re-downloads), and every localStorage key except
  // site settings, favorites, and chat sessions. Per-game targeting is not
  // offered on purpose — Unity save folders are unlabeled hashes that
  // cannot be mapped back to titles, so anything narrower would silently
  // miss the broken game.
  var WIPE_KEEP_DBS = new Set([
    "$scramjet",
    "__scramjet_controller",
    "scramjet-config",
    "aetheris-games-cache",
    "UnityCache",
    "CachedXMLHttpRequests",
  ]);
  var WIPE_KEEP_KEYS = new Set([
    "tabName",
    "tabIcon",
    "aetheris-theme",
    "theme",
    "panickey",
    "panicurl",
    "proxyTransport",
    "spoofDesktopUA",
    "aetheris-customBg",
    "oskEnabled",
    "performanceMode",
    "settingsTab",
    "backupReminderLast",
    "favoritedGames",
    "favoritedApps",
    "movieSourceIdx",
    "dmToken",
    "dmDeviceId",
    "dmUsername",
    "dmAutoLogin",
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
      return name && !SKIP_DBS.has(name);
    });
  }

  async function listWipeDatabases() {
    var known = [];
    try {
      known = Aetheris.readList("idbNames");
    } catch (_) {}
    var names = known;
    try {
      names = known.concat(
        (await indexedDB.databases()).map(function (db) {
          return db.name;
        }),
      );
    } catch (_) {}
    return Array.from(new Set(names)).filter(function (name) {
      return name && !WIPE_KEEP_DBS.has(name);
    });
  }

  function deleteDatabaseByName(name) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        finish(
          new Error(
            "Timed out deleting " + name + ". Close other site tabs and retry.",
          ),
        );
      }, 8000);
      function finish(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      }
      try {
        var req = indexedDB.deleteDatabase(name);
        req.onsuccess = function () {
          finish();
        };
        req.onerror = function () {
          finish(req.error || new Error("Could not delete " + name));
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

  // Deletes every game-save database and game localStorage key, keeping
  // site settings/favorites/sessions. Fails loudly (names the database)
  // instead of half-wiping: game tabs must be closed first, which the
  // settings page confirms twice.
  async function wipeGameSaves(progress) {
    function note(stage) {
      try {
        if (typeof progress === "function") progress(stage);
      } catch (_) {}
    }
    var wipedDbs = 0;
    var wipedKeys = 0;
    note("Finding game databases…");
    var names = await listWipeDatabases();
    for (var n = 0; n < names.length; n++) {
      note("Deleting " + names[n] + "…");
      await deleteDatabaseByName(names[n]);
      wipedDbs++;
    }
    note("Clearing game storage…");
    var doomed = [];
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      if (key && !WIPE_KEEP_KEYS.has(key)) doomed.push(key);
    }
    doomed.forEach(function (key) {
      try {
        localStorage.removeItem(key);
        wipedKeys++;
      } catch (_) {}
    });
    try {
      sessionStorage.clear();
    } catch (_) {}
    return { databases: wipedDbs, keys: wipedKeys };
  }

  // Tracked per-game wipe: instead of guessing which storage belongs to a
  // game (Unity save folders are unlabeled hashes), snapshot everything,
  // let the user play that one game, diff, and wipe exactly what moved —
  // expanded to the full save folder so untouched old saves go too. Only
  // deletions by key: databases themselves are never deleted, so there is
  // no version-upgrade or blocked-connection hazard anywhere in this flow.
  var tracking = null;

  function hashAdd(h, text) {
    for (var i = 0; i < text.length; i++)
      h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
    return h;
  }

  function hashView(h, view) {
    h = hashAdd(h, "V" + view.byteLength + ":");
    var step = Math.max(1, Math.floor(view.byteLength / 256));
    for (var i = 0; i < view.byteLength; i += step)
      h = Math.imul(h ^ view[i], 0x01000193) >>> 0;
    return hashAdd(h, ";");
  }

  function hashValue(h, value, depth) {
    if (depth > 8) return hashAdd(h, "~;");
    if (value === null || value === undefined) return hashAdd(h, "nil;");
    var type = typeof value;
    if (type === "number" || type === "boolean" || type === "bigint")
      return hashAdd(h, type[0] + String(value) + ";");
    if (type === "string") return hashAdd(h, "s" + value.length + ":" + value + ";");
    var tag = Object.prototype.toString.call(value);
    if (tag === "[object Date]")
      return hashAdd(h, "D" + (isNaN(value) ? "nan" : value.getTime()) + ";");
    if (tag === "[object ArrayBuffer]") return hashView(h, new Uint8Array(value));
    if (ArrayBuffer.isView(value)) return hashView(h, value);
    if (tag === "[object Blob]")
      return hashAdd(h, "blob" + value.size + ":" + value.type + ";");
    if (Array.isArray(value)) {
      h = hashAdd(h, "A" + value.length + "[");
      for (var i = 0; i < value.length; i++)
        h = hashValue(h, value[i], depth + 1);
      return hashAdd(h, "];");
    }
    var keys = [];
    try {
      keys = Object.keys(value).sort();
    } catch (_) {
      return hashAdd(h, "?" + String(value).slice(0, 64) + ";");
    }
    h = hashAdd(h, "O" + keys.length + "{");
    for (var k = 0; k < keys.length; k++)
      h = hashValue(hashAdd(h, keys[k] + "="), value[keys[k]], depth + 1);
    return hashAdd(h, "};");
  }

  function digestOf(value) {
    return hashValue(0x811c9dc5, value, 0).toString(16);
  }

  function stableKey(key) {
    var tag = Object.prototype.toString.call(key);
    var body = null;
    try {
      body = JSON.stringify(key);
    } catch (_) {}
    if (body === undefined || body === null) body = String(key);
    return tag + "|" + body;
  }

  function readStoreDigests(db, storeName) {
    return new Promise(function (resolve, reject) {
      var tx;
      try {
        tx = db.transaction(storeName, "readonly");
      } catch (error) {
        reject(error);
        return;
      }
      var out = [];
      tx.oncomplete = function () {
        resolve(out);
      };
      tx.onerror = tx.onabort = function () {
        reject(tx.error || new Error("Could not read " + storeName));
      };
      var cursor;
      try {
        cursor = tx.objectStore(storeName).openCursor();
      } catch (error) {
        reject(error);
        return;
      }
      cursor.onsuccess = function () {
        var entry = cursor.result;
        if (!entry) return;
        var digest;
        try {
          digest = digestOf(entry.value);
        } catch (_) {
          digest = "unreadable";
        }
        out.push({ key: entry.primaryKey, digest: digest });
        try {
          entry.continue();
        } catch (error) {
          reject(error);
        }
      };
      cursor.onerror = function () {
        reject(cursor.error || new Error("Could not read " + storeName));
      };
    });
  }

  async function captureState() {
    var snap = { dbs: Object.create(null), ls: Object.create(null) };
    var names = await listDatabases();
    for (var n = 0; n < names.length; n++) {
      var db = null;
      try {
        db = await openDatabase(names[n]);
      } catch (error) {
        if (error && error.name === "AbortError") continue;
        throw error;
      }
      if (!db) continue;
      try {
        var per = (snap.dbs[names[n]] = Object.create(null));
        var stores = Array.from(db.objectStoreNames);
        for (var s = 0; s < stores.length; s++)
          per[stores[s]] = await readStoreDigests(db, stores[s]);
      } finally {
        db.close();
      }
    }
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      if (!key) continue;
      try {
        snap.ls[key] = digestOf(localStorage.getItem(key));
      } catch (_) {}
    }
    return snap;
  }

  function subtreeRoot(key) {
    if (typeof key !== "string" || key.charAt(0) !== "/") return null;
    var m = /^\/idbfs\/[^/]+\//.exec(key);
    if (m) return m[0];
    m = /^\/userfs\/godot\/app_userdata\/[^/]+\//.exec(key);
    if (m) return m[0];
    m = /^\/userfs\/[^/]+\//.exec(key);
    if (m) return m[0];
    return null;
  }

  function commonPrefix(keys) {
    if (!keys.length) return null;
    var prefix = keys[0];
    for (var i = 1; i < keys.length; i++) {
      while (keys[i].indexOf(prefix) !== 0) {
        prefix = prefix.slice(0, -1);
        if (!prefix) return null;
      }
    }
    var cut = Math.max(
      prefix.lastIndexOf("@"),
      prefix.lastIndexOf("_"),
      prefix.lastIndexOf(":"),
      prefix.lastIndexOf("-"),
      prefix.lastIndexOf("."),
      prefix.lastIndexOf("/"),
    );
    prefix = cut > 0 ? prefix.slice(0, cut + 1) : "";
    return prefix.length >= 4 ? prefix : null;
  }

  async function trackStart(progress) {
    function note(stage) {
      try {
        if (typeof progress === "function") progress(stage);
      } catch (_) {}
    }
    note("Snapshotting storage…");
    var snap = await captureState();
    var stores = 0;
    Object.keys(snap.dbs).forEach(function (name) {
      stores += Object.keys(snap.dbs[name]).length;
    });
    tracking = { snap: snap, footprint: null };
    return {
      databases: Object.keys(snap.dbs).length,
      stores: stores,
      keys: Object.keys(snap.ls).length,
    };
  }

  async function trackDiff(progress) {
    function note(stage) {
      try {
        if (typeof progress === "function") progress(stage);
      } catch (_) {}
    }
    if (!tracking)
      throw new Error("Press “Track game data” first, play the game, then come back.");
    note("Comparing storage…");
    var before = tracking.snap;
    var after = await captureState();
    var footprint = {
      records: [],
      lsKeys: [],
      subtrees: [],
      lsPrefix: null,
    };
    var seenRoots = Object.create(null);
    Object.keys(after.dbs).forEach(function (name) {
      Object.keys(after.dbs[name]).forEach(function (store) {
        var oldRows = Object.create(null);
        if (before.dbs[name] && before.dbs[name][store])
          before.dbs[name][store].forEach(function (row) {
            oldRows[stableKey(row.key)] = row;
          });
        after.dbs[name][store].forEach(function (row) {
          var skey = stableKey(row.key);
          var old = oldRows[skey];
          if (!old || old.digest !== row.digest) {
            footprint.records.push({ db: name, store: store, key: row.key });
            var root = subtreeRoot(row.key);
            if (root && !seenRoots[name + "\n" + store + "\n" + root]) {
              seenRoots[name + "\n" + store + "\n" + root] = true;
              footprint.subtrees.push({ db: name, store: store, root: root });
            }
          }
        });
      });
    });
    Object.keys(after.ls).forEach(function (key) {
      if (!(key in before.ls) || before.ls[key] !== after.ls[key])
        footprint.lsKeys.push(key);
    });
    footprint.lsPrefix = commonPrefix(footprint.lsKeys);
    tracking.footprint = footprint;
    return {
      databases: Object.keys(after.dbs).length,
      records: footprint.records.length,
      keys: footprint.lsKeys.length,
      subtrees: footprint.subtrees.map(function (s) {
        return s.root;
      }),
      lsPrefix: footprint.lsPrefix,
    };
  }

  function deleteStoreKeys(dbName, storeName, keys) {
    return new Promise(function (resolve, reject) {
      var db = null;
      if (!keys.length) {
        resolve(0);
        return;
      }
      openDatabase(dbName).then(
        function (opened) {
          db = opened;
          var tx;
          try {
            tx = db.transaction(storeName, "readwrite");
          } catch (error) {
            db.close();
            reject(error);
            return;
          }
          var done = 0;
          tx.oncomplete = function () {
            db.close();
            resolve(done);
          };
          tx.onerror = tx.onabort = function () {
            db.close();
            reject(tx.error || new Error("Wipe rolled back for " + dbName));
          };
          var store = tx.objectStore(storeName);
          keys.forEach(function (key) {
            var req;
            try {
              req = store.delete(key);
            } catch (error) {
              tx.abort();
              reject(error);
              return;
            }
            req.onsuccess = function () {
              done++;
            };
            req.onerror = function () {
              tx.abort();
              reject(req.error || new Error("Could not wipe " + dbName));
            };
          });
        },
        function (error) {
          if (error && error.name === "AbortError") resolve(0);
          else reject(error);
        },
      );
    });
  }

  async function keysWithPrefix(dbName, storeName, prefix) {
    var db = null;
    try {
      db = await openDatabase(dbName);
    } catch (error) {
      if (error && error.name === "AbortError") return [];
      throw error;
    }
    if (!db) return [];
    try {
      var rows = await readStoreDigests(db, storeName);
      // Also match the folder record itself ("…/abc", no trailing slash),
      // not just its children ("…/abc/…").
      var bare =
        prefix.charAt(prefix.length - 1) === "/"
          ? prefix.slice(0, -1)
          : prefix;
      return rows
        .filter(function (row) {
          return (
            typeof row.key === "string" &&
            (row.key === bare || row.key.indexOf(prefix) === 0)
          );
        })
        .map(function (row) {
          return row.key;
        });
    } finally {
      db.close();
    }
  }

  async function trackWipe(progress) {
    function note(stage) {
      try {
        if (typeof progress === "function") progress(stage);
      } catch (_) {}
    }
    var footprint =
      tracking && tracking.footprint ? tracking.footprint : null;
    if (!footprint)
      throw new Error("Press “Show what changed” first so there is something to wipe.");
    if (
      !footprint.records.length &&
      !footprint.lsKeys.length &&
      !footprint.subtrees.length
    )
      throw new Error("The tracked session touched nothing — nothing to wipe.");
    var wipedRecords = 0;
    var wipedKeys = 0;
    var i, s;
    for (i = 0; i < footprint.subtrees.length; i++) {
      s = footprint.subtrees[i];
      note("Wiping " + s.root + "…");
      wipedRecords += await deleteStoreKeys(
        s.db,
        s.store,
        await keysWithPrefix(s.db, s.store, s.root),
      );
    }
    var direct = Object.create(null);
    footprint.records.forEach(function (row) {
      var id = row.db + "\n" + row.store;
      (direct[id] = direct[id] || { db: row.db, store: row.store, keys: [] }).keys.push(
        row.key,
      );
    });
    var groupIds = Object.keys(direct);
    for (i = 0; i < groupIds.length; i++) {
      var group = direct[groupIds[i]];
      var roots = footprint.subtrees
        .filter(function (st) {
          return st.db === group.db && st.store === group.store;
        })
        .map(function (st) {
          return st.root;
        });
      var remaining = group.keys.filter(function (key) {
        return !roots.some(function (root) {
          return typeof key === "string" && key.indexOf(root) === 0;
        });
      });
      if (!remaining.length) continue;
      note("Wiping " + group.db + "…");
      wipedRecords += await deleteStoreKeys(group.db, group.store, remaining);
    }
    var doomed = footprint.lsKeys.slice();
    if (footprint.lsPrefix) {
      for (var k = 0; k < localStorage.length; k++) {
        var key = localStorage.key(k);
        if (
          key &&
          key.indexOf(footprint.lsPrefix) === 0 &&
          doomed.indexOf(key) === -1
        )
          doomed.push(key);
      }
    }
    note("Clearing stored values…");
    doomed.forEach(function (key) {
      if (WIPE_KEEP_KEYS.has(key)) return;
      try {
        localStorage.removeItem(key);
        wipedKeys++;
      } catch (_) {}
    });
    tracking = null;
    return {
      records: wipedRecords,
      keys: wipedKeys,
      subtrees: footprint.subtrees.map(function (x) {
        return x.root;
      }),
    };
  }

  async function dumpDatabase(name) {
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
      await new Promise(function (resolve, reject) {
        var tx = db.transaction(stores, "readonly");
        tx.oncomplete = resolve;
        tx.onerror = tx.onabort = function () {
          reject(tx.error || new Error("Could not read " + name));
        };
        stores.forEach(function (name) {
          var store = tx.objectStore(name);
          var info = (out.stores[name] = {
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
          });
          store.getAllKeys().onsuccess = function (event) {
            info.keys = event.target.result;
          };
          store.getAll().onsuccess = function (event) {
            info.values = event.target.result;
          };
        });
      });
      // No awaits inside an IDB transaction (especially important on Safari).
      for (var storeName of stores) {
        var info = out.stores[storeName];
        for (var i = 0; i < info.values.length; i++) {
          info.keys[i] = await encode(info.keys[i]);
          info.values[i] = await encode(info.values[i]);
          if (i % 250 === 0)
            await new Promise(function (r) {
              setTimeout(r, 0);
            });
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
      var data = {
        format: "aetheris-backup",
        version: 2,
        createdAt: new Date().toISOString(),
        localStorage: localSnapshot(),
        indexedDB: Object.create(null),
      };
      for (var name of await listDatabases()) {
        status("Exporting " + name + "…");
        var dump = await dumpDatabase(name);
        if (dump) data.indexedDB[name] = dump;
      }
      var blob = new Blob([JSON.stringify(data)], { type: "application/json" });
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
        "Backup ready. On iPad, tap the link or touch and hold to save it to Files. Keep backups private.",
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
    var legacy = data.format !== "aetheris-backup";
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
    var version = Math.max(db ? db.version : 1, saved.version);
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
    wipe: wipeGameSaves,
    trackStart: trackStart,
    trackDiff: trackDiff,
    trackWipe: trackWipe,
  };
})();

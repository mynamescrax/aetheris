window.games = window.games || [];
window.gamesloaded = false;
window.gamesLoadErrors = [];

var gamesources = [
  "assets/data/velara.json",
  "assets/data/gnmath.json",
  "assets/data/petezah.json",
  "assets/data/truffled.json",
  "assets/data/aetheris.json",
  "assets/data/igroutka.json",
];

function slugify(str) {
  return String(str || "")
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizegame(rawgame, fallbacksource) {
  if (!rawgame || typeof rawgame !== "object") return null;

  var game = {};
  var keys = Object.keys(rawgame);
  for (var i = 0; i < keys.length; i++) game[keys[i]] = rawgame[keys[i]];

  if (!game.title && game.name) game.title = game.name;
  if (!game.image && game.img) game.image = game.img;

  if (!game.source) game.source = fallbacksource || "unknown";

  if (Array.isArray(game.tags))
    game.tags = game.tags.filter(function (tag) {
      return (
        typeof tag !== "string" || tag.toLowerCase() !== "epstein"
      );
    });

  if (game.id === undefined || game.id === null || game.id === "") {
    game.id = game.url || game.html || game.source + "-" + slugify(game.title);
  } else {
    game.id = String(game.id);
  }

  return game;
}

// an hour: the catalog changes rarely, and the SWR cache headers on
// /assets/data/* keep the files themselves fresh server-side. the old 5
// minutes meant most return visits re-downloaded and re-parsed ~5.5MB.
var GAMES_CACHE_TTL = 60 * 60 * 1000;
var GAMES_IDB = "aetheris-games-cache";
var GAMES_STORE = "cache";
var GAMES_IDB_KEY = "games";

function opengamecache() {
  return new Promise(function (resolve) {
    var done = false;
    var timer = setTimeout(function () {
      finish(null);
    }, 2000);
    function finish(db) {
      if (done) {
        if (db) db.close();
        return;
      }
      done = true;
      clearTimeout(timer);
      resolve(db);
    }
    try {
      var req = indexedDB.open(GAMES_IDB, 1);
      req.onupgradeneeded = function (e) {
        if (!e.target.result.objectStoreNames.contains(GAMES_STORE))
          e.target.result.createObjectStore(GAMES_STORE);
      };
      req.onsuccess = function (e) {
        finish(e.target.result);
      };
      req.onerror = req.onblocked = function () {
        finish(null);
      };
    } catch (e) {
      finish(null);
    }
  });
}

async function getcachedgames() {
  var db = await opengamecache();
  if (!db) return null;
  return new Promise(function (resolve) {
    var settled = false,
      tx;
    var timer = setTimeout(function () {
      try {
        if (tx) tx.abort();
      } catch (_) {}
      finish(null);
    }, 2000);
    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      db.close();
      resolve(value);
    }
    try {
      tx = db.transaction(GAMES_STORE, "readonly");
      var get = tx.objectStore(GAMES_STORE).get(GAMES_IDB_KEY);
      get.onsuccess = function () {
        var v = get.result;
        finish(
          v &&
            v.schema === 4 &&
            Array.isArray(v.data) &&
            v.data.length &&
            Date.now() - v.ts >= 0 &&
            Date.now() - v.ts < GAMES_CACHE_TTL
            ? v.data
            : null,
        );
      };
      get.onerror =
        tx.onerror =
        tx.onabort =
          function () {
            finish(null);
          };
    } catch (e) {
      finish(null);
    }
  });
}

async function setcachedgames(data) {
  var db = await opengamecache();
  if (!db) return;
  try {
    var tx = db.transaction(GAMES_STORE, "readwrite");
    tx.objectStore(GAMES_STORE).put(
      { schema: 4, ts: Date.now(), data: data },
      GAMES_IDB_KEY,
    );
    tx.oncomplete = function () {
      db.close();
    };
    tx.onerror = function () {
      db.close();
    };
  } catch (e) {
    db.close();
  }
}

async function fetchjson(url) {
  var controller = new AbortController();
  var timer = setTimeout(function () {
    controller.abort();
  }, 8000);
  try {
    var res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function loadgamesdata() {
  var cached = await getcachedgames();
  if (cached) {
    window.games = cached;
    window.gamesloaded = true;
    window.dispatchEvent(new Event("gamesloaded"));
    return window.games;
  }

  var results = await Promise.allSettled(
    gamesources.map(function (file) {
      var sourcename = file
        .split("/")
        .pop()
        .replace(/\.json$/i, "");
      return fetchjson(file).then(function (data) {
        if (Array.isArray(data)) {
          return data
            .map(function (g) {
              return normalizegame(g, sourcename);
            })
            .filter(Boolean);
        } else if (data && Array.isArray(data.games)) {
          return data.games
            .map(function (g) {
              return normalizegame(g, sourcename);
            })
            .filter(Boolean);
        } else {
          throw new Error("Unexpected catalog format: " + file);
        }
      });
    }),
  );

  var merged = [];
  for (var i = 0; i < results.length; i++) {
    if (results[i].status === "fulfilled") {
      merged = merged.concat(results[i].value);
    } else {
      window.gamesLoadErrors.push(gamesources[i]);
      console.error("Failed to load games source:", results[i].reason);
    }
  }

  merged.sort(function (a, b) {
    var sourcecompare = (a.source || "").localeCompare(b.source || "");
    if (sourcecompare !== 0) return sourcecompare;
    return (a.title || "").localeCompare(b.title || "");
  });

  // sources are merged sorted by name, so aetheris ids come first and keep
  // their raw form (the server's play-count allowlist matches them verbatim,
  // and load links resolve to the earlier source — same as before this
  // dedupe existed). a duplicate id arriving from a later source is re-keyed
  // with its source prefix instead of silently shadowing the earlier game;
  // rawid preserves the original so pre-dedupe favorites still match.
  var seenids = new Set();
  merged.forEach(function (g) {
    var key = String(g.id);
    if (seenids.has(key)) {
      g.rawid = key;
      var base = g.source + ":" + key;
      key = base;
      var suffix = 2;
      while (seenids.has(key)) key = base + ":" + suffix++;
      g.id = key;
    }
    seenids.add(key);
  });

  window.games = merged;
  window.gamesloaded = true;
  // A temporarily failed source must not vanish from the library for an hour.
  if (merged.length && !window.gamesLoadErrors.length) setcachedgames(merged);

  window.dispatchEvent(new Event("gamesloaded"));

  return window.games;
}

window.gamesready = window.gamesready || loadgamesdata();

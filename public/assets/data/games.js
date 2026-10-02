window.games = window.games || [];
window.gamesloaded = false;
window.gamesLoading = false;
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
            v.schema === 6 &&
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
      { schema: 6, ts: Date.now(), data: data },
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

function mergegames(lists) {
  var merged = [];
  for (var i = 0; i < lists.length; i++)
    if (lists[i]) merged = merged.concat(lists[i]);

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

  return merged;
}

var gamelistbyload = new Array(gamesources.length);
var gameloadpromises = new Array(gamesources.length);
// igroutka is ~4.5MB and most visitors never open that source, so the games
// grid defers it until the source is actually selected. The player page sets
// window.gamesLoadAll before this script runs because deep links can point
// at any source.
var gamessourcesdeferred = window.gamesLoadAll
  ? []
  : ["assets/data/igroutka.json"];

function gamessourcename(file) {
  return file
    .split("/")
    .pop()
    .replace(/\.json$/i, "");
}

function updategamesloading() {
  window.gamesLoading = gameloadpromises.some(function (p) {
    return !!p;
  });
}

// Publish each catalog as it arrives instead of leaving the library blank
// until the slowest source finishes downloading.
function publishgames() {
  window.games = mergegames(gamelistbyload);
  window.dispatchEvent(new Event("gamesupdated"));
}

function maybecachegames() {
  var complete = gamelistbyload.every(function (list) {
    return !!list;
  });
  if (
    complete &&
    !window.gamesLoadErrors.length &&
    window.games &&
    window.games.length
  )
    setcachedgames(window.games);
}

function loadgamesource(file, index) {
  if (gamelistbyload[index]) return Promise.resolve(gamelistbyload[index]);
  if (gameloadpromises[index]) return gameloadpromises[index];

  var sourcename = gamessourcename(file);
  var promise = fetchjson(file)
    .then(function (data) {
      var list;
      if (Array.isArray(data)) {
        list = data
          .map(function (g) {
            return normalizegame(g, sourcename);
          })
          .filter(Boolean);
      } else if (data && Array.isArray(data.games)) {
        list = data.games
          .map(function (g) {
            return normalizegame(g, sourcename);
          })
          .filter(Boolean);
      } else {
        throw new Error("Unexpected catalog format: " + file);
      }
      gamelistbyload[index] = list;
      var errorindex = window.gamesLoadErrors.indexOf(file);
      if (errorindex !== -1) window.gamesLoadErrors.splice(errorindex, 1);
      publishgames();
      maybecachegames();
      return list;
    })
    .catch(function (reason) {
      if (window.gamesLoadErrors.indexOf(file) === -1)
        window.gamesLoadErrors.push(file);
      console.error("Failed to load games source:", reason);
      throw reason;
    })
    .finally(function () {
      gameloadpromises[index] = null;
      updategamesloading();
    });

  gameloadpromises[index] = promise;
  updategamesloading();
  return promise;
}

async function loadgamesdata() {
  var cached = await getcachedgames();
  if (cached) {
    window.games = cached;
    window.gamesloaded = true;
    window.dispatchEvent(new Event("gamesloaded"));
    return window.games;
  }

  var initial = [];
  gamesources.forEach(function (file, index) {
    if (gamessourcesdeferred.indexOf(file) === -1)
      initial.push(
        loadgamesource(file, index).catch(function () {
          // errors are recorded in window.gamesLoadErrors
        }),
      );
  });
  await Promise.all(initial);

  window.gamesloaded = true;
  window.dispatchEvent(new Event("gamesloaded"));
  return window.games;
}

// Load one source by its short name ("igroutka", "velara", …). Resolves to
// null for unknown names; rejections are swallowed here because the failure
// is already recorded in window.gamesLoadErrors for the retry UI.
window.gamesloadsource = function (name) {
  var index = -1;
  for (var i = 0; i < gamesources.length; i++)
    if (gamessourcename(gamesources[i]) === String(name)) {
      index = i;
      break;
    }
  if (index === -1) return Promise.resolve(null);
  return loadgamesource(gamesources[index], index).catch(function () {
    return null;
  });
};

window.gamesloadall = function () {
  return Promise.all(
    gamesources.map(function (file, index) {
      return loadgamesource(file, index).catch(function () {
        return null;
      });
    }),
  );
};

window.gamesretryfailed = function () {
  var failed = [];
  gamesources.forEach(function (file, index) {
    if (!gamelistbyload[index] && window.gamesLoadErrors.indexOf(file) !== -1)
      failed.push(window.gamesloadsource(gamessourcename(file)));
  });
  return Promise.all(failed);
};

window.gameshasloaded = function (name) {
  for (var i = 0; i < gamesources.length; i++)
    if (gamessourcename(gamesources[i]) === String(name))
      return !!gamelistbyload[i];
  return false;
};

window.gamesready = window.gamesready || loadgamesdata();

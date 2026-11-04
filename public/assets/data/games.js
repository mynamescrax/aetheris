window.games = window.games || [];
window.gamesloaded = false;
window.gamesLoading = false;
window.gamesLoadErrors = [];

// Live catalogs. aetheris is our own snapshot; every other provider is
// relayed by the server through /api/games/catalog/:source (the providers
// mostly send no CORS headers, so the browser cannot read them). A merged list
// is reused from IndexedDB for up to an hour, so a new provider listing shows
// up on the next visit after that, not instantly. Adding a provider means one
// entry here and its mapping function below — nothing to keep in sync by hand.
var gamesources = [
  { name: "aetheris", url: "assets/data/aetheris.json", map: passthroughcatalog },
  { name: "gnmath", url: "/api/games/catalog/gnmath", map: gnmathcatalog },
  { name: "truffled", url: "/api/games/catalog/truffled", map: truffledcatalog },
  { name: "velara", url: "/api/games/catalog/velara", map: velaracatalog },
  { name: "petezah", url: "/api/games/catalog/petezah", map: petezahcatalog },
  { name: "selenite", url: "/api/games/catalog/selenite", map: selenitecatalog },
];

// Try order inside one game: our own catalog first, then the providers in the
// order the player falls back through. Merging and the player share this, so a
// game keeps the same primary source whatever order the catalogs arrive in.
var gamesourcepriority = [
  "aetheris",
  "gnmath",
  "truffled",
  "velara",
  "petezah",
  "selenite",
];

function gamesourceorder(name) {
  var preferred = gamesourcepriority.indexOf(name);
  if (preferred !== -1) return preferred;
  for (var i = 0; i < gamesources.length; i++)
    if (gamesources[i].name === name)
      return gamesourcepriority.length + i;
  return 99;
}

function absoluteurl(value, base) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    var url = new URL(value, base);
    return /^https?:$/.test(url.protocol) ? url.href : "";
  } catch (e) {
    return "";
  }
}

// gn-math's catalog ships placeholders instead of absolute URLs.
var GN_MATH_HTML = "https://gn-math.github.io/html";
var GN_MATH_COVERS = "https://cdn.jsdelivr.net/gh/freebuisness/covers@main";

function fillgnmath(value) {
  return String(value || "")
    .replace(/\{HTML_URL\}/g, GN_MATH_HTML)
    .replace(/\{COVER_URL\}/g, GN_MATH_COVERS)
    .replace(/\{[A-Z_]+\}/g, "");
}

function gnmathcatalog(raw) {
  // id -1 is their "suggest games" discord promo, not a game.
  if (!raw || raw.id === -1) return null;
  var title = raw.name || raw.title;
  if (!title || /^\[!\]/.test(String(title))) return null;
  return {
    title: title,
    url: absoluteurl(fillgnmath(raw.url || raw.html), "https://gn-math.github.io/"),
    image: absoluteurl(fillgnmath(raw.cover || raw.image), "https://gn-math.github.io/"),
  };
}

function truffledcatalog(raw) {
  if (!raw) return null;
  var title = raw.name || raw.title;
  if (!title) return null;
  return {
    title: title,
    url: absoluteurl(raw.url || raw.location || raw.html, "https://truffled.lol/"),
    image: absoluteurl(
      raw.thumbnail || raw.image || raw.img,
      "https://truffled.lol/",
    ),
  };
}

function velaracatalog(raw) {
  if (!raw) return null;
  var title = raw.title || raw.name;
  if (!title) return null;
  return {
    title: title,
    url: absoluteurl(raw.location || raw.url || raw.html, "https://velara.my/"),
    image: absoluteurl(raw.image || raw.img, "https://velara.my/"),
  };
}

function petezahcatalog(raw) {
  if (!raw) return null;
  var title = raw.label || raw.title || raw.name;
  if (!title) return null;

  // Their catalog points at /iframe.html?url=<game>, a wrapper page. Play the
  // game itself instead of nesting their wrapper inside the proxy.
  var target = String(raw.url || "");
  var wrapped = /[?&]url=([^&]+)/.exec(target);
  if (wrapped) {
    try {
      target = decodeURIComponent(wrapped[1]);
    } catch (e) {
      target = wrapped[1];
    }
  }
  // /!!/<url> is their bot-protected passthrough: it answers with a Cloudflare
  // challenge instead of the game, so play the target itself. Their catalog
  // writes it relative (/!!/<url>, often behind /iframe.html?url=).
  var rawpassthrough =
    /^(?:https?:\/\/petezahgames\.com)?\/!!\/(.+)$/i.exec(target);
  if (rawpassthrough) {
    var passthroughurl = rawpassthrough[1];
    try {
      passthroughurl = decodeURIComponent(passthroughurl);
    } catch (e) {}
    if (/^https?:\/\//i.test(passthroughurl)) target = passthroughurl;
  }
  var url = absoluteurl(target, "https://petezahgames.com/");
  // The list also carries request forms and discord invites.
  if (!url || /^https?:\/\/(docs\.google\.com|discord\.(gg|com))\//i.test(url))
    return null;

  return {
    title: title,
    url: url,
    image: absoluteurl(
      raw.imageUrl || raw.image || raw.img,
      "https://petezahgames.com/",
    ),
    tags: Array.isArray(raw.categories) ? raw.categories.slice() : [],
  };
}

// Selenite lists games as an object keyed by id with no URL: the playable copy
// is /resources/semag/<directory>/index.html and the cover sits beside it.
function selenitecatalog(raw) {
  if (!raw) return null;
  var title = raw.name || raw.title;
  if (!title || !raw.directory) return null;
  var dir = String(raw.directory)
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  var base = "https://selenite.cc/resources/semag/" + dir + "/";
  // Encode each segment: an image can live in a subdirectory, and encoding the
  // separator would turn "img/gd.webp" into a request for "img%2Fgd.webp".
  var imagepath = raw.image
    ? String(raw.image)
        .split("/")
        .map(encodeURIComponent)
        .join("/")
    : "";
  return {
    title: title,
    url: base + "index.html",
    image: imagepath ? base + imagepath : "",
    tags: Array.isArray(raw.tags) ? raw.tags.slice() : [],
  };
}

function passthroughcatalog(raw) {
  return raw;
}

function slugify(str) {
  return String(str || "")
    .toLowerCase()
    .trim()
    .replace(/['\"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// truffled appends the publisher to some titles ("Academytale, Webport"),
// which otherwise reads as a different game to the title dedupe.
function cleantitle(value) {
  return String(value || "")
    .replace(/,\s*Webport\s*$/i, "")
    .trim();
}

function normalizegame(rawgame, fallbacksource) {
  if (!rawgame || typeof rawgame !== "object") return null;

  var game = {};
  var keys = Object.keys(rawgame);
  for (var i = 0; i < keys.length; i++) game[keys[i]] = rawgame[keys[i]];

  if (!game.title && game.name) game.title = game.name;
  if (game.title) game.title = cleantitle(game.title);
  if (!game.image && game.img) game.image = game.img;

  if (!game.source) game.source = fallbacksource || "unknown";

  if (Array.isArray(game.tags))
    game.tags = game.tags.filter(function (tag) {
      return typeof tag !== "string" || tag.toLowerCase() !== "epstein";
    });

  if (game.id === undefined || game.id === null || game.id === "") {
    game.id = game.url || game.html || game.source + "-" + slugify(game.title);
  } else {
    game.id = String(game.id);
  }

  return game;
}

// an hour: the catalogs change rarely, and the merged list is cached as one
// blob so a return visit doesn't re-download and re-parse every provider.
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
            v.schema === 18 &&
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
      // Bump the schema when the merge changes so clients do not keep an
      // hour-old card list built by the previous rules.
      { schema: 18, ts: Date.now(), data: data },
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
  // A cold server-side catalog fetch can take a few seconds on top of the
  // download itself, so this is longer than a plain file request.
  var timer = setTimeout(function () {
    controller.abort();
  }, 20000);
  try {
    var res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// One catalog record per game. A game several providers carry keeps every
// playable copy in `sources`, best first, so the library shows one card and the
// player can fall back without the title appearing five times.
function sourceentry(game) {
  return {
    name: game.source,
    id: game.id,
    url: game.url || "",
    html: game.html || "",
    iframe: game.iframe || "",
    image: game.image || game.img || "",
  };
}

// Provider spellings of one game differ in noise that should never create a
// second card: "2048"/"2048 Game", "Shapez"/"Shapez.io", "Pizza Tower"/"Pizza
// Tower (Web Port)", "The World's Hardest Game"/"Worlds Hardest Game".
var DEDUPE_NOISE = {
  game: 1,
  games: 1,
  html5: 1,
  webport: 1,
  unblocked: 1,
  fullscreen: 1,
  full: 1,
  screen: 1,
  play: 1,
  online: 1,
  io: 1,
  the: 1,
  a: 1,
  an: 1,
  remake: 1,
  edition: 1,
  deluxe: 1,
  goty: 1,
  hd: 1,
};
// A remastered build is a separate entry on purpose.
var DEDUPE_EDITION = { remastered: 1, remaster: 1 };
// Extra words that only describe a flavour of the same build.
var DEDUPE_SUFFIX = {
  lite: 1,
  plus: 1,
  pro: 1,
  classic: 1,
  beta: 1,
  demo: 1,
  trial: 1,
  scratch: 1,
  case: 1,
};

function dedupetokens(title) {
  var text = cleantitle(title || "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/&/g, " and ")
    // "Pizza Tower (Web Port)" is the same game; keep "Web Dashers" whole.
    .replace(/\bweb\s*port\b/g, " ");
  text = text
    .replace(/\biii\b/g, "3")
    .replace(/\bii\b/g, "2")
    .replace(/\biv\b/g, "4")
    .replace(/\bvi\b/g, "6")
    .replace(/\bv\b/g, "5")
    .replace(/\bvol(?:ume)?\.?\s*(\d+)/g, "$1")
    .replace(/\bpart\s*(\d+)/g, "$1");
  return text.split(/[^a-z0-9]+/).filter(Boolean);
}

// The words that identify the game, with noise and edition markers removed.
function dedupecore(title) {
  var tokens = dedupetokens(title);
  var kept = [];
  for (var i = 0; i < tokens.length; i++)
    if (!DEDUPE_NOISE[tokens[i]] && !DEDUPE_EDITION[tokens[i]])
      kept.push(tokens[i]);
  return kept.join("");
}

function dedupeeditions(title) {
  return dedupetokens(title)
    .filter(function (token) {
      return DEDUPE_EDITION[token];
    })
    .sort();
}

// Initials of the title, so "Five Nights At Freddy's" and "FNAF" agree.
// An all-caps word contributes each of its letters ("TD3" -> "td3").
function dedupeacronym(title) {
  var primary = cleantitle(title || "")
    .replace(/['’`]/g, "")
    .split(",")[0];
  var words = primary.split(/[^A-Za-z0-9]+/).filter(Boolean);
  var out = "";
  for (var i = 0; i < words.length; i++) {
    var word = words[i];
    if (/^\d+$/.test(word)) {
      out += word;
      continue;
    }
    var caps = word.match(/[A-Z]/g);
    var digits = word.match(/\d+/g);
    if (caps && caps.length >= 2 && word === word.toUpperCase()) {
      out += caps.join("").toLowerCase();
      if (digits) out += digits.join("");
    } else {
      out += word.charAt(0).toLowerCase();
      if (digits) out += digits.join("");
    }
  }
  return out;
}

function dedupeedit(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 9;
  var m = a.length;
  var n = b.length;
  var prev = [];
  for (var j = 0; j <= n; j++) prev[j] = j;
  for (var i = 1; i <= m; i++) {
    var cur = [i];
    for (var k = 1; k <= n; k++)
      cur[k] = Math.min(
        prev[k] + 1,
        cur[k - 1] + 1,
        prev[k - 1] + (a.charAt(i - 1) === b.charAt(k - 1) ? 0 : 1),
      );
    prev = cur;
  }
  return prev[n];
}

// Tokens of the longer title that the shorter one does not already account
// for. A token also covers its own extensions ("agar" covers "agario").
function dedupeextras(longer, shorter) {
  var extra = [];
  for (var i = 0; i < longer.length; i++) {
    var token = longer[i];
    var covered = false;
    for (var j = 0; j < shorter.length; j++) {
      var other = shorter[j];
      if (
        token === other ||
        token.indexOf(other) === 0 ||
        other.indexOf(token) === 0
      ) {
        covered = true;
        break;
      }
    }
    if (!covered) extra.push(token);
  }
  return extra;
}

var DEDUPE_GENERIC_SLUG = {
  index: 1,
  embed: 1,
  main: 1,
  game: 1,
  games: 1,
  play: 1,
  html: 1,
  app: 1,
  iframe: 1,
  files: 1,
  file: 1,
  start: 1,
  home: 1,
  download: 1,
  downloads: 1,
};

function decodeurlpart(value) {
  try {
    return decodeURIComponent(value);
  } catch (e) {
    return value;
  }
}

// The directory naming a game when the file is "index.html": skip "index",
// numeric and generic names so "/kindergarten/1/index.html" resolves to
// "kindergarten" and "/pegg/deluxe/index.html" to "deluxe".
function slugparent(parts) {
  for (var i = parts.length - 2; i >= 0; i--) {
    var name = parts[i].toLowerCase();
    if (DEDUPE_GENERIC_SLUG[name] || /^\d+$/.test(name)) continue;
    return parts[i];
  }
  return "";
}

// The provider's own name for the game, taken from the playable URL:
// "https://truffled.lol/games/btd3/index.html" -> "btd3",
// "assets/games/bloonsTD3.html" -> "bloontd3",
// "https://gn-math.github.io/html/0-fix2.html" -> "" (numeric, no name).
function gameslug(game) {
  var value = game.url || game.html || game.iframe;
  if (!value) return "";
  var url;
  try {
    url = new URL(value, "https://aetheris.win/");
  } catch (e) {
    return "";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "";
  var host = url.hostname.toLowerCase();
  var parts = url.pathname.split("/").filter(Boolean).map(decodeurlpart);
  var last = parts.length ? parts[parts.length - 1] : "";
  last = last.replace(/\.(html?|htm|php)$/i, "");
  var slug = "";
  if (host.indexOf("github.io") !== -1) {
    var hindex = parts.indexOf("html");
    slug = hindex !== -1 && parts[hindex + 1] ? parts[hindex + 1] : last;
    slug = slug
      .replace(/\.(html?|htm)$/i, "")
      .replace(/-(fix\d*|f\d*|update\d*|a\d*|ff)$/i, "");
    if (/^\d+$/.test(slug)) return "";
  } else if (
    host.indexOf("selenite.cc") !== -1 ||
    host.indexOf("gospel.newcovenant-teaching.org") !== -1
  ) {
    var sindex = parts.indexOf("semag");
    slug =
      sindex !== -1 ? parts[sindex + 1] || "" : slugparent(parts) || "";
  } else if (host.indexOf("truffled.lol") !== -1) {
    if (parts[0] === "games")
      slug = last === "index" ? slugparent(parts) : last;
    else if (parts[0] === "gamefile") slug = last;
  } else if (host.indexOf("petezahgames.com") !== -1) {
    if (parts[0] !== "embed")
      slug = last === "index" ? slugparent(parts) : last;
  } else {
    slug = last === "index" ? slugparent(parts) : last;
  }
  slug = String(slug)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  if (slug.length < 3 || /^\d+$/.test(slug) || DEDUPE_GENERIC_SLUG[slug])
    return "";
  return slug;
}

function dedupesameedition(a, b) {
  return (
    dedupeeditions(a.title).join(",") === dedupeeditions(b.title).join(",")
  );
}

// Whether the shorter token list appears in the longer one, in order, with
// only the returned tokens left over ("Minecraft Beta 1.7.3" vs "1.7.3").
function dedupesubsequence(longer, shorter) {
  var extra = [];
  var j = 0;
  for (var i = 0; i < longer.length; i++) {
    if (
      j < shorter.length &&
      (longer[i] === shorter[j] || longer[i].indexOf(shorter[j]) === 0)
    ) {
      j++;
      continue;
    }
    extra.push(longer[i]);
  }
  return j === shorter.length ? extra : null;
}

// Provider compounds hide the same noise inside one word
// ("theworldshardestgame" vs "world's hardest game").
function loosecore(title) {
  return dedupecore(title).replace(
    /the|game|games|html5|unblocked|webport|online/g,
    "",
  );
}

// Two cards are the same game when they resolve to the same provider file and
// their titles agree. The title rules are deliberately strict: sequels, DLC
// and remastered builds keep separate cards.
function deduperelated(a, b, slug) {
  var ca = dedupecore(a.title);
  var cb = dedupecore(b.title);
  if (!ca || !cb) return false;
  if (ca === cb) return true;
  var la = loosecore(a.title);
  var lb = loosecore(b.title);
  if (la && la === lb) return true;

  var aa = dedupeacronym(a.title);
  var ab = dedupeacronym(b.title);
  var anorm = ca === slug;
  var bnorm = cb === slug;
  var aslug = aa === slug;
  var bslug = ab === slug;

  // "Btd 3" / "Bloons Tower Defense 3": one name is the file, the other
  // spells the same initials.
  if ((anorm && bslug) || (bnorm && aslug)) return true;
  if (aslug && bslug) return true;

  // "Quake" / "Quake 1": the provider numbers the first entry.
  if (ca === cb + "1" || cb === ca + "1") return true;

  // A typo both cards agree on in the file name ("Bomberman"/"Bombmerman").
  if (
    ca.length >= 6 &&
    cb.length >= 6 &&
    Math.abs(ca.length - cb.length) <= 1 &&
    dedupeedit(ca, cb) === 1 &&
    (anorm || bnorm || aslug || bslug)
  )
    return true;

  // One title extends the other. The extra words must be a flavour ("Lite")
  // or a subtitle/franchise of two or more words
  // ("Henry Stickmin: …"). Articles inside a provider's compound spelling do
  // not count ("Bob the Robber 2" / "Bobtherobber 2").
  var ta = dedupetokens(a.title);
  var tb = dedupetokens(b.title);
  var shorter = ta;
  var longer = tb;
  var shortcore = la;
  var longcore = lb;
  if (shortcore.length > longcore.length) {
    shorter = tb;
    longer = ta;
    shortcore = lb;
    longcore = la;
  }
  if (longcore.indexOf(shortcore) !== -1) {
    // "Growden.io" / "Grow Denio": the provider split one word in two.
    if (
      longcore.indexOf(shortcore) === 0 &&
      longcore.length - shortcore.length <= 2
    )
      return true;
    var extra = dedupeextras(longer, shorter);
    if (!extra.length) return true;
    if (extra.length >= 2) return true;
    if (extra.length === 1 && DEDUPE_SUFFIX[extra[0]]) return true;
  }
  var sub = dedupesubsequence(longer, shorter);
  if (sub && (sub.length >= 2 || (sub.length === 1 && DEDUPE_SUFFIX[sub[0]])))
    return true;
  return false;
}

// Second pass: providers often ship one game under different titles and the
// same file path ("Bloons Tower Defense 3", "Bloon TD3", "Btd 3"). Fold those
// copies into one card so the player can fall back between them.
function foldgroups(cards, groups, remove) {
  for (var key in groups) {
    var list = groups[key];
    if (list.length < 2) continue;
    list.sort(function (a, b) {
      var priority = gamesourceorder(a.source) - gamesourceorder(b.source);
      if (priority !== 0) return priority;
      return (a.title || "").localeCompare(b.title || "");
    });
    var target = list[0];
    for (var j = 1; j < list.length; j++) {
      var other = list[j];
      if (remove.indexOf(other) !== -1) continue;
      if (!dedupesameedition(target, other)) continue;
      if (!deduperelated(target, other, key)) continue;
      for (var k = 0; k < other.sources.length; k++)
        addalternate(target, other.sources[k], other);
      if (!target.image && other.image) target.image = other.image;
      remove.push(other);
    }
  }
}

function foldfilecopies(cards) {
  var groups = Object.create(null);
  for (var i = 0; i < cards.length; i++) {
    var slug = gameslug(cards[i]);
    if (!slug) continue;
    if (!groups[slug]) groups[slug] = [];
    groups[slug].push(cards[i]);
  }
  var removed = [];
  foldgroups(cards, groups, removed);
  if (!removed.length) return cards;
  return cards.filter(function (card) {
    return removed.indexOf(card) === -1;
  });
}

// Third pass: the same game across providers whose file names differ but whose
// initials are the provider's name for it ("Bloons Tower Defense 3" is
// "bloonsTD3.html" on one provider and "btd3" on the others). At least one
// file must actually be named after those initials, so two titles that merely
// share initials are not folded together.
function foldacronymcopies(cards) {
  var groups = Object.create(null);
  var named = Object.create(null);
  for (var i = 0; i < cards.length; i++) {
    var acronym = dedupeacronym(cards[i].title);
    if (acronym.length < 3) continue;
    if (!groups[acronym]) groups[acronym] = [];
    groups[acronym].push(cards[i]);
    // A file named after the initials, or a card whose whole title is the
    // initials ("ADOFAI"), makes them safe to fold.
    if (
      gameslug(cards[i]) === acronym ||
      dedupecore(cards[i].title) === acronym
    )
      named[acronym] = true;
  }
  for (var key in groups) if (!named[key]) delete groups[key];
  var removed = [];
  foldgroups(cards, groups, removed);
  if (!removed.length) return cards;
  return cards.filter(function (card) {
    return removed.indexOf(card) === -1;
  });
}

function gamesdedupekey(game) {
  var title = game.title || game.name || "";
  var core = dedupecore(title);
  if (!core) return "id:" + game.source + ":" + game.id;
  // A remastered build is a separate entry on purpose, so the marker stays in
  // the key: everything else about the title is folded together.
  var editions = dedupeeditions(title);
  return "title:" + core + (editions.length ? "|" + editions.join(",") : "");
}

function copiesmatch(a, b) {
  return (a.url || a.html || a.iframe) === (b.url || b.html || b.iframe);
}

function addalternate(entry, source, game) {
  // A provider can list the same title more than once (numeric junk, duplicate
  // rows). Those copies belong on the one card so the player can fall back
  // through them, but an exact repeat of a URL adds nothing.
  for (var i = 0; i < entry.sources.length; i++)
    if (copiesmatch(entry.sources[i], source)) return false;
  entry.sources.push(source);
  entry.sources.sort(function (a, b) {
    return gamesourceorder(a.name) - gamesourceorder(b.name);
  });
  if (!entry.image && source.image) entry.image = source.image;
  if (Array.isArray(game.tags))
    game.tags.forEach(function (tag) {
      if (typeof tag === "string" && entry.tags.indexOf(tag) === -1)
        entry.tags.push(tag);
    });
  return true;
}

function mergegames(lists) {
  var records = [];
  for (var i = 0; i < lists.length; i++)
    if (lists[i]) records = records.concat(lists[i]);

  // Highest-priority source first, so the first record for a title becomes the
  // primary copy and aetheris ids stay verbatim (the server's play-count
  // allowlist matches them, and load links resolve the same way).
  records.sort(function (a, b) {
    var priority = gamesourceorder(a.source) - gamesourceorder(b.source);
    if (priority !== 0) return priority;
    return (a.title || "").localeCompare(b.title || "");
  });

  var bykey = Object.create(null);
  var merged = [];
  records.forEach(function (game) {
    var key = gamesdedupekey(game);
    var entry = bykey[key];
    if (entry) {
      // addalternate also folds in a provider's own repeated rows; a false
      // result means this exact URL is already on the card.
      addalternate(entry, sourceentry(game), game);
      return;
    }
    entry = {};
    var keys = Object.keys(game);
    for (var k = 0; k < keys.length; k++) entry[keys[k]] = game[keys[k]];
    entry.id = String(game.id);
    entry.title = game.title || game.name || "";
    entry.image = game.image || game.img || "";
    entry.tags = Array.isArray(game.tags) ? game.tags.slice() : [];
    entry.source = game.source;
    entry.sources = [sourceentry(game)];
    bykey[key] = entry;
    merged.push(entry);
  });

  // Unrelated games can still share an id; re-key the later one with its
  // source prefix and keep rawid so old favorites keep matching.
  var seenids = new Set();
  merged.forEach(function (game) {
    var id = String(game.id);
    if (seenids.has(id)) {
      game.rawid = id;
      var base = game.source + ":" + id;
      id = base;
      var suffix = 2;
      while (seenids.has(id)) id = base + ":" + suffix++;
      game.id = id;
    }
    seenids.add(id);
  });

  // Providers sometimes ship one game under different titles and the same
  // file path; fold those copies into the card the title pass built.
  merged = foldfilecopies(merged);
  merged = foldacronymcopies(merged);

  merged.sort(function (a, b) {
    return (a.title || "").localeCompare(b.title || "");
  });
  return merged;
}

// Favorites were saved under whatever id a card had at the time: the primary
// id, a provider's own id, or a re-keyed "source:id". Accept all of them.
function gamehasid(game, value) {
  if (!game) return false;
  var wanted = String(value);
  if (game.id != null && String(game.id) === wanted) return true;
  if (game.rawid != null && String(game.rawid) === wanted) return true;
  if (Array.isArray(game.sources))
    for (var i = 0; i < game.sources.length; i++) {
      var source = game.sources[i];
      if (source.id == null) continue;
      if (String(source.id) === wanted) return true;
      if (source.name + ":" + source.id === wanted) return true;
    }
  return false;
}

window.gamehasid = gamehasid;

var gamelistbyload = new Array(gamesources.length);
var gameloadpromises = new Array(gamesources.length);
// No source is currently deferred: every catalog is small enough to load up
// front. Keep the mechanism in case a large source is added again.
var gamessourcesdeferred = [];

function updategamesloading() {
  window.gamesLoading = gameloadpromises.some(function (p) {
    return !!p;
  });
}

// Publish each catalog as it arrives instead of leaving the library blank
// until the slowest provider finishes downloading.
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

function catalogitems(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.games)) return data.games;
  // selenite ships one object keyed by id instead of an array.
  if (data && typeof data === "object") {
    var keys = Object.keys(data);
    if (
      keys.length &&
      keys.every(function (key) {
        var value = data[key];
        return (
          value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          (value.title || value.name || value.label)
        );
      })
    )
      return keys.map(function (key) {
        return data[key];
      });
  }
  return null;
}

function loadgamesource(source, index) {
  if (gamelistbyload[index]) return Promise.resolve(gamelistbyload[index]);
  if (gameloadpromises[index]) return gameloadpromises[index];

  var promise = fetchjson(source.url)
    .then(function (data) {
      var items = catalogitems(data);
      if (!items) throw new Error("Unexpected catalog format: " + source.url);
      var list = items
        .map(function (raw) {
          return source.map(raw);
        })
        .map(function (raw) {
          return normalizegame(raw, source.name);
        })
        .filter(function (game) {
          return !!(game && (game.url || game.html || game.iframe));
        });
      gamelistbyload[index] = list;
      var errorindex = window.gamesLoadErrors.indexOf(source.url);
      if (errorindex !== -1) window.gamesLoadErrors.splice(errorindex, 1);
      publishgames();
      maybecachegames();
      return list;
    })
    .catch(function (reason) {
      if (window.gamesLoadErrors.indexOf(source.url) === -1)
        window.gamesLoadErrors.push(source.url);
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
  gamesources.forEach(function (source, index) {
    if (gamessourcesdeferred.indexOf(source) === -1)
      initial.push(
        loadgamesource(source, index).catch(function () {
          // errors are recorded in window.gamesLoadErrors
        }),
      );
  });
  await Promise.all(initial);

  window.gamesloaded = true;
  window.dispatchEvent(new Event("gamesloaded"));
  return window.games;
}

// Load one source by its short name ("aetheris", "gnmath", …). Resolves to
// null for unknown names; rejections are swallowed here because the failure
// is already recorded in window.gamesLoadErrors for the retry UI.
window.gamesloadsource = function (name) {
  for (var i = 0; i < gamesources.length; i++)
    if (gamesources[i].name === String(name))
      return loadgamesource(gamesources[i], i).catch(function () {
        return null;
      });
  return Promise.resolve(null);
};

window.gamesloadall = function () {
  return Promise.all(
    gamesources.map(function (source, index) {
      return loadgamesource(source, index).catch(function () {
        return null;
      });
    }),
  );
};

window.gamesretryfailed = function () {
  var failed = [];
  gamesources.forEach(function (source, index) {
    if (
      !gamelistbyload[index] &&
      window.gamesLoadErrors.indexOf(source.url) !== -1
    )
      failed.push(window.gamesloadsource(source.name));
  });
  return Promise.all(failed);
};

window.gameshasloaded = function (name) {
  for (var i = 0; i < gamesources.length; i++)
    if (gamesources[i].name === String(name)) return !!gamelistbyload[i];
  return false;
};

window.gamesready = window.gamesready || loadgamesdata();

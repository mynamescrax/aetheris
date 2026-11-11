import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Loads the real catalog script in a VM (stopping before it starts fetching)
// so the provider mappings and the merge can be exercised offline.
function catalog() {
  const source = readFileSync(
    new URL("../public/assets/data/games.js", import.meta.url),
    "utf8",
  );
  const sandbox = {
    console,
    Event: function () {},
    URL,
    URLSearchParams,
    Promise,
    Set,
    Map,
    setTimeout,
    clearTimeout,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    source.slice(0, source.indexOf("window.gamesready")),
    sandbox,
  );
  const get = (name) => vm.runInContext(name, sandbox);
  const mergeName = vm.runInContext(
    "Object.getOwnPropertyNames(this).find(function (n) { return /^merg/.test(n); }, this)",
    sandbox,
  );
  return {
    merge: get(mergeName),
    order: get("gamesourceorder"),
    normalize: get("normalizegame"),
    names: vm.runInContext(
      "gamesources.map(function (s) { return s.name; })",
      sandbox,
    ),
    urls: vm.runInContext(
      "gamesources.map(function (s) { return s.url; })",
      sandbox,
    ),
    map: {
      gnmath: get("gnmathcatalog"),
      truffled: get("truffledcatalog"),
      velara: get("velaracatalog"),
      selenite: get("selenitecatalog"),
    },
  };
}

test("catalogs are fetched live, aetheris first and in fallback order", () => {
  const game = catalog();
  assert.deepEqual(Array.from(game.names), [
    "aetheris",
    "gnmath",
    "truffled",
    "velara",
    "selenite",
  ]);
  assert.equal(game.urls[0], "assets/data/aetheris.json");
  for (const url of Array.from(game.urls).slice(1))
    assert.match(String(url), /^\/api\/games\/catalog\//);

  const order = ["aetheris", "gnmath", "truffled", "velara", "selenite"].map(
    (name) => game.order(name),
  );
  assert.deepEqual(
    order,
    order.slice().sort((a, b) => a - b),
    "priority must not reorder itself",
  );
});

test("provider catalogs are mapped onto the internal game shape", () => {
  const game = catalog();

  const gn = game.map.gnmath({
    id: 0,
    name: "Bowmasters",
    cover: "{COVER_URL}/0.png",
    url: "{HTML_URL}/0-fix2.html",
  });
  assert.equal(gn.url, "https://gn-math.github.io/html/0-fix2.html");
  assert.equal(
    gn.image,
    "https://cdn.jsdelivr.net/gh/freebuisness/covers@main/0.png",
  );
  assert.equal(game.map.gnmath({ id: -1, name: "[!] SUGGEST GAMES" }), null);

  const truffled = game.map.truffled({
    name: "1 on 1 Soccer",
    url: "/games/1on1soccer/index.html",
    thumbnail: "png/games/12.webp",
  });
  assert.equal(
    truffled.url,
    "https://truffled.lol/games/1on1soccer/index.html",
  );
  assert.equal(truffled.image, "https://truffled.lol/png/games/12.webp");

  const velara = game.map.velara({
    title: "10 Minutes Till Dawn",
    location: "assets/games/10minutestilldawn.html",
    image: "assets/games/10minutestilldawn.jpg",
  });
  assert.equal(
    velara.url,
    "https://velara.my/assets/games/10minutestilldawn.html",
  );

  const selenite = game.map.selenite({
    name: "Geometry Dash",
    image: "gd.webp",
    directory: "webdash",
    tags: ["top", "platformer"],
  });
  assert.equal(
    selenite.url,
    "https://selenite.cc/resources/semag/webdash/index.html",
  );
  assert.equal(
    selenite.image,
    "https://selenite.cc/resources/semag/webdash/gd.webp",
  );
  assert.deepEqual(Array.from(selenite.tags), ["top", "platformer"]);
  assert.equal(game.map.selenite({ name: "No directory" }), null);
});

test("a selenite cover in a subdirectory keeps its separators", () => {
  const game = catalog();
  const mapped = game.map.selenite({
    name: "Geometry Dash",
    image: "img/gd.webp",
    directory: "webdash",
  });
  assert.equal(
    mapped.image,
    "https://selenite.cc/resources/semag/webdash/img/gd.webp",
  );
});

test("the server accepts every catalog shape the client reader does", async () => {
  const { iscatalogpayload } = await import("../lib/game-catalogs.js");
  assert.equal(iscatalogpayload([{ name: "a" }]), true);
  assert.equal(iscatalogpayload({ games: [{ name: "a" }] }), true);
  assert.equal(iscatalogpayload({ a: { name: "A" }, b: { title: "B" } }), true);
  assert.equal(iscatalogpayload({}), false);
  assert.equal(iscatalogpayload({ a: "not a game" }), false);
  assert.equal(iscatalogpayload(null), false);
});

test("gnmath is served from the saved snapshot, not the network", async () => {
  const Fastify = (await import("fastify")).default;
  const { registerGameCatalogs } = await import("../lib/game-catalogs.js");
  const app = Fastify();
  registerGameCatalogs(app);
  await app.ready();
  try {
    const res = await app.inject({
      method: "GET",
      url: "/api/games/catalog/gnmath",
    });
    assert.equal(res.statusCode, 200);
    assert.equal(
      res.headers["cache-control"],
      "public, max-age=300, stale-while-revalidate=3600",
    );
    const data = res.json();
    assert.ok(Array.isArray(data), "the snapshot stays in provider shape");
    assert.ok(data.length > 500, "the snapshot should carry the whole library");

    const unknown = await app.inject({
      method: "GET",
      url: "/api/games/catalog/not-a-source",
    });
    assert.equal(unknown.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("a game carried by several providers becomes one card with ordered copies", () => {
  const game = catalog();
  const list = (source, records) =>
    records.map((record) => game.normalize(record, source));

  const merged = game.merge([
    list("velara", [
      { title: "Alpha", url: "https://velara.my/a/", tags: ["Action"] },
    ]),
    list("truffled", [{ title: "Alpha", url: "https://truffled.lol/a/" }]),
    list("gnmath", [
      { title: "Alpha", url: "https://gn-math.github.io/html/1.html" },
    ]),
    list("aetheris", [
      {
        id: "alpha",
        title: "Alpha",
        html: "assets/games/alpha.html",
        tags: ["Skill"],
      },
    ]),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "alpha");
  assert.equal(merged[0].source, "aetheris");
  assert.deepEqual(
    Array.from(merged[0].sources, (source) => source.name),
    ["aetheris", "gnmath", "truffled", "velara"],
  );
  assert.deepEqual(Array.from(merged[0].tags).sort(), ["Action", "Skill"]);
});

test("duplicate titles fold into one card, including short and repeated rows", () => {
  const game = catalog();
  const list = (source, records) =>
    records.map((record) => game.normalize(record, source));

  // "-3" is listed by three providers; it must be one card, not three.
  const short = game.merge([
    list("aetheris", [{ title: "-3", html: "assets/games/-3.html" }]),
    list("gnmath", [
      { title: "-3", url: "https://gn-math.github.io/html/816.html" },
    ]),
    list("truffled", [
      { title: "-3", url: "https://truffled.lol/games/minus3/index.html" },
    ]),
  ]);
  assert.equal(short.length, 1);
  assert.deepEqual(
    Array.from(short[0].sources, (source) => source.name),
    ["aetheris", "gnmath", "truffled"],
  );

  // One provider listing the same title twice keeps both copies on one card.
  const repeated = game.merge([
    list("truffled", [
      { title: "Alpha", url: "https://truffled.lol/a/" },
      { title: "Alpha", url: "https://truffled.lol/b/" },
    ]),
  ]);
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].sources.length, 2);

  // The exact same URL twice adds nothing.
  const exact = game.merge([
    list("truffled", [
      { title: "Alpha", url: "https://truffled.lol/a/" },
      { title: "Alpha", url: "https://truffled.lol/a/" },
    ]),
  ]);
  assert.equal(exact.length, 1);
  assert.equal(exact[0].sources.length, 1);

  // truffled appends a publisher to some titles; it is still the same game.
  const suffixed = game.merge([
    list("aetheris", [
      { title: "Academytale", html: "assets/games/academytale.html" },
    ]),
    list("truffled", [
      {
        title: "Academytale, Webport",
        url: "https://truffled.lol/games/academytale/",
      },
    ]),
  ]);
  assert.equal(suffixed.length, 1);
  assert.equal(suffixed[0].title, "Academytale");

  // Same title with different spacing is the same game.
  const spaced = game.merge([
    list("gnmath", [
      { title: "2048 Merge Run", url: "https://gn-math.github.io/html/1.html" },
    ]),
    list("velara", [
      {
        title: "2048 Mergerun",
        url: "https://velara.my/assets/games/2048.html",
      },
    ]),
  ]);
  assert.equal(spaced.length, 1);
  assert.deepEqual(
    Array.from(spaced[0].sources, (source) => source.name),
    ["gnmath", "velara"],
  );

  // Games whose titles only look similar still stay apart.
  const distinct = game.merge([
    list("aetheris", [
      { title: "10 Minutes Till Dawn", html: "assets/games/10.html" },
      { title: "20 Minutes Till Dawn", html: "assets/games/20.html" },
    ]),
  ]);
  assert.equal(distinct.length, 2);
});

test("provider spellings of one title fold into one card", () => {
  const game = catalog();
  const list = (source, records) =>
    records.map((record) => game.normalize(record, source));

  const merged = game.merge([
    list("aetheris", [
      { title: "2048", html: "assets/games/2048.html" },
      { title: "Shapez.io", html: "assets/games/shapez.html" },
      { title: "GTA III", html: "assets/games/gta3.html" },
      { title: "The World's Hardest Game", html: "assets/games/twhg.html" },
      { title: "Red Ball 4: Volume 2", html: "assets/games/redball4vol2.html" },
    ]),
    list("velara", [
      {
        title: "2048 Game",
        url: "https://velara.my/assets/games/2048game.html",
      },
      { title: "Shapez", url: "https://velara.my/assets/games/shapez.html" },
      { title: "GTA 3", url: "https://velara.my/assets/games/gta3.html" },
      {
        title: "Worlds Hardest Game",
        url: "https://velara.my/assets/games/twhg.html",
      },
      {
        title: "Red Ball 4 Vol. 2",
        url: "https://velara.my/assets/games/redball42.html",
      },
    ]),
  ]);
  assert.equal(merged.length, 5);
  for (const card of merged) assert.equal(card.sources.length, 2);
});

test("remastered builds stay separate from the original", () => {
  const game = catalog();
  const list = (source, records) =>
    records.map((record) => game.normalize(record, source));
  const merged = game.merge([
    list("aetheris", [
      { title: "Super Mario Bros", html: "assets/games/smb.html" },
      { title: "Super Mario Bros Remastered", html: "assets/games/smbr.html" },
    ]),
  ]);
  assert.equal(merged.length, 2);
});

test("one provider file under different names folds into one card", () => {
  const game = catalog();
  const list = (source, records) =>
    records.map((record) => game.normalize(record, source));
  const merged = game.merge([
    list("aetheris", [
      { title: "Bloons Tower Defense 3", html: "assets/games/bloonsTD3.html" },
    ]),
    list("truffled", [
      { title: "Bloon TD3", url: "https://truffled.lol/games/btd3/index.html" },
    ]),
    list("velara", [
      { title: "Btd 3", url: "https://velara.my/assets/games/btd3.html" },
    ]),
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(
    Array.from(merged[0].sources, (source) => source.name),
    ["aetheris", "truffled", "velara"],
  );
});

test("provider compounds that hide articles still fold", () => {
  const game = catalog();
  const list = (source, records) =>
    records.map((record) => game.normalize(record, source));
  const merged = game.merge([
    list("aetheris", [
      { title: "Bob the Robber 2", html: "assets/games/bobtherobber2.html" },
      {
        title: "The World's Hardest Game 3",
        html: "assets/games/theworldshardestgame3.html",
      },
    ]),
    list("velara", [
      {
        title: "Bobtherobber 2",
        url: "https://velara.my/assets/games/bobtherobber2.html",
      },
      {
        title: "Theworldshardestgame 3",
        url: "https://velara.my/assets/games/theworldshardestgame3.html",
      },
    ]),
  ]);
  assert.equal(merged.length, 2);
  for (const card of merged) assert.equal(card.sources.length, 2);
});

test("initials and split words still fold on the same provider file", () => {
  const game = catalog();
  const list = (source, records) =>
    records.map((record) => game.normalize(record, source));
  const merged = game.merge([
    list("aetheris", [
      {
        title: "A Dance of Fire and Ice",
        html: "assets/games/adanceoffireandice.html",
      },
      { title: "Grow Denio", html: "assets/games/growdenio/index.html" },
    ]),
    list("selenite", [
      {
        title: "ADOFAI",
        url: "https://selenite.cc/resources/semag/adofai/index.html",
      },
    ]),
    list("velara", [
      {
        title: "Growden.io",
        url: "https://velara.my/assets/games/growdenio.html",
      },
    ]),
  ]);
  assert.equal(merged.length, 2);
  for (const card of merged) assert.equal(card.sources.length, 2);
});

test("acronyms and subtitles fold; sequels and different games stay apart", () => {
  const game = catalog();
  const list = (source, records) =>
    records.map((record) => game.normalize(record, source));
  const merged = game.merge([
    list("aetheris", [
      { title: "Five Nights At Freddy's", html: "assets/games/FNAF.html" },
      {
        title: "Henry Stickmin: Escaping the Prison",
        html: "assets/games/escapingtheprison.html",
      },
      { title: "Rocket League", html: "assets/games/rl.html" },
      { title: "Moto X3M", html: "assets/games/moto.html" },
    ]),
    list("selenite", [
      {
        title: "FNAF",
        url: "https://selenite.cc/resources/semag/fnaf/index.html",
      },
      {
        title: "Rocket League Sideswipe",
        url: "https://nowgg.fun/apps/psyonix-studios/4656/rocket-league.html",
      },
      {
        title: "Moto X3M 2",
        url: "https://selenite.cc/resources/semag/motox3m2/index.html",
      },
    ]),
    list("velara", [
      {
        title: "Es Cap Ing The Prison",
        url: "https://velara.my/assets/games/escapingtheprison.html",
      },
    ]),
  ]);

  const bytitle = {};
  for (const card of merged) bytitle[card.title] = card;
  assert.ok(bytitle["Five Nights At Freddy's"]);
  assert.deepEqual(
    Array.from(bytitle["Five Nights At Freddy's"].sources, (s) => s.name),
    ["aetheris", "selenite"],
  );
  assert.deepEqual(
    Array.from(
      bytitle["Henry Stickmin: Escaping the Prison"].sources,
      (s) => s.name,
    ),
    ["aetheris", "velara"],
  );
  assert.ok(bytitle["Rocket League"]);
  assert.ok(bytitle["Rocket League Sideswipe"]);
  assert.ok(bytitle["Moto X3M"]);
  assert.ok(bytitle["Moto X3M 2"]);
  assert.equal(merged.length, 6);
});

test("different games that only share initials stay apart", () => {
  const game = catalog();
  const list = (source, records) =>
    records.map((record) => game.normalize(record, source));

  // A fan game whose title has the same initials as FNAF 3.
  const fnaf = game.merge([
    list("aetheris", [
      { title: "Five Nights At Freddy's 3", html: "assets/games/FNAF3.html" },
    ]),
    list("gnmath", [
      {
        title: "Five Nights at Frickbear's 3",
        url: "https://gn-math.github.io/html/813-f3.html",
      },
    ]),
  ]);
  assert.equal(fnaf.length, 2);

  // Two installments whose initials match because both subtitles start with R.
  const isaac = game.merge([
    list("truffled", [
      {
        title: "The Binding Of Issac: Rebirth",
        url: "https://truffled.lol/games/psp/tboir/index.html",
      },
      {
        title: "The Binding Of Issac: Repentance",
        url: "https://truffled.lol/games/boi/index.html",
      },
    ]),
  ]);
  assert.equal(isaac.length, 2);
});

test("a bare title and its numbered first entry fold across providers", () => {
  const game = catalog();
  const list = (source, records) =>
    records.map((record) => game.normalize(record, source));

  const merged = game.merge([
    list("aetheris", [
      { title: "Slope", html: "assets/games/slope.html" },
      { title: "Vex 1", html: "assets/games/vex1.html" },
      { title: "Slope 2", html: "assets/games/slope2.html" },
    ]),
    list("velara", [
      {
        title: "Slope 1",
        url: "https://velara.my/assets/games/slope1.html",
      },
    ]),
    list("truffled", [
      { title: "Vex", url: "https://truffled.lol/games/vex/index.html" },
    ]),
  ]);

  const bytitle = {};
  for (const card of merged) bytitle[card.title] = card;
  assert.ok(bytitle["Slope"]);
  assert.ok(bytitle["Slope 2"]);
  assert.ok(bytitle["Vex"]);
  assert.equal(bytitle["Slope"].sources.length, 2);
  assert.equal(bytitle["Vex"].sources.length, 2);
  assert.equal(bytitle["Slope 2"].sources.length, 1);
  assert.equal(merged.length, 3);
});

test("tags fold case-insensitively across providers", () => {
  const game = catalog();
  const list = (source, records) =>
    records.map((record) => game.normalize(record, source));

  const merged = game.merge([
    list("aetheris", [
      {
        title: "Alpha",
        html: "assets/games/alpha.html",
        tags: ["Action", "Skill"],
      },
    ]),
    list("selenite", [
      {
        title: "Alpha",
        url: "https://selenite.cc/resources/semag/alpha/index.html",
        tags: ["action", "platformer"],
      },
    ]),
  ]);

  assert.equal(merged.length, 1);
  assert.deepEqual(
    Array.from(merged[0].tags, (tag) => tag.toLowerCase()).sort(),
    ["action", "platformer", "skill"],
  );
});

test("the catalog script version matches in both loaders", () => {
  const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
  const pick = (text) => /assets\/data\/games\.js\?v=([\w.-]+)/.exec(text);
  const maths = pick(read("../public/maths.html"));
  const player = pick(read("../public/js/player-data.js"));
  assert.ok(maths, "maths.html loads the catalog script");
  assert.ok(player, "player-data.js loads the catalog script");
  assert.equal(player[1], maths[1]);
});

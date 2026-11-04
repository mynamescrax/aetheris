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
      petezah: get("petezahcatalog"),
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
    "petezah",
    "selenite",
  ]);
  assert.equal(game.urls[0], "assets/data/aetheris.json");
  for (const url of Array.from(game.urls).slice(1))
    assert.match(String(url), /^\/api\/games\/catalog\//);

  const order = [
    "aetheris",
    "gnmath",
    "truffled",
    "velara",
    "petezah",
    "selenite",
  ].map((name) => game.order(name));
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

  const petezah = game.map.petezah({
    label: "Minecraft",
    imageUrl: "/storage/images/main/minecraft.jpg",
    url: "/iframe.html?url=/storage/ag/originals/precision/index.html",
    categories: ["2 player"],
  });
  assert.equal(
    petezah.url,
    "https://petezahgames.com/storage/ag/originals/precision/index.html",
  );
  assert.deepEqual(Array.from(petezah.tags), ["2 player"]);
  assert.equal(
    game.map.petezah({
      label: "Request Games",
      url: "https://docs.google.com/forms/d/e/x/viewform",
    }),
    null,
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

test("a game carried by every provider becomes one card with ordered copies", () => {
  const game = catalog();
  const list = (source, records) =>
    records.map((record) => game.normalize(record, source));

  const merged = game.merge([
    list("petezah", [{ title: "Alpha", url: "https://petezahgames.com/a/" }]),
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
    ["aetheris", "gnmath", "truffled", "velara", "petezah"],
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

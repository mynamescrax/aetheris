import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function history(saved = "[]") {
  const storage = new Map([["moviesRecent", saved]]);
  const context = vm.createContext({
    items: [],
    recentItems: [],
    Aetheris: {
      storage: {
        getItem: (key) => storage.get(key),
        setItem: (key, value) => storage.set(key, value),
      },
    },
  });
  const source = fs.readFileSync(
    new URL("../public/js/movies-ui.js", import.meta.url),
    "utf8",
  );
  vm.runInContext(
    source.slice(
      source.indexOf("  function readRecent()"),
      source.indexOf("  function renderRecent()"),
    ),
    context,
  );
  context.recentItems = context.readRecent();
  return { context, storage };
}

test("history handles corrupt or invalid browser data", () => {
  for (const saved of [
    "{",
    "null",
    "{}",
    '[null,{"id":-1},{"id":1,"media_type":"person","title":"Invalid"}]',
  ]) {
    assert.equal(history(saved).context.recentItems.length, 0);
  }
});

test("history persists API metadata, deduplicates by media type, and reorders reopened titles", () => {
  const { context, storage } = history();
  context.items = [
    { id: 1, title: "Movie", vote_average: 8.37, poster_path: "/movie.jpg" },
    { id: 1, name: "Series", media_type: "tv", first_air_date: "2024-02-01" },
  ];
  context.rememberItem(1, "movie");
  context.rememberItem(1, "tv");
  context.rememberItem(1, "movie");
  const saved = JSON.parse(storage.get("moviesRecent"));
  assert.equal(saved.length, 2);
  assert.equal(saved[0].media_type, "movie");
  assert.equal(saved[0].vote_average, 8.37);
  assert.equal(saved[0].poster_path, "/movie.jpg");
  assert.equal(saved[1].title, "Series");
  assert.equal(saved[1].release_date, "2024-02-01");
  assert.equal(
    history(storage.get("moviesRecent")).context.recentItems.length,
    2,
  );
});

test("history keeps only the latest 20 titles and can reopen saved titles outside the current catalogue", () => {
  const { context } = history();
  context.items = Array.from({ length: 25 }, (_, index) => ({
    id: index + 1,
    title: "Title " + index,
  }));
  context.items.forEach((item) => context.rememberItem(item.id, "movie"));
  assert.equal(context.recentItems.length, 20);
  assert.equal(context.recentItems[0].id, 25);
  context.items = [];
  context.rememberItem(10, "movie");
  assert.equal(context.recentItems[0].id, 10);
  assert.equal(context.recentItems.length, 20);
});

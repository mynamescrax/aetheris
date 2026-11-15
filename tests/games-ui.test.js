import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function library({
  games = [{ id: "primary", title: "Example", tags: [] }],
  state = null,
} = {}) {
  const elements = new Map();
  function element() {
    return {
      children: [],
      value: "",
      style: {},
      dataset: {},
      listeners: {},
      classList: { toggle() {}, add() {}, remove() {} },
      setAttribute() {},
      removeAttribute() {},
      addEventListener(name, handler) {
        this.listeners[name] = handler;
      },
      append(...items) {
        this.children.push(...items);
      },
      appendChild(item) {
        if (item.fragment) this.children.push(...item.children);
        else this.children.push(item);
      },
      replaceChildren() {
        this.children = [];
      },
    };
  }
  const listeners = {};
  let checks = 0;
  let favorites = ["provider:42"];
  const timers = [];
  const sandbox = {
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
      createElement: element,
      createDocumentFragment: () =>
        Object.assign(element(), { fragment: true }),
      addEventListener() {},
      dispatchEvent() {},
    },
    Aetheris: {
      readList: () => favorites,
      storage: { getItem: () => "1" },
      imageUrl: (url) => url,
    },
    sessionStorage: {
      getItem: (key) =>
        key === "aetheris-games-state" ? JSON.stringify(state) : null,
      setItem() {},
    },
    fetch: async () => ({ ok: false }),
    setTimeout: (fn) => timers.push(fn),
    clearTimeout() {},
    Event: class {},
    location: {},
  };
  sandbox.window = {
    games,
    gamesloaded: true,
    gamehasid: (game, id) => {
      checks++;
      return game.id === "primary" && id === "provider:42";
    },
    addEventListener(name, handler) {
      listeners[name] = handler;
    },
  };
  vm.runInNewContext(
    readFileSync(new URL("../public/js/games.js", import.meta.url), "utf8"),
    sandbox,
  );
  return {
    elements,
    sandbox,
    get checks() {
      return checks;
    },
    search(value) {
      elements.get("search-box").value = value;
      elements.get("search-box").listeners.input();
      timers.pop()();
    },
    favorites(value) {
      favorites = value;
      listeners.storage({ key: "favoritedGames" });
    },
  };
}

test("library caches favorite matches and invalidates them after storage changes", () => {
  const ui = library();
  const { elements, sandbox } = ui;
  assert.equal(ui.checks, 1);
  const favGrid = elements.get("favoritedgames");
  assert.equal(favGrid.children.length, 1);
  elements.get("games-more").listeners.click();
  assert.equal(ui.checks, 1, "pagination reuses the favorite match");
  ui.favorites([]);
  assert.equal(favGrid.children.length, 0);
  assert.equal(elements.get("gamecards").children.length, 1);
  const cards = elements.get("gamecards").children[0];
  elements.get("random-game-btn").listeners.click();
  assert.equal(sandbox.location.href, "/load.html?game=primary");
  assert.equal(
    elements.get("gamecards").children[0],
    cards,
    "random selection skips rebuilding cards",
  );
});

test("pagination retains existing card nodes and restores the saved page size", () => {
  const games = Array.from({ length: 500 }, (_, id) => ({
    id: String(id),
    title: `Game ${id}`,
    tags: [],
  }));
  const { elements } = library({ games, state: { limit: 240 } });
  const grid = elements.get("gamecards");
  assert.equal(grid.children.length, 240);
  const original = grid.children.slice();
  elements.get("games-more").listeners.click();
  assert.equal(grid.children.length, 360);
  original.forEach((node, index) => assert.equal(grid.children[index], node));
});

test("indexed search and trimmed tags retain the original favorites grouping", () => {
  const ui = library({
    games: [
      { id: "primary", title: "Space Racer", tags: [" Action "] },
      { id: "other", title: "Space Puzzle", tags: ["Puzzle"] },
      { id: "third", title: "City Racer", tags: ["Action"] },
    ],
  });
  ui.search("SPACE");
  assert.equal(ui.elements.get("gamecards").children.length, 1);
  assert.equal(ui.elements.get("favoritedgames").children.length, 1);
  ui.favorites([]);
  assert.equal(ui.elements.get("favoritedgames").children.length, 0);
  assert.equal(ui.elements.get("gamecards").children.length, 2);
  const action = ui.elements
    .get("tag-container")
    .children.find((chip) => chip.textContent.trim() === "Action");
  action.listeners.click();
  assert.equal(ui.elements.get("gamecards").children.length, 1);
  assert.equal(ui.elements.get("gamecards").children[0].dataset.id, "primary");
  ui.search("no matching games");
  assert.match(ui.elements.get("games-status").textContent, /No matches/);
});

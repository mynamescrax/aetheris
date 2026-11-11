import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

test("library caches favorite matches and invalidates them after storage changes", () => {
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
        this.children.push(item);
      },
      replaceChildren() {
        this.children = [];
      },
    };
  }
  const listeners = {};
  let checks = 0;
  let favorites = ["provider:42"];
  const game = { id: "primary", title: "Example", tags: [] };
  const sandbox = {
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
      createElement: element,
      createDocumentFragment: element,
      addEventListener() {},
      dispatchEvent() {},
    },
    Aetheris: {
      readList: () => favorites,
      storage: { getItem: () => "1" },
      imageUrl: (url) => url,
    },
    sessionStorage: { getItem: () => null, setItem() {} },
    fetch: async () => ({ ok: false }),
    setTimeout: () => 1,
    clearTimeout() {},
    Event: class {},
    location: {},
  };
  sandbox.window = {
    games: [game],
    gamesloaded: true,
    gamehasid: (_, id) => {
      checks++;
      return id === "provider:42";
    },
    addEventListener(name, handler) {
      listeners[name] = handler;
    },
  };
  vm.runInNewContext(
    readFileSync(new URL("../public/js/games.js", import.meta.url), "utf8"),
    sandbox,
  );
  assert.equal(checks, 1);
  const favGrid = elements.get("favoritedgames");
  assert.equal(favGrid.children[0].children.length, 1);
  elements.get("games-more").listeners.click();
  assert.equal(checks, 1, "pagination reuses the favorite match");
  favorites = [];
  listeners.storage({ key: "favoritedGames" });
  assert.equal(favGrid.children[0].children.length, 0);
  assert.equal(elements.get("gamecards").children[0].children.length, 1);
  const cards = elements.get("gamecards").children[0];
  elements.get("random-game-btn").listeners.click();
  assert.equal(sandbox.location.href, "/load.html?game=primary");
  assert.equal(
    elements.get("gamecards").children[0],
    cards,
    "random selection skips rebuilding cards",
  );
});

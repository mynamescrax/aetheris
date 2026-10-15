import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Execute the shipped playback state machine with deterministic timers, without
// loading third-party players or adding hooks/exports to production code.
function harness() {
  const listeners = {}, timers = new Map(), beacons = [], storage = new Map();
  let timerId = 0;
  const state = {
    document: { hidden: false, activeElement: null },
    window: { addEventListener(name, fn) { listeners[name] = fn; } },
    player: { contentWindow: {}, src: "" },
    playerStatus: { textContent: "", classList: { add() {}, remove() {} } },
    hint: { textContent: "" }, source: { value: "0" },
    currentItem: { type: "movie", id: 550 }, currentEpisode: null,
    playerTimer: null, Date, Math, URL,
    location: { href: "https://aetheris.win/movies.html" },
    Aetheris: { storage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) } },
    uiBeacon: p => beacons.push(p), dbg() {}, urlHost: () => "test.invalid",
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const ctx = vm.createContext(state);
  vm.runInContext(fs.readFileSync(new URL("../public/js/movie-sources.js", import.meta.url), "utf8"), ctx);
  const source = fs.readFileSync(new URL("../public/js/movies-ui.js", import.meta.url), "utf8");
  const start = source.indexOf("  // Auto-fallback.");
  const end = source.indexOf("  function openPlayer(", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), ctx);
  ctx.setIframe();
  function message(state, extra = {}) {
    listeners.message({ source: ctx.player.contentWindow, data: { type: "aetheris-movie-playback", state, ...extra } });
  }
  function tick() {
    const [id, timer] = [...timers].at(-1);
    timers.delete(id);
    timer.fn();
  }
  return { ctx, message, tick, timers, beacons, listeners };
}

test("fallback prioritizes VidAPI before the weaker late fallbacks without reindexing", () => {
  const { ctx } = harness();
  const ids = [ctx.MOVIES_SOURCES[ctx.attempt.index].id];
  for (let i = 0; i < 4; i++) {
    ctx.sourceFailed(ctx.attempt, "timeout");
    ids.push(ctx.MOVIES_SOURCES[ctx.attempt.index].id);
  }
  assert.deepEqual(ids, ["flixer", "2embed", "vidapi", "vidsrc-su", "vidrock"]);
  assert.equal(ctx.MOVIES_SOURCES[2].id, "vidrock", "legacy index remains stable");
});

test("metadata does not permanently disable startup recovery", () => {
  const { ctx, message, tick, beacons } = harness();
  message("starting");
  message("ready", { paused: false });
  assert.equal(ctx.attempt.ready, true);
  tick();
  assert.equal(ctx.attempt.index, 1);
  assert.ok(beacons.some(b => b.ev === "startup-stall"));
});

test("a paused ready player waits for a tap instead of counting idle time as failure", () => {
  const { message, timers } = harness();
  message("ready", { paused: true });
  assert.equal(timers.size, 0);
  message("starting");
  assert.equal(timers.size, 1);
});

test("ongoing progress clears stall recovery but persistent buffering switches source", () => {
  const { ctx, message, timers, tick, beacons } = harness();
  message("playing");
  assert.equal(timers.size, 0);
  message("buffering");
  assert.equal(timers.size, 1);
  const timer = [...timers.keys()][0];
  message("buffering");
  assert.equal([...timers.keys()][0], timer, "repeated waiting cannot postpone recovery forever");
  message("progress");
  assert.equal(timers.size, 0);
  message("buffering");
  tick();
  assert.equal(ctx.attempt.index, 1);
  assert.ok(beacons.some(b => b.ev === "stall"));
  assert.ok(beacons.every(b => b.aid && b.provider));
});

test("pause clears recovery and background tabs do not trigger false failures", () => {
  const { ctx, message, timers, tick } = harness();
  message("playing"); message("buffering"); message("paused");
  assert.equal(timers.size, 0);
  message("buffering"); ctx.document.hidden = true; tick();
  assert.equal(ctx.attempt.index, 0);
  assert.equal(timers.size, 1);
});

test("exhaustion is counted once and never says nothing played after confirmed playback", () => {
  const { ctx, message, beacons } = harness();
  message("playing");
  for (let i = 0; i < 5; i++) ctx.sourceFailed(ctx.attempt, "stall");
  ctx.sourceFailed(ctx.attempt, "stall");
  assert.equal(beacons.filter(b => b.ev === "exhausted").length, 0);
  const again = harness();
  for (let i = 0; i < 6; i++) again.ctx.sourceFailed(again.ctx.attempt, "timeout");
  assert.equal(again.beacons.filter(b => b.ev === "exhausted").length, 1);
});

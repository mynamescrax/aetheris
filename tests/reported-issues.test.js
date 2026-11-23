import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Krillion uses the Scramjet player in the current tab", () => {
  const apps = JSON.parse(read("../public/assets/data/apps.json"));
  const krillion = apps.find((app) => app.id === "krillion");
  assert.equal(krillion.url, "https://krillion.cc/");
  assert.equal(krillion.href, undefined);
  assert.equal(krillion.newTab, undefined);
  assert.equal(krillion.noProxy, undefined);
});

test("proxy navigation errors stay readable in dark themes and flag the player", () => {
  const sw = read("../public/sw.js");
  assert.match(sw, /function proxynavigationerror\(/);
  assert.match(sw, /<meta name="aetheris-error" content="proxy">/);
  assert.match(sw, /color-scheme: dark/);
  assert.match(sw, /default-src 'none'; style-src 'unsafe-inline'/);
  assert.match(sw, /request\.mode === "navigate"/);

  const loadjs = read("../public/js/load.js");
  assert.match(loadjs, /aetheris-error"\]\[content="proxy"\]/);
});

test("search errors are legible and no longer print a raw engine code", () => {
  const search = read("../public/search.html");
  assert.doesNotMatch(search, /id="sj-error-code"/);
  assert.doesNotMatch(search, /sj-error-code/);
  assert.doesNotMatch(search, /failed to load: /);
  assert.match(search, /#error-area \{[\s\S]*?background: #241b1a/);
  assert.match(search, /#sj-error \{[\s\S]*?color: #ffe0cf/);
  assert.match(
    search,
    /The page could not load\. Check your connection and try again\./,
  );
});

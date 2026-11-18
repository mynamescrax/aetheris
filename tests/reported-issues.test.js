import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Krillion opens in its own tab instead of an unframed inline page", () => {
  const apps = JSON.parse(read("../public/assets/data/apps.json"));
  const krillion = apps.find((app) => app.id === "krillion");
  assert.equal(krillion.href, "https://krillion.cc/");
  assert.equal(
    krillion.newTab,
    true,
    "the tile must opt out of the proxy frame",
  );

  const appsjs = read("../public/js/apps.js");
  assert.match(appsjs, /app\.href && app\.newTab/);
  assert.match(appsjs, /card\.target = "_blank"/);

  const loadjs = read("../public/js/load.js");
  assert.match(loadjs, /if \(entry\.newTab\)/);
  assert.match(loadjs, /externalHref/);
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

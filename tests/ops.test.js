// Static checks for deployment files that are not exercised by the app tests.
// These guard against silent regressions (security headers removed from the
// Caddyfile, deploy verification gate dropped, ...).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const caddyfile = readFileSync(
  fileURLToPath(new URL("../Caddyfile", import.meta.url)),
  "utf8",
);
const indexjs = readFileSync(
  fileURLToPath(new URL("../index.js", import.meta.url)),
  "utf8",
);
const wispenginejs = readFileSync(
  fileURLToPath(new URL("../lib/wisp-engine.js", import.meta.url)),
  "utf8",
);

test("the site block sends baseline security headers", () => {
  assert.match(
    caddyfile,
    /Strict-Transport-Security "max-age=31536000; includeSubDomains"/,
  );
  assert.match(caddyfile, /X-Content-Type-Options "nosniff"/);
  assert.match(caddyfile, /Referrer-Policy "strict-origin-when-cross-origin"/);
  assert.match(caddyfile, /X-Frame-Options "SAMEORIGIN"/);
});

test("wisp stream limits keep the per-host option disabled", () => {
  // wisp-js 0.4.1 iterates `connection.streams` (a plain object) when
  // stream_limit_per_host is enabled, throwing "connection.streams is not
  // iterable" and breaking every proxied request. The total limit is safe
  // because it uses Object.keys(). Do not re-enable the per-host option
  // until the dependency fixes its check.
  assert.match(wispenginejs, /stream_limit_total:\s*\d+/);
  assert.match(wispenginejs, /stream_limit_per_host:\s*-1\b/);
});

test("1games assets and the split-file helper use a pinned jsDelivr upstream", () => {
  const route = caddyfile.match(/handle @game_assets \{[^}]*\}/)[0];
  assert.match(route, /reverse_proxy http:\/\/127\.0\.0\.1:8080/);
  assert.doesNotMatch(route, /raw\.githubusercontent\.com|rewrite/);
  assert.match(indexjs, /registerGameAssets\(fastify\)/);
  // Both the plain relay path and the opaque one reach the app, and no
  // per-file CDN rule is left: every asset goes through the app's mirror
  // relay, which picks the upstream from its allowlist (see MIRRORS in
  // lib/game-assets.js) and validates the body before serving it.
  assert.match(caddyfile, /@game_assets path \/game-assets\/\* \/s\/\*/);
  assert.doesNotMatch(caddyfile, /cdn\.jsdelivr\.net|raw\.githubusercontent\.com/);
});

test("1games pages resolve builds and split parts through our origin", () => {
  const dir = new URL("../public/assets/games/", import.meta.url);
  let pages = 0;
  let splitPages = 0;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".html")) continue;
    const html = readFileSync(new URL(file, dir), "utf8");
    if (!html.includes("1games-rips")) continue;
    pages++;
    assert.doesNotMatch(html, /https:\/\/[^"\s]*1games-rips/, file);
    const base = new URL(html.match(/<base[^>]*href="([^"]+)/i)[1], "https://aetheris.win");
    assert.equal(base.origin, "https://aetheris.win", file);
    assert.ok(base.pathname.startsWith("/game-assets/1games-rips/"), file);
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
    const context = {
      window: { location: new URL("https://aetheris.win/assets/games/" + file) },
      localStorage: { setItem() {} }, URLSearchParams, Date,
    };
    vm.runInNewContext(scripts.find(s => /var config\s*=/.test(s)), context);
    for (const path of [context.loaderUrl, context.config.dataUrl, context.config.frameworkUrl, context.config.codeUrl]) {
      const url = new URL(path, base);
      assert.equal(url.origin, base.origin, file);
      assert.ok(url.pathname.startsWith(base.pathname), file);
      assert.ok(!url.pathname.includes("//"), `${file}: duplicate slash in ${path}`);
    }
    const merger = scripts.find(s => s.includes("window.fileMergerConfig"));
    if (merger) {
      splitPages++;
      assert.match(html, /src="\/game-assets\/m\/jsdelivr\/gh\/bubbls\/UGS-Assets@[a-f0-9]{40}\/merge\.js"/, file);
      assert.doesNotMatch(html, /src="https:[^"]*\/merge\.js"/, file);
      vm.runInNewContext(merger, context);
      for (const part of context.window.fileMergerConfig.files) {
        const prefix = context.window.fileMergerConfig.basePath + part.name;
        assert.equal(new URL(prefix, base).pathname, new URL(context.config[part.name.includes(".wasm") ? "codeUrl" : "dataUrl"], base).pathname, file);
      }
    }
  }
  assert.equal(pages, 12);
  assert.equal(splitPages, 8);
});

test("the TMDB key comes only from the environment", () => {
  assert.match(indexjs, /const TMDB_KEY = process\.env\.TMDB_API_KEY \|\| "";/);
  assert.match(indexjs, /"Movies search not configured\."/);
});

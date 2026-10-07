// Static checks for deployment files that are not exercised by the app tests.
// These guard against silent regressions (security headers removed from the
// Caddyfile, deploy verification gate dropped, ...).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const caddyfile = readFileSync(
  fileURLToPath(new URL("../Caddyfile", import.meta.url)),
  "utf8",
);
const indexjs = readFileSync(
  fileURLToPath(new URL("../index.js", import.meta.url)),
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
  assert.match(indexjs, /stream_limit_total:\s*\d+/);
  assert.match(indexjs, /stream_limit_per_host:\s*-1\b/);
});

test("the TMDB key comes only from the environment", () => {
  assert.match(indexjs, /const TMDB_KEY = process\.env\.TMDB_API_KEY \|\| "";/);
  assert.match(indexjs, /"Movies search not configured\."/);
});

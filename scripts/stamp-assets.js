// Keeps the ?v= stamps on /css/ and /js/ URLs in step with the files they
// load. index.js lets browsers and Cloudflare keep a stamped css/js URL for a
// year without asking again, so a file that changed under an old stamp would
// stay stale for returning visitors.
//
// `pnpm stamp` gives every changed file a new stamp (YYYYMMDD.N) in every
// page and script that loads it, and records the file's hash in
// tests/asset-stamps.json. tests/asset-stamps.test.js fails until it has run.
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifestpath = join(root, "tests", "asset-stamps.json");

// Everything that can load the site's css/js with a stamp: the pages and
// browser scripts in public/, and server code that injects script tags
// (movie-relay.js). Game builds, media and vendored code never do.
const sources = [
  "index.js",
  "movie-relay.js",
  "lc-relay.js",
  "monitor.js",
  "lib",
  "public",
];
const skipdirs = new Set(["node_modules", "assets", "vendor", ".git"]);

// "./js/site.js?v=20261101.1", "/css/nav.css?v=1", "js/x.js?v=2". The
// lookbehind skips the same path on another host (cdn.example/js/x.js?v=1).
const stamped =
  /(?<![\w./-])((?:\.{0,2}\/)?)((?:css|js)\/[\w./-]+?\.(?:css|js))\?v=([\w.-]+)/g;

function walk(path, out) {
  if (!existsSync(path)) return out;
  if (!statSync(path).isDirectory()) {
    if (/\.(html?|js)$/i.test(path)) out.push(path);
    return out;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipdirs.has(entry.name)) walk(join(path, entry.name), out);
    } else if (/\.(html?|js)$/i.test(entry.name)) {
      out.push(join(path, entry.name));
    }
  }
  return out;
}

function sourcefiles() {
  return sources.flatMap((source) => walk(join(root, source), []));
}

// asset ("js/site.js") -> stamp -> files that load it with that stamp
function scan() {
  const refs = new Map();
  for (const file of sourcefiles()) {
    const name = relative(root, file).replaceAll("\\", "/");
    for (const match of readFileSync(file, "utf8").matchAll(stamped)) {
      const [, , asset, stamp] = match;
      if (!refs.has(asset)) refs.set(asset, new Map());
      const stamps = refs.get(asset);
      if (!stamps.has(stamp)) stamps.set(stamp, new Set());
      stamps.get(stamp).add(name);
    }
  }
  return refs;
}

// Line endings don't count, so a CRLF checkout hashes like the server's.
function digest(asset) {
  const file = join(root, "public", asset);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function readmanifest() {
  try {
    return JSON.parse(readFileSync(manifestpath, "utf8"));
  } catch {
    return {};
  }
}

function writemanifest(manifest) {
  const sorted = {};
  for (const asset of Object.keys(manifest).sort())
    sorted[asset] = manifest[asset];
  writeFileSync(manifestpath, JSON.stringify(sorted, null, 2) + "\n");
}

function localday(date = new Date()) {
  return (
    String(date.getFullYear()) +
    String(date.getMonth() + 1).padStart(2, "0") +
    String(date.getDate()).padStart(2, "0")
  );
}

function nextstamp(used, day) {
  let n = 0;
  for (const stamp of used) {
    const match = /^(\d{8})\.(\d+)$/.exec(stamp);
    if (match && match[1] === day) n = Math.max(n, Number(match[2]));
  }
  return day + "." + (n + 1);
}

function describe(stamps) {
  return [...stamps]
    .map(([stamp, files]) => `?v=${stamp} in ${[...files].join(", ")}`)
    .join("; ");
}

// Problems that would let a browser keep an outdated file; [] when in sync.
export function checkstamps() {
  const manifest = readmanifest();
  const problems = [];
  const refs = [...scan()].sort(([a], [b]) => a.localeCompare(b));
  for (const [asset, stamps] of refs) {
    const hash = digest(asset);
    const [stamp] = stamps.keys();
    const entry = manifest[asset];
    if (!hash) problems.push(`${asset}: no such file (${describe(stamps)})`);
    else if (stamps.size > 1)
      problems.push(`${asset}: loaded with different stamps: ${describe(stamps)}`);
    else if (!entry || entry.stamp !== stamp)
      problems.push(`${asset}?v=${stamp}: not recorded in tests/asset-stamps.json`);
    else if (entry.hash !== hash)
      problems.push(`${asset}: changed since it was stamped ?v=${stamp}`);
  }
  return problems;
}

// Gives changed files a new stamp everywhere they're loaded and records the
// hashes. Returns asset -> new stamp for the ones it changed.
export function stampassets(day = localday()) {
  let manifest = readmanifest();
  const changed = new Map();
  // A rewritten script changes too, so whatever loads it needs another pass.
  for (let pass = 0; pass < 5; pass++) {
    const next = {};
    const rewrites = new Map();
    for (const [asset, stamps] of scan()) {
      const hash = digest(asset);
      if (!hash) continue;
      const used = [...stamps.keys()];
      const entry = manifest[asset];
      let stamp;
      if (
        used.length === 1 &&
        (!entry || entry.stamp !== used[0] || entry.hash === hash)
      ) {
        // in sync, newly added, or already bumped by hand
        stamp = used[0];
      } else if (entry && entry.hash === hash && used.includes(entry.stamp)) {
        // unchanged file loaded under mixed stamps: settle on the recorded one
        stamp = entry.stamp;
      } else {
        stamp = nextstamp(used, day);
      }
      next[asset] = { stamp, hash };
      if (used.length > 1 || used[0] !== stamp) rewrites.set(asset, stamp);
    }
    manifest = next;
    if (!rewrites.size) break;
    for (const file of sourcefiles()) {
      const text = readFileSync(file, "utf8");
      const out = text.replace(stamped, (match, prefix, asset) =>
        rewrites.has(asset)
          ? `${prefix}${asset}?v=${rewrites.get(asset)}`
          : match,
      );
      if (out !== text) writeFileSync(file, out);
    }
    for (const [asset, stamp] of rewrites) changed.set(asset, stamp);
  }
  writemanifest(manifest);
  return changed;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const changed = stampassets();
  for (const [asset, stamp] of changed) console.log(`${asset} -> ?v=${stamp}`);
  const problems = checkstamps();
  for (const problem of problems) console.error(problem);
  if (problems.length) process.exitCode = 1;
  else if (!changed.size) console.log("All ?v= stamps match their files.");
}

import { readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { spawnSync } from "node:child_process";

let checked = 0;
const failures = [];
let modulecounter = 0;

// Inline type="module" blocks contain import/await/import.meta syntax that
// vm.Script (classic script) rejects; parse them with node's module parser.
function checkModuleSource(source) {
  const file = join(
    tmpdir(),
    `aetheris-check-${process.pid}-${modulecounter++}.mjs`,
  );
  try {
    writeFileSync(file, source);
    const result = spawnSync(process.execPath, ["--check", file], {
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr.trim());
  } finally {
    try {
      rmSync(file, { force: true });
    } catch {
      /* temp cleanup best effort */
    }
  }
}
function walk(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) {
      if (
        !["node_modules", "database", "games", "images", ".git"].includes(
          entry.name,
        )
      )
        walk(file);
      continue;
    }
    try {
      if (file.endsWith(".js")) {
        const result = spawnSync(process.execPath, ["--check", file], {
          encoding: "utf8",
        });
        if (result.status !== 0) throw new Error(result.stderr.trim());
        checked++;
      } else if (file.endsWith(".html")) {
        const html = readFileSync(file, "utf8");
        let index = 0;
        for (const script of html.matchAll(
          /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi,
        )) {
          if (
            /\bsrc\s*=|\btype\s*=\s*["'](?:application\/ld\+json|application\/json)/i.test(
              script[1],
            )
          )
            continue;
          if (/\btype\s*=\s*["']module["']/i.test(script[1]))
            checkModuleSource(script[2]);
          else new Script(script[2], { filename: file + ":inline-" + ++index });
          checked++;
        }
      } else if (
        file.endsWith(".json") &&
        // join() emits backslashes on Windows; compare separators agnostically.
        file.replaceAll("\\", "/").includes("assets/data")
      ) {
        const data = JSON.parse(readFileSync(file, "utf8"));
        if (!Array.isArray(data) && !Array.isArray(data.games))
          throw new Error("Unexpected catalog format.");
        checked++;
      }
    } catch (error) {
      failures.push(file + ": " + error.message);
    }
  }
}
walk("public");
for (const file of [
  "index.js",
  "monitor.js",
  "movie-relay.js",
  "lc-relay.js",
]) {
  const result = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
  });
  if (result.status !== 0) failures.push(file + ": " + result.stderr.trim());
  checked++;
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `Checked ${checked} scripts, inline blocks, and catalogs; no syntax/JSON errors.`,
  );

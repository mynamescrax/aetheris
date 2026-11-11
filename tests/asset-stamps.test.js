import test from "node:test";
import assert from "node:assert/strict";
import { checkstamps } from "../scripts/stamp-assets.js";

// index.js caches stamped /css/ and /js/ URLs for a year, so a file must
// never change under a stamp it has already been served with.
test("stamped css/js files match the hash recorded for their stamp", () => {
  const problems = checkstamps();
  assert.equal(
    problems.length,
    0,
    problems.join("\n") +
      '\nRun "pnpm stamp" to give changed files a new ?v= stamp.',
  );
});

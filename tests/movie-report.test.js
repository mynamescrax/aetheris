import test from "node:test";
import assert from "node:assert/strict";
import { createmoviereport } from "../lib/movie-report.js";

function harness(opts = {}) {
  let t = 1_000_000;
  const posts = [];
  const report = createmoviereport({
    webhookUrl: "https://discord.invalid/hook",
    now: () => t,
    fetchimpl: async (_url, init) => {
      posts.push(JSON.parse(init.body));
      return { ok: true, status: 204 };
    },
    log: { error() {}, log() {} },
    ...opts,
  });
  return { report, posts, tick: (ms) => (t += ms) };
}

test("summary tallies plays and failures per source", async () => {
  const { report, posts } = harness();
  const flixer = { name: "Flixer (flixer.su)", src: "0", kind: "movie", id: "550" };
  report.record({ ...flixer, ev: "play", ip: "a" });
  report.record({ ...flixer, ev: "ready", ip: "a" });
  report.record({ ...flixer, ev: "timeout", ip: "b" });
  report.record({ ...flixer, ev: "error", ip: "c" });
  report.record({ ...flixer, ev: "exhausted", ip: "c" });
  assert.equal(await report.flush(), true);
  assert.equal(posts.length, 1);
  const fields = posts[0].embeds[0].fields;
  const src = fields.find((f) => f.name.includes("Flixer"));
  assert.match(src.value, /1 played/);
  assert.match(src.value, /2 failed \(67%\)/);
  assert.match(src.value, /timeout 1, error 1/);
  const none = fields.find((f) => f.name.includes("Nothing played"));
  assert.match(none.value, /themoviedb\.org\/movie\/550/);
  // flushed: the next window starts empty and posts nothing
  assert.equal(await report.flush(), false);
  assert.equal(posts.length, 1);
});

test("alerts once when a source fails for several visitors with no plays", () => {
  const { report, posts, tick } = harness({ deadFailures: 4, deadIps: 3 });
  const vid = { name: "VidAPI (vidapi.xyz)", src: "4", kind: "movie", id: "1" };
  for (const ip of ["a", "b", "c", "a"]) {
    report.record({ ...vid, ev: "timeout", ip });
    tick(1000);
  }
  assert.equal(posts.length, 1);
  assert.match(posts[0].embeds[0].title, /VidAPI .* looks dead/);
  for (const ip of ["d", "e"]) report.record({ ...vid, ev: "timeout", ip });
  assert.equal(posts.length, 1, "cooldown suppresses repeat alerts");
});

test("no dead alert when the source also played for someone", () => {
  const { report, posts } = harness({ deadFailures: 3, deadIps: 2 });
  const s = { name: "2Embed (2embed.cc)", src: "1", kind: "tv", id: "2" };
  report.record({ ...s, ev: "ready", ip: "z" });
  for (const ip of ["a", "b", "c", "d"]) report.record({ ...s, ev: "error", ip });
  assert.equal(posts.length, 0);
});

test("junk names are ignored and state survives a restart", () => {
  const { report } = harness();
  report.record({ ev: "error", name: "@everyone <script>", src: "x" });
  assert.equal(report.summary(), null);
  report.record({ ev: "error", name: "@everyone", src: "2", ip: "a" });
  const saved = JSON.parse(JSON.stringify(report.serialize()));
  const { report: again } = harness();
  again.restore(saved);
  const field = again.summary().embeds[0].fields[0];
  assert.match(field.name, /source #2/);
  assert.match(field.value, /1 failed/);
});

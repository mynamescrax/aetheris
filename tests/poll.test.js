import test from "node:test";
import assert from "node:assert/strict";
import { createpoll, NEXT_FEATURE_POLL } from "../lib/poll.js";

const DEV = (n) => String(n).padStart(64, "a");
const quiet = { log() {}, error() {} };

function setup(extra = {}) {
  let t = 1_000_000;
  const posts = [];
  const poll = createpoll({
    durationMs: 1000,
    webhookUrl: "https://discord.test/hook",
    now: () => t,
    log: quiet,
    fetchimpl: async (url, init) => {
      posts.push(JSON.parse(init.body));
      return { ok: true };
    },
    ...extra,
  });
  poll.start();
  poll.stop();
  return { poll, posts, tick: (ms) => (t += ms) };
}

test("poll: one vote per device, any IP", () => {
  const { poll } = setup();
  assert.equal(poll.vote(DEV(1), "music-player", "1.1.1.1").ok, true);
  const again = poll.vote(DEV(1), "cloud-gaming", "8.8.8.8");
  assert.equal(again.ok, false);
  assert.equal(again.code, 409);
  assert.equal(again.choice, "music-player");
  // same IP, different device: still counts
  assert.equal(poll.vote(DEV(2), "cloud-gaming", "1.1.1.1").ok, true);
  assert.equal(poll.status(DEV(1)).voted, true);
  assert.equal(poll.status(DEV(3)).voted, false);
  assert.equal(poll.vote(DEV(3), "nope").code, 400);
  assert.deepEqual(poll.results().counts, {
    "cloud-gaming": 1,
    "music-player": 1,
    "more-games": 0,
  });
});

test("poll: device ids and IPs are not kept in plain text", async () => {
  const { poll } = setup({
    resolvecountries: async (ips) =>
      new Map(ips.map((ip) => [ip, { code: "US", name: "United States" }])),
  });
  poll.vote(DEV(1), "more-games", "1.2.3.4");
  await poll.resolvepending();
  const saved = JSON.stringify(poll.serialize());
  assert.ok(!saved.includes(DEV(1)));
  assert.ok(!saved.includes("1.2.3.4"));
  assert.ok(saved.includes('"c":"US"'));
});

test("poll: closes after the duration and posts results by country once", async () => {
  const geo = {
    "1.0.0.1": { code: "US", name: "United States" },
    "1.0.0.2": { code: "GB", name: "United Kingdom" },
  };
  const { poll, posts, tick } = setup({
    resolvecountries: async (ips) =>
      new Map(ips.map((ip) => [ip, geo[ip] || null])),
  });
  poll.vote(DEV(1), "cloud-gaming", "1.0.0.1");
  poll.vote(DEV(2), "cloud-gaming", "1.0.0.1");
  poll.vote(DEV(3), "more-games", "1.0.0.1");
  poll.vote(DEV(4), "music-player", "1.0.0.2");
  poll.vote(DEV(5), "music-player", "");

  tick(1000);
  assert.equal(poll.status().active, false);
  assert.equal(poll.vote(DEV(6), "cloud-gaming").code, 410);

  assert.equal(await poll.finish(), true);
  assert.equal(await poll.finish(), true);
  assert.equal(posts.length, 1);

  const embed = posts[0].embeds[0];
  assert.match(embed.title, /What should be the next feature/);
  assert.match(
    embed.description,
    /Tie between \*\*Cloud gaming\*\* and \*\*Music player\*\*/,
  );
  const bycountry = embed.fields.find((f) => /by country/.test(f.name)).value;
  const lines = bycountry.split("\n");
  assert.match(
    lines[0],
    /United States\*\* \u2014 3 votes .*top pick: Cloud gaming \(2\)/,
  );
  assert.match(
    lines[1],
    /United Kingdom\*\* \u2014 1 vote .*top pick: Music player \(1\)/,
  );
  assert.match(bycountry, /Unknown location: 1/);
  assert.equal(embed.fields.find((f) => /Total/.test(f.name)).value, "5");
});

test("poll: restore keeps the original window and posted flag", () => {
  const { poll } = setup();
  poll.vote(DEV(1), "cloud-gaming");
  const data = JSON.parse(JSON.stringify(poll.serialize()));

  const again = createpoll({ now: () => 1_000_500, log: quiet });
  again.restore(data);
  again.start();
  again.stop();
  assert.equal(again.serialize().endsAt, data.endsAt);
  assert.equal(again.status(DEV(1)).voted, true);

  const other = createpoll({ now: () => 1_000_500, log: quiet });
  other.restore({ ...data, id: "some-old-poll" });
  assert.equal(other.status(DEV(1)).voted, false);
  assert.equal(NEXT_FEATURE_POLL.options.length, 3);
});

test("poll: live feed posts each vote with country and totals once", async () => {
  const feed = [];
  let fail = false;
  const { poll, tick } = setup({
    votewebhookUrl: "https://discord.test/feed",
    resolvecountries: async (ips) =>
      new Map(
        ips.map((ip) => [
          ip,
          ip === "1.0.0.9" ? null : { code: "AU", name: "Australia" },
        ]),
      ),
    fetchimpl: async (url, init) => {
      if (url.endsWith("/feed")) {
        if (fail) return { ok: false, status: 429 };
        feed.push(JSON.parse(init.body));
      }
      return { ok: true };
    },
  });
  poll.vote(DEV(1), "more-games", "1.0.0.1");
  poll.vote(DEV(2), "cloud-gaming", "1.0.0.9"); // lookup fails
  await poll.tick();
  assert.equal(feed.length, 1);
  let embed = feed[0].embeds[0];
  assert.equal(embed.title, "\uD83D\uDDF3\uFE0F New vote");
  assert.match(
    embed.description,
    /Australia \u2192 \*\*Fix and add more games\*\*/,
  );
  assert.match(embed.fields[0].name, /2 votes/);
  assert.match(embed.fields[0].value, /Cloud gaming: \*\*1\*\* \(50%\)/);

  await poll.tick(); // nothing new yet
  assert.equal(feed.length, 1);

  fail = true;
  tick(3 * 60 * 1000); // unresolved vote is announced as unknown...
  await poll.tick();
  assert.equal(feed.length, 1); // ...but Discord said no, so retry
  fail = false;
  await poll.tick();
  assert.equal(feed.length, 2);
  assert.match(
    feed[1].embeds[0].description,
    /Unknown location \u2192 \*\*Cloud gaming/,
  );
});

test("poll: a failed webhook post is retried, not marked posted", async () => {
  let fail = true;
  const { poll, tick } = setup({
    fetchimpl: async () => ({ ok: !fail, status: fail ? 500 : 204 }),
  });
  tick(1000);
  assert.equal(await poll.finish(), false);
  assert.equal(poll.serialize().posted, false);
  fail = false;
  assert.equal(await poll.finish(), true);
  assert.equal(poll.serialize().posted, true);
});

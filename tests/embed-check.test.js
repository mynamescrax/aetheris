import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import {
  allowedgameurl,
  isframeable,
  registerEmbedCheck,
} from "../lib/embed-check.js";

function headers(values = {}) {
  return new Headers(values);
}

test("framing policy is read from X-Frame-Options and CSP", () => {
  assert.equal(isframeable(headers()), true);
  assert.equal(isframeable(headers({ "x-frame-options": "DENY" })), false);
  assert.equal(
    isframeable(headers({ "x-frame-options": "SAMEORIGIN" })),
    false,
  );
  assert.equal(
    isframeable(
      headers({ "content-security-policy": "frame-ancestors 'self'" }),
    ),
    false,
  );
  assert.equal(
    isframeable(
      headers({
        "content-security-policy": "default-src *; frame-ancestors *",
      }),
    ),
    true,
  );
  assert.equal(
    isframeable(
      headers({
        "content-security-policy":
          "frame-ancestors 'self' https://aetheris.win",
      }),
      "aetheris.win",
    ),
    true,
  );
  assert.equal(
    isframeable(
      headers({
        "content-security-policy-report-only": "frame-ancestors 'none'",
      }),
    ),
    false,
  );
});

test("only our own catalog hosts can be probed", () => {
  assert.ok(allowedgameurl("https://gn-math.github.io/html/0-fix2.html"));
  assert.ok(allowedgameurl("https://truffled.lol/games/1/index.html"));
  assert.ok(allowedgameurl("https://www.youtube.com/watch?v=1"));
  for (const bad of [
    "http://truffled.lol/games/1/index.html",
    "https://example.com/game.html",
    "https://user:pass@truffled.lol/game.html",
    "https://truffled.lol:8443/game.html",
    "not a url",
  ])
    assert.equal(allowedgameurl(bad), null, bad);
});

test("the check answers frameability and caches it", async () => {
  let calls = 0;
  const app = Fastify();
  registerEmbedCheck(app, {
    resolve: async () => ({}),
    fetchimpl: async (url, options) => {
      calls++;
      assert.equal(options.method, "HEAD");
      return new Response("", {
        status: 200,
        headers: { "x-frame-options": "SAMEORIGIN" },
      });
    },
  });
  await app.ready();
  try {
    const url = encodeURIComponent("https://velara.my/assets/games/x.html");
    const first = await app.inject("/api/embed-check?url=" + url);
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().frameable, false);

    const second = await app.inject("/api/embed-check?url=" + url);
    assert.equal(second.json().frameable, false);
    assert.equal(calls, 1, "the answer is cached");

    const refused = await app.inject(
      "/api/embed-check?url=" + encodeURIComponent("https://example.com/x"),
    );
    assert.equal(refused.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("a provider without framing headers is frameable", async () => {
  const app = Fastify();
  registerEmbedCheck(app, {
    resolve: async () => ({}),
    fetchimpl: async (_url, options) => {
      assert.equal(options.method, "HEAD");
      return new Response("", { status: 200 });
    },
  });
  await app.ready();
  try {
    const url = encodeURIComponent("https://gn-math.github.io/html/0.html");
    const result = await app.inject("/api/embed-check?url=" + url);
    assert.equal(result.json().frameable, true);
  } finally {
    await app.close();
  }
});

test("a redirect or an error page is unknown, not frameable", async () => {
  const app = Fastify();
  registerEmbedCheck(app, {
    resolve: async () => ({}),
    fetchimpl: async () =>
      new Response("", { status: 302, headers: { location: "/verify" } }),
  });
  await app.ready();
  try {
    const url = encodeURIComponent("https://petezahgames.com/iframe.html");
    const result = await app.inject("/api/embed-check?url=" + url);
    assert.equal(result.json().frameable, null);
  } finally {
    await app.close();
  }
});

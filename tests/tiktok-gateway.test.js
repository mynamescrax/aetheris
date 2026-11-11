import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

import {
  COOKIE_PATH,
  CookieJar,
  toBrowserSetCookie,
} from "../lib/tiktok-cookies.js";
import {
  handleTikTokRequest,
  injectClient,
  isTikTokNavPath,
  isTikTokRequest,
  rewriteAbsoluteUrls,
  rewriteRootRelativeAttributes,
  TIKTOK_BASE,
  TIKTOK_NAV_COOKIE,
} from "../lib/tiktok-gateway.js";

const site = (file) =>
  readFileSync(new URL("../public/" + file, import.meta.url), "utf8");

test("the gateway only claims its /tiktok subtree", () => {
  assert.equal(TIKTOK_BASE, "/tiktok");
  assert.equal(isTikTokRequest("/tiktok"), true);
  assert.equal(isTikTokRequest("/tiktok/"), true);
  assert.equal(isTikTokRequest("/tiktok/tt?url=x"), true);
  assert.equal(isTikTokRequest("/tiktok/foryou"), true);
  assert.equal(isTikTokRequest("/tiktok.html"), false);
  assert.equal(isTikTokRequest("/tiktokish/tt"), false);
  assert.equal(isTikTokRequest("/api/accounts/me"), false);
});

test("TikTok navigation paths are recognized without swallowing site routes", () => {
  for (const path of [
    "/foryou",
    "/following",
    "/@user",
    "/video/123",
    "/search?q=cats",
    "/live",
    "/404?fromUrl=/foryou",
  ])
    assert.equal(isTikTokNavPath(path), true, path);
  for (const path of [
    "/",
    "/index.html",
    "/movies.html",
    "/api/accounts/me",
    "/tiktok.html",
    "/tiktok/tt",
    "/assets/images/icon.png",
  ])
    assert.equal(isTikTokNavPath(path), false, path);
  assert.equal(TIKTOK_NAV_COOKIE, "aetheris_tt");
});

test("absolute TikTok URLs are mapped under /tiktok, external URLs are not", () => {
  const referer = "https://www.tiktok.com/foryou";
  const out = rewriteAbsoluteUrls(
    "a https://www.tiktok.com/api/post/?a=1 b https://example.com/z c //www.tiktok.com/@user",
    referer,
  );
  assert.equal(out.includes("/tiktok/tt?url="), true);
  assert.equal(out.includes("https://example.com/z"), true);
  assert.equal(
    out.includes(
      "/tiktok/tt?url=" +
        encodeURIComponent("https://www.tiktok.com/@user") +
        "&referer=" +
        encodeURIComponent(referer) +
        "&tt=1",
    ),
    true,
  );
});

test("JS API paths keep their upstream form so signatures stay valid", () => {
  const source = 'fetch("https://www.tiktok.com/api/recommend/item_list/?a=1")';
  const out = rewriteAbsoluteUrls(source, "https://www.tiktok.com/foryou", true);
  assert.equal(out, source);
});

test("root-relative assets stay inside the gateway subtree", () => {
  const out = rewriteRootRelativeAttributes(
    '<script src="/static/app.js"></script><link rel="stylesheet" href="/app.css"><a href="/@user">u</a><form action="/login"></form><img data-src="/img/a.png"><a href="https://example.com/x">e</a>',
  );
  assert.match(out, /src="\/tiktok\/static\/app\.js"/);
  assert.match(out, /href="\/tiktok\/app\.css"/);
  // Anchors and forms are mapped by the client hook, not rewritten here; the
  // SPA router must keep seeing /@user and /login in location.pathname.
  assert.match(out, /<a href="\/@user">/);
  assert.match(out, /action="\/login"/);
  assert.match(out, /data-src="\/tiktok\/img\/a\.png"/);
  assert.match(out, /href="https:\/\/example\.com\/x"/);
  // Already-gateway URLs are left alone.
  assert.equal(
    rewriteRootRelativeAttributes('src="/tiktok/tt?url=x"'),
    'src="/tiktok/tt?url=x"',
  );
});

test("HTML injection loads the client from /tiktok and sets the upstream target", () => {
  const html = injectClient(
    "<html><head><link rel=\"preconnect\" href=\"https://sf16.ttwstatic.com\"><title>x</title></head><body></body></html>",
    "https://www.tiktok.com/foryou",
  );
  assert.match(html, /src="\/tiktok\/tt-client\.js"/);
  assert.match(html, /window\.__TT_TARGET__="https:\/\/www\.tiktok\.com\/foryou"/);
  assert.equal(html.includes("preconnect"), false);
});

test("TikTok cookies are namespaced and downgraded for plain HTTP", () => {
  const plain = toBrowserSetCookie(
    "sid=1; Domain=.tiktok.com; Path=/; Secure; SameSite=None; HttpOnly",
    { secure: false },
  );
  assert.match(plain, /^aetheris_tt_sid=1/);
  assert.equal(plain.includes("Domain="), false);
  assert.match(plain, /Path=\//);
  assert.equal(plain.includes("Secure"), false);
  assert.match(plain, /SameSite=Lax/);
  assert.match(plain, /HttpOnly/);

  const tls = toBrowserSetCookie("sid=1; Path=/api; SameSite=None", {
    secure: true,
  });
  assert.match(tls, /^aetheris_tt_sid=1/);
  assert.match(tls, /Path=\//);
  assert.match(tls, /SameSite=None/);
  assert.match(tls, /Secure/);
});

test("the server-side jar withholds cookies from hosts they were not minted for", () => {
  const jar = new CookieJar();
  jar.record(
    ["sid=secret; Domain=.tiktok.com; Path=/", "ttwid=cdn; Domain=.tiktokcdn.com; Path=/"],
    "www.tiktok.com",
  );
  assert.equal(
    jar.filter("aetheris_tt_sid=secret; aetheris_tt_ttwid=cdn", "www.tiktok.com"),
    "sid=secret",
  );
  assert.equal(
    jar.filter(
      "aetheris_tt_sid=secret; aetheris_tt_ttwid=cdn",
      "v16-webapp-prime.tiktok.com",
    ),
    "sid=secret",
  );
  assert.equal(
    jar.filter(
      "aetheris_tt_sid=secret; aetheris_tt_ttwid=cdn",
      "sf16-website-login.tiktokcdn.com",
    ),
    "ttwid=cdn",
  );
  // Unprefixed site cookies (and the navigation marker) never go upstream.
  assert.equal(
    jar.filter("site_session=1; aetheris_tt=1; other=1", "example.com"),
    "",
  );
  // An unknown prefixed cookie is a JS-written TikTok cookie; strip the prefix.
  assert.equal(
    jar.filter("aetheris_tt_newcookie=1", "www.tiktok.com"),
    "newcookie=1",
  );
});

test("cookie deletion removes the learned scope", () => {
  const jar = new CookieJar();
  jar.record(["sid=1; Domain=.tiktok.com; Path=/"], "www.tiktok.com");
  jar.record(["sid=; Domain=.tiktok.com; Path=/; Max-Age=0"], "www.tiktok.com");
  // Deleted means "unknown", so the prefixed value still passes through.
  assert.equal(jar.filter("aetheris_tt_sid=1", "www.tiktok.com"), "sid=1");
});

async function withGateway(fn) {
  const server = createServer((req, res) => {
    if (handleTikTokRequest(req, res)) return;
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not the gateway");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("the gateway serves its client hook and points its root at the area", async () => {
  await withGateway(async (base) => {
    const root = await fetch(base + "/tiktok/", { redirect: "manual" });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get("location"), "/tiktok.html");

    const client = await fetch(base + "/tiktok/tt-client.js");
    assert.equal(client.status, 200);
    assert.match(client.headers.get("content-type"), /javascript/);
    const source = await client.text();
    assert.match(source, /var BASE = "\/tiktok"/);
    assert.match(source, /COOKIE_PATH/);
  });
});

test("the gateway rejects non-TikTok targets before any network call", async () => {
  await withGateway(async (base) => {
    const blocked = await fetch(
      base + "/tiktok/tt?url=" + encodeURIComponent("https://example.com/"),
    );
    assert.equal(blocked.status, 403);
    assert.match(await blocked.text(), /host not allowed/);

    const port = await fetch(
      base +
        "/tiktok/tt?url=" +
        encodeURIComponent("https://www.tiktok.com:8080/"),
    );
    assert.equal(port.status, 403);
    assert.match(await port.text(), /port not allowed/);

    const options = await fetch(base + "/tiktok/tt", { method: "OPTIONS" });
    assert.equal(options.status, 204);
    assert.equal(options.headers.get("access-control-allow-origin"), "*");
  });
});

test("root navigation redirects into /tiktok only while the marker is set", async () => {
  await withGateway(async (base) => {
    const noMarker = await fetch(base + "/foryou", { redirect: "manual" });
    assert.equal(noMarker.status, 404);

    const marked = await fetch(base + "/foryou?lang=en", {
      redirect: "manual",
      headers: { Cookie: TIKTOK_NAV_COOKIE + "=1" },
    });
    assert.equal(marked.status, 302);
    const location = marked.headers.get("location");
    assert.match(location, /^\/tiktok\/tt\?url=/);
    assert.equal(
      new URL(location, base).searchParams.get("url"),
      "https://www.tiktok.com/foryou?lang=en",
    );

    // A real site page is never claimed just because the marker is present.
    const sitePage = await fetch(base + "/movies.html", {
      redirect: "manual",
      headers: { Cookie: TIKTOK_NAV_COOKIE + "=1" },
    });
    assert.equal(sitePage.status, 404);
  });
});

test("the site exposes TikTok as a nav page and a catalog card", () => {
  const nav = site("index.html");
  assert.match(nav, /data-page="tiktok"/);
  assert.match(nav, /assets\/images\/tiktok\.webp/);

  const sitejs = site("js/site.js");
  assert.match(sitejs, /tiktok: "tiktok\.html"/);

  const page = site("tiktok.html");
  assert.match(page, /\/tiktok\/tt\?url=/);
  assert.match(page, /id="tiktok-frame"/);
  assert.match(page, /Something went wrong/);

  const apps = JSON.parse(site("assets/data/apps.json"));
  const tiktok = apps.find((app) => app.id === "tiktok");
  assert.equal(tiktok.href, "/tiktok.html");
  assert.equal(tiktok.url, undefined);
  // Old /load.html?app=tiktok bookmarks hand off to the dedicated page.
  assert.match(site("js/load.js"), /location\.replace\(entry\.href\)/);
});

test("the gateway client masks navigations to real upstream paths", () => {
  const source = site("js/tiktok-client.js");
  assert.match(source, /var BASE = "\/tiktok"/);
  assert.match(source, /u\.pathname === "\/" \? "\/foryou" : u\.pathname/);
  assert.match(source, /GATE_RE/);
  assert.match(source, /attributes\.push\("Path=" \+ COOKIE_PATH\)/);
  assert.match(source, /var COOKIE_PATH = "\/"/);
  assert.match(source, /var COOKIE_PREFIX = "aetheris_tt_"/);
});

test("the injected client sets and clears the navigation marker", () => {
  const source = site("js/tiktok-client.js");
  assert.match(source, /var NAV_MARKER = "aetheris_tt"/);
  assert.match(source, /setnavmarker\(true\)/);
  assert.match(source, /pagehide/);
  assert.match(source, /Max-Age=0/);
  assert.match(source, /Path=\/; SameSite=Lax/);
});

test("the TikTok area is only the frame", () => {
  const page = site("tiktok.html");
  assert.match(page, /SITEPAGE_RE/);
  assert.match(page, /current\.pathname === "\/"/);
  assert.match(page, /id="tiktok-frame"/);
  assert.doesNotMatch(page, /tiktok-bar|tiktok-url|tiktok-reload|tiktok-open/);
});

test("the cookie path constant is root so masked paths can see the jar", () => {
  assert.equal(COOKIE_PATH, "/");
});

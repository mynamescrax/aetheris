import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import {
  registerGameAssets,
  validGameAsset,
  decodeAssetSegment,
  assetToken,
  opaqueAssetUrl,
  assetCacheControl,
  GAME_ASSET_REVISION,
} from "../lib/game-assets.js";
import { rewriteAssetUrls } from "../lib/asset-urls.js";

const path = "/game-assets/1games-rips/trackdash/game.data.unityweb";
const binary = Buffer.concat([Buffer.from("UnityWebData1.0\0"), Buffer.alloc(1024)]);
function fixture(options = {}) {
  const app = Fastify();
  // Every fixture gets its own cache directory: the disk cache outlives the
  // process, so a shared one would let one test serve another's bytes.
  const dir = mkdtempSync(join(tmpdir(), "aetheris-assets-"));
  registerGameAssets(app, { cacheDir: dir, ...options });
  app.addHook("onClose", async () => {
    rmSync(dir, { recursive: true, force: true });
  });
  return app;
}

function bodyOf(result) {
  return Buffer.from(result.rawPayload);
}

test("game CDN rejects HTTP-200 errors and falls back only within jsDelivr", async () => {
  const urls = [];
  const app = fixture({ fetchimpl: async (url, options) => {
    urls.push(url);
    assert.equal(options.redirect, "error");
    assert.deepEqual(options.headers, { "accept-encoding": "identity" }, "only an identity hint is sent upstream; visitor credentials never are");
    return urls.length === 1
      ? new Response("429: Too Many Requests", { status: 200 })
      : new Response(binary, { headers: { "Content-Encoding": "br", "Set-Cookie": "bad=1" } });
  }});
  try {
    const result = await app.inject(path);
    assert.equal(result.statusCode, 200);
    assert.deepEqual(await bodyOf(result), binary);
    assert.equal(urls.length, 2);
    assert.ok(urls[0].includes("@" + GAME_ASSET_REVISION));
    assert.ok(urls[1].includes("@main/"));
    assert.ok(urls.every(url => url.startsWith("https://cdn.jsdelivr.net/gh/mynamescrax/1games-rips@")));
    assert.equal(result.headers["content-encoding"], undefined);
    assert.equal(result.headers["set-cookie"], undefined);
    await app.inject(path);
    assert.equal(urls.length, 2, "valid bytes are cached");
  } finally { await app.close(); }
});

test("failed assets return non-cacheable errors, not fake Unity data", async () => {
  let calls = 0;
  const app = fixture({ fetchimpl: async () => {
    calls++;
    return new Response("Failed to fetch repository", { status: 404 });
  }});
  try {
    const result = await app.inject(path);
    assert.equal(result.statusCode, 502);
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(calls, 2);
    assert.equal((await app.inject(path)).statusCode, 503);
    assert.equal(calls, 2, "a cooldown prevents retry storms");
  } finally { await app.close(); }
});

test("concurrent callers share an in-flight asset download", async () => {
  let calls = 0;
  const app = fixture({ fetchimpl: async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 10));
    return new Response(binary);
  }});
  try {
    const results = await Promise.all([app.inject(path), app.inject(path)]);
    assert.ok(results.every(result => result.statusCode === 200));
    assert.equal(calls, 1);
  } finally { await app.close(); }
});

test("sixteen split downloads queue without rejecting a normal large game", async () => {
  let active = 0, maximum = 0;
  const app = fixture({ fetchimpl: async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return new Response(binary);
  }});
  try {
    const results = await Promise.all(Array.from({ length: 16 }, (_, i) => app.inject(path + ".part" + (i + 1))));
    assert.ok(results.every(result => result.statusCode === 200));
    assert.ok(maximum <= 4);
  } finally { await app.close(); }
});

test("binary validation distinguishes first and later split chunks", () => {
  assert.equal(validGameAsset("x.data.unityweb", Buffer.from("429: Too Many Requests")), false);
  assert.equal(validGameAsset("x.data.unityweb", Buffer.alloc(1024)), false);
  assert.equal(validGameAsset("x.data.unityweb.part1", binary), true);
  assert.equal(validGameAsset("x.data.unityweb.part2", Buffer.alloc(1024)), true);
  assert.equal(validGameAsset("x.wasm.unityweb", Buffer.concat([Buffer.from([0,97,115,109]), Buffer.alloc(1024)])), true);
});

test("the CDN relay rejects encoded traversal and enforces its cache budget", async () => {
  let calls = 0;
  const app = fixture({ maxCacheBytes: 1, fetchimpl: async () => {
    calls++;
    return new Response(binary);
  }});
  try {
    const invalid = await app.inject("/game-assets/1games-rips/game/%2e%2e%2fsecret");
    assert.equal(invalid.statusCode, 400);
    assert.equal(calls, 0);
    await app.inject(path);
    await app.inject(path);
    assert.equal(calls, 2, "oversized entries are not retained");
  } finally { await app.close(); }
});

test("mirror relay serves any allowlisted static CDN through our origin", async () => {
  const urls = [];
  const js = "console.log('game');";
  const app = fixture({ fetchimpl: async (url, options) => {
    urls.push(url);
    assert.equal(options.redirect, "error");
    if (url.includes("NG.asm.js")) return new Response(binary);
    return new Response(js);
  }});
  try {
    const asm = await app.inject("/game-assets/m/jsdelivr/gh/bubbls/clusterarchive@b7c6a3b/Release/NG.asm.js");
    assert.equal(asm.statusCode, 200);
    assert.deepEqual(await bodyOf(asm), binary);
    assert.equal(urls[0], "https://cdn.jsdelivr.net/gh/bubbls/clusterarchive@b7c6a3b/Release/NG.asm.js");
    const script = await app.inject("/game-assets/m/fastly/gh/bubbls/clusterarchive@b7c6a3b/Release/UnityLoader.js");
    assert.equal(script.statusCode, 200);
    assert.equal(script.headers["content-type"], "application/javascript; charset=utf-8");
    assert.equal(urls[1], "https://fastly.jsdelivr.net/gh/bubbls/clusterarchive@b7c6a3b/Release/UnityLoader.js");
    await app.inject("/game-assets/m/jsdelivr/gh/bubbls/clusterarchive@b7c6a3b/Release/NG.asm.js");
    assert.equal(urls.length, 2, "mirror bytes are cached");
    const cors = await app.inject({ url: "/game-assets/m/fastly/gh/bubbls/clusterarchive@b7c6a3b/Release/UnityLoader.js", headers: { origin: "http://localhost:8080" } });
    assert.equal(cors.statusCode, 200);
    assert.equal(cors.headers["access-control-allow-origin"], "http://localhost:8080");
  } finally { await app.close(); }
});

test("mirror relay rejects unknown hosts, traversal and poisoned bodies", async () => {
  let calls = 0;
  const app = fixture({ fetchimpl: async (url) => {
    calls++;
    assert.ok(/^https:\/\/(?:cdn|fastly|gcore)\.jsdelivr\.net\/|^https:\/\/raw\.githubusercontent\.com\//.test(url), "never fetches outside the allowlist");
    return new Response("429: Too Many Requests", { status: 200 });
  }});
  try {
    assert.equal((await app.inject("/game-assets/m/evil/gh/x/y.js")).statusCode, 400);
    assert.equal((await app.inject("/game-assets/m/jsdelivr/gh/x/%2e%2e%2fsecret")).statusCode, 400);
    assert.equal((await app.inject("/game-assets/m/jsdelivr/")).statusCode, 400);
    assert.equal(calls, 0);
    const poisoned = await app.inject("/game-assets/m/jsdelivr/gh/bubbls/clusterarchive@b7c6a3b/Release/NG.asm.js");
    assert.equal(poisoned.statusCode, 502);
    assert.equal(poisoned.headers["cache-control"], "no-store");
    assert.equal((await app.inject("/game-assets/m/jsdelivr/gh/bubbls/clusterarchive@b7c6a3b/Release/NG.asm.js")).statusCode, 503);
    assert.equal(calls, 4, "each jsDelivr upstream plus the GitHub raw fallback is tried once; a cooldown then stops retries");
  } finally { await app.close(); }
});

test("the relay forwards the exact path the visitor asked for", async () => {
  const urls = [];
  const app = fixture({ fetchimpl: async (url) => {
    urls.push(url);
    return new Response("ok");
  }});
  try {
    // A jsDelivr path can carry an encoded space ("fruit%20ninja/"). The CDN
    // has to see the same path the browser would have sent directly, so the
    // raw request target is forwarded and never re-encoded.
    const result = await app.inject("/game-assets/m/jsdelivr/gh/bubbls/UGS-Assets@main/fruit%20ninja/Build/x.js");
    assert.equal(result.statusCode, 200);
    assert.equal(urls[0], "https://cdn.jsdelivr.net/gh/bubbls/UGS-Assets@main/fruit%20ninja/Build/x.js");
    // the decoded name still decides the content type
    const script = await app.inject("/game-assets/m/jsdelivr/gh/bubbls/UGS-Assets@main/x%2Ejs");
    assert.equal(script.headers["content-type"], "application/javascript; charset=utf-8");
  } finally { await app.close(); }
});

test("the relay refuses paths that could name another file", async () => {
  let calls = 0;
  const app = fixture({ fetchimpl: async () => {
    calls++;
    return new Response("ok");
  }});
  try {
    // encoded traversal, an encoded separator, a malformed escape and an
    // empty segment all name a different file than the visitor asked for
    assert.equal((await app.inject("/game-assets/m/jsdelivr/gh/x/%2e%2e%2fsecret")).statusCode, 400);
    assert.equal((await app.inject("/game-assets/m/jsdelivr/gh/x/a%2Fb")).statusCode, 400);
    assert.equal((await app.inject("/game-assets/m/jsdelivr/gh/x/%zz")).statusCode, 400);
    assert.equal((await app.inject("/game-assets/m/jsdelivr/gh/x//y")).statusCode, 400);
    assert.equal((await app.inject("/game-assets/m/jsdelivr/gh/x/y/")).statusCode, 400);
    assert.equal(calls, 0, "nothing is fetched for a refused path");
  } finally { await app.close(); }
});

test("Unity's compressed build type is a valid asset, not a poisoned body", () => {
  // A "Compressed" Unity build wraps its data in its own container, and the
  // WebGL framework file is the loader module itself. Neither is gzip, and
  // refusing them 502'd 3dash, BitLife and 10 Minutes Till Dawn.
  const compressed = Buffer.concat([
    Buffer.from([0x6b, 0x8d, 0x00]),
    Buffer.from("UnityWeb Compressed"),
    Buffer.alloc(1024, 0x41),
  ]);
  const module = Buffer.concat([
    Buffer.from([0x0a]),
    Buffer.from("var UnityModule = (function() {"),
    Buffer.alloc(1024, 0x41),
  ]);
  assert.equal(validGameAsset("x.data.unityweb", compressed), true);
  assert.equal(validGameAsset("x.wasm.unityweb", compressed), true);
  assert.equal(validGameAsset("x.wasm.framework.unityweb", module), true);
  assert.equal(validGameAsset("x.wasm.framework.unityweb.part1", module), true);
  // the error bodies the check exists for are still refused
  assert.equal(validGameAsset("x.data.unityweb", Buffer.from("<!DOCTYPE html><html>")), false);
  assert.equal(validGameAsset("x.data.unityweb", Buffer.from("429: Too Many Requests")), false);
});

test("a blocked jsDelivr user still serves the file from GitHub", async () => {
  // jsDelivr answers 403 "User <name> is blocked" for abusive users, and the
  // file is still on GitHub. The path has no @ref, so the fallback has to
  // resolve the default branch.
  const urls = [];
  const app = fixture({ fetchimpl: async (url) => {
    urls.push(url);
    if (url.includes("jsdelivr")) {
      return new Response("User genizy is blocked.", { status: 403 });
    }
    return new Response(Buffer.alloc(1024, 0x42));
  }});
  try {
    const result = await app.inject("/game-assets/m/jsdelivr/gh/genizy/google-class/nova-craft/assets/pinwheel.png");
    assert.equal(result.statusCode, 200);
    assert.equal(
      urls.at(-1),
      "https://raw.githubusercontent.com/genizy/google-class/HEAD/nova-craft/assets/pinwheel.png",
    );
  } finally { await app.close(); }
});

test("the githack mirror is served from GitHub, not its dead redirect", async () => {
  // raw.githack.com is a 301 to raw.githubusercontent.com these days and the
  // relay refuses upstream redirects, so the mirror points at GitHub.
  const urls = [];
  const app = fixture({ fetchimpl: async (url) => {
    urls.push(url);
    return new Response("ok");
  }});
  try {
    const result = await app.inject("/game-assets/m/githack/gn-math/assets/main/198/TemplateData/progressFull.Dark.png");
    assert.equal(result.statusCode, 200);
    assert.equal(
      urls[0],
      "https://raw.githubusercontent.com/gn-math/assets/main/198/TemplateData/progressFull.Dark.png",
    );
    assert.ok(!urls.some((url) => url.includes("githack")), "no request goes to the redirecting host");
  } finally { await app.close(); }
});

test("an opaque URL carries the mirror and the directory, not the CDN layout", async () => {
  const urls = [];
  const app = fixture({ fetchimpl: async (url) => {
    urls.push(url);
    return new Response("ok");
  }});
  try {
    const opaque = opaqueAssetUrl("jsdelivr", "gh/bubbls/UGS-Assets@ac5cdfc0042aca584e72619375b4aca948a9243c/merge.js");
    assert.ok(opaque.startsWith("/s/"), "the opaque URL hides the mirror and the repo");
    assert.ok(opaque.endsWith("/merge.js"), "the file name stays readable");
    assert.ok(!opaque.includes("jsdelivr"), "the mirror is not in the URL");
    assert.ok(!opaque.includes("UGS-Assets"), "the repo is not in the URL");

    const result = await app.inject(opaque);
    assert.equal(result.statusCode, 200);
    assert.equal(
      urls[0],
      "https://cdn.jsdelivr.net/gh/bubbls/UGS-Assets@ac5cdfc0042aca584e72619375b4aca948a9243c/merge.js",
      "the opaque URL fetches the same file",
    );
  } finally { await app.close(); }
});

test("an opaque URL is refused when the token does not decode", async () => {
  let calls = 0;
  const app = fixture({ fetchimpl: async () => {
    calls++;
    return new Response("ok");
  }});
  try {
    assert.equal((await app.inject("/s/not-base64!!/x.js")).statusCode, 400);
    assert.equal((await app.inject("/s/" + Buffer.from("evil:gh/x").toString("base64url") + "/x.js")).statusCode, 400);
    assert.equal((await app.inject("/s/" + Buffer.from("jsdelivr:gh/x/%2e%2e%2fsecret").toString("base64url") + "/x.js")).statusCode, 400);
    assert.equal((await app.inject("/s/" + Buffer.from("jsdelivr:gh/x").toString("base64url") + "/%2e%2e%2fsecret")).statusCode, 400);
    assert.equal(calls, 0, "nothing is fetched for a refused token");
  } finally { await app.close(); }
});

test("the service worker relays the same paths as the relay does", () => {
  // The worker redirects absolute CDN URLs to the relay, so its path rules
  // have to match the relay's: a path the worker accepts but the relay
  // refuses ends in a 400, and one the worker refuses is fetched from the CDN
  // directly. Pull the worker's rules out of the shipped file and compare.
  const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  const from = source.indexOf("var SEGMENT =");
  const to = source.indexOf("// Absolute CDN URLs hardcoded");
  assert.ok(from !== -1 && to > from, "the worker segment rules are where we expect them");
  const context = { decodeURIComponent, btoa };
  vm.runInNewContext(
    source.slice(from, to) + "\nthis.validsegment = validsegment;\nthis.assettoken = assettoken;",
    context,
  );
  const segments = [
    "x.js",
    "UnityLoader.js",
    "fruit%20ninja",
    "a%2Fb",
    "%2e%2e%2f",
    "%2E%2E",
    "..",
    ".",
    "",
    "a b",
    "a%zz",
    "x%25y",
    "UPPER@main",
  ];
  for (const segment of segments) {
    assert.equal(
      Boolean(context.validsegment(segment)),
      decodeAssetSegment(segment) !== null,
      `the worker and the relay disagree about "${segment}"`,
    );
  }
  // the worker builds the same opaque tokens as the relay
  for (const [mirror, dir] of [
    ["jsdelivr", "gh/bubbls/UGS-Assets@ac5cdfc0042aca584e72619375b4aca948a9243c"],
    ["ghraw", "ParrrotVR/ultrapoolwebport/main"],
    ["cdnjs", "ajax/libs/jquery/3.7.1"],
  ]) {
    assert.equal(context.assettoken(mirror, dir), assetToken(mirror, dir), `${mirror} ${dir}`);
  }
});

test("a page shows opaque URLs instead of the CDN layout", () => {
  const html = [
    '<base href="/game-assets/m/jsdelivr/gh/bubbls/UGS-Assets@main/10minutestilldawn/">',
    '<script src="/game-assets/m/jsdelivr/gh/bubbls/UGS-Assets@ac5cdf/merge.js"></script>',
    '<img src="/game-assets/m/ghraw/ParrrotVR/ultrapoolwebport/main/index2.png">',
    '<a href="/game-assets/m/jsdelivr/gh/x/y.js?v=2">',
  ].join("\n");
  const rewritten = rewriteAssetUrls(html);
  assert.ok(!rewritten.includes("/game-assets/m/"), "no relay URL is left in the page");
  assert.ok(!rewritten.includes("jsdelivr"), "no mirror is named");
  assert.ok(!rewritten.includes("UGS-Assets"), "no repo is named");
  assert.ok(rewritten.includes('href="/s/'), "the base href points at the relay");
  assert.ok(rewritten.includes("/merge.js\""), "the file name stays readable");
  assert.ok(rewritten.includes("?v=2"), "a query string survives");
  // a URL the relay would not serve is left alone
  const unknown = rewriteAssetUrls('<img src="/game-assets/m/nosuchmirror/x/y.png">');
  assert.ok(unknown.includes("/game-assets/m/nosuchmirror/"), "an unknown mirror is untouched");
});

test("HEAD probes report sizes without downloading the body", async () => {
  const calls = [];
  const app = fixture({ fetchimpl: async (url, options) => {
    calls.push({ url, method: options.method || "GET" });
    if (options.method === "HEAD") {
      return new Response(null, { headers: { "content-length": "20893373" } });
    }
    return new Response(binary);
  }});
  try {
    const head = await app.inject({
      method: "HEAD",
      url: "/game-assets/m/jsdelivr/gh/bubblfan/fnaf@main/1/resources.zip.part1",
    });
    assert.equal(head.statusCode, 200);
    assert.equal(head.headers["content-length"], "20893373");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "HEAD", "the body is never fetched for a size probe");
    // cached for the next probe, so a split loader asks upstream only once
    await app.inject({ method: "HEAD", url: "/game-assets/m/jsdelivr/gh/bubblfan/fnaf@main/1/resources.zip.part1" });
    assert.equal(calls.length, 1);
  } finally { await app.close(); }
});

test("large assets stream instead of being buffered whole", async () => {
  const size = 20 * 1024 * 1024;
  let streamed = false;
  const app = fixture({ fetchimpl: async () => {
    streamed = true;
    const body = new ReadableStream({
      start(controller) {
        for (let i = 0; i < size / 65536; i++) controller.enqueue(new Uint8Array(65536));
        controller.close();
      },
    });
    return new Response(body, { headers: { "content-length": String(size) } });
  }});
  try {
    const result = await app.inject("/game-assets/m/jsdelivr/gh/bubblfan/fnaf@main/1/resources.zip.part1");
    assert.equal(result.statusCode, 200);
    assert.equal(
      result.headers["content-length"],
      String(size),
      "the size of the build is passed on, or the Unity loader shows no progress at all",
    );
    assert.equal((await bodyOf(result)).length, size);
    assert.ok(streamed);
    // The build is on disk now, so the second visitor gets it from there
    // instead of pulling it through the VPS again.
    const again = await app.inject("/game-assets/m/jsdelivr/gh/bubblfan/fnaf@main/1/resources.zip.part1");
    assert.equal(again.statusCode, 200);
    assert.equal((await bodyOf(again)).length, size);
    assert.equal(again.headers["content-length"], String(size), "a cached build is served from disk");
    assert.equal(again.headers["accept-ranges"], "bytes");
  } finally { await app.close(); }
});

test("a build whose length cannot be trusted is served without one", async () => {
  // A compressed body was decoded on the way in, so the length in the header
  // describes the compressed bytes. Sending it would cut the build short.
  const size = 20 * 1024 * 1024;
  const app = fixture({ fetchimpl: async () => {
    const body = new ReadableStream({
      start(controller) {
        for (let i = 0; i < size / 65536; i++) controller.enqueue(new Uint8Array(65536));
        controller.close();
      },
    });
    return new Response(body, {
      headers: { "content-length": String(size / 2), "content-encoding": "br" },
    });
  }});
  try {
    const result = await app.inject("/game-assets/m/jsdelivr/gh/bubblfan/fnaf@main/1/resources.zip.part1");
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers["content-length"], undefined, "a length we cannot trust is not sent");
    assert.equal((await bodyOf(result)).length, size);
  } finally { await app.close(); }
});

test("a visitor that walks away leaves no half-written build behind", async () => {
  const size = 20 * 1024 * 1024;
  const dir = mkdtempSync(join(tmpdir(), "aetheris-assets-"));
  const app = Fastify();
  registerGameAssets(app, { cacheDir: dir, fetchimpl: async () => {
    const body = new ReadableStream({
      start(controller) {
        for (let i = 0; i < size / 65536; i++) controller.enqueue(new Uint8Array(65536));
        controller.close();
      },
    });
    return new Response(body, { headers: { "content-length": String(size) } });
  }});
  try {
    // The client goes away after the first chunk.
    await app.inject({
      url: "/game-assets/m/jsdelivr/gh/bubblfan/fnaf@main/1/resources.zip.part1",
      payload: undefined,
      simulate: { end: true, split: true },
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    const leftovers = readdirSync(dir).filter(name => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "an abandoned transfer leaves no temp file");
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an upstream that stops halfway continues on the next mirror", async () => {
  // A jsDelivr edge that stops sending used to end the whole request: the
  // visitor waited for the stall guard, got a truncated build and reloaded.
  // The bytes already sent stay with the visitor and the next mirror is
  // asked for the rest.
  const size = 6 * 1024 * 1024;
  const chunk = 65536;
  const delivered = 16;
  const calls = [];
  const app = fixture({ fetchimpl: async (url, options) => {
    calls.push({ url, range: options.headers.range || null });
    const start = options.headers.range
      ? Number(options.headers.range.replace("bytes=", "").replace("-", ""))
      : 0;
    let sent = start;
    let pulls = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (!options.headers.range && pulls >= delivered) {
          // The first mirror delivers a megabyte and then stops.
          controller.error(new Error("upstream stalled"));
          return;
        }
        pulls++;
        if (sent >= size) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(chunk));
        sent += chunk;
      },
    });
    return new Response(body, {
      status: options.headers.range ? 206 : 200,
      headers: { "content-length": String(size - start) },
    });
  }});
  try {
    const result = await app.inject("/game-assets/m/jsdelivr/gh/bubblfan/fnaf@main/1/resources.zip.part1");
    assert.equal(result.statusCode, 200);
    const served = await bodyOf(result);
    assert.equal(served.length, size, "the visitor gets the whole build");
    assert.ok(calls.length >= 2, "the transfer moved to another mirror");
    assert.equal(
      calls[1].range,
      `bytes=${delivered * chunk}-`,
      "the next mirror is asked for the missing bytes",
    );
    assert.notEqual(calls[0].url, calls[1].url, "a different mirror is used");
  } finally { await app.close(); }
});

test("a mirror that ignores the range header does not duplicate bytes", async () => {
  const size = 6 * 1024 * 1024;
  const chunk = 65536;
  const delivered = 16;
  const calls = [];
  const app = fixture({ fetchimpl: async (url, options) => {
    calls.push({ url, range: options.headers.range || null });
    let sent = 0;
    let pulls = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (!options.headers.range && pulls >= delivered) {
          controller.error(new Error("upstream stalled"));
          return;
        }
        pulls++;
        // The mirror ignores the range and sends the whole file again.
        if (sent >= size) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(chunk));
        sent += chunk;
      },
    });
    return new Response(body, { headers: { "content-length": String(size) } });
  }});
  try {
    const result = await app.inject("/game-assets/m/jsdelivr/gh/bubblfan/fnaf@main/1/resources.zip.part1");
    assert.equal(result.statusCode, 200);
    const served = await bodyOf(result);
    assert.equal(served.length, size, "the bytes the visitor already had are not sent twice");
    assert.equal(calls[1].range, `bytes=${delivered * chunk}-`);
  } finally { await app.close(); }
});

test("a build that is on disk is served from there and supports ranges", async () => {
  const size = 6 * 1024 * 1024;
  const chunk = 65536;
  let calls = 0;
  const app = fixture({ fetchimpl: async () => {
    calls++;
    const body = new ReadableStream({
      start(controller) {
        for (let i = 0; i < size / chunk; i++) controller.enqueue(new Uint8Array(chunk));
        controller.close();
      },
    });
    return new Response(body, { headers: { "content-length": String(size) } });
  }});
  try {
    const url = "/game-assets/m/jsdelivr/gh/bubblfan/fnaf@main/1/resources.zip.part1";
    const first = await app.inject(url);
    assert.equal(first.statusCode, 200);
    assert.equal((await bodyOf(first)).length, size);
    assert.equal(calls, 1);

    const second = await app.inject(url);
    assert.equal(second.statusCode, 200);
    assert.equal((await bodyOf(second)).length, size);
    assert.equal(calls, 1, "the second visitor does not touch the CDN again");

    const slice = await app.inject({
      method: "GET",
      url,
      headers: { range: "bytes=100-199" },
    });
    assert.equal(slice.statusCode, 206);
    assert.equal(slice.headers["content-range"], `bytes 100-199/${size}`);
    assert.equal((await bodyOf(slice)).length, 100);

    const broken = await app.inject({
      method: "GET",
      url,
      headers: { range: `bytes=${size + 10}-` },
    });
    assert.equal(broken.statusCode, 416);
  } finally { await app.close(); }
});

test("a pinned build may sit in the browser for a year", () => {
  assert.equal(
    assetCacheControl("gh/bubblfan/fnaf@0123456789abcdef0123456789abcdef01234567/1/main.js"),
    "public, max-age=31536000, immutable",
  );
  assert.equal(
    assetCacheControl("gh/bubblfan/fnaf@main/1/main.js"),
    "public, max-age=300",
  );
});

test("a length hint from a compressed body never truncates the asset", async () => {
  // Node's fetch inflates a gzip body but leaves the on-wire (compressed)
  // Content-Length in the headers. Treating that hint as "the body ended here"
  // served a prefix of every compressed text asset: FNAF's main.js reached the
  // browser as 7,229 of 19,599 bytes and the loader never ran.
  const part = Buffer.alloc(5000, 0x61);
  const app = fixture({ fetchimpl: async () => {
    const body = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 4; i++) controller.enqueue(new Uint8Array(part));
        controller.close();
      },
    });
    // 20,000 decoded bytes, but the header describes the 10,000-byte compressed form.
    return new Response(body, { headers: { "content-length": "10000", "content-encoding": "gzip" } });
  }});
  try {
    const result = await app.inject("/game-assets/m/jsdelivr/gh/bubblfan/fnaf@main/1/main.js");
    assert.equal(result.statusCode, 200);
    assert.equal((await bodyOf(result)).length, 20000, "the whole decoded body is served");
    assert.equal(result.headers["content-encoding"], undefined);
  } finally { await app.close(); }
});

test("a length hint larger than the body does not stall the response", async () => {
  const app = fixture({ fetchimpl: async () => new Response("console.log(1);", {
    headers: { "content-length": "999999" },
  }) });
  try {
    const result = await app.inject("/game-assets/m/jsdelivr/gh/bubbls/clusterarchive@b7c6a3b/Release/UnityLoader.js");
    assert.equal(result.statusCode, 200);
    assert.equal((await bodyOf(result)).toString(), "console.log(1);");
  } finally { await app.close(); }
});

test("jsDelivr package-size 403 falls back to the GitHub raw mirror", async () => {
  const urls = [];
  const app = fixture({ fetchimpl: async (url) => {
    urls.push(url);
    if (url.includes("jsdelivr.net")) {
      return new Response("Package size exceeded the configured limit of 50 MB.", { status: 403 });
    }
    return new Response(binary);
  }});
  try {
    const result = await app.inject("/game-assets/m/jsdelivr/gh/bubblfan/fnaf@main/4/resources.zip.part10");
    assert.equal(result.statusCode, 200);
    assert.deepEqual(await bodyOf(result), binary);
    assert.equal(urls.at(-1), "https://raw.githubusercontent.com/bubblfan/fnaf/main/4/resources.zip.part10");
  } finally { await app.close(); }
});

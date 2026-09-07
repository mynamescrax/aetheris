import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import fs from "node:fs";
import {
  isPublicAddress,
  resolvePublicUrl,
  pinnedLookup,
} from "../lib/public-network.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import {
  rewriteM3u8,
  rewriteHtml,
  rewriteJsImports,
  decompressBuffer,
} from "../movie-relay.js";

test("private, reserved and IPv4-mapped IPv6 addresses are blocked", () => {
  for (const ip of [
    "127.0.0.1",
    "0.0.0.0",
    "10.1.1.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "203.0.113.1",
    "::",
    "::1",
    "fe80::1",
    "fc00::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:a00:1",
    "2001:db8::1",
    "2002:7f00:1::",
    "bad-ip",
  ])
    assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of [
    "8.8.8.8",
    "1.1.1.1",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "::ffff:808:808",
  ])
    assert.equal(isPublicAddress(ip), true, ip);
});

test("URL validation rejects alternate local encodings and mixed DNS answers", async () => {
  for (const url of [
    "http://2130706433/",
    "http://0x7f000001/",
    "http://[::ffff:7f00:1]/",
    "file:///etc/passwd",
    "https://user:pass@example.com/",
    "http://example.com:8080/",
    "http://localhost./",
  ])
    await assert.rejects(resolvePublicUrl(url));
  await assert.rejects(
    resolvePublicUrl("https://provider.test/", async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]),
  );
  const resolved = await resolvePublicUrl(
    "https://provider.test/path",
    async () => [{ address: "8.8.8.8", family: 4 }],
  );
  assert.equal(resolved.url.pathname, "/path");
  await new Promise((resolve, reject) =>
    pinnedLookup(resolved.addresses)(
      "provider.test",
      { all: true },
      (error, answers) => {
        if (error) return reject(error);
        assert.deepEqual(answers, [{ address: "8.8.8.8", family: 4 }]);
        resolve();
      },
    ),
  );
});

test("rate limiting cannot be reset by changing a device fingerprint", () => {
  let time = 100;
  const consume = createRateLimiter({ now: () => time, maxEntries: 2 });
  assert.equal(consume("register:ip", 2, 1000).allowed, true);
  assert.equal(consume("register:ip", 2, 1000).allowed, true);
  assert.equal(consume("register:ip", 2, 1000).allowed, false);
  time += 1001;
  assert.equal(consume("register:ip", 2, 1000).allowed, true);
  consume("other:ip", 1, 1000);
  assert.equal(consume("third:ip", 1, 1000).allowed, false);
});

test("HLS rewrites initialization, audio, subtitles, keys and media segments", () => {
  const input =
    '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-KEY:METHOD=AES-128,URI="../key"\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/track.m3u8"\n#EXT-X-PART:DURATION=0.3,URI="part.m4s"\nsegment.ts\n';
  const output = rewriteM3u8(
    input,
    new URL("https://cdn.example/live/master.m3u8"),
  );
  for (const url of [
    "https://cdn.example/live/init.mp4",
    "https://cdn.example/key",
    "https://cdn.example/live/audio/track.m3u8",
    "https://cdn.example/live/part.m4s",
    "https://cdn.example/live/segment.ts",
  ])
    assert.ok(output.includes(encodeURIComponent(url)), url);
  assert.ok(output.startsWith("#EXTM3U"));
});

test("HTML and JavaScript use the upstream document/module directory", () => {
  const html = rewriteHtml(
    '<html><head></head><body><iframe src="./embed"></iframe></body></html>',
    new URL("https://provider.example/path/index.html"),
  );
  assert.ok(
    html.includes(encodeURIComponent("https://provider.example/path/embed")),
  );
  assert.ok(html.includes("/js/movie-proxy-client.js"));
  const js = rewriteJsImports(
    'import("./chunk.js"); export {x} from "./lib.js";',
    new URL("https://provider.example/assets/index.js"),
  );
  assert.ok(
    js.includes(encodeURIComponent("https://provider.example/assets/chunk.js")),
  );
  assert.ok(
    js.includes(encodeURIComponent("https://provider.example/assets/lib.js")),
  );
});

test("movie proxy client repairs provider-prefixed absolute relay URLs", () => {
  const client = fs.readFileSync(
    new URL("../public/js/movie-proxy-client.js", import.meta.url),
    "utf8",
  );
  assert.ok(client.includes("trimmed.indexOf(absoluteProxy)"));
  assert.ok(client.includes("trimmed.slice(embeddedProxyIndex)"));
  assert.match(client, /location\.origin\s*\+\s*PROXY_ROUTE/);
});

test("compression is decoded correctly and oversized/broken text is rejected", () => {
  const data = Buffer.from("<html>test</html>");
  assert.deepEqual(decompressBuffer(zlib.gzipSync(data), "gzip"), data);
  assert.deepEqual(decompressBuffer(zlib.brotliCompressSync(data), "br"), data);
  assert.throws(() => decompressBuffer(Buffer.from("broken"), "gzip"));
  assert.throws(() => decompressBuffer(data, "unknown"));
  assert.throws(() =>
    decompressBuffer(
      zlib.gzipSync(Buffer.alloc(16 * 1024 * 1024 + 1, 65)),
      "gzip",
    ),
  );
});

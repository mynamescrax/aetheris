import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import Fastify from "fastify";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { envNumber } from "../lib/env.js";

test("numeric environment settings distinguish zero from invalid values", () => {
  const name = "AETHERIS_TEST_NUMERIC_SETTING";
  const previous = process.env[name];
  try {
    for (const raw of [
      undefined,
      "",
      "  ",
      "invalid",
      "Infinity",
      "NaN",
      "-1",
    ]) {
      if (raw === undefined) delete process.env[name];
      else process.env[name] = raw;
      assert.equal(envNumber(name, 192), 192, String(raw));
    }
    for (const [raw, expected] of [
      ["0", 0],
      [" 0 ", 0],
      ["1.5", 1.5],
      ["256", 256],
    ]) {
      process.env[name] = raw;
      assert.equal(envNumber(name, 192), expected);
    }
    process.env[name] = "0";
    assert.equal(envNumber(name, 12, 1), 12);
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});

test("startup loads .env before feature imports and preserves host settings", () => {
  const root = new URL("../", import.meta.url);
  const index = readFileSync(new URL("index.js", root), "utf8");
  assert.match(index, /^import "\.\/lib\/load-env\.js";/);
  const dir = mkdtempSync(join(tmpdir(), "aetheris-config-"));
  const env = { ...process.env, AETHERIS_TEST_HOST: "host" };
  delete env.AETHERIS_TEST_FILE;
  try {
    writeFileSync(
      join(dir, ".env"),
      "AETHERIS_TEST_FILE=file\nAETHERIS_TEST_HOST=dotenv\n",
    );
    writeFileSync(
      join(dir, "feature.mjs"),
      "export const value = process.env.AETHERIS_TEST_FILE;",
    );
    writeFileSync(
      join(dir, "entry.mjs"),
      `
      import ${JSON.stringify(new URL("lib/load-env.js", root).href)};
      import { value } from './feature.mjs';
      console.log(JSON.stringify({ value, host: process.env.AETHERIS_TEST_HOST }));
    `,
    );
    const result = spawnSync(process.execPath, [join(dir, "entry.mjs")], {
      cwd: dir,
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      value: "file",
      host: "host",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup without a .env file remains supported", () => {
  const dir = mkdtempSync(join(tmpdir(), "aetheris-config-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import ${JSON.stringify(new URL("../lib/load-env.js", import.meta.url).href)};`,
      ],
      { cwd: dir, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("zero game cache budget neither reads nor creates a disk cache", async (t) => {
  const previous = process.env.GAME_ASSET_DISK_CACHE_MB;
  let registerGameAssets;
  try {
    process.env.GAME_ASSET_DISK_CACHE_MB = "0";
    ({ registerGameAssets } = await import("../lib/game-assets.js?zero-cache"));
  } finally {
    if (previous === undefined) delete process.env.GAME_ASSET_DISK_CACHE_MB;
    else process.env.GAME_ASSET_DISK_CACHE_MB = previous;
  }
  const dir = mkdtempSync(join(tmpdir(), "aetheris-config-cache-"));
  const cacheDir = join(dir, "disabled");
  const app = Fastify();
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const bytes = Buffer.alloc(5 * 1024 * 1024, 1);
  let calls = 0;
  registerGameAssets(app, {
    cacheDir,
    fetchimpl: async () => {
      calls++;
      return new Response(bytes, {
        headers: { "content-length": String(bytes.length) },
      });
    },
  });
  for (let i = 0; i < 2; i++) {
    const response = await app.inject(
      "/game-assets/m/jsdelivr/gh/example/repo@main/game.zip",
    );
    assert.equal(response.statusCode, 200);
    assert.equal(response.rawPayload.length, bytes.length);
  }
  assert.equal(calls, 2);
  assert.equal(existsSync(cacheDir), false);
});

test("zero movie cache budget fetches each media body again", async (t) => {
  const previous = process.env.MOVIE_SEGMENT_CACHE_MB;
  let registerMovieRelay;
  try {
    process.env.MOVIE_SEGMENT_CACHE_MB = "0";
    ({ registerMovieRelay } = await import("../movie-relay.js?zero-cache"));
  } finally {
    if (previous === undefined) delete process.env.MOVIE_SEGMENT_CACHE_MB;
    else process.env.MOVIE_SEGMENT_CACHE_MB = previous;
  }
  let calls = 0;
  const upstream = http.createServer((_req, res) => {
    calls++;
    res.writeHead(200, { "content-type": "video/mp4", "content-length": 1024 });
    res.end(Buffer.alloc(1024, 1));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const app = Fastify();
  t.after(async () => {
    await app.close();
    await new Promise((resolve) => upstream.close(resolve));
  });
  registerMovieRelay(app, {
    resolveTarget: async (raw) => ({
      url: new URL(raw),
      addresses: [{ address: "127.0.0.1", family: 4 }],
    }),
  });
  const url =
    "/movie-proxy?url=" +
    encodeURIComponent(
      `http://fixture.test:${upstream.address().port}/clip.mp4`,
    );
  for (let i = 0; i < 2; i++) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 200);
    assert.equal(response.rawPayload.length, 1024);
    assert.equal(response.headers["x-movie-cache"], undefined);
  }
  assert.equal(calls, 2);
});

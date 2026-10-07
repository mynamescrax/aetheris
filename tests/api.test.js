import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createServer, get as httpGet } from "node:http";
import { WebSocket } from "ws";

const root = fileURLToPath(new URL("../", import.meta.url));
let child, base, runtime, provider, alice, bob, legacyToken;
const device = () => randomBytes(32).toString("hex");
const headers = (token) => ({
  "Content-Type": "application/json",
  ...(token ? { Authorization: "Bearer " + token } : {}),
});
async function api(path, options = {}) {
  const res = await fetch(base + path, options);
  return { status: res.status, headers: res.headers, data: await res.json() };
}
async function register(name, id = device()) {
  const result = await api("/api/accounts/register", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      username: name,
      password: "local-test-password",
      deviceId: id,
    }),
  });
  return { ...result, deviceId: id };
}

before(async () => {
  runtime = mkdtempSync(join(tmpdir(), "aetheris-test-"));
  provider = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      return res.end(
        JSON.stringify({ data: [{ id: "test-chat" }, { id: "test-image" }] }),
      );
    }
    if (req.url.startsWith("/3/search/test")) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ seen: req.url }));
    }
    if (req.url.startsWith("/3/search/badkey")) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ status_message: "Invalid API key" }));
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      // model "upstream-NNN" makes the fixture fail with that status
      const fault = /"model":"upstream-(\d+)"/.exec(body);
      if (fault) {
        res.writeHead(Number(fault[1]), { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
      }
      if (req.url === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          'data: {"choices":[{"delta":{"content":"Local stream works"}}]}\n\ndata: [DONE]\n\n',
        );
      } else {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            data: [{ b64_json: "dGVzdA==", mime_type: "image/png" }],
          }),
        );
      }
    });
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));

  // A user file as written before commit 0b6c23ea: the session is keyed by
  // the raw 48-char token. Startup migration must re-key it to sha256(token).
  legacyToken = randomBytes(36).toString("base64url");
  mkdirSync(join(runtime, "database"), { recursive: true });
  writeFileSync(
    join(runtime, "database", "legacyuser.json"),
    JSON.stringify({
      username: "LegacyUser",
      passwordHash: "scrypt:" + "0".repeat(32) + ":" + "0".repeat(128),
      ip: "127.0.0.1",
      createdAt: Date.now(),
      sessions: { [legacyToken]: { ip: "127.0.0.1", createdAt: Date.now() } },
      dms: {},
    }),
  );

  child = spawn(process.execPath, [join(root, "index.js")], {
    cwd: runtime,
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      MAX_SSE_PER_IP: "3",
      REPORT_WEBHOOK_URL: "",
      STATS_WEBHOOK_URL: "",
      CRAX_GPT_KEY: "local-test-only",
      AI_REQUIRE_LOGIN: "true",
      CRAX_GPT_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1`,
      CRAX_GPT_MODEL: "test-chat",
      CRAX_GPT_IMAGE_MODEL: "test-image",
      TMDB_API_KEY: "local-test-only",
      TMDB_BASE_URL: `http://127.0.0.1:${provider.address().port}/3`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    let logs = "";
    const timer = setTimeout(
      () => reject(new Error("Test server did not start: " + logs)),
      15000,
    );
    child.stdout.on("data", (data) => {
      logs += data;
      const match = logs.match(/http:\/\/localhost:(\d+)/);
      if (match) {
        base = "http://127.0.0.1:" + match[1];
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (data) => {
      logs += data;
    });
    child.once("exit", (code) => {
      if (!base) {
        clearTimeout(timer);
        reject(new Error(`Server exited ${code}: ${logs}`));
      }
    });
  });
  alice = await register("TestAlice");
  bob = await register("TestBob");
  assert.equal(alice.status, 200);
  assert.equal(bob.status, 200);
});

after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }
  if (provider) await new Promise((resolve) => provider.close(resolve));
  if (runtime) rmSync(runtime, { recursive: true, force: true });
});

test("malformed and reserved account input returns 400, not 500", async () => {
  for (const username of [
    42,
    {},
    [],
    "__proto__",
    "constructor",
    "prototype",
    "a",
  ]) {
    const result = await api("/api/accounts/register", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        username,
        password: "local-test-password",
        deviceId: device(),
      }),
    });
    assert.equal(result.status, 400, JSON.stringify(username));
  }
  const result = await api("/api/accounts/login", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ username: "TestAlice", password: {} }),
  });
  assert.equal(result.status, 400);
});

test("simultaneous registrations cannot create two accounts for one device", async () => {
  const id = device();
  const results = await Promise.all([
    register("DeviceRaceA", id),
    register("DeviceRaceB", id),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 403]);
});

test("concurrent DMs are retained and timestamps are strictly increasing", async () => {
  const results = await Promise.all(
    Array.from({ length: 16 }, (_, i) =>
      api("/api/dm/" + (i % 2 ? "TestAlice" : "TestBob"), {
        method: "POST",
        headers: headers(i % 2 ? bob.data.token : alice.data.token),
        body: JSON.stringify({ message: "message " + i }),
      }),
    ),
  );
  results.forEach((result) => assert.equal(result.status, 200));
  const messages = await api("/api/dm/TestBob", {
    headers: headers(alice.data.token),
  });
  assert.equal(messages.data.length, 16);
  for (let i = 1; i < messages.data.length; i++)
    assert.ok(messages.data[i].time > messages.data[i - 1].time);
  const cursor = messages.data[7].time;
  const remaining = await api("/api/dm/TestBob?after=" + cursor, {
    headers: headers(alice.data.token),
  });
  assert.equal(remaining.data.length, 8);
  assert.match(messages.headers.get("cache-control"), /no-store/);
});

test("invalid DM bodies fail cleanly and read cursors do not mark later messages", async () => {
  for (const message of [null, 42, {}, "   "]) {
    const result = await api("/api/dm/TestBob", {
      method: "POST",
      headers: headers(alice.data.token),
      body: JSON.stringify({ message }),
    });
    assert.equal(result.status, 400);
  }
  await api("/api/dm-inbox/read/TestBob", {
    method: "POST",
    headers: headers(alice.data.token),
    body: JSON.stringify({ through: 0 }),
  });
  const inbox = await api("/api/dm-inbox", {
    headers: headers(alice.data.token),
  });
  assert.equal(inbox.data.conversations[0].unread, 8);
});

test("expired sessions cannot delete an account", async () => {
  const result = await register("ExpiredSession");
  const path = join(runtime, "database", "expiredsession.json");
  const user = JSON.parse(readFileSync(path, "utf8"));
  // sessions are keyed by sha256(token) server-side — edit whatever key
  // exists rather than assuming the raw token
  const sessionKey = Object.keys(user.sessions)[0];
  user.sessions[sessionKey].createdAt = Date.now() - 31 * 86400000;
  writeFileSync(path, JSON.stringify(user));
  const deleted = await api("/api/accounts/delete", {
    method: "DELETE",
    headers: headers(result.data.token),
    body: "{}",
  });
  assert.equal(deleted.status, 401);
  assert.equal(existsSync(path), true);
});

test("a stored session key cannot be replayed as a bearer token", async () => {
  const result = await register("StoredKeyReplay");
  assert.equal(result.status, 200);

  const path = join(runtime, "database", "storedkeyreplay.json");
  const storedKey = Object.keys(
    JSON.parse(readFileSync(path, "utf8")).sessions,
  )[0];
  assert.match(storedKey, /^[a-f0-9]{64}$/);

  const replay = await api("/api/accounts/me", {
    headers: headers(storedKey),
  });
  assert.equal(replay.status, 401);

  // a rejected replay must not evict the real session from the index
  const me = await api("/api/accounts/me", {
    headers: headers(result.data.token),
  });
  assert.equal(me.status, 200);
  assert.equal(me.data.username, "StoredKeyReplay");
});

test("legacy raw-token sessions migrate to hashed keys and keep working", async () => {
  const path = join(runtime, "database", "legacyuser.json");
  // startup migration re-keyed the session
  const keys = Object.keys(JSON.parse(readFileSync(path, "utf8")).sessions);
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^[a-f0-9]{64}$/);
  assert.notEqual(keys[0], legacyToken);

  // the raw token still authenticates...
  const me = await api("/api/accounts/me", {
    headers: headers(legacyToken),
  });
  assert.equal(me.status, 200);
  assert.equal(me.data.username, "LegacyUser");

  // ...but the migrated stored key does not
  const replay = await api("/api/accounts/me", {
    headers: headers(keys[0]),
  });
  assert.equal(replay.status, 401);
});

test("reports do not falsely succeed when the webhook is not configured", async () => {
  const result = await api("/api/report", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      issue: "Game not loading",
      steps: "Local QA test",
      deviceId: device(),
    }),
  });
  assert.equal(result.status, 503);
  assert.equal(result.data.ok, false);
});

test("movie relay rejects private targets and malformed referers", async () => {
  for (const url of [
    "http://127.0.0.1/",
    "http://[::ffff:7f00:1]/",
    "http://169.254.169.254/",
  ]) {
    const res = await fetch(
      base + "/movie-proxy?url=" + encodeURIComponent(url),
    );
    assert.equal(res.status, 403);
  }
  const res = await fetch(
    base + "/movie-proxy?url=https%3A%2F%2Fexample.com&referer=bad",
  );
  assert.equal(res.status, 400);
});

test("movie-ping is rate limited", async () => {
  let limited = false;
  for (let i = 0; i < 65; i++) {
    const res = await fetch(base + "/movie-ping?v=test&origin=test");
    if (res.status === 429) {
      limited = true;
      break;
    }
    assert.equal(res.status, 204);
  }
  assert.equal(limited, true);
});

test("TMDB passthrough injects the server key and forwards queries", async () => {
  const res = await api(
    "/api/tmdb/search/test?query=hello&page=2&api_key=client-fake",
  );
  assert.equal(res.status, 200);
  assert.equal(
    res.data.seen,
    "/3/search/test?query=hello&page=2&api_key=local-test-only",
  );
});

test("AI login option, model defaults, and streaming work with a local provider fixture", async () => {
  let res = await api("/api/ai/chat", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ messages: [{ role: "user", content: "test" }] }),
  });
  assert.equal(res.status, 401);
  res = await api("/api/ai/models", { headers: headers(alice.data.token) });
  assert.equal(res.data.default_model, "test-chat");
  const stream = await fetch(base + "/api/ai/chat", {
    method: "POST",
    headers: headers(alice.data.token),
    body: JSON.stringify({
      messages: [{ role: "user", content: "test" }],
      stream: true,
    }),
  });
  assert.equal(stream.status, 200);
  assert.match(await stream.text(), /Local stream works/);
  assert.equal(stream.headers.get("x-accel-buffering"), "no");
  const invalid = await api("/api/ai/images", {
    method: "POST",
    headers: headers(alice.data.token),
    body: JSON.stringify({ prompt: "test", n: 999 }),
  });
  assert.equal(invalid.status, 400);

  // anonymous AI is allowed by default, but oversized text is rejected
  // before any upstream spend
  const oversized = await api("/api/ai/chat", {
    method: "POST",
    headers: headers(alice.data.token),
    body: JSON.stringify({
      messages: [{ role: "user", content: "x".repeat(200_001) }],
    }),
  });
  assert.equal(oversized.status, 413);
});

test("a malformed WebSocket upstream cannot crash the server", async () => {
  await new Promise((resolve) => {
    const ws = new WebSocket(
      base.replace("http:", "ws:") + "/wsproxy/growden.io:invalid",
    );
    ws.on("error", resolve);
    ws.on("close", resolve);
  });
  assert.equal((await api("/online-count")).status, 200);
});

test("image relay rejects missing and non-public targets", async () => {
  let res = await fetch(base + "/img");
  assert.equal(res.status, 400);

  res = await fetch(
    base + "/img?url=" + encodeURIComponent("http://127.0.0.1/cover.png"),
  );
  assert.equal(res.status, 403);

  res = await fetch(
    base + "/img?url=" + encodeURIComponent("file:///etc/passwd"),
  );
  assert.equal(res.status, 403);

  res = await fetch(base + "/img?url=" + "x".repeat(9000));
  assert.equal(res.status, 400);

  // the server stays healthy after the rejected requests
  assert.equal((await api("/online-count")).status, 200);
});

test("served proxy bundles carry the legacy-Safari compat prefix", async () => {
  const prefix = '(()=>{if(typeof Object.hasOwn!=="function")';

  const core = await fetch(base + "/scramjet/scramjet.js");
  assert.equal(core.status, 200);
  assert.match(core.headers.get("content-type") || "", /javascript/);
  const coretext = await core.text();
  assert.ok(coretext.startsWith(prefix));
  assert.match(coretext, /BroadcastChannel/);

  const controller = await fetch(base + "/controller/controller.api.js");
  assert.equal(controller.status, 200);
  assert.match(controller.headers.get("content-type") || "", /javascript/);
  const controllertext = await controller.text();
  assert.ok(controllertext.startsWith(prefix));
  assert.match(controllertext, /BroadcastChannel/);
});

test("lc-relay accepts any origin (open relay) and same-origin hosts", async () => {
  const wsBase = base.replace("http:", "ws:");
  // OPEN RELAY (operator decision 2026-10-03): cross-origin upgrades must be
  // accepted so other sites can use the relay.
  const crossId = await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsBase + "/lc-relay", {
      headers: { origin: "https://evil.example" },
    });
    const timer = setTimeout(
      () => reject(new Error("cross-origin upgrade hung")),
      5000,
    );
    ws.on("open", () => {
      const room = Buffer.from("XORIGIN");
      const version = Buffer.from("1.0");
      const frame = Buffer.concat([
        Buffer.from([1, 0, room.length]),
        room,
        Buffer.from([version.length]),
        version,
      ]);
      ws.send(frame);
    });
    ws.on("message", (data) => {
      const buf = Buffer.from(data);
      if (buf[0] !== 2) return;
      clearTimeout(timer);
      ws.close();
      resolve(buf[1]);
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  assert.equal(crossId, 0);

  // A same-origin host can create a room and receives JOINED (opcode 2, id 0).
  const joinedId = await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsBase + "/lc-relay", {
      headers: { origin: base },
    });
    const timer = setTimeout(
      () => reject(new Error("same-origin join timed out")),
      5000,
    );
    ws.on("open", () => {
      const room = Buffer.from("TESTROOM");
      const version = Buffer.from("1.0");
      const frame = Buffer.concat([
        Buffer.from([1, 0, room.length]),
        room,
        Buffer.from([version.length]),
        version,
      ]);
      ws.send(frame);
    });
    ws.on("message", (data) => {
      const buf = Buffer.from(data);
      if (buf[0] !== 2) return;
      clearTimeout(timer);
      ws.close();
      resolve(buf[1]);
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  assert.equal(joinedId, 0);

  // Crafted control characters in a room code are rejected instead of
  // reaching the server log.
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsBase + "/lc-relay", {
      headers: { origin: base },
    });
    const timer = setTimeout(
      () => reject(new Error("crafted join hung")),
      5000,
    );
    ws.on("open", () => {
      const room = Buffer.from("bad\r\nroom");
      const version = Buffer.from("1.0");
      ws.send(
        Buffer.concat([
          Buffer.from([1, 0, room.length]),
          room,
          Buffer.from([version.length]),
          version,
        ]),
      );
    });
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.on("close", finish);
    ws.on("error", finish);
  });
  assert.equal((await api("/online-count")).status, 200);
});

test("wisp rejects cross-origin WebSocket upgrades and accepts same-origin ones", async () => {
  const wsBase = base.replace("http:", "ws:");

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsBase + "/wisp/", {
      headers: { origin: "https://evil.example" },
    });
    const timer = setTimeout(
      () => reject(new Error("cross-origin wisp upgrade hung")),
      5000,
    );
    ws.on("open", () => {
      clearTimeout(timer);
      ws.close();
      reject(new Error("cross-origin wisp upgrade was accepted"));
    });
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.on("error", finish);
    ws.on("close", finish);
  });

  // same-origin clients still complete the upgrade
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsBase + "/wisp/", {
      headers: { origin: base },
    });
    const timer = setTimeout(
      () => reject(new Error("same-origin wisp upgrade timed out")),
      5000,
    );
    ws.on("open", () => {
      clearTimeout(timer);
      ws.close();
      resolve();
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  assert.equal((await api("/online-count")).status, 200);
});

test("the online counter caps SSE connections per IP", async () => {
  const open = () =>
    new Promise((resolve, reject) => {
      const req = httpGet(base + "/online", (res) => resolve({ req, res }));
      req.on("error", reject);
    });
  const streams = [];
  try {
    for (let i = 0; i < 3; i++) {
      const { req, res } = await open();
      assert.equal(res.statusCode, 200);
      streams.push(req);
    }
    const { req, res } = await open();
    assert.equal(res.statusCode, 503);
    req.destroy();
  } finally {
    for (const req of streams) req.destroy();
  }
});

test("account deletion removes counterpart conversations", async () => {
  const result = await api("/api/accounts/delete", {
    method: "DELETE",
    headers: headers(bob.data.token),
    body: "{}",
  });
  assert.equal(result.status, 200);
  const inbox = await api("/api/dm-inbox", {
    headers: headers(alice.data.token),
  });
  assert.equal(inbox.data.conversations.length, 0);
  assert.equal(existsSync(join(runtime, "database", "testbob.json")), false);
});

test("authenticated API GETs are rate limited per account", async () => {
  const account = await register("GetLimitUser");
  assert.equal(account.status, 200);

  let limited = false;
  for (let i = 0; i < 320; i++) {
    const res = await api("/api/accounts/me", {
      headers: headers(account.data.token),
    });
    if (res.status === 429) {
      limited = true;
      break;
    }
    assert.equal(res.status, 200);
  }
  assert.equal(limited, true);

  // the limit is per account: another session is unaffected
  const other = await api("/api/accounts/me", {
    headers: headers(alice.data.token),
  });
  assert.equal(other.status, 200);
});

test("polling a DM thread does not use up the send limit", async () => {
  const a = await register("PollerA");
  const b = await register("PollerB");
  for (let i = 0; i < 125; i++) {
    const res = await api("/api/dm/PollerB", { headers: headers(a.data.token) });
    assert.equal(res.status, 200);
  }
  const sent = await api("/api/dm/PollerB", {
    method: "POST",
    headers: headers(a.data.token),
    body: JSON.stringify({ message: "hi" }),
  });
  assert.equal(sent.status, 200);
  assert.equal(b.status, 200);
});

test("marking an unknown conversation read does not grow the user file", async () => {
  for (const other of ["NobodyOne", "NobodyTwo"]) {
    const res = await api("/api/dm-inbox/read/" + other, {
      method: "POST",
      headers: headers(alice.data.token),
      body: "{}",
    });
    assert.equal(res.status, 200);
  }
  const stored = JSON.parse(
    readFileSync(join(runtime, "database", "testalice.json"), "utf8"),
  );
  assert.equal(Object.hasOwn(stored.lastRead || {}, "nobodyone"), false);
  assert.equal(Object.hasOwn(stored.lastRead || {}, "nobodytwo"), false);
});

test("TMDB passthrough cannot climb out of the API base path", async () => {
  const res = await fetch(base + "/api/tmdb/x%2F..%2F..%2Fv1%2Fmodels");
  assert.equal(res.status, 400);
});

test("TMDB rejecting the server key is a 502, not a 401", async () => {
  const res = await api("/api/tmdb/search/badkey?query=x");
  assert.equal(res.status, 502);
  assert.match(res.data.error, /misconfigured/);
});

test("AI upstream auth errors are reported as server misconfiguration", async () => {
  for (const stream of [false, true]) {
    const res = await api("/api/ai/chat", {
      method: "POST",
      headers: headers(alice.data.token),
      body: JSON.stringify({
        model: "upstream-401",
        messages: [{ role: "user", content: "test" }],
        stream,
      }),
    });
    assert.equal(res.status, 502);
    assert.match(res.data.error, /AI service misconfigured/);
  }
  const busy = await api("/api/ai/chat", {
    method: "POST",
    headers: headers(alice.data.token),
    body: JSON.stringify({
      model: "upstream-429",
      messages: [{ role: "user", content: "test" }],
    }),
  });
  assert.equal(busy.status, 429);
  assert.match(busy.data.error, /busy/);
});

test("DM sends are limited per account, not per shared IP", async () => {
  const noisy = await register("DmNoisy");
  const quiet = await register("DmQuiet");
  const send = (from, to, message) =>
    api("/api/dm/" + to, {
      method: "POST",
      headers: headers(from.data.token),
      body: JSON.stringify({ message }),
    });
  let limited = false;
  for (let i = 0; i < 65; i++) {
    const res = await send(noisy, "DmQuiet", "msg " + i);
    if (res.status === 429) {
      limited = true;
      break;
    }
    assert.equal(res.status, 200);
  }
  assert.equal(limited, true);
  // another account behind the same IP is unaffected
  assert.equal((await send(quiet, "DmNoisy", "hi")).status, 200);
});

function login(username, password, ip) {
  return api("/api/accounts/login", {
    method: "POST",
    headers: { ...headers(), "X-Forwarded-For": ip },
    body: JSON.stringify({ username, password }),
  });
}

test("failed logins from one IP cannot lock the account out elsewhere", async () => {
  let limited = false;
  for (let i = 0; i < 12; i++) {
    const res = await login("TestAlice", "wrong-password", "203.0.113.7");
    if (res.status === 429) {
      limited = true;
      break;
    }
    assert.equal(res.status, 401);
  }
  assert.equal(limited, true);
  // even the right password is refused from the attacking IP
  const blocked = await login("TestAlice", "local-test-password", "203.0.113.7");
  assert.equal(blocked.status, 429);
  const victim = await login(
    "TestAlice",
    "local-test-password",
    "198.51.100.20",
  );
  assert.equal(victim.status, 200);
});

test("one IP cannot spray failed logins across many usernames", async () => {
  let limited = false;
  for (let i = 0; i < 55; i++) {
    const res = await login("Spray" + i, "wrong-password", "203.0.113.8");
    if (res.status === 429) {
      limited = true;
      break;
    }
    assert.equal(res.status, 401);
  }
  assert.equal(limited, true);
  const other = await login("Spray0", "wrong-password", "198.51.100.21");
  assert.equal(other.status, 401);
});

test("new passwords need 6 characters but old short ones can still log in", async () => {
  const res = await api("/api/accounts/register", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      username: "ShortPassword",
      password: "12345",
      deviceId: device(),
    }),
  });
  assert.equal(res.status, 400);
  // a 4-character password is a valid login format (wrong, not malformed)
  const old = await login("TestAlice", "abcd", "198.51.100.22");
  assert.equal(old.status, 401);
});

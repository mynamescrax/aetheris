import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket } from "ws";

const root = fileURLToPath(new URL("../", import.meta.url));
let child, base, runtime, provider, alice, bob;
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
    req.resume();
    req.on("end", () => {
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
  child = spawn(process.execPath, [join(root, "index.js")], {
    cwd: runtime,
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      REPORT_WEBHOOK_URL: "",
      STATS_WEBHOOK_URL: "",
      CRAX_GPT_KEY: "local-test-only",
      AI_REQUIRE_LOGIN: "true",
      CRAX_GPT_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1`,
      CRAX_GPT_MODEL: "test-chat",
      CRAX_GPT_IMAGE_MODEL: "test-image",
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
  user.sessions[result.data.token].createdAt = Date.now() - 31 * 86400000;
  writeFileSync(path, JSON.stringify(user));
  const deleted = await api("/api/accounts/delete", {
    method: "DELETE",
    headers: headers(result.data.token),
    body: "{}",
  });
  assert.equal(deleted.status, 401);
  assert.equal(existsSync(path), true);
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

test("AI login option, model defaults, and streaming work with a local provider fixture", async () => {
  let res = await api("/api/ai/chat", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ messages: [{ role: "user", content: "test" }] }),
  });
  assert.equal(res.status, 401);
  res = await api("/api/ai/models");
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

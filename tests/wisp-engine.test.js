import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { createwispengine } from "../lib/wisp-engine.js";

// Minimal Wisp v1 client: CONNECT (0x01), DATA (0x02), CONTINUE (0x03),
// CLOSE (0x04). Stream ids and ports are little-endian.
function packet(type, stream, payload) {
  const head = Buffer.alloc(5);
  head.writeUInt8(type, 0);
  head.writeUInt32LE(stream, 1);
  return Buffer.concat([head, payload]);
}

function connectpacket(stream, host, port) {
  const p = Buffer.alloc(3);
  p.writeUInt8(0x01, 0); // TCP
  p.writeUInt16LE(port, 1);
  return packet(0x01, stream, Buffer.concat([p, Buffer.from(host)]));
}

// Opens one stream to host:port; resolves with the bytes received or
// "closed:<reason>" if the server refused the stream.
function wispget(wsurl, host, port, request) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsurl);
    let got = Buffer.alloc(0);
    const timer = setTimeout(() => {
      ws.terminate();
      got.length ? resolve(got.toString("latin1")) : reject(new Error("timeout"));
    }, 15000);
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ws.on("open", () => {
      ws.send(connectpacket(1, host, port));
      if (request) ws.send(packet(0x02, 1, Buffer.from(request)));
    });
    ws.on("message", (data) => {
      const buf = Buffer.from(data);
      const type = buf.readUInt8(0);
      const stream = buf.readUInt32LE(1);
      if (stream !== 1) return;
      if (type === 0x02) got = Buffer.concat([got, buf.subarray(5)]);
      if (type === 0x04) {
        clearTimeout(timer);
        ws.close();
        resolve(
          got.length ? got.toString("latin1") : "closed:" + buf.readUInt8(5),
        );
      }
    });
  });
}

async function withengine(engineName, fn) {
  const engine = createwispengine({
    engine: engineName,
    workers: 1,
    basePort: 4532,
    blockedDomains: ["pornhub.com"],
    blockedPorts: [25],
    dnsServers: ["1.1.1.3"],
    log: { log() {}, error() {} },
  });
  await engine.start();
  const server = createServer();
  server.on("upgrade", (req, socket, head) => engine.route(req, socket, head));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `ws://127.0.0.1:${server.address().port}/wisp/`;
  try {
    await fn(url, engine);
  } finally {
    await engine.stop();
    server.close();
  }
}

const online = process.env.WISP_NETWORK_TESTS !== "0";
const GET = "GET / HTTP/1.0\r\nHost: example.com\r\n\r\n";

for (const name of ["wispurr", "wisp-js"]) {
  test(`${name}: relays TCP and refuses blocked hosts and ports`, { skip: !online }, async () => {
    await withengine(name, async (url, engine) => {
      assert.equal(engine.status().engine, name);
      const ok = await wispget(url, "example.com", 80, GET);
      assert.match(ok, /^HTTP\/1\.[01] \d{3}/);
      assert.match(await wispget(url, "pornhub.com", 443), /^closed:/);
      assert.match(await wispget(url, "example.com", 25), /^closed:/);
      assert.match(await wispget(url, "127.0.0.1", 22), /^closed:/);
    });
  });
}

test("wispurr: a crashed worker falls back to wisp-js, then respawns", { skip: !online }, async () => {
  await withengine("wispurr", async (url, engine) => {
    const first = engine.status().workers[0];
    assert.equal(first.up, true);
    process.kill(first.pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(engine.status().workers[0].up, false);
    // still served, by the in-process fallback
    assert.match(await wispget(url, "example.com", 80, GET), /^HTTP\/1\.[01]/);
    assert.ok(engine.status().fallbacks >= 1);
    const deadline = Date.now() + 8000;
    while (!engine.status().workers[0].up && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 100));
    const again = engine.status().workers[0];
    assert.equal(again.up, true);
    assert.notEqual(again.pid, first.pid);
    assert.match(await wispget(url, "example.com", 80, GET), /^HTTP\/1\.[01]/);
  });
});

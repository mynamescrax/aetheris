import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { WebSocket } from "ws";
import { createEosRelay } from "../eos-relay.js";

const PUID_A = "a".repeat(32);
const PUID_B = "b".repeat(32);

function hello(puid) {
  return Buffer.concat([Buffer.from("H"), Buffer.from(puid, "latin1")]);
}

function packet(dst, payload) {
  return Buffer.concat([
    Buffer.from("P"),
    Buffer.from(dst, "latin1"),
    Buffer.from(payload),
  ]);
}

function advertise(sid, record) {
  const id = Buffer.from(sid, "latin1");
  const body = Buffer.from(record);
  const frame = Buffer.alloc(3 + id.length + body.length);
  frame[0] = 0x53;
  frame.writeUInt16BE(id.length, 1);
  id.copy(frame, 3);
  body.copy(frame, 3 + id.length);
  return frame;
}

function search(qid) {
  const frame = Buffer.alloc(5);
  frame[0] = 0x51;
  frame.writeUInt32BE(qid, 1);
  return frame;
}

async function startRelay(options = {}) {
  const relay = createEosRelay({ log: () => {}, ...options });
  const server = http.createServer((req, res) => {
    res.writeHead(426);
    res.end();
  });
  server.on("upgrade", (req, socket, head) => relay.upgrade(req, socket, head));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    relay,
    url: `ws://127.0.0.1:${server.address().port}/eos-relay`,
    async close() {
      relay.stop();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function connect(url, options = {}) {
  const ws = new WebSocket(url, options);
  const inbox = [];
  const waiters = [];
  ws.on("message", (data) => {
    const frame = Buffer.from(data);
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else inbox.push(frame);
  });
  let closed = null;
  ws.on("close", (code, reason) => {
    closed = { code, reason: String(reason) };
  });
  return {
    ws,
    send: (frame) => ws.send(frame),
    next(ms = 2000) {
      return new Promise((resolve, reject) => {
        if (inbox.length) return resolve(inbox.shift());
        const waiter = (frame) => {
          clearTimeout(timer);
          resolve(frame);
        };
        const timer = setTimeout(() => {
          // A timed-out waiter must not stay queued, or it swallows the next frame.
          const at = waiters.indexOf(waiter);
          if (at !== -1) waiters.splice(at, 1);
          reject(new Error("no relay frame"));
        }, ms);
        waiters.push(waiter);
      });
    },
    open() {
      return new Promise((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
    },
    closed(ms = 2000) {
      return new Promise((resolve, reject) => {
        if (closed) return resolve(closed);
        const timer = setTimeout(() => reject(new Error("socket stayed open")), ms);
        ws.once("close", (code, reason) => {
          clearTimeout(timer);
          resolve({ code, reason: String(reason) });
        });
      });
    },
  };
}

test("a public relay lists servers and forwards packets between players", async (t) => {
  const relay = await startRelay();
  t.after(() => relay.close());

  const host = connect(relay.url);
  const client = connect(relay.url);
  t.after(() => {
    host.ws.terminate();
    client.ws.terminate();
  });
  await Promise.all([host.open(), client.open()]);
  host.send(hello(PUID_A));
  client.send(hello(PUID_B));

  const record = Buffer.from("server-record");
  host.send(advertise("room1", record));
  client.send(search(7));

  const reply = await client.next();
  assert.equal(reply[0], 0x52);
  assert.equal(reply.readUInt32BE(1), 7);
  assert.equal(reply.readUInt16BE(5), 1);
  const length = reply.readUInt32BE(7);
  assert.deepEqual(reply.subarray(11, 11 + length), record);
  assert.equal(relay.relay.status().sessions, 1);

  host.send(packet(PUID_B, "hello-client"));
  const forwarded = await client.next();
  assert.equal(forwarded[0], 0x50);
  assert.equal(forwarded.toString("latin1", 1, 33), PUID_A);
  assert.equal(forwarded.toString("latin1", 33), "hello-client");

  const unknown = "z".repeat(32);
  client.send(packet(unknown, "nowhere"));
  const gone = await client.next();
  assert.equal(gone[0], 0x47);
  assert.equal(gone.toString("latin1", 1, 33), unknown);
  assert.equal(relay.relay.status().dropped, 1);
});

test("a player's servers disappear when its socket closes", async (t) => {
  const relay = await startRelay();
  t.after(() => relay.close());

  const host = connect(relay.url);
  const watcher = connect(relay.url);
  t.after(() => {
    host.ws.terminate();
    watcher.ws.terminate();
  });
  await Promise.all([host.open(), watcher.open()]);
  host.send(hello(PUID_A));
  watcher.send(hello(PUID_B));
  host.send(advertise("room1", Buffer.from("record")));
  watcher.send(search(1));
  assert.equal((await watcher.next()).readUInt16BE(5), 1);

  host.ws.close();
  const gone = await watcher.next();
  assert.equal(gone[0], 0x47);
  assert.equal(gone.toString("latin1", 1, 33), PUID_A);
  assert.equal(relay.relay.status().sessions, 0);

  watcher.send(search(2));
  assert.equal((await watcher.next()).readUInt16BE(5), 0);
});

test("reconnecting with the same id replaces the older socket", async (t) => {
  const relay = await startRelay();
  t.after(() => relay.close());

  const first = connect(relay.url);
  const second = connect(relay.url);
  t.after(() => {
    first.ws.terminate();
    second.ws.terminate();
  });
  await Promise.all([first.open(), second.open()]);
  first.send(hello(PUID_A));
  await first.next(50).catch(() => {});
  second.send(hello(PUID_A));

  const closed = await first.closed();
  assert.equal(closed.code, 1000);
  assert.equal(closed.reason, "replaced");
  assert.equal(relay.relay.status().peers, 1);
  assert.equal(relay.relay.status().replaced, 1);
});

test("bad hellos, bad frames and oversized frames close the socket", async (t) => {
  const relay = await startRelay({ maxFrameBytes: 64 });
  t.after(() => relay.close());

  const shortHello = connect(relay.url);
  t.after(() => shortHello.ws.terminate());
  await shortHello.open();
  shortHello.send(Buffer.from("H"));
  assert.equal((await shortHello.closed()).code, 1008);

  const early = connect(relay.url);
  t.after(() => early.ws.terminate());
  await early.open();
  early.send(search(1));
  assert.equal((await early.closed()).reason, "hello_first");

  const huge = connect(relay.url);
  t.after(() => huge.ws.terminate());
  await huge.open();
  huge.send(Buffer.concat([hello(PUID_A), Buffer.alloc(256)]));
  assert.equal((await huge.closed()).code, 1009);
});

test("a whole IP cannot open unlimited sockets", async (t) => {
  const relay = await startRelay({ maxConnectionsPerIp: 1 });
  t.after(() => relay.close());

  const first = connect(relay.url);
  t.after(() => first.ws.terminate());
  await first.open();

  const second = connect(relay.url);
  await assert.rejects(second.open(), /503|Unexpected server response/);
  assert.equal(relay.relay.status().connections, 1);
});

test("an idle player is kept alive with data, not just pings", async (t) => {
  // A client that never pongs, like a page behind a proxy that drops ping frames.
  const relay = await startRelay({ heartbeatMs: 25, keepaliveMs: 40, idleTimeoutMs: 600 });
  t.after(() => relay.close());

  const player = connect(relay.url, { autoPong: false });
  t.after(() => player.ws.terminate());
  await player.open();
  player.send(hello(PUID_A));

  const keepalive = await player.next(500);
  assert.equal(keepalive[0], 0x52, "keepalive is a search reply the game ignores");
  assert.equal(keepalive.readUInt32BE(1), 0xffffffff, "its qid matches no pending search");
  assert.equal(keepalive.readUInt16BE(5), 0);

  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(relay.relay.status().peers, 1, "no pong must not cost the player its socket");
  player.send(search(3));
  let reply = await player.next();
  // Keepalives keep arriving; the real answer is the one whose qid matches.
  while (reply.readUInt32BE(1) === 0xffffffff) reply = await player.next();
  assert.equal(reply[0], 0x52);
  assert.equal(reply.readUInt32BE(1), 3, "real search replies still match their qid");
});

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

test("a room is a private relay: servers and packets stay inside it", async (t) => {
  const relay = await startRelay();
  t.after(() => relay.close());

  const host = connect(relay.url + "?room=friends");
  const outsider = connect(relay.url + "?room=other");
  const friend = connect(relay.url + "?room=FRIENDS");
  t.after(() => {
    host.ws.terminate();
    outsider.ws.terminate();
    friend.ws.terminate();
  });
  await Promise.all([host.open(), outsider.open(), friend.open()]);
  host.send(hello(PUID_A));
  outsider.send(hello(PUID_B));
  friend.send(hello("c".repeat(32)));
  host.send(advertise("room1", Buffer.from("private")));
  await settle();

  outsider.send(search(1));
  assert.equal((await outsider.next()).readUInt16BE(5), 0);
  friend.send(search(2));
  const listed = await friend.next();
  assert.equal(listed.readUInt16BE(5), 1, "the room sees its own servers");

  host.send(packet(PUID_B, "cross-room"));
  const gone = await host.next();
  assert.equal(gone[0], 0x47, "packets must not cross rooms");

  host.send(packet("c".repeat(32), "same-room"));
  const forwarded = await friend.next();
  assert.equal(forwarded[0], 0x50);
  assert.equal(forwarded.toString("latin1", 33), "same-room");
  assert.equal(relay.relay.status().rooms, 2);
});

test("maxSessions caps the servers one connection may advertise", async (t) => {
  const relay = await startRelay();
  t.after(() => relay.close());

  const host = connect(relay.url + "?maxSessions=1");
  const watcher = connect(relay.url);
  t.after(() => {
    host.ws.terminate();
    watcher.ws.terminate();
  });
  await Promise.all([host.open(), watcher.open()]);
  host.send(hello(PUID_A));
  watcher.send(hello(PUID_B));
  host.send(advertise("room1", Buffer.from("first")));
  host.send(advertise("room2", Buffer.from("second")));
  await settle();

  watcher.send(search(1));
  const reply = await watcher.next();
  assert.equal(reply.readUInt16BE(5), 1, "the second server is refused, not the first");
  const length = reply.readUInt32BE(7);
  assert.equal(reply.toString("latin1", 11, 11 + length), "first");
  assert.equal(relay.relay.status().sessions, 1);
});

test("Q 0xFFFFFFFF is a silent keepalive that still counts as activity", async (t) => {
  const relay = await startRelay({ heartbeatMs: 60_000, keepaliveMs: 60_000, idleTimeoutMs: 300 });
  t.after(() => relay.close());

  const player = connect(relay.url, { autoPong: false });
  t.after(() => player.ws.terminate());
  await player.open();
  player.send(hello(PUID_A));
  await settle(60);

  const keepalive = Buffer.alloc(5);
  keepalive[0] = 0x51;
  keepalive.writeUInt32BE(0xffffffff, 1);

  // No pongs at all: only these silent keepalives hold the socket inside its 300 ms window,
  // for 800 ms, which is well past where silence would have dropped it.
  for (let i = 0; i < 8; i++) {
    player.send(keepalive);
    await settle(100);
  }
  assert.equal(relay.relay.status().peers, 1, "keepalives kept the player connected");
  await assert.rejects(player.next(150), /no relay frame/, "a keepalive is never answered");

  player.send(search(5));
  const reply = await player.next();
  assert.equal(reply.readUInt32BE(1), 5, "a real search still works afterwards");
});

test("a large session record survives the relay intact", async (t) => {
  const relay = await startRelay();
  t.after(() => relay.close());

  // The game's record is length-prefixed fields plus up to 64 attributes, so it can be
  // several KB; a cap that is too small would silently hide a hosted server.
  const host = connect(relay.url);
  const watcher = connect(relay.url);
  t.after(() => {
    host.ws.terminate();
    watcher.ws.terminate();
  });
  await Promise.all([host.open(), watcher.open()]);
  host.send(hello(PUID_A));
  watcher.send(hello(PUID_B));
  const record = Buffer.alloc(12 * 1024);
  for (let i = 0; i < record.length; i++) record[i] = 0x61 + (i % 26);
  host.send(advertise("bigserver", record));
  await settle();

  watcher.send(search(9));
  const reply = await watcher.next();
  assert.equal(reply.readUInt16BE(5), 1);
  const length = reply.readUInt32BE(7);
  assert.equal(length, record.length);
  assert.deepEqual(reply.subarray(11, 11 + length), record);
});

test("the public docs page covers every frame and option", () => {
  const html = fs.readFileSync(
    new URL("../public/relay-api.html", import.meta.url),
    "utf8",
  );
  assert.ok(html.includes("wss://aetheris.win/eos-relay"));
  for (const kind of ["H", "P", "S", "D", "Q", "R", "G"])
    assert.ok(html.includes(`<code>${kind}</code>`), `frame ${kind}`);
  for (const option of ["room", "maxSessions", "idle"])
    assert.ok(html.includes(`<code>${option}</code>`), `option ${option}`);
});

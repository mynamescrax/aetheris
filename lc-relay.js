// LC-Wisp relay — port of the game's standalone relay (relay/server.js of the LC
// project) mounted into Aetheris' Fastify upgrade hook, so the game dials
// wss://<this domain>/lc-relay and no extra process is needed.
//
// Why a relay and not the wisp servers from config.js: wisp servers are pure
// TCP/UDP tunnels — they open a connection from the browser to an arbitrary
// host. A WebGL host lives in a browser and cannot accept inbound connections,
// so a rendezvous point is required. Serving this endpoint from the SAME origin
// as the game means the WebGL build's same-origin WebSocket rides the same wisp
// tunnel as the page.
//
// Wire protocol (binary frames, integers little-endian):
//   1 JOIN       C->R  [op][role(0 host,1 client)][roomLen][room utf8][verLen][version utf8]
//   2 JOINED     R->C  [op][wireId u64]                       (host always gets 0)
//   3 PEER_JOIN  R->H  [op][peerId u64]
//   4 PEER_LEAVE R->H  [op][peerId u64]
//   5 DATA       C->R  [op][dst u64][payload]  -> relay re-emits [op][src u64][payload]
//   6 ERROR      R->C  [op][reason utf8]
//   7 KICK       H->R  [op][targetId u64]
//   8 PING       any   [op][echo u64]  -> reply 9 PONG [op][echo u64] to the sender

import { WebSocket, WebSocketServer } from "ws";

const MAX_PLAYERS = 4;
const IDLE_TIMEOUT_MS = 40 * 1000;
const MAX_FRAME_BYTES = 1024 * 1024;
// The relay is unauthenticated, so without caps any socket could mint
// unlimited rooms and pin memory. Sizing: MAX_ROOMS_PER_IP must tolerate a
// whole classroom behind one NAT address hosting concurrently.
const MAX_ROOMS = 250;
const MAX_ROOMS_PER_IP = 5;

const OpJoin = 1;
const OpJoined = 2;
const OpPeerJoin = 3;
const OpPeerLeave = 4;
const OpData = 5;
const OpError = 6;
const OpKick = 7;
const OpPing = 8;
const OpPong = 9;

/** @type {Map<string, Room>} */
const rooms = new Map();
const roomsPerIp = new Map(); // host remote address -> rooms currently open

function roomOpened(room) {
  roomsPerIp.set(room.hostIp, (roomsPerIp.get(room.hostIp) || 0) + 1);
}

function roomClosed(room) {
  const n = (roomsPerIp.get(room.hostIp) || 1) - 1;
  if (n <= 0) roomsPerIp.delete(room.hostIp);
  else roomsPerIp.set(room.hostIp, n);
}

class Room {
  constructor(code, host, hostIp) {
    this.code = code;
    this.host = host; // wire id 0
    this.hostIp = hostIp || "unknown";
    this.members = new Map(); // wireId -> ws
    this.nextMemberId = 1;
  }

  memberCount() {
    return this.members.size;
  }

  assignId() {
    while (this.members.has(this.nextMemberId)) this.nextMemberId++;
    return this.nextMemberId++;
  }
}

function writeUInt64LE(buf, offset, value) {
  for (let i = 0; i < 8; i++)
    buf[offset + i] = Number((BigInt(value) >> BigInt(i * 8)) & 0xffn);
}

function readUInt64LE(buf, offset) {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(buf[offset + i]);
  return Number(v);
}

function send(ws, frame) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    if (ws.bufferedAmount > 4 * MAX_FRAME_BYTES) {
      ws.terminate();
      return;
    }
    try {
      ws.send(frame);
    } catch {
      /* socket is dead; close handling will clean up */
    }
  }
}

function sendJoined(ws, id) {
  const frame = Buffer.alloc(9);
  frame[0] = OpJoined;
  writeUInt64LE(frame, 1, id);
  send(ws, frame);
}

function sendPeerJoin(ws, id) {
  const frame = Buffer.alloc(9);
  frame[0] = OpPeerJoin;
  writeUInt64LE(frame, 1, id);
  send(ws, frame);
}

function sendPeerLeave(ws, id) {
  const frame = Buffer.alloc(9);
  frame[0] = OpPeerLeave;
  writeUInt64LE(frame, 1, id);
  send(ws, frame);
}

function sendError(ws, reason) {
  const reasonBytes = Buffer.from(reason, "utf8");
  const frame = Buffer.alloc(1 + reasonBytes.length);
  frame[0] = OpError;
  reasonBytes.copy(frame, 1);
  send(ws, frame);
}

function sendData(ws, src, payload) {
  const frame = Buffer.alloc(9 + payload.length);
  frame[0] = OpData;
  writeUInt64LE(frame, 1, src);
  payload.copy(frame, 9);
  send(ws, frame);
}

function dropClient(ws, reason) {
  try {
    ws.close(1000, reason);
  } catch {
    ws.terminate();
  }
}

/**
 * Handle a member leaving: detach it from its room and notify the host.
 * The room itself is destroyed when the host leaves.
 */
function handleMemberLeave(ws) {
  const room = ws.room;
  if (!room) return;
  ws.room = null;

  if (ws === room.host) {
    // Host left: the room is gone. Tell everyone.
    rooms.delete(room.code);
    roomClosed(room);
    for (const member of room.members.values()) {
      member.room = null;
      sendError(member, "The host left the game.");
      dropClient(member, "host_left");
    }
    room.members.clear();
    console.log(`[lc-relay] room ${room.code} closed (host left)`);
    return;
  }

  const id = ws.wireId;
  if (id != null && room.members.delete(id)) {
    sendPeerLeave(room.host, id);
    console.log(
      `[lc-relay] room ${room.code}: member ${id} left (${room.memberCount()} member(s) remaining)`,
    );
  }
}

function handleFrame(ws, frame) {
  if (frame.length < 1) return;

  // OpPing works on any connected socket, before a room is assigned.
  if (frame[0] === OpPing) {
    const pong = Buffer.alloc(9);
    pong[0] = OpPong;
    if (frame.length >= 9) frame.copy(pong, 1, 1, 9);
    send(ws, pong);
    return;
  }

  const room = ws.room;
  if (!room) return; // must join a room first

  switch (frame[0]) {
    case OpData: {
      if (frame.length < 9) break;
      const dst = readUInt64LE(frame, 1);
      const payload = Buffer.from(frame.subarray(9));
      if (ws === room.host) {
        const target = room.members.get(dst);
        if (target) sendData(target, 0n, payload);
      } else {
        sendData(room.host, ws.wireId, payload);
      }
      break;
    }

    case OpKick: {
      if (ws !== room.host || frame.length < 9) break;
      const targetId = readUInt64LE(frame, 1);
      const target = room.members.get(targetId);
      if (target) {
        room.members.delete(targetId);
        target.room = null;
        dropClient(target, "Kicked by the host.");
        sendPeerLeave(room.host, targetId);
        console.log(
          `[lc-relay] room ${room.code}: member ${targetId} kicked by host`,
        );
      }
      break;
    }

    default:
      // OpJoin is only valid before a room is assigned; OpPeerJoin/OpPeerLeave/OpJoined are server-only.
      break;
  }
}

function handleJoin(ws, frame) {
  if (frame.length < 4) {
    sendError(ws, "bad_join_frame");
    dropClient(ws, "bad_join_frame");
    return;
  }
  const role = frame[1];
  const roomLen = frame[2];
  if (3 + roomLen + 1 > frame.length) {
    sendError(ws, "bad_join_frame");
    dropClient(ws, "bad_join_frame");
    return;
  }
  const code = frame.subarray(3, 3 + roomLen).toString("utf8");
  const verLen = frame[3 + roomLen];
  if (
    (role !== 0 && role !== 1) ||
    roomLen === 0 ||
    roomLen > 64 ||
    4 + roomLen + verLen !== frame.length
  ) {
    sendError(ws, "bad_join_frame");
    dropClient(ws, "bad_join_frame");
    return;
  }
  const version = frame
    .subarray(4 + roomLen, 4 + roomLen + verLen)
    .toString("utf8");

  if (role === 0) {
    // Host: create the room.
    if (rooms.has(code)) {
      sendError(ws, "That join code is already in use. Try hosting again.");
      dropClient(ws, "room_exists");
      return;
    }
    if (rooms.size >= MAX_ROOMS) {
      sendError(ws, "The relay is full right now. Try again in a bit.");
      dropClient(ws, "relay_full");
      return;
    }
    const hostedByIp = roomsPerIp.get(ws.remoteAddress || "unknown") || 0;
    if (hostedByIp >= MAX_ROOMS_PER_IP) {
      sendError(
        ws,
        "Too many games are being hosted from this connection. Try again later.",
      );
      dropClient(ws, "room_limit");
      return;
    }
    const room = new Room(code, ws, ws.remoteAddress);
    rooms.set(code, room);
    roomOpened(room);
    ws.room = room;
    ws.wireId = 0;
    sendJoined(ws, 0);
    console.log(`[lc-relay] room ${code} created (host, version ${version})`);
  } else {
    // Client: join an existing room.
    const room = rooms.get(code);
    if (!room) {
      sendError(
        ws,
        "That room doesn't exist. Double-check the code with the host.",
      );
      dropClient(ws, "room_not_found");
      return;
    }
    if (room.memberCount() >= MAX_PLAYERS - 1) {
      sendError(ws, "The room is full!");
      dropClient(ws, "room_full");
      return;
    }
    const id = room.assignId();
    ws.room = room;
    ws.wireId = id;
    room.members.set(id, ws);
    sendJoined(ws, id);
    sendPeerJoin(room.host, id);
    console.log(
      `[lc-relay] room ${code}: member ${id} joined (${room.memberCount()} in room)`,
    );
  }
}

/**
 * Mount point for Aetheris' upgrade hook: handle a /lc-relay WebSocket upgrade.
 * Same semantics as wss://<origin>/lc-relay on the standalone relay.
 */
function lcRelayUpgrade(req, socket, head) {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
}

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_FRAME_BYTES,
});

wss.on("connection", (ws, req) => {
  let lastSeen = Date.now();
  ws.room = null;
  ws.wireId = null;
  ws.remoteAddress = req.socket.remoteAddress;

  ws.on("message", (data) => {
    lastSeen = Date.now();
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (!ws.room) {
      if (buf[0] === OpJoin) handleJoin(ws, buf);
      else if (buf[0] !== OpPing) sendError(ws, "join_first");
      else handleFrame(ws, buf);
    } else {
      handleFrame(ws, buf);
    }
  });

  ws.on("close", () => handleMemberLeave(ws));
  ws.on("error", () => handleMemberLeave(ws));

  // Heartbeat: drop sockets that stop talking (flaky school connections die silently).
  const hb = setInterval(() => {
    if (Date.now() - lastSeen > IDLE_TIMEOUT_MS) {
      console.log(
        `[lc-relay] dropping idle connection (${req.socket.remoteAddress})`,
      );
      ws.terminate();
      clearInterval(hb);
    }
  }, 15 * 1000);
  ws.on("close", () => clearInterval(hb));

  console.log(`[lc-relay] connection from ${req.socket.remoteAddress}`);
});

export { lcRelayUpgrade };

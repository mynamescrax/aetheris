// Public game relay, served at wss://<host>/eos-relay (and /relay).
//
// Any Rexcomp web port whose offline EOS backend (x64/rt/win32/eos_fake.c) talks to a relay can use
// this one: one WebSocket per game page, `?REXCOMP_RELAY=wss://<host>/eos-relay`. Each page says hello
// with its product user id, advertises the listen servers it hosts, and EOS P2P packets are forwarded
// by that id, so nobody needs an inbound port or a forwarded router. The same endpoint serves every
// game that speaks the protocol; the relay never looks inside a packet.
//
// Wire protocol (binary frames, integers big-endian, first byte = kind). It is identical to
// x64/tools/eos_relay.py, so the standalone Python relay and this one are interchangeable:
//
//   client -> relay                            relay -> client
//   H puid[32]           hello                 P src[32] payload   packet from src
//   P dst[32] payload    packet to dst         G puid[32]          that player left (or is unknown)
//   S n:u16 sid record   advertise a server    R qid:u32 n:u16 (len:u32 record)*   reply to Q
//   D n:u16 sid          withdraw it
//   Q qid:u32            list everyone else's servers
//
// A player's servers are withdrawn when its socket closes, and the other players get G. It is
// deliberately open to any Origin (it only moves game packets between players), so a page served
// from localhost, a Chromebook tunnel or another site can all use it. Because it is public and
// unauthenticated, every socket is bounded: frame size (a browser gets 1009), message/byte token
// buckets, connections per IP, advertised servers per player, and a heartbeat that drops a peer
// whose network vanished instead of leaving a dead server in everyone's list.

import { WebSocket, WebSocketServer } from "ws";

const OpHello = 0x48; // H
const OpPacket = 0x50; // P
const OpGone = 0x47; // G
const OpAdvertise = 0x53; // S
const OpWithdraw = 0x44; // D
const OpSearch = 0x51; // Q
const OpSearchReply = 0x52; // R

// Caddy terminates TLS and proxies from loopback, so socket.remoteAddress is always 127.0.0.1 in
// production. The rightmost X-Forwarded-For entry is the address Caddy appended (the real peer);
// earlier entries are client-supplied and spoofable.
function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const value = Array.isArray(forwarded)
    ? forwarded[forwarded.length - 1]
    : forwarded;
  if (typeof value === "string" && value) {
    const parts = value.split(",");
    const last = parts[parts.length - 1].trim();
    if (last) return last;
  }
  return req.socket.remoteAddress || "unknown";
}

// Ids reach `pm2 logs`; strip control characters and cap the length so a crafted frame cannot forge
// log lines or write megabytes per connection.
function clean(value, max = 80) {
  return String(value ?? "?")
    // eslint-disable-next-line no-control-regex -- stripping control characters is the entire point
    .replace(/[\r\n\t\x00-\x1f]+/g, " ")
    .slice(0, max);
}

function tokenBucket(rate, burst, now = Date.now) {
  let tokens = burst;
  let last = now();
  return (cost) => {
    const time = now();
    tokens = Math.min(burst, tokens + ((time - last) / 1000) * rate) - cost;
    last = time;
    return tokens >= 0;
  };
}

function isPrintableAscii(bytes, from, to) {
  for (let i = from; i < to; i++) if (bytes[i] < 0x21 || bytes[i] > 0x7e) return false;
  return true;
}

// Per-socket settings a player may pass on the relay URL: ?room=FRIENDS, ?maxSessions=2, ?idle=120.
// Every value is clamped, so a crafted URL cannot raise a limit above what the relay allows.
function connectionSettings(search, cfg) {
  const params = new URLSearchParams(search || "");
  const room = (params.get("room") || "")
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, 32);
  const number = (name, min, max, fallback) => {
    const value = Number(params.get(name));
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(value)));
  };
  return {
    room,
    maxSessions: number("maxSessions", 1, cfg.maxSessionsPerPeer, cfg.maxSessionsPerPeer),
    idleTimeoutMs: number("idle", 60, 900, Math.round(cfg.idleTimeoutMs / 1000)) * 1000,
  };
}

const sum = (list) => list.reduce((n, item) => n + item, 0);

export function createEosRelay(options = {}) {
  const cfg = {
    maxConnections: 1024,
    maxConnectionsPerIp: 48,
    maxPeers: 512,
    maxPeersPerIp: 32,
    maxSessionsPerPeer: 8,
    maxSessions: 2048,
    maxRecordBytes: 16 * 1024,
    // An EOS packet is < 1.3 KB; only a session record gets large (the game's record is
    // length-prefixed fields plus up to 64 attributes), so the frame cap has to clear it.
    maxFrameBytes: 32 * 1024,
    heartbeatMs: 20_000,
    keepaliveMs: 25_000,
    idleTimeoutMs: 600_000, // backstop only: proxies close a dead socket far sooner
    msgRate: 300, // a host at 30 Hz fans out a few hundred small packets a second
    msgBurst: 900,
    byteRate: 256 * 1024,
    byteBurst: 1024 * 1024,
    log: (line) => console.log(line),
    ...options,
  };

  /** @type {Map<string, object>} product user id -> connection */
  const peers = new Map();
  /** @type {Map<string, { owner: string, record: Buffer }>} session id -> advertised record */
  const sessions = new Map();
  /** @type {Set<object>} every open socket, hello or not */
  const sockets = new Set();
  const connectionsPerIp = new Map();
  const peersPerIp = new Map();
  const started = Date.now();
  const stats = { packets: 0, bytes: 0, dropped: 0, replaced: 0 };

  const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.maxFrameBytes });

  function send(ws, frame) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 4 * cfg.maxFrameBytes) {
      ws.terminate();
      return;
    }
    try {
      ws.send(frame);
    } catch {
      /* the close handler cleans up */
    }
  }

  function sendGone(ws, puid) {
    const frame = Buffer.alloc(33);
    frame[0] = OpGone;
    frame.write(puid, 1, "latin1");
    send(ws, frame);
  }

  function count(map, key, delta) {
    const n = (map.get(key) || 0) + delta;
    if (n <= 0) map.delete(key);
    else map.set(key, n);
  }

  function closeWith(conn, code, reason) {
    try {
      conn.ws.close(code, reason);
    } catch {
      conn.ws.terminate();
    }
  }

  // Forget a connection: its id, its advertised servers, and the peers watching it. A replaced
  // socket has already lost its puid, so only the live connection for that id is cleaned up.
  function drop(conn) {
    if (conn.dropped) return;
    conn.dropped = true;
    sockets.delete(conn);

    const puid = conn.puid;
    conn.puid = null;
    if (!puid) return;
    count(peersPerIp, conn.ip, -1);
    if (peers.get(puid) !== conn) return;

    peers.delete(puid);
    let withdrawn = 0;
    for (const [sid, session] of sessions) {
      if (session.owner !== puid) continue;
      sessions.delete(sid);
      withdrawn++;
    }
    for (const other of peers.values()) sendGone(other.ws, puid);
    cfg.log(
      `[eos-relay] - ${clean(puid)} (${peers.size} player(s), ${withdrawn} server(s) withdrawn, ${conn.ip})`,
    );
  }

  function handleHello(conn, frame) {
    if (frame.length !== 33 || !isPrintableAscii(frame, 1, 33)) {
      closeWith(conn, 1008, "bad_hello");
      return;
    }
    const puid = frame.toString("latin1", 1, 33);
    const previous = peers.get(puid);

    if (!previous && peers.size >= cfg.maxPeers) {
      closeWith(conn, 1013, "relay_full");
      return;
    }
    if (!previous && (peersPerIp.get(conn.ip) || 0) >= cfg.maxPeersPerIp) {
      closeWith(conn, 1029, "too_many_peers");
      return;
    }

    // A page that reloaded comes back with the same id: the newer socket wins.
    if (previous && previous !== conn) {
      stats.replaced++;
      peers.delete(puid);
      previous.puid = null;
      count(peersPerIp, previous.ip, -1);
      for (const [sid, session] of sessions) {
        if (session.owner === puid) sessions.delete(sid);
      }
      closeWith(previous, 1000, "replaced");
    } else if (conn.puid && conn.puid !== puid) {
      // Same socket, different id: its old servers are not this player's any more.
      count(peersPerIp, conn.ip, -1);
      for (const [sid, session] of sessions) {
        if (session.owner === conn.puid) sessions.delete(sid);
      }
    }

    conn.puid = puid;
    peers.set(puid, conn);
    count(peersPerIp, conn.ip, 1);
    cfg.log(
      `[eos-relay] + ${clean(puid)} from ${conn.ip} (${peers.size} player(s)${previous ? ", reconnected" : ""})`,
    );
  }

  function handlePacket(conn, frame) {
    if (frame.length < 33) {
      closeWith(conn, 1008, "bad_packet");
      return;
    }
    const dst = frame.toString("latin1", 1, 33);
    const target = peers.get(dst);
    // A room is a private relay: packets and servers never cross between rooms.
    if (!target || target.room !== conn.room) {
      // The sender's EOS layer turns this into "connection failed" for that peer.
      stats.dropped++;
      sendGone(conn.ws, dst);
      return;
    }
    const out = Buffer.allocUnsafe(frame.length);
    out[0] = OpPacket;
    out.write(conn.puid, 1, "latin1");
    frame.copy(out, 33, 33);
    stats.packets++;
    stats.bytes += out.length - 33;
    send(target.ws, out);
  }

  function handleAdvertise(conn, frame) {
    if (frame.length < 4) {
      closeWith(conn, 1008, "bad_session");
      return;
    }
    const len = frame.readUInt16BE(1);
    if (len === 0 || len > 64 || 3 + len > frame.length || !isPrintableAscii(frame, 3, 3 + len)) {
      closeWith(conn, 1008, "bad_session");
      return;
    }
    const record = frame.subarray(3 + len);
    if (record.length > cfg.maxRecordBytes) {
      stats.dropped++;
      cfg.log(
        `[eos-relay] dropped a ${record.length} byte session record from ${clean(conn.puid)}`,
      );
      return;
    }
    const sid = frame.toString("latin1", 3, 3 + len);
    const fresh = !sessions.has(sid);
    if (!fresh) {
      // Re-advertising its own server (settings changed) is always fine.
    } else if (sessions.size >= cfg.maxSessions) {
      stats.dropped++;
      cfg.log(`[eos-relay] server list is full (${sessions.size}); dropping ${clean(sid)}`);
      return;
    } else {
      let mine = 0;
      for (const session of sessions.values()) if (session.owner === conn.puid) mine++;
      if (mine >= conn.maxSessions) {
        stats.dropped++;
        cfg.log(
          `[eos-relay] ${clean(conn.puid)} already advertises ${mine} server(s); dropping ${clean(sid)}`,
        );
        return;
      }
    }
    sessions.set(sid, {
      owner: conn.puid,
      room: conn.room,
      record: Buffer.from(record),
    });
    if (fresh) {
      cfg.log(
        `[eos-relay] server ${clean(sid)} advertised by ${clean(conn.puid)} (${sessions.size} listed)`,
      );
    }
  }

  function handleWithdraw(conn, frame) {
    if (frame.length < 3) {
      closeWith(conn, 1008, "bad_session");
      return;
    }
    const len = frame.readUInt16BE(1);
    if (3 + len > frame.length) {
      closeWith(conn, 1008, "bad_session");
      return;
    }
    const sid = frame.toString("latin1", 3, 3 + len);
    const session = sessions.get(sid);
    if (session && session.owner === conn.puid) {
      sessions.delete(sid);
      cfg.log(`[eos-relay] server ${clean(sid)} withdrawn`);
    }
  }

  function handleSearch(conn, frame) {
    if (frame.length < 5) {
      closeWith(conn, 1008, "bad_search");
      return;
    }
    const qid = frame.readUInt32BE(1);
    const records = [];
    let size = 7; // op + qid + count
    for (const session of sessions.values()) {
      if (session.owner === conn.puid || session.room !== conn.room) continue;
      if (size + 4 + session.record.length > 64 * 1024) break;
      records.push(session.record);
      size += 4 + session.record.length;
    }
    const out = Buffer.allocUnsafe(7 + sum(records.map((r) => 4 + r.length)));
    out[0] = OpSearchReply;
    out.writeUInt32BE(qid, 1);
    out.writeUInt16BE(records.length, 5);
    let offset = 7;
    for (const record of records) {
      out.writeUInt32BE(record.length, offset);
      record.copy(out, offset + 4);
      offset += 4 + record.length;
    }
    send(conn.ws, out);
    cfg.log(`[eos-relay] ${clean(conn.puid)} searched: ${records.length} server(s)`);
  }

  function handleFrame(conn, frame) {
    if (frame.length < 1) return;
    switch (frame[0]) {
      case OpHello:
        handleHello(conn, frame);
        return;
      case OpPacket:
        handlePacket(conn, frame);
        return;
      case OpAdvertise:
        handleAdvertise(conn, frame);
        return;
      case OpWithdraw:
        handleWithdraw(conn, frame);
        return;
      case OpSearch:
        handleSearch(conn, frame);
        return;
      default:
        // The EOS backend never sends anything else; ignore it rather than guess.
        stats.dropped++;
    }
  }

  function attach(ws, req, ip, settings) {
    const conn = {
      ws,
      ip,
      puid: null,
      dropped: false,
      room: settings.room,
      maxSessions: settings.maxSessions,
      idleTimeoutMs: settings.idleTimeoutMs,
      lastSeen: Date.now(),
      keepaliveAt: Date.now(),
      messages: tokenBucket(cfg.msgRate, cfg.msgBurst),
      bytes: tokenBucket(cfg.byteRate, cfg.byteBurst),
    };
    sockets.add(conn);

    ws.on("pong", () => {
      conn.lastSeen = Date.now();
    });

    ws.on("message", (data) => {
      conn.lastSeen = Date.now();
      const frame = Buffer.isBuffer(data) ? data : Buffer.from(data);
      // Evaluate both so each bucket stays accurate.
      const withinMessages = conn.messages(1);
      const withinBytes = conn.bytes(frame.length);
      if (!withinMessages || !withinBytes) {
        stats.dropped++;
        cfg.log(`[eos-relay] rate limited ${clean(conn.puid || ip)}`);
        closeWith(conn, 1008, "rate_limited");
        return;
      }
      if (!conn.puid && frame[0] !== OpHello) {
        closeWith(conn, 1008, "hello_first");
        return;
      }
      handleFrame(conn, frame);
    });

    ws.on("close", () => drop(conn));
    ws.on("error", () => drop(conn));
  }

  function upgrade(req, socket, head) {
    const ip = clientIp(req);
    const fromIp = connectionsPerIp.get(ip) || 0;
    if (sockets.size >= cfg.maxConnections || fromIp >= cfg.maxConnectionsPerIp) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return;
    }
    connectionsPerIp.set(ip, fromIp + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      count(connectionsPerIp, ip, -1);
    };
    // Covers both a failed handshake and the WebSocket closing later.
    socket.once("close", release);
    const query = req.url && req.url.includes("?") ? req.url.slice(req.url.indexOf("?") + 1) : "";
    const settings = connectionSettings(query, cfg);
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, req, ip, settings));
  }

  // Keepalive. Cloudflare, which fronts this relay, closes a WebSocket that carries no data for
  // about 100 s, and it does not reliably deliver ping/pong frames. So a quiet game - sitting in a
  // menu, or loading a map for a minute or two - is kept alive with a valid search reply that the
  // game ignores (an R whose qid matches no pending search is dropped by eos_fake's search_reply).
  // Liveness therefore never depends on a pong: the idle timeout is only a backstop, and a socket
  // whose network died is closed by the proxy first, which raises a close event here.
  const KEEPALIVE = Buffer.from([OpSearchReply, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00]);
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const conn of sockets) {
      if (now - conn.lastSeen > conn.idleTimeoutMs) {
        cfg.log(`[eos-relay] dropping silent connection (${clean(conn.puid || conn.ip)})`);
        conn.ws.terminate();
        continue;
      }
      if (now - conn.keepaliveAt >= cfg.keepaliveMs) {
        conn.keepaliveAt = now;
        send(conn.ws, KEEPALIVE);
      }
      try {
        conn.ws.ping();
      } catch {
        conn.ws.terminate();
      }
    }
  }, Math.max(200, Math.min(cfg.keepaliveMs, cfg.heartbeatMs, 5_000)));
  heartbeat.unref();

  function status() {
    return {
      relay: "eos",
      uptimeS: Math.round((Date.now() - started) / 1000),
      peers: peers.size,
      rooms: new Set([...peers.values()].map((conn) => conn.room)).size,
      sessions: sessions.size,
      connections: sockets.size,
      ...stats,
    };
  }

  // The numbers the docs page promises, from the single place that enforces them.
  function limits() {
    return {
      maxConnections: cfg.maxConnections,
      maxConnectionsPerIp: cfg.maxConnectionsPerIp,
      maxPlayers: cfg.maxPeers,
      maxPlayersPerIp: cfg.maxPeersPerIp,
      maxSessionsPerPlayer: cfg.maxSessionsPerPeer,
      maxSessions: cfg.maxSessions,
      maxRecordBytes: cfg.maxRecordBytes,
      maxFrameBytes: cfg.maxFrameBytes,
      heartbeatMs: cfg.heartbeatMs,
      keepaliveMs: cfg.keepaliveMs,
      idleTimeoutMs: cfg.idleTimeoutMs,
      messagesPerSecond: cfg.msgRate,
      bytesPerSecond: cfg.byteRate,
    };
  }

  function stop() {
    clearInterval(heartbeat);
    for (const conn of sockets) conn.ws.terminate();
    sockets.clear();
    peers.clear();
    sessions.clear();
    wss.close();
  }

  return { upgrade, status, limits, stop };
}

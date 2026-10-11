// Post-deploy proxy check, run by deploy.sh after the restart:
//   node scripts/wisp-check.js [port]
// 1. asks the app which Wisp engine is live (/wisp-status, loopback only)
// 2. opens a real Wisp stream through /wisp/ to example.com:80 and expects
//    an HTTP response back.
// Exit 0 = proxy works on wispurr, 2 = proxy works but fell back to wisp-js,
// 1 = proxy is broken.
import { WebSocket } from "ws";

const TARGET_HOST = process.env.WISP_CHECK_HOST || "example.com";
const TARGET_PORT = Number(process.env.WISP_CHECK_PORT) || 80;

function packet(type, streamid, payload) {
  const head = Buffer.alloc(5);
  head[0] = type;
  head.writeUInt32LE(streamid, 1);
  return Buffer.concat([head, payload]);
}

// Resolves with the first bytes the target sent back through the relay.
export function wispprobe(base, { host = TARGET_HOST, port = TARGET_PORT, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = base.replace(/^http/, "ws").replace(/\/$/, "") + "/wisp/";
    const ws = new WebSocket(url, { headers: { Origin: base.replace(/\/$/, "") } });
    ws.binaryType = "nodebuffer";
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`no reply from ${host}:${port} within ${timeoutMs}ms`));
    }, timeoutMs);
    const done = (fn, v) => {
      clearTimeout(timer);
      ws.terminate();
      fn(v);
    };
    ws.on("open", () => {
      const connect = Buffer.alloc(3);
      connect[0] = 1; // TCP
      connect.writeUInt16LE(port, 1);
      ws.send(packet(1, 1, Buffer.concat([connect, Buffer.from(host)])));
      ws.send(
        packet(
          2,
          1,
          Buffer.from(`HEAD / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`),
        ),
      );
    });
    ws.on("message", (data) => {
      if (data[0] === 2 && data.readUInt32LE(1) === 1)
        done(resolve, data.subarray(5).toString("latin1"));
      else if (data[0] === 4 && data.readUInt32LE(1) === 1)
        done(reject, new Error(`stream closed by relay (reason 0x${data[5]?.toString(16)})`));
    });
    ws.on("unexpected-response", (_req, res) =>
      done(reject, new Error(`upgrade refused: HTTP ${res.statusCode}`)),
    );
    ws.on("error", (err) => done(reject, err));
  });
}

async function main() {
  const port = Number(process.argv[2] || process.env.PORT) || 8080;
  const base = `http://127.0.0.1:${port}`;

  let status = null;
  try {
    const res = await fetch(`${base}/wisp-status`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) status = await res.json();
  } catch {
    /* reported below */
  }

  // Workers start alongside the app, so give them a few seconds to come up.
  for (let i = 0; i < 20 && status?.wanted === "wispurr" && status.engine !== "wispurr"; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      status = await (await fetch(`${base}/wisp-status`)).json();
    } catch {
      /* keep the last answer */
    }
  }

  try {
    const reply = await wispprobe(base);
    if (!/^HTTP\/1\.[01] \d{3}/.test(reply)) throw new Error(`unexpected reply: ${reply.slice(0, 40)}`);
  } catch (err) {
    console.error(`!! Proxy check FAILED: ${err.message}`);
    process.exit(1);
  }

  if (!status) {
    console.log("-> Proxy check OK (engine unknown: /wisp-status unavailable)");
    return;
  }
  const up = status.workers?.filter((w) => w.up).length ?? 0;
  if (status.wanted === "wispurr" && status.engine !== "wispurr") {
    console.error(
      "!! Proxy works but is on the wisp-js FALLBACK: no wispurr worker is up.\n" +
        "!! Check `pm2 logs aetheris | grep wisp` (missing musl? sudo apt install musl)",
    );
    process.exit(2);
  }
  console.log(
    `-> Proxy check OK (${status.engine}${status.engine === "wispurr" ? `, ${up}/${status.workers.length} workers up` : ""})`,
  );
}

if (process.argv[1]?.endsWith("wisp-check.js")) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error("!! Proxy check crashed:", err);
      process.exit(1);
    },
  );
}

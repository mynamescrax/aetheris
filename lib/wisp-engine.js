// Wisp is the WebSocket TCP relay Scramjet's transports talk to.
//
// Default engine: wispurr (a Go wisp server) in its own worker processes, so
// proxy traffic doesn't share the Node event loop with the site, chat and the
// movie relay. Each worker is respawned with backoff if it dies. Until a
// worker is up (or if the binary can't run on this platform), upgrades fall
// back to in-process wisp-js, so the proxy never goes dark.
//
// WISP_ENGINE=wisp-js forces the old in-process server.
// WISP_WORKERS sets the wispurr worker count (default 2, max 8).
// WISP_PORT sets the first worker port (default 4432, loopback only).
import { readdirSync, readFileSync } from "node:fs";
import { server as wispjs, logging } from "@mercuryworkshop/wisp-js/server";

const RESPAWN_MIN_MS = 1000;
const RESPAWN_MAX_MS = 30_000;

// wispurr only matches exact hostnames, so list the common hosts of each
// blocked domain. Subdomains are still covered by the family-filter DNS.
function exacthosts(domains) {
  const out = new Set();
  for (const d of domains) {
    out.add(d);
    out.add("www." + d);
    out.add("m." + d);
  }
  return [...out];
}

function suffixpatterns(domains) {
  return domains.map(
    (d) => new RegExp("(^|\\.)" + d.replace(/[.]/g, "\\.") + "$", "i"),
  );
}

// If this app was SIGKILLed (PM2 kill timeout, OOM), its workers were
// reparented to init and keep their ports. Kill those orphans on startup.
// Linux only; elsewhere the workers die with their stdio pipes.
function reaporphans(binPath, log) {
  if (process.platform !== "linux") return 0;
  let reaped = 0;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmd = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
      if (cmd[0] !== binPath) continue;
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      if (ppid !== 1) continue;
      process.kill(Number(entry), "SIGKILL");
      reaped++;
    } catch {
      /* process went away or isn't ours */
    }
  }
  if (reaped) log.log(`[wisp] killed ${reaped} orphaned wispurr worker(s)`);
  return reaped;
}

export function wispurrconfig({ blockedDomains, blockedPorts, dnsServers }) {
  return {
    host: "127.0.0.1",
    allowTCP: true,
    allowUDP: false,
    // matches wisp-js: some games connect straight to an IP
    allowDirectIP: true,
    allowPrivateIPs: false,
    allowLoopbackIPs: false,
    tcpNoDelay: true,
    tcpBufferSize: 262144,
    socketBufferSize: 16777216,
    pendingQueueSize: 33554432,
    websocketPermessageDeflate: false,
    blacklist: {
      hostnames: exacthosts(blockedDomains),
      ports: blockedPorts,
    },
    dnsServers,
    dnsMethod: "resolve",
    dnsResultOrder: "ipv4first",
    enableV2: true,
    enableTwisp: false,
    handshakeTimeoutSeconds: 10,
    passwordAuth: false,
    // Requests reach the workers from this process on loopback, carrying
    // Caddy's X-Forwarded-For. CF-Connecting-IP is client-controlled here.
    parseRealIP: true,
    trustedProxies: ["127.0.0.1", "::1"],
    trustedHeaders: ["X-Forwarded-For"],
    nonWSResponse: "",
    logLevel: "warn",
    proxy: "",
    maxMessageSize: 262144,
    staticDir: "",
    bandwidthLimitKbps: 0,
    // A whole school can share one NAT IP, so per-IP limits stay generous.
    connectionsLimitPerIP: 400,
    connectionWindowSeconds: 10,
    floodProtection: {
      enabled: true,
      maxConnectsPerSourceIPPerSecond: 500,
      maxConnectsPerDestPerSecond: 500,
      maxConnectsPerDestPerMinute: 20000,
      maxInFlightSyns: 4096,
      // same per-connection cap as the old wisp-js stream_limit_total
      maxConcurrentStreamsPerConnection: 256,
      maxConcurrentConnections: 16384,
      wsCloseAfterViolations: 64,
      logBlockedDials: false,
    },
    // Persistent IP scoring would punish every user behind a shared NAT.
    reputation: { enabled: false },
  };
}

export function createwispengine({
  blockedDomains = [],
  blockedPorts = [],
  dnsServers = [],
  engine = process.env.WISP_ENGINE || "wispurr",
  workers = Number(process.env.WISP_WORKERS) || 2,
  basePort = Number(process.env.WISP_PORT) || 4432,
  log = console,
} = {}) {
  logging.set_level(logging.NONE);
  Object.assign(wispjs.options, {
    allow_udp_streams: false,
    hostname_blacklist: suffixpatterns(blockedDomains),
    port_blacklist: blockedPorts,
    // stream_limit_per_host must stay -1 on wisp-js 0.4.1: its check iterates
    // a plain object and throws, so no stream ever opens.
    stream_limit_total: 128,
    stream_limit_per_host: -1,
    dns_servers: dnsServers,
  });

  const slots = [];
  let stopped = false;
  let next = 0;
  let fallbacks = 0;
  let lastfallbackwarn = 0;

  async function startslot(slot) {
    if (stopped) return;
    try {
      await slot.instance.start(1);
      const proc = slot.instance.processes?.[0]?.process;
      slot.port = slot.instance.ports[0];
      slot.up = true;
      slot.failures = 0;
      log.log(`[wisp] wispurr worker ${slot.id} up on 127.0.0.1:${slot.port}`);
      proc?.once("close", (code, signal) => {
        slot.up = false;
        if (stopped) return;
        log.error(
          `[wisp] wispurr worker ${slot.id} exited (code=${code} signal=${signal}); respawning`,
        );
        schedule(slot);
      });
    } catch (err) {
      slot.up = false;
      // ENOENT on an existing file: the npm linux build is linked against
      // musl, so glibc distros need its loader. Retrying won't help.
      if (err?.code === "ENOENT" || /ENOENT/.test(String(err?.message))) {
        log.error(
          `[wisp] wispurr can't run here (${err?.message || err}); using wisp-js.` +
            (process.platform === "linux"
              ? " On Ubuntu/Debian: sudo apt install musl"
              : ""),
        );
        return;
      }
      log.error(
        `[wisp] wispurr worker ${slot.id} failed to start: ${err?.message || err}`,
      );
      schedule(slot);
    }
  }

  function schedule(slot) {
    if (stopped) return;
    slot.failures++;
    const delay = Math.min(
      RESPAWN_MAX_MS,
      RESPAWN_MIN_MS * 2 ** Math.min(slot.failures - 1, 5),
    );
    clearTimeout(slot.timer);
    slot.timer = setTimeout(() => startslot(slot), delay);
    slot.timer.unref?.();
  }

  async function start() {
    if (engine !== "wispurr") {
      log.log("[wisp] using in-process wisp-js");
      return;
    }
    let wispurr;
    try {
      ({ wispurr } = await import("wispurr"));
      const { binPath } = await import("wispurr/dist/path.js");
      reaporphans(binPath, log);
    } catch (err) {
      log.error(
        `[wisp] wispurr unavailable (${err?.message || err}); using wisp-js`,
      );
      return;
    }
    const count = Math.max(1, Math.min(8, Math.floor(workers)));
    const config = wispurrconfig({ blockedDomains, blockedPorts, dnsServers });
    for (let i = 0; i < count; i++) {
      slots.push({
        id: i,
        instance: new wispurr({ ...config, port: basePort + i }),
        up: false,
        port: null,
        failures: 0,
        timer: null,
      });
    }
    await Promise.all(slots.map(startslot));
  }

  function route(req, socket, head) {
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[(next + i) % slots.length];
      if (slot.up) {
        next = (next + i + 1) % slots.length;
        slot.instance.route(req, socket, head);
        return;
      }
    }
    fallbacks++;
    // Only worth shouting about when wispurr was wanted; a minute apart so a
    // dead worker pool can't flood the log.
    const now = Date.now();
    if (engine === "wispurr" && now - lastfallbackwarn > 60_000) {
      lastfallbackwarn = now;
      log.error(
        `[wisp] WARNING no wispurr worker is up; proxy is running on wisp-js (fallbacks so far: ${fallbacks})`,
      );
    }
    wispjs.routeRequest(req, socket, head);
  }

  async function stop() {
    stopped = true;
    await Promise.all(
      slots.map(async (slot) => {
        clearTimeout(slot.timer);
        if (slot.instance.isRunning) {
          try {
            await slot.instance.stop(2000);
          } catch {
            /* already gone */
          }
        }
      }),
    );
  }

  // Synchronous last resort so workers never outlive this process.
  function killnow() {
    stopped = true;
    for (const slot of slots) {
      for (const p of slot.instance.processes || []) {
        try {
          p.process.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  }

  function status() {
    return {
      wanted: engine,
      // what new connections actually get right now
      engine: slots.some((s) => s.up) ? "wispurr" : "wisp-js",
      workers: slots.map((s) => ({
        id: s.id,
        up: s.up,
        port: s.port,
        pid: s.up ? s.instance.processes?.[0]?.process?.pid : undefined,
      })),
      fallbacks,
    };
  }

  return { start, route, stop, killnow, status };
}

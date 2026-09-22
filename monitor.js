#!/usr/bin/env node

/**
 * monitor.js — site uptime monitor & auto-recovery for Caddy + Fastify
 * with Discord webhook alerts and periodic status reports.
 */

import { exec }             from "node:child_process";
import { createWriteStream } from "node:fs";
import { connect }          from "node:net";
import { dirname }          from "node:path";
import { fileURLToPath }    from "node:url";
import { promisify }        from "node:util";

const execAsync = promisify(exec);

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
if (!DISCORD_WEBHOOK) throw new Error("DISCORD_WEBHOOK env var not set");

// the app directory: this file ships inside the repo, so its own location is
// the correct cwd/env-file anchor even when the monitor itself was started
// from somewhere else (pm2 from /root, systemd, nohup, ...)
const APP_DIR = process.env.APP_DIR || dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  domains: (process.env.DOMAINS || [
    "https://aetheris.win",
    "https://crax.lol",
    "https://hosting.crax.lol",
  ].join(",")).split(",").map(s => s.trim()).filter(Boolean),

  fallbackHost:   process.env.FALLBACK_HOST     || "127.0.0.1",
  fallbackPort:   parseInt(process.env.FALLBACK_PORT || "8080"),
  intervalMs:     parseInt(process.env.CHECK_INTERVAL || "60") * 1000,
  timeoutMs:      parseInt(process.env.TIMEOUT || "8000"),
  appService:     process.env.APP_SERVICE       || "aetheris",
  logFile:        process.env.LOG_FILE          || "/var/log/monitor.log",
  appDir:         APP_DIR,
  envFile:        process.env.ENV_FILE          || `${APP_DIR}/.env`,

  // How often to post a summary report to Discord, in MINUTES. Default: 15.
  reportIntervalMs: parseInt(process.env.REPORT_INTERVAL || "15") * 60 * 1000,
};

// ─── LOGGING ─────────────────────────────────────────────────────────────────

let logStream;
try {
  logStream = createWriteStream(CONFIG.logFile, { flags: "a" });
} catch {
  logStream = null;
}
if (logStream) {
  // createWriteStream failures (ENOENT, EACCES, disk full) arrive as an async
  // 'error' event, not a synchronous throw — without this listener the first
  // unwritable write would take down the whole monitor process
  logStream.on("error", err => {
    console.error("log stream error:", err.message);
    logStream = null;
  });
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logStream?.write(line + "\n");
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

// async exec — execSync blocked the event loop for up to its 15s timeout,
// which could stack ticks on a slow box (pm2 daemon cold-start etc.)
async function run(cmd) {
  try {
    const { stdout } = await execAsync(cmd, { timeout: 15_000 });
    return { ok: true, out: stdout.trim() };
  } catch (err) {
    const out = String(err.stderr || err.message || "").trim();
    return { ok: false, out: out.slice(0, 500) };
  }
}

// the app runs under pm2 (see notes.md) — `pm2 pid` prints the pid, or 0
// when the process is stopped/missing. systemd was retired when the stack
// moved to pm2, so systemctl is only used for caddy below.
async function pm2Active(name) {
  const { ok, out } = await run(`pm2 pid ${name}`);
  return ok && /^\d+$/.test(out) && parseInt(out, 10) > 0;
}

async function systemdActive(name) {
  const { ok, out } = await run(`systemctl is-active ${name}`);
  return ok && out === "active";
}

function tcpReachable(host, port, timeoutMs = 3000) {
  return new Promise(resolve => {
    const sock = connect({ host, port }, () => { sock.destroy(); resolve(true); });
    sock.setTimeout(timeoutMs);
    sock.on("error",   () => resolve(false));
    sock.on("timeout", () => { sock.destroy(); resolve(false); });
  });
}

function httpCheck(url, timeoutMs) {
  return new Promise(resolve => {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    fetch(url, { signal: ctrl.signal, redirect: "follow" })
      .then(res => {
        clearTimeout(timer);
        // cancel the unread body so undici can put the connection back in
        // its pool instead of waiting for GC
        if (res.body) res.body.cancel().catch(() => {});
        resolve({ ok: res.status < 500, status: res.status });
      })
      .catch(err => {
        clearTimeout(timer);
        const msg = err.name === "AbortError" ? "TIMEOUT" : err.message;
        resolve({ ok: false, error: msg });
      });
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function formatDuration(ms) {
  if (ms < 1000) return "< 1s";
  const totalSecs = Math.round(ms / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ─── DISCORD ─────────────────────────────────────────────────────────────────

async function sendWebhook(payload) {
  try {
    const res = await fetch(DISCORD_WEBHOOK, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
      // a hung Discord call must not stall the reporting loop for undici's
      // full default header timeout
      signal:  AbortSignal.timeout(15_000),
    });
    if (!res.ok) log(`Discord webhook failed: ${res.status} ${await res.text()}`);
  } catch (err) {
    log(`Discord webhook error: ${err.message}`);
  }
}

// Instant alert — site went down
async function alertDown(url, reason) {
  await sendWebhook({
    embeds: [{
      title:       "🔴 Site Down",
      description: `**${url}** is unreachable.`,
      color:       0xe74c3c,
      fields: [
        // Discord embed fields cap at 1024 chars — a longer error message
        // would make the whole webhook 400 and the alert would be lost
        { name: "Error",     value: String(reason).slice(0, 1000),  inline: true },
        { name: "Time",      value: new Date().toUTCString(),      inline: false },
      ],
      footer: { text: "Aetheris Uptime Monitor" },
      timestamp: new Date().toISOString(),
    }],
  });
}

// Instant alert — site recovered
async function alertUp(url, downtimeMs) {
  await sendWebhook({
    embeds: [{
      title:       "🟢 Site Recovered",
      description: `**${url}** is back online.`,
      color:       0x2ecc71,
      fields: [
        { name: "Downtime", value: formatDuration(downtimeMs), inline: true },
        { name: "Time",     value: new Date().toUTCString(),   inline: false },
      ],
      footer: { text: "Aetheris Uptime Monitor" },
      timestamp: new Date().toISOString(),
    }],
  });
}

// Instant alert — recovery action taken
async function alertRecovery(type, detail) {
  await sendWebhook({
    embeds: [{
      title:       "🔧 Recovery Action",
      color:       0xf39c12,
      fields: [
        { name: "Type",   value: type,   inline: true },
        { name: "Action", value: detail, inline: true },
      ],
      footer: { text: "Aetheris Uptime Monitor" },
      timestamp: new Date().toISOString(),
    }],
  });
}

// Periodic summary report
async function sendReport() {
  const windowMs    = CONFIG.reportIntervalMs;
  const windowHours = windowMs / (1000 * 60 * 60);
  const windowLabel = windowHours % 1 === 0 ? `${windowHours}-Hour` : `${(windowHours * 60).toFixed(0)}-Minute`;

  // snapshot each domain's stats and reset them synchronously, BEFORE any
  // webhook await — increments landing during a slow Discord call belong to
  // the next window, not the one being reported, and overlapping reports
  // must not double-reset
  const reports = [];
  for (const url of CONFIG.domains) {
    const s = state.get(url);
    if (!s) continue;

    reports.push({
      url,
      totalChecks: s.totalChecks,
      upChecks:    s.upChecks,
      isUp:        !s.down,
      downtimeMs:  s.totalDowntimeMs + (s.down && s.since ? Date.now() - s.since : 0),
      lastError:   s.lastError,
    });

    s.totalChecks     = 0;
    s.upChecks        = 0;
    s.totalDowntimeMs = 0;
    s.lastError       = null;
  }

  for (const r of reports) {
    const totalChecks  = r.totalChecks;
    const downChecks   = totalChecks - r.upChecks;
    const uptimePct    = totalChecks === 0 ? 100 : (r.upChecks / totalChecks) * 100;
    const isUp         = r.isUp;

    const uptimeColor  = uptimePct === 100 ? 0x2ecc71 : uptimePct >= 95 ? 0xf39c12 : 0xe74c3c;

    await sendWebhook({
      embeds: [{
        title: `${new URL(r.url).hostname} — ${windowLabel} Status Report`,
        color: uptimeColor,
        fields: [
          {
            name:   "Status",
            value:  isUp ? "🟢 UP" : "🔴 DOWN",
            inline: true,
          },
          {
            name:   `Uptime (window)`,
            value:  `${uptimePct.toFixed(2)}%`,
            inline: true,
          },
          {
            name:   "Checks",
            value:  `${r.upChecks} up / ${downChecks} down of ${totalChecks} total`,
            inline: false,
          },
          {
            name:   "Active Downtime Duration",
            value:  r.downtimeMs > 0 ? formatDuration(r.downtimeMs) : "None",
            inline: true,
          },
          {
            name:   "Last Recorded Error",
            value:  r.lastError || "None",
            inline: true,
          },
        ],
        footer:    { text: `${new URL(r.url).hostname} Uptime Monitor` },
        timestamp: new Date().toISOString(),
      }],
    });
  }
}

// ─── RECOVERY ────────────────────────────────────────────────────────────────

async function recover(fallbackReachable) {
  const type = fallbackReachable ? "POSSIBLE_CADDY" : "POSSIBLE_APP";
  log(`Recovery triggered — type: ${type}, fallback reachable: ${fallbackReachable}`);

  if (type === "POSSIBLE_CADDY") {
    log("Running: systemctl reload caddy");
    await run("systemctl reload caddy");
    await sleep(2000);

    if (!(await systemdActive("caddy"))) {
      log("Caddy not active. Running: systemctl start caddy");
      const res = await run("systemctl start caddy");
      log(`caddy start result: ${res.ok ? "ok" : "FAILED — " + res.out}`);
      await alertRecovery("Caddy", res.ok ? "systemctl start caddy → ok" : `FAILED: ${res.out}`);
    } else {
      log("caddy reload result: ok");
      await alertRecovery("Caddy", "systemctl reload caddy → ok");
    }

  } else {
    // app-side recovery — pm2, not systemd (the old aetheris.service is
    // disabled; see notes.md)
    if (!(await pm2Active(CONFIG.appService))) {
      log(`Running: pm2 restart ${CONFIG.appService}`);
      const res = await run(`pm2 restart ${CONFIG.appService} --update-env`);
      if (!res.ok) {
        // not in the pm2 process list at all — start it fresh. --cwd pins
        // the app to ITS directory: index.js resolves the user database
        // and .env from process.cwd(), so a start from the monitor's cwd
        // could boot a healthy-looking app against an empty database.
        log(`pm2 restart failed. Running: pm2 start index.js --cwd ${CONFIG.appDir}`);
        const res2 = await run(
          `pm2 start index.js --name ${CONFIG.appService} --cwd "${CONFIG.appDir}" ` +
            `--node-args="--env-file=${CONFIG.envFile}" --kill-timeout 5000 && pm2 save`,
        );
        log(`${CONFIG.appService} start result: ${res2.ok ? "ok" : "FAILED — " + res2.out}`);
        await alertRecovery("Node App", res2.ok ? `pm2 start index.js --name ${CONFIG.appService} → ok` : `FAILED: ${res2.out}`);
      } else {
        log(`${CONFIG.appService} restart result: ok`);
        await alertRecovery("Node App", `pm2 restart ${CONFIG.appService} → ok`);
      }
    } else {
      // pm2 knows the process but the port check failed — it's crash-looping
      // or hung; restart it to be safe
      log(`Running: pm2 restart ${CONFIG.appService}`);
      const res = await run(`pm2 restart ${CONFIG.appService} --update-env`);
      log(`${CONFIG.appService} restart result: ${res.ok ? "ok" : "FAILED — " + res.out}`);
      await alertRecovery("Node App", res.ok ? `pm2 restart ${CONFIG.appService} → ok` : `FAILED: ${res.out}`);
    }
  }
}

// ─── STATE ───────────────────────────────────────────────────────────────────

const state = new Map(
  CONFIG.domains.map(url => [url, {
    down:             false,
    since:            null,
    totalChecks:      0,
    upChecks:         0,
    totalDowntimeMs:  0,
    lastError:        null,
  }])
);

// ─── TICK ────────────────────────────────────────────────────────────────────

let ticking = false;

async function tick() {
  // a slow tick (8s http timeouts + recovery with its sleeps) must never
  // stack on top of a still-running one
  if (ticking) return;
  ticking = true;
  try {
    await tickinner();
  } finally {
    ticking = false;
  }
}

async function tickinner() {
  const results = await Promise.all(
    CONFIG.domains.map(async url => {
      const result = await httpCheck(url, CONFIG.timeoutMs);
      return { url, ...result };
    })
  );

  const failed  = results.filter(r => !r.ok);
  const passing = results.filter(r => r.ok);

  for (const { url } of passing) {
    const s = state.get(url);
    s.totalChecks++;
    s.upChecks++;
    if (s.down) {
      const downtimeMs = Date.now() - s.since;
      s.totalDowntimeMs += downtimeMs;
      log(`${url} is back UP. Downtime: ${formatDuration(downtimeMs)}`);
      await alertUp(url, downtimeMs);
      s.down  = false;
      s.since = null;
    }
  }

  for (const { url, status, error } of failed) {
    const s      = state.get(url);
    const reason = error || `HTTP ${status}`;
    s.totalChecks++;
    s.lastError = reason;
    if (!s.down) {
      s.down  = true;
      s.since = Date.now();
      log(`${url} is DOWN. Error: ${reason}`);
      await alertDown(url, reason);
    } else {
      const elapsed = Math.round((Date.now() - s.since) / 1000);
      log(`${url} still DOWN (${elapsed}s). Error: ${reason}`);
    }
  }

  // only take recovery action when EVERY domain is down — that means the box
  // itself (caddy or the app). a partial outage means caddy is serving and
  // the app answers for the other domains, so restarting anything globally
  // would knock over the healthy domains for nothing. alert only.
  if (failed.length > 0 && failed.length === CONFIG.domains.length) {
    const fallbackReachable = await tcpReachable(CONFIG.fallbackHost, CONFIG.fallbackPort);
    log(`Fallback (port ${CONFIG.fallbackPort}) reachable: ${fallbackReachable}`);
    await recover(fallbackReachable);
  } else if (failed.length > 0) {
    log(`Partial outage — ${failed.length}/${CONFIG.domains.length} domain(s) down, others healthy. Skipping global recovery.`);
  }
}

// ─── START ───────────────────────────────────────────────────────────────────

log(`Monitor starting. Watching ${CONFIG.domains.length} domain(s) every ${CONFIG.intervalMs / 1000}s:`);
for (const d of CONFIG.domains) log(`  ${d}`);

tick();
setInterval(tick, CONFIG.intervalMs);
setInterval(sendReport, CONFIG.reportIntervalMs);

process.on("SIGINT",  () => { log("Monitor stopped."); logStream?.end(); process.exit(0); });
process.on("SIGTERM", () => { log("Monitor stopped."); logStream?.end(); process.exit(0); });

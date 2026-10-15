// Movie source health reports for Discord (MOVIE_WEBHOOK_URL).
//
// The movies page sends /movie-ping beacons for each source attempt (see
// attemptBeacon in public/js/movies-ui.js). This tallies them per source and
// posts:
//   - a summary every MOVIE_REPORT_HOURS (default 24): plays vs failures per
//     source, failure reasons, and titles where no source worked;
//   - an immediate alert when a source looks dead: lots of failures from
//     several different visitors in the last hour and not one success.
// Beacons are unauthenticated, so names are whitelisted by shape, the number
// of tracked sources is capped, and "dead" needs several distinct IPs.

const SUCCESS = new Set(["ready", "playing"]);
const NEUTRAL = new Set(["open", "play", "autoplay", "loaded"]);
const MAX_SOURCES = 16;
const MAX_TITLES = 15;
const NAME_RE = /^[\w .()-]{1,60}$/;

const SOURCE_NAMES = {
  flixer: "Flixer (flixer.su)",
  "2embed": "2Embed (2embed.cc)",
  vidrock: "VidRock (vidrock.net)",
  "vidsrc-su": "VidSrc.su (vidsrc.su)",
  vidapi: "VidAPI (vidapi.xyz)",
};

function sourcekey(name, src, provider) {
  if (Object.hasOwn(SOURCE_NAMES, provider || "")) return SOURCE_NAMES[provider];
  if (name && NAME_RE.test(name)) return name;
  return /^\d{1,2}$/.test(String(src)) ? `source #${src}` : null;
}

function pct(n, d) {
  return d ? `${Math.round((n / d) * 100)}%` : "-";
}

export function createmoviereport({
  webhookUrl = process.env.MOVIE_WEBHOOK_URL || "",
  intervalMs = (Number(process.env.MOVIE_REPORT_HOURS) || 24) * 3600_000,
  deadFailures = 8,
  deadIps = 3,
  deadWindowMs = 3600_000,
  alertCooldownMs = 6 * 3600_000,
  now = Date.now,
  fetchimpl = (...a) => fetch(...a),
  log = console,
} = {}) {
  let sources = new Map();
  let exhausted = { count: 0, titles: new Set() };
  let since = now();
  let timer = null;
  const seenEvents = new Map();
  let flushing = false;
  const lastalert = new Map();
  // per-source { t, ip, ok } within deadWindowMs; survives summary resets
  const recents = new Map();

  function entry(key) {
    let e = sources.get(key);
    if (!e) {
      if (sources.size >= MAX_SOURCES) return null;
      e = {
        attempts: 0,
        ready: 0,
        playing: 0,
        failures: 0,
        reasons: new Map(),
        failips: new Set(),
      };
      sources.set(key, e);
    }
    return e;
  }

  async function post(payload) {
    if (!webhookUrl) return false;
    try {
      const res = await fetchimpl(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) log.error("[movie-report] webhook failed:", res.status);
      return res.ok;
    } catch (err) {
      log.error("[movie-report] webhook error:", err?.message || err);
      return false;
    }
  }

  function remember(key, ip, ok) {
    const t = now();
    const list = (recents.get(key) || []).filter((r) => t - r.t < deadWindowMs);
    list.push({ t, ip, ok });
    if (!recents.has(key) && recents.size >= MAX_SOURCES * 2) recents.clear();
    recents.set(key, list.slice(-200));
    return list;
  }

  function checkdead(key, recent) {
    const t = now();
    if (recent.some((r) => r.ok)) return;
    const fails = recent.length;
    const ips = new Set(recent.map((r) => r.ip)).size;
    if (fails < deadFailures || ips < deadIps) return;
    if (lastalert.has(key) && t - lastalert.get(key) < alertCooldownMs) return;
    lastalert.set(key, t);
    const mins = Math.round(deadWindowMs / 60000);
    post({
      username: "aetheris movies",
      embeds: [
        {
          title: `🚨 ${key} looks dead`,
          description: `${fails} failures from ${ips} different visitors in the last ${mins} min and not a single play.`,
          color: 0xef4444,
          timestamp: new Date(t).toISOString(),
          footer: { text: "Aetheris • movie source alert" },
        },
      ],
    });
  }

  // ev/name/src/kind/id come straight from the beacon (already stripped of
  // control characters); ip is the server-side client IP.
  function record({ ev, name, src, provider, aid, kind, id, season, episode, ip = "?" }) {
    ev = String(ev || "");
    const key = sourcekey(name, src, provider);
    // New clients attach a per-attempt random id, not a persistent viewer id.
    // Duplicate beacons must not inflate readiness, playback or failure totals.
    if (/^[a-zA-Z0-9-]{8,80}$/.test(aid || "")) {
      const token = `${key || "?"}:${aid}:${ev}`;
      if ((seenEvents.get(token) || 0) > now()) return;
      if (seenEvents.size >= 5000) seenEvents.delete(seenEvents.keys().next().value);
      seenEvents.set(token, now() + 86400_000);
    }
    if (ev === "exhausted") {
      exhausted.count++;
      if (
        exhausted.titles.size < MAX_TITLES &&
        /^(movie|tv)$/.test(kind) &&
        /^\d{1,9}$/.test(String(id))
      ) {
        const ep = kind === "tv" && /^\d{1,4}$/.test(String(season)) && /^\d{1,4}$/.test(String(episode))
          ? `/season/${season}/episode/${episode}` : "";
        exhausted.titles.add(`${kind}/${id}${ep}`);
      }
      return;
    }
    if (ev === "open") return;
    if (!key || (NEUTRAL.has(ev) && ev !== "play" && ev !== "autoplay")) return;
    const e = entry(key);
    if (!e) return;
    if (ev === "play" || ev === "autoplay") e.attempts++;
    else if (ev === "ready") {
      e.ready++;
    } else if (ev === "playing") {
      e.playing++;
      remember(key, ip, true);
    }
    else if (!NEUTRAL.has(ev) && !SUCCESS.has(ev) && ev !== "exhausted") {
      const reason = /^[\w-]{1,30}$/.test(ev) ? ev : "other";
      e.failures++;
      e.reasons.set(reason, (e.reasons.get(reason) || 0) + 1);
      e.failips.add(ip);
      checkdead(key, remember(key, ip, false));
    }
  }

  function summary() {
    if (!sources.size && !exhausted.count) return null;
    const hours = Math.max(1, Math.round((now() - since) / 3600_000));
    let worst = 0;
    const fields = [...sources.entries()]
      .sort((a, b) => b[1].failures - a[1].failures)
      .map(([key, e]) => {
        const ok = e.playing;
        const readyOnly = Math.max(0, e.ready - e.playing);
        const tries = ok + e.failures;
        if (tries >= 5) worst = Math.max(worst, e.failures / tries);
        const reasons = [...e.reasons.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([r, n]) => `${r} ${n}`)
          .join(", ");
        const icon = !tries ? "⚪" : e.failures / tries >= 0.5 ? "🔴" : e.failures / tries >= 0.2 ? "🟡" : "🟢";
        return {
          name: `${icon} ${key}`,
          value:
            `✅ ${ok} played · ⏸ ${readyOnly} ready only · ❌ ${e.failures} failed (${pct(e.failures, tries)})` +
            (reasons ? `\n${reasons}` : "") +
            (e.failures ? ` · ${e.failips.size} visitor${e.failips.size === 1 ? "" : "s"}` : ""),
          inline: false,
        };
      });
    if (exhausted.count) {
      const titles = [...exhausted.titles]
        .map((t) => `[${t}](https://www.themoviedb.org/${t})`)
        .join(", ");
      fields.push({
        name: `😞 Nothing played: ${exhausted.count} time${exhausted.count === 1 ? "" : "s"}`,
        value: (titles || "no title ids").slice(0, 1024),
        inline: false,
      });
    }
    return {
      username: "aetheris movies",
      embeds: [
        {
          title: `🎬 Movie sources, last ${hours}h`,
          color: worst >= 0.5 ? 0xef4444 : worst >= 0.2 ? 0xf59e0b : 0x22c55e,
          fields: fields.slice(0, 25),
          timestamp: new Date(now()).toISOString(),
          footer: { text: "Aetheris • played = video advanced; ready ≠ played. Failure % uses play/failure events." },
        },
      ],
    };
  }

  async function flush() {
    if (flushing) return false;
    const payload = summary();
    if (!payload) return false;
    flushing = true;
    const previousSources = sources, previousExhausted = exhausted, previousSince = since;
    sources = new Map();
    exhausted = { count: 0, titles: new Set() };
    since = now();
    try {
      const sent = await post(payload);
      if (!sent) {
        // Keep events recorded while the request was in flight, too.
        for (const [key, old] of previousSources) {
          const current = entry(key);
          if (!current) continue;
          for (const field of ["attempts", "ready", "playing", "failures"]) current[field] += old[field];
          for (const [reason, n] of old.reasons) current.reasons.set(reason, (current.reasons.get(reason) || 0) + n);
          for (const ip of old.failips) current.failips.add(ip);
        }
        exhausted.count += previousExhausted.count;
        exhausted.titles = new Set([...previousExhausted.titles, ...exhausted.titles].slice(0, MAX_TITLES));
        since = previousSince;
      }
      return sent;
    } finally { flushing = false; }
  }

  // Tallies survive restarts (deploys happen more often than reports), so
  // the app saves them on shutdown and loads them on boot.
  function serialize() {
    return {
      since,
      exhausted: { count: exhausted.count, titles: [...exhausted.titles] },
      sources: [...sources].map(([k, e]) => [
        k,
        { ...e, reasons: [...e.reasons], failips: [...e.failips] },
      ]),
    };
  }

  function restore(data) {
    if (!data || typeof data !== "object") return;
    try {
      if (Number.isFinite(data.since) && data.since <= now()) since = data.since;
      exhausted = {
        count: Number(data.exhausted?.count) || 0,
        titles: new Set((data.exhausted?.titles || []).slice(0, MAX_TITLES)),
      };
      sources = new Map(
        (data.sources || []).slice(0, MAX_SOURCES).map(([k, e]) => [
          k,
          {
            attempts: Number(e.attempts) || 0,
            ready: Number(e.ready) || 0,
            playing: Number(e.playing) || 0,
            failures: Number(e.failures) || 0,
            reasons: new Map(e.reasons || []),
            failips: new Set(e.failips || []),
          },
        ]),
      );
    } catch (err) {
      log.error("[movie-report] ignoring bad saved state:", err?.message || err);
    }
  }

  // Checked every 10 minutes against the saved window start rather than a
  // fixed interval, so restarts don't keep pushing the report back.
  function start() {
    if (!webhookUrl || timer) return;
    timer = setInterval(() => {
      if (now() - since >= intervalMs) flush();
    }, Math.min(intervalMs, 600_000));
    timer.unref?.();
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  return {
    record,
    summary,
    flush,
    start,
    stop,
    serialize,
    restore,
    enabled: !!webhookUrl,
  };
}

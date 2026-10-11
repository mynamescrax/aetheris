// Site-wide poll: one vote per device (dmDeviceId, never IP, since a whole
// school shares one address), open for `durationMs` from the first start,
// then the final result goes to Discord (REPORT_WEBHOOK_URL) once.
//
// Device ids are stored hashed. A voter's IP is kept only until its country
// is resolved (batched through lib/geo.js, ip-api's free batch endpoint
// allows ~15 calls/min), then dropped; only the country stays.

import { createHash } from "node:crypto";
import { countryflag } from "./geo.js";

export const NEXT_FEATURE_POLL = {
  id: "next-feature-2026-10",
  question: "What should be the next feature?",
  options: [
    { id: "cloud-gaming", label: "Cloud gaming" },
    { id: "music-player", label: "Music player" },
    { id: "more-games", label: "Fix and add more games" },
  ],
};

const DAY = 24 * 60 * 60 * 1000;
const GEO_BATCH = 100;
const GEO_BATCHES_PER_TICK = 5;

export function hashvoter(deviceid) {
  return createHash("sha256")
    .update(`poll-voter:${deviceid}`)
    .digest("hex")
    .slice(0, 32);
}

function pct(n, total) {
  return total ? Math.round((n / total) * 1000) / 10 : 0;
}

function bar(n, total, width = 12) {
  const filled = total ? Math.round((n / total) * width) : 0;
  return "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
}

// Tallies the stored votes. Pure, so tests can check the Discord payload.
export function tallypoll(poll, votes) {
  const counts = Object.fromEntries(poll.options.map((o) => [o.id, 0]));
  const bycountry = new Map();
  let unknown = 0;
  for (const v of votes) {
    if (!(v.o in counts)) continue;
    counts[v.o]++;
    if (!v.c) {
      unknown++;
      continue;
    }
    let row = bycountry.get(v.c);
    if (!row) {
      row = {
        code: v.c,
        name: v.n || v.c,
        total: 0,
        counts: Object.fromEntries(poll.options.map((o) => [o.id, 0])),
      };
      bycountry.set(v.c, row);
    }
    row.total++;
    row.counts[v.o]++;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const top = Math.max(0, ...Object.values(counts));
  const winners = total ? poll.options.filter((o) => counts[o.id] === top) : [];
  const countries = [...bycountry.values()].sort(
    (a, b) => b.total - a.total || a.name.localeCompare(b.name),
  );
  return { counts, total, winners, countries, unknown };
}

function leader(poll, counts) {
  const top = Math.max(0, ...Object.values(counts));
  if (!top) return null;
  const ids = poll.options.filter((o) => counts[o.id] === top);
  return { labels: ids.map((o) => o.label), count: top };
}

export function pollpayload(poll, tally, { startedAt, endsAt } = {}) {
  const { counts, total, winners, countries, unknown } = tally;
  const lines = poll.options.map((o) => {
    const n = counts[o.id];
    const crown = winners.some((w) => w.id === o.id) ? " \uD83C\uDFC6" : "";
    return `**${o.label}**${crown}\n\`${bar(n, total)}\` ${n} vote${n === 1 ? "" : "s"} (${pct(n, total)}%)`;
  });
  let result;
  if (!total) result = "No votes were cast.";
  else if (winners.length === 1)
    result = `**${winners[0].label}** wins with ${counts[winners[0].id]} of ${total} votes.`;
  else
    result = `Tie between ${winners.map((w) => `**${w.label}**`).join(" and ")} (${counts[winners[0].id]} votes each).`;

  const countrylines = [];
  for (const [i, c] of countries.slice(0, 10).entries()) {
    const lead = leader(poll, c.counts);
    const pick = lead
      ? `${lead.labels.join(" / ")} (${lead.count})`
      : "no votes";
    countrylines.push(
      `${i + 1}. ${countryflag(c.code)} **${c.name}** \u2014 ${c.total} vote${c.total === 1 ? "" : "s"} \u00B7 top pick: ${pick}`,
    );
  }
  if (countries.length > 10)
    countrylines.push(`\u2026and ${countries.length - 10} more countries`);
  if (unknown) countrylines.push(`Unknown location: ${unknown}`);

  const fields = [
    {
      name: "\uD83D\uDDF3\uFE0F Total votes",
      value: String(total),
      inline: true,
    },
    {
      name: "\uD83C\uDF10 Countries",
      value: String(countries.length),
      inline: true,
    },
    {
      name: "\uD83C\uDF0D Most votes by country",
      value: (countrylines.join("\n") || "No location data").slice(0, 1024),
      inline: false,
    },
  ];
  if (startedAt && endsAt)
    fields.push({
      name: "\u23F1\uFE0F Ran",
      value: `<t:${Math.floor(startedAt / 1000)}:f> \u2192 <t:${Math.floor(endsAt / 1000)}:f>`,
      inline: false,
    });

  return {
    username: "Aetheris Poll",
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: `\uD83D\uDCCA Poll closed: ${poll.question}`,
        description: `${result}\n\n${lines.join("\n\n")}`.slice(0, 4000),
        color: 0xa855f7,
        fields,
        timestamp: new Date(endsAt || Date.now()).toISOString(),
        footer: { text: "Aetheris \u2022 Poll results" },
      },
    ],
  };
}

export function createpoll({
  poll = NEXT_FEATURE_POLL,
  durationMs = DAY,
  webhookUrl = process.env.REPORT_WEBHOOK_URL || "",
  resolvecountries = null, // async (ips[]) => Map(ip -> {code,name}|null)
  fetchimpl = fetch,
  now = Date.now,
  onchange = () => {},
  log = console,
} = {}) {
  let state = {
    id: poll.id,
    startedAt: 0,
    endsAt: 0,
    posted: false,
    votes: {}, // voterhash -> { o, t, c?, n?, ip? }
  };
  let finishtimer = null;
  let geotimer = null;
  let posting = null;

  function restore(data) {
    if (!data || data.id !== poll.id || typeof data.votes !== "object") return;
    state = {
      id: poll.id,
      startedAt: Number(data.startedAt) || 0,
      endsAt: Number(data.endsAt) || 0,
      posted: !!data.posted,
      votes: data.votes || {},
    };
  }

  function serialize() {
    return state;
  }

  function isopen() {
    return !!state.startedAt && !state.posted && now() < state.endsAt;
  }

  function status(deviceid) {
    const mine = deviceid ? state.votes[hashvoter(deviceid)] : null;
    return {
      id: poll.id,
      active: isopen(),
      question: poll.question,
      options: poll.options,
      endsAt: state.endsAt,
      voted: !!mine,
      choice: mine ? mine.o : null,
    };
  }

  function vote(deviceid, optionid, ip) {
    if (!isopen())
      return { ok: false, code: 410, error: "This poll has closed." };
    if (!poll.options.some((o) => o.id === optionid))
      return { ok: false, code: 400, error: "Pick one of the options." };
    const key = hashvoter(deviceid);
    if (state.votes[key])
      return {
        ok: false,
        code: 409,
        error: "You already voted.",
        choice: state.votes[key].o,
      };
    state.votes[key] = { o: optionid, t: now(), ...(ip ? { ip } : {}) };
    onchange();
    return { ok: true, choice: optionid };
  }

  // Resolve pending IPs to countries, then forget the IPs.
  async function resolvepending(maxbatches = GEO_BATCHES_PER_TICK) {
    const final = maxbatches === Infinity;
    if (!resolvecountries) return;
    const pending = Object.values(state.votes).filter((v) => v.ip);
    if (!pending.length) return;
    const ips = [...new Set(pending.map((v) => v.ip))].slice(
      0,
      GEO_BATCH * maxbatches,
    );
    let lookup;
    try {
      lookup = await resolvecountries(ips);
    } catch (err) {
      log.error("[poll] country lookup failed:", err?.message || err);
      return;
    }
    const wanted = new Set(ips);
    for (const v of pending) {
      if (!wanted.has(v.ip) || !lookup.has(v.ip)) continue;
      const c = lookup.get(v.ip);
      if (c && c.code) {
        v.c = c.code;
        v.n = c.name || c.code;
      } else if (!final) continue; // failed lookups retry next tick
      delete v.ip;
    }
    onchange();
  }

  function results() {
    return tallypoll(poll, Object.values(state.votes));
  }

  async function finish() {
    if (state.posted) return true;
    if (posting) return posting;
    posting = (async () => {
      // everything that's left, ignoring the per-tick cap
      await resolvepending(Infinity);
      const payload = pollpayload(poll, results(), state);
      if (!webhookUrl) {
        log.error("[poll] REPORT_WEBHOOK_URL not set; results not posted");
        state.posted = true;
        onchange();
        return true;
      }
      try {
        const res = await fetchimpl(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        state.posted = true;
        for (const v of Object.values(state.votes)) delete v.ip;
        onchange();
        log.log?.("[poll] results posted to discord");
        return true;
      } catch (err) {
        log.error(
          "[poll] webhook failed, retrying in 5 min:",
          err?.message || err,
        );
        return false;
      }
    })();
    try {
      return await posting;
    } finally {
      posting = null;
    }
  }

  function schedule() {
    clearTimeout(finishtimer);
    if (state.posted) return;
    const wait = state.endsAt - now();
    // long waits re-check in chunks (setTimeout overflows past ~24.8 days)
    finishtimer = setTimeout(
      async () => {
        if (now() < state.endsAt) return schedule();
        const ok = await finish();
        if (!ok) {
          finishtimer = setTimeout(schedule, 5 * 60 * 1000);
          finishtimer.unref?.();
        }
      },
      Math.max(0, Math.min(wait, 6 * 60 * 60 * 1000)),
    );
    finishtimer.unref?.();
  }

  function start() {
    if (!state.startedAt) {
      state.startedAt = now();
      state.endsAt = state.startedAt + durationMs;
      onchange();
    }
    schedule();
    if (!geotimer && resolvecountries) {
      geotimer = setInterval(() => {
        if (!state.posted) resolvepending();
      }, 60_000);
      geotimer.unref?.();
    }
  }

  function stop() {
    clearTimeout(finishtimer);
    clearInterval(geotimer);
    finishtimer = null;
    geotimer = null;
  }

  return {
    restore,
    serialize,
    status,
    vote,
    results,
    resolvepending,
    finish,
    start,
    stop,
    isopen,
  };
}

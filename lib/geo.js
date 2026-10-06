// Country lookup for the stats webhook's "Top Countries" field.
//
// The site terminates TLS in Caddy (no Cloudflare in front), so there is no
// trusted country header. Instead the server batch-resolves the IPs of the
// people currently online via ip-api.com's free batch endpoint (100 IPs per
// request, no key) once per stats post, and caches results so the same IP is
// only looked up once a day. Private/loopback addresses are never sent.

const BATCH_URL =
  "http://ip-api.com/batch?fields=status,countryCode,country,query";
const BATCH_SIZE = 100;
const CACHE_TTL = 24 * 60 * 60 * 1000;
const CACHE_MAX = 50_000;

export function normalizeip(ip) {
  const s = String(ip || "").trim();
  return s.startsWith("::ffff:") ? s.slice(7) : s;
}

export function isprivateip(ip) {
  const s = normalizeip(ip).toLowerCase();
  if (!s) return true;
  if (s.includes(":")) {
    return (
      s === "::1" ||
      s === "::" ||
      s.startsWith("fc") ||
      s.startsWith("fd") ||
      s.startsWith("fe80")
    );
  }
  const p = s.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return true;
  return (
    p[0] === 10 ||
    p[0] === 127 ||
    p[0] === 0 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
  );
}

// "US" -> 🇺🇸
export function countryflag(code) {
  if (!/^[A-Za-z]{2}$/.test(code || "")) return "🏳️";
  return String.fromCodePoint(
    ...code
      .toUpperCase()
      .split("")
      .map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  );
}

// countries: array of { code, name } (or null for unknown), one per person.
export function topcountries(countries, n = 5) {
  const tally = new Map();
  for (const c of countries) {
    if (!c || !c.code) continue;
    const cur = tally.get(c.code) || { code: c.code, name: c.name, count: 0 };
    cur.count++;
    tally.set(c.code, cur);
  }
  return [...tally.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, n);
}

export function formattopcountries(top) {
  if (!top.length) return "No location data yet";
  return top
    .map(
      (c, i) =>
        `${i + 1}. ${countryflag(c.code)} **${c.name}** (${c.code}) — ${c.count}`,
    )
    .join("\n");
}

export function createGeoResolver({ fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map(); // ip -> { value: {code,name}|null, ts }

  async function resolve(ips) {
    const out = new Map();
    const pending = [];
    const t = now();
    for (const raw of new Set(ips.map(normalizeip))) {
      if (isprivateip(raw)) {
        out.set(raw, null);
        continue;
      }
      const hit = cache.get(raw);
      if (hit && t - hit.ts < CACHE_TTL) out.set(raw, hit.value);
      else pending.push(raw);
    }

    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const chunk = pending.slice(i, i + BATCH_SIZE);
      try {
        const res = await fetchImpl(BATCH_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(chunk),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`geo lookup HTTP ${res.status}`);
        const rows = await res.json();
        for (const row of Array.isArray(rows) ? rows : []) {
          const ip = normalizeip(row?.query);
          const value =
            row?.status === "success" && row.countryCode
              ? { code: row.countryCode, name: row.country || row.countryCode }
              : null;
          cache.set(ip, { value, ts: t });
          out.set(ip, value);
        }
      } catch (e) {
        // leave these uncached so the next post retries them
        console.error("[geo] lookup failed:", e.message);
        for (const ip of chunk) if (!out.has(ip)) out.set(ip, null);
      }
    }

    if (cache.size > CACHE_MAX) {
      for (const [ip, v] of cache) {
        if (t - v.ts >= CACHE_TTL || cache.size > CACHE_MAX) cache.delete(ip);
      }
    }
    return out;
  }

  return { resolve, cache };
}

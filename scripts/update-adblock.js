// Refreshes the proxy ad/tracker blocklist used by public/sw.js.
// Source: HaGeZi Multi LIGHT (GPL-3.0), domains-only wildcard format: each
// entry also covers its subdomains. LIGHT is built from Top 1M/10M domains and
// is meant not to break sites, which matters for games that wait on ad SDKs.
//
// After running, bump ADBLOCK_LIST_VERSION in public/sw.js so clients refetch.
//   node scripts/update-adblock.js
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE =
  "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/light-onlydomains.txt";
const OUT = fileURLToPath(
  new URL("../public/assets/data/adblock-domains.txt", import.meta.url),
);

// Never block these, even if a future list adds them: the proxy, game and
// movie paths depend on them.
const ALLOW = new Set(["aetheris.win", "jsdelivr.net", "cdn.jsdelivr.net"]);

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`blocklist download failed: ${res.status}`);
const text = await res.text();

const header = [];
const domains = [];
for (const raw of text.split("\n")) {
  const line = raw.trim();
  if (!line) continue;
  if (line.startsWith("#")) {
    if (/^# (Title|Homepage|License|Last modified|Version):/.test(line))
      header.push(line);
    continue;
  }
  const domain = line.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(domain) || ALLOW.has(domain)) continue;
  domains.push(domain);
}
if (domains.length < 10000)
  throw new Error(`blocklist looks truncated: ${domains.length} entries`);

writeFileSync(OUT, header.join("\n") + "\n" + domains.join("\n") + "\n");
console.log(`wrote ${domains.length} domains to ${OUT}`);

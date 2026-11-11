// WebSocket Origin check for the Wisp upgrade. WebSockets skip CORS, so
// without it any website could use visitors' browsers to drive our relay.
//
// - No Origin header (non-browser client): allowed.
// - Origin "null" (sandboxed/opaque): rejected.
// - Origin hostname equals Host hostname (port-insensitive): allowed.
// - Both on our own domains, e.g. balf-games.xyz -> aetheris.win: allowed.
//   Loopback only matches loopback, so a local page can't reach production.
// - Hosts listed in WS_EXTRA_ORIGINS="a.com,b.com": allowed.

const OWN_ROOTS = ["aetheris.win", "crax.lol", "balf-games.ink", "balf-games.xyz", "neosbay.com"];

function extraOrigins() {
  const raw = process.env.WS_EXTRA_ORIGINS || process.env.LC_RELAY_EXTRA_ORIGINS || "";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean);
}

function hostnameOf(value) {
  if (typeof value !== "string" || !value) return "";
  // Host headers may carry a port ("aetheris.win:443", "[::1]:8080").
  const noPort = value.startsWith("[")
    ? value.slice(0, value.indexOf("]") + 1)
    : value.split(":")[0];
  return noPort.trim().toLowerCase().replace(/\.$/, "");
}

function originHostname(origin) {
  if (typeof origin !== "string" || !origin || origin === "null") return "";
  try {
    return new URL(origin).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

function isLoopbackHost(hostname) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  );
}

function isOwnHost(hostname) {
  if (!hostname) return false;
  return OWN_ROOTS.some((root) => hostname === root || hostname.endsWith(`.${root}`));
}

export function websocketOriginAllowed(req) {
  const origin = req?.headers?.origin;
  if (typeof origin !== "string" || !origin) return true;
  if (origin === "null") return false;

  const originHost = originHostname(origin);
  if (!originHost) return false;

  const host = hostnameOf(req.headers?.host);
  if (!host) return true;
  if (originHost === host) return true;

  if (isOwnHost(originHost) && isOwnHost(host)) return true;
  if (isLoopbackHost(originHost) && isLoopbackHost(host)) return true;
  if (extraOrigins().includes(originHost)) return true;

  return false;
}

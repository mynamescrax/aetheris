// Shared WebSocket Origin check for the app's raw upgrade handlers (wisp,
// lc-relay). WebSockets are not subject to CORS, so without this check any
// website could open these endpoints from a visitor's browser and use the
// server as a relay.
//
// Policy:
// - No Origin header (non-browser clients) -> allowed.
// - Origin "null" (sandboxed opaque origin) -> rejected (would bypass checks).
// - Exact hostname match (Origin vs Host, port-insensitive, case-insensitive)
//   -> allowed. Works for any deployment, including forks and localhost.
// - Both sides on our own operator domains (Caddy on-demand allowlist) ->
//   allowed, so a page on balf-games.xyz can dial the aetheris.win relay and
//   vice versa. Rooms live in one process, so cross-host play works.
// - Otherwise rejected. Set WS_EXTRA_ORIGINS="truffled.lol,example.com" to
//   explicitly allow friendly third-party sites to use the relay.

const OWN_ROOTS = ["aetheris.win", "crax.lol", "balf-games.ink", "balf-games.xyz"];

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

function isOwnHost(hostname) {
  if (!hostname) return false;
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  )
    return true;
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

  // Same operator, different domain (aetheris.win <-> balf-games.xyz etc).
  if (isOwnHost(originHost) && isOwnHost(host)) return true;

  // Explicitly allowlisted friendly sites.
  if (extraOrigins().includes(originHost)) return true;

  return false;
}

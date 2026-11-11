/* Cookie helpers for the gateway (see lib/tiktok-gateway.js).
 * Adapted from https://github.com/mynamescrax/tiktok-gateway-proxy (ISC, see
 * tiktok-gateway.LICENSE).
 *
 * Why this exists: every upstream host is served from ONE browser origin, so
 * the browser's cookie jar mixes cookies from tiktok.com, tiktokcdn-eu.com,
 * tiktokv.com, ... . Forwarding that whole jar upstream hands session cookies
 * to CDN/telemetry hosts, which a real browser can never do. And because we
 * strip `Domain` on the way out, the browser cannot tell us the original scope
 * either — so we remember it here and rebuild a correctly scoped Cookie
 * request header for each upstream host.
 *
 * Unknown cookies (set by page JS via document.cookie, or seen before the jar
 * learned their scope) are passed through untouched: the pre-jar behaviour is
 * the fallback, so a cold jar is never worse than the old blanket forward.
 */

const SEP = "\u0000";

// TikTok's router needs root masked paths (/foryou), which means its cookies
// must be visible at Path=/. To keep them from colliding with the site's own
// cookies (and to keep site cookies out of TikTok requests), every TikTok
// cookie name gets this prefix in the browser jar. The gateway strips it when
// rebuilding the upstream Cookie header.
export const COOKIE_PREFIX = "aetheris_tt_";
export const COOKIE_PATH = "/";

function normalizeDomain(value) {
  return String(value || "").trim().toLowerCase().replace(/^\.+/, "");
}

/** Parse one Set-Cookie value into name/value/attributes. */
export function parseSetCookie(raw) {
  const parts = String(raw || "").split(";");
  const pair = parts.shift().trim();
  const eq = pair.indexOf("=");
  const cookie = {
    name: eq === -1 ? "" : pair.slice(0, eq).trim(),
    value: eq === -1 ? "" : pair.slice(eq + 1),
    attributes: {},
    deleted: false,
  };
  if (!cookie.name) return cookie;
  for (const part of parts) {
    const i = part.indexOf("=");
    const key = (i === -1 ? part : part.slice(0, i)).trim().toLowerCase();
    if (!key) continue;
    cookie.attributes[key] = i === -1 ? "" : part.slice(i + 1).trim();
  }
  const maxAge = cookie.attributes["max-age"];
  if (maxAge !== undefined && Number(maxAge) <= 0) cookie.deleted = true;
  const expires = Date.parse(cookie.attributes.expires || "");
  if (Number.isFinite(expires) && expires <= Date.now()) cookie.deleted = true;
  return cookie;
}

/**
 * Rewrite an upstream Set-Cookie for our own origin.
 *
 * - `Domain` is dropped (we only ever set cookies on the gateway origin).
 * - The name gets `COOKIE_PREFIX` so TikTok's `sessionid`/`ttwid` cannot
 *   collide with a site cookie; the client hook does the same for JS writes.
 * - `Path` is forced to `/`: masked root paths (/foryou) must see the cookies.
 * - `Secure` is kept only when the gateway itself is served over TLS, and
 *   `SameSite=None` is downgraded to `Lax` on plain HTTP (Chrome excludes
 *   `SameSite=None` cookies on insecure origins, which killed msToken).
 * - `Partitioned` is dropped: it requires `Secure`, and our pages are
 *   top-level same-origin, so partitioning buys nothing here.
 */
export function toBrowserSetCookie(
  raw,
  { secure = false, path = COOKIE_PATH } = {},
) {
  const cookie = parseSetCookie(raw);
  if (!cookie.name) return "";
  const attrs = cookie.attributes;
  const parts = [`${COOKIE_PREFIX}${cookie.name}=${cookie.value}`, `Path=${path}`];
  if (attrs.expires !== undefined) parts.push(`Expires=${attrs.expires}`);
  if (attrs["max-age"] !== undefined) parts.push(`Max-Age=${attrs["max-age"]}`);
  if (attrs.httponly !== undefined) parts.push("HttpOnly");
  if (attrs.samesite !== undefined) {
    const none = String(attrs.samesite).toLowerCase() === "none";
    parts.push(`SameSite=${none && !secure ? "Lax" : attrs.samesite}`);
  }
  if (attrs.priority !== undefined) parts.push(`Priority=${attrs.priority}`);
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** Remember the scope each cookie name was minted with. */
export class CookieJar {
  constructor() {
    this.entries = new Map();
    this.names = new Map();
  }

  static key(name, domain, hostOnly) {
    return name + SEP + domain + SEP + (hostOnly ? "1" : "0");
  }

  /** Record the Set-Cookie headers returned by `requestHost`. */
  record(rawList, requestHost) {
    const host = normalizeDomain(requestHost);
    if (!host || !rawList) return;
    const list = Array.isArray(rawList) ? rawList : [rawList];
    for (const raw of list) {
      const cookie = parseSetCookie(raw);
      if (!cookie.name) continue;
      const domain = cookie.attributes.domain ? normalizeDomain(cookie.attributes.domain) : host;
      if (!domain) continue;
      const hostOnly = cookie.attributes.domain === undefined;
      const key = CookieJar.key(cookie.name, domain, hostOnly);
      if (cookie.deleted) this.entries.delete(key);
      else this.entries.set(key, { name: cookie.name, domain, hostOnly, at: Date.now() });
    }
    if (this.entries.size > 512) this.prune();
    this.reindex();
  }

  /** True when a cookie minted for `scope` would be sent to `host`. */
  static matches(scope, host) {
    if (scope.hostOnly) return host === scope.domain;
    return host === scope.domain || host.endsWith("." + scope.domain);
  }

  /**
   * Rebuild a Cookie request header for `host`.
   * Only prefixed (TikTok) cookies are forwarded, with the prefix removed.
   * Unprefixed browser cookies belong to the site and never go upstream.
   */
  filter(cookieHeader, host) {
    const raw = String(cookieHeader || "");
    if (!raw) return "";
    const h = normalizeDomain(host);
    const kept = [];
    for (const part of raw.split(";")) {
      const pair = part.trim();
      if (!pair) continue;
      const eq = pair.indexOf("=");
      const browserName = (eq === -1 ? pair : pair.slice(0, eq)).trim();
      if (!browserName.startsWith(COOKIE_PREFIX)) continue;
      const name = browserName.slice(COOKIE_PREFIX.length);
      if (!name) continue;
      const scopes = this.names.get(name);
      if (scopes && !scopes.some((scope) => CookieJar.matches(scope, h))) {
        continue;
      }
      kept.push(name + (eq === -1 ? "" : pair.slice(eq)));
    }
    return kept.join("; ");
  }

  prune(limit = 512) {
    const stale = [...this.entries.entries()].sort((a, b) => a[1].at - b[1].at);
    for (let i = 0; i < stale.length - limit; i++) this.entries.delete(stale[i][0]);
  }

  reindex() {
    const names = new Map();
    for (const entry of this.entries.values()) {
      const list = names.get(entry.name);
      if (list) list.push(entry);
      else names.set(entry.name, [entry]);
    }
    this.names = names;
  }
}

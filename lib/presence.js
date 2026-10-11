// Chat presence: an account counts as online while one of its pages keeps
// making authenticated API calls (site.js sends a heartbeat every 30s, and
// the chat UI polls). Kept in memory only, so after a restart everyone reads
// as offline until their next request.
export const PRESENCE_TTL_MS = 75_000;

export function createPresence({
  ttl = PRESENCE_TTL_MS,
  maxEntries = 50_000,
  now = Date.now,
} = {}) {
  // lowercase username -> last request time, oldest first (re-inserted on
  // every hit), so the cap can evict the least recently seen in O(1)
  const lastseen = new Map();

  function isOnline(lc) {
    const time = lastseen.get(lc);
    return time !== undefined && now() - time < ttl;
  }

  return {
    seen(lc) {
      lastseen.delete(lc);
      lastseen.set(lc, now());
      if (lastseen.size > maxEntries)
        lastseen.delete(lastseen.keys().next().value);
    },
    forget(lc) {
      lastseen.delete(lc);
    },
    isOnline,
    status(lc) {
      return { online: isOnline(lc), lastSeen: lastseen.get(lc) ?? null };
    },
  };
}

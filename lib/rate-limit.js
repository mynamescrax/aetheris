export function createRateLimiter({ maxEntries = 20000, now = Date.now } = {}) {
  const entries = new Map();
  return function consume(key, limit, windowMs) {
    const time = now();
    let entry = entries.get(key);
    if (!entry || entry.reset <= time) {
      if (entries.size >= maxEntries) {
        for (const [name, item] of entries)
          if (item.reset <= time) entries.delete(name);
        // Still full: evict the oldest entry. Refusing new keys instead would
        // let someone rotating identities lock out every new user.
        if (entries.size >= maxEntries && !entries.has(key)) {
          const oldest = entries.keys().next().value;
          if (oldest !== undefined) entries.delete(oldest);
        }
      }
      entry = { used: 0, reset: time + windowMs };
      entries.set(key, entry);
    }
    entry.used++;
    return {
      allowed: entry.used <= limit,
      retryAfter: Math.max(1, Math.ceil((entry.reset - time) / 1000)),
    };
  };
}

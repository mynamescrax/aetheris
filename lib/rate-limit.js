export function createRateLimiter({ maxEntries = 20000, now = Date.now } = {}) {
  const entries = new Map();
  // One heap node per live key. A full table can reclaim expired windows
  // without scanning every active visitor on every new request.
  const expiry = [];

  function swap(a, b) {
    [expiry[a], expiry[b]] = [expiry[b], expiry[a]];
    expiry[a].index = a;
    expiry[b].index = b;
  }

  function up(index) {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (expiry[parent].reset <= expiry[index].reset) break;
      swap(parent, index);
      index = parent;
    }
  }

  function remove(entry) {
    const index = entry.index;
    const last = expiry.pop();
    if (index === expiry.length) return;
    expiry[index] = last;
    last.index = index;
    const parent = (index - 1) >> 1;
    if (index > 0 && last.reset < expiry[parent].reset) {
      up(index);
      return;
    }
    let at = index;
    while (at * 2 + 1 < expiry.length) {
      let child = at * 2 + 1;
      if (
        child + 1 < expiry.length &&
        expiry[child + 1].reset < expiry[child].reset
      )
        child++;
      if (expiry[at].reset <= expiry[child].reset) break;
      swap(at, child);
      at = child;
    }
  }

  return function consume(key, limit, windowMs) {
    const time = now();
    let entry = entries.get(key);
    if (!entry || entry.reset <= time) {
      if (entries.size >= maxEntries) {
        while (expiry.length && expiry[0].reset <= time) {
          const expired = expiry[0];
          entries.delete(expired.key);
          remove(expired);
        }
        // Still full: evict the oldest entry. Refusing new keys instead would
        // let someone rotating identities lock out every new user.
        if (entries.size >= maxEntries && !entries.has(key)) {
          const oldest = entries.keys().next().value;
          if (oldest !== undefined) {
            remove(entries.get(oldest));
            entries.delete(oldest);
          }
        }
      } else if (entry) {
        remove(entry);
      }
      entry = { key, used: 0, reset: time + windowMs, index: expiry.length };
      entries.set(key, entry);
      expiry.push(entry);
      up(entry.index);
    }
    entry.used++;
    return {
      allowed: entry.used <= limit,
      retryAfter: Math.max(1, Math.ceil((entry.reset - time) / 1000)),
    };
  };
}

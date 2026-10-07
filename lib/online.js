// Counts distinct browsers rather than SSE streams: streams sharing a
// per-browser id (?c=) count once, streams without one count individually.
export function uniqueOnlineCount(clients, clientids) {
  const ids = new Set();
  let anonymous = 0;
  for (const res of clients) {
    const id = clientids.get(res);
    if (id) ids.add(id);
    else anonymous++;
  }
  return ids.size + anonymous;
}

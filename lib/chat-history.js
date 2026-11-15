// DM and group writers append monotonically increasing timestamps. Locate the
// first unseen message without rescanning or allocating the full history.
export function firstMessageAfter(messages, after) {
  after = Number(after);
  if (
    !messages.length ||
    Number.isNaN(after) ||
    messages[messages.length - 1].time <= after
  )
    return messages.length;
  if (messages[0].time > after) return 0;
  let low = 0;
  let high = messages.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (messages[middle].time <= after) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function messagesAfter(messages, after) {
  return messages.slice(firstMessageAfter(messages, after));
}

export function countUnread(messages, after, include) {
  let count = 0;
  for (let i = firstMessageAfter(messages, after); i < messages.length; i++)
    if (include(messages[i])) count++;
  return count;
}

export function latestUnread(messages, after, include) {
  const first = firstMessageAfter(messages, after);
  for (let i = messages.length - 1; i >= first; i--)
    if (include(messages[i])) return messages[i];
  return null;
}

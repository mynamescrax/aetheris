import test from "node:test";
import assert from "node:assert/strict";
import { messagesAfter, countUnread } from "../lib/chat-history.js";

test("cursor lookup matches polling semantics including equal timestamps and invalid cursors", () => {
  const messages = [1, 2, 2, 3, 5, 100].map((time, i) =>
    Object.freeze({ time, from: i % 2 ? "me" : "other", system: i === 4 }),
  );
  Object.freeze(messages);
  const include = (message) => message.from !== "me" && !message.system;
  for (const after of [
    -Infinity,
    -1,
    0,
    1,
    2,
    3,
    4,
    5,
    99,
    100,
    Infinity,
    NaN,
    "2",
    "bad",
  ]) {
    assert.deepEqual(
      messagesAfter(messages, after),
      messages.filter((m) => m.time > after),
    );
    assert.equal(
      countUnread(messages, after, include),
      messages.filter((m) => m.time > after && include(m)).length,
    );
  }
  assert.deepEqual(messagesAfter([], 0), []);
  assert.equal(countUnread([], 0, include), 0);
});

test("an up-to-date chat poll avoids reading the full message history", () => {
  let timestampsRead = 0;
  const messages = Array.from({ length: 1000 }, (_, i) => ({
    get time() {
      timestampsRead++;
      return i + 1;
    },
    from: "other",
  }));
  assert.deepEqual(messagesAfter(messages, 1000), []);
  assert.equal(timestampsRead, 1);
  timestampsRead = 0;
  assert.equal(messagesAfter(messages, 995).length, 5);
  assert.ok(timestampsRead <= 12, `read ${timestampsRead} timestamps`);
  let checked = 0;
  assert.equal(
    countUnread(messages, 995, () => {
      checked++;
      return true;
    }),
    5,
  );
  assert.equal(checked, 5, "only unread candidates need sender/system checks");
});

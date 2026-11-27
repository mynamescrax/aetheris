import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function fixture() {
  class Element {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.events = {};
      this.attributes = {};
      this.classList = { add() {} };
    }
    append(...elements) {
      for (const element of elements) {
        this.children.push(element);
        element.parent = this;
      }
    }
    appendChild(element) {
      this.append(element);
    }
    remove() {
      if (this.parent)
        this.parent.children = this.parent.children.filter(
          (child) => child !== this,
        );
    }
    setAttribute(name, value) {
      this.attributes[name] = value;
    }
    addEventListener(name, handler) {
      this.events[name] = handler;
    }
    contains(target) {
      return (
        this === target || this.children.some((child) => child.contains(target))
      );
    }
  }
  let now = 0,
    id = 0;
  const timers = new Map();
  const document = {
    body: new Element("body"),
    hidden: false,
    createElement: (tag) => new Element(tag),
  };
  const window = { Aetheris: {} };
  vm.runInNewContext(
    readFileSync(
      new URL("../public/js/chat-notifications.js", import.meta.url),
      "utf8",
    ),
    {
      window,
      document,
      Date: { now: () => now },
      setTimeout: (fn, delay) => {
        timers.set(++id, { fn, due: now + delay });
        return id;
      },
      clearTimeout: (key) => timers.delete(key),
    },
  );
  return {
    api: window.Aetheris.chatNotifications,
    document,
    cards: () => document.body.children[0]?.children || [],
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
        if (!next || next[1].due > end) break;
        timers.delete(next[0]);
        now = next[1].due;
        next[1].fn();
      }
      now = end;
    },
  };
}

function conversation(time, name = "Friend", message = "hello") {
  return {
    with: name,
    lastTime: time,
    unread: 1,
    notification: { from: name, time, message },
  };
}

test("initial unread messages stay quiet; new messages show once and expire", () => {
  const f = fixture();
  f.api.update([conversation(1)], "session", null);
  assert.equal(f.cards().length, 0);
  f.api.update([conversation(2)], "session", null);
  assert.equal(f.cards().length, 1);
  f.api.update([conversation(2)], "session", null);
  f.advance(5180);
  assert.equal(f.cards().length, 0);
  f.api.update([conversation(2)], "session", null);
  assert.equal(f.cards().length, 0);
});

test("open conversations, read messages and account changes never replay a popup", () => {
  const f = fixture();
  f.api.update([], "session", null);
  f.api.update([conversation(1)], "session", "friend");
  f.api.update([conversation(1)], "session", null);
  assert.equal(f.cards().length, 0);
  f.api.update(
    [{ ...conversation(2), unread: 0, notification: null }],
    "session",
    null,
  );
  assert.equal(f.cards().length, 0);
  f.api.update([conversation(3)], "session", null);
  assert.equal(f.cards().length, 1);
  f.api.update([conversation(100)], "other-session", null);
  assert.equal(f.cards().length, 0);
  f.api.update([conversation(101)], "other-session", null);
  assert.equal(f.cards().length, 1);
  f.api.clear();
  assert.equal(f.cards().length, 0);
});

test("notification text is literal and click-to-open is separate from dismiss", () => {
  const f = fixture();
  let opened;
  f.api.onOpen = (key, display) => {
    opened = [key, display];
  };
  f.api.update([], "session", null);
  f.api.update(
    [conversation(1, "Friend", '<img src=x onerror="bad()">')],
    "session",
    null,
  );
  const card = f.cards()[0];
  assert.equal(card.attributes.role, "status");
  assert.equal(
    card.children[0].children[1].children[2].textContent,
    '<img src=x onerror="bad()">',
  );
  card.children[1].events.click();
  assert.equal(opened, undefined);
  f.advance(180);
  assert.equal(f.cards().length, 0);
  f.api.update([conversation(2)], "session", null);
  f.cards()[0].children[0].events.click();
  assert.deepEqual(opened, ["friend", "Friend"]);
  assert.equal(f.cards().length, 0);
});

test("hover and keyboard focus pause dismissal without trapping focus", () => {
  const f = fixture();
  f.api.update([], "session", null);
  f.api.update([conversation(1)], "session", null);
  const card = f.cards()[0];
  f.advance(2000);
  card.events.mouseenter();
  f.advance(10000);
  assert.equal(f.cards().length, 1);
  card.events.focusin();
  card.events.mouseleave();
  f.advance(10000);
  assert.equal(f.cards().length, 1);
  card.events.focusout({ relatedTarget: null });
  f.advance(3180);
  assert.equal(f.cards().length, 0);
});

test("bursts stay bounded and hidden pages do not consume new message notifications", () => {
  const f = fixture();
  f.api.update([], "session", null);
  f.document.hidden = true;
  f.api.update([conversation(1)], "session", null);
  f.document.hidden = false;
  f.api.update([conversation(1)], "session", null);
  assert.equal(f.cards().length, 1);
  f.api.update(
    [
      conversation(2, "Other"),
      conversation(2, "Third"),
      conversation(2, "Fourth"),
    ],
    "session",
    null,
  );
  assert.equal(f.cards().length, 3);
  f.api.update([conversation(3, "Fourth", "newest")], "session", null);
  assert.equal(f.cards().length, 3);
  assert.equal(
    f.cards().at(-1).children[0].children[1].children[2].textContent,
    "newest",
  );
});

test("group notifications identify the sender and open the group conversation", () => {
  const f = fixture();
  let opened;
  f.api.onOpen = (key) => {
    opened = key;
  };
  f.api.update([], "session", null);
  f.api.update(
    [
      {
        ...conversation(1, "Study group", "Ready?"),
        group: "Abcdefgh1234",
        notification: { from: "Alex", message: "Ready?", time: 1 },
      },
    ],
    "session",
    null,
  );
  const open = f.cards()[0].children[0];
  assert.equal(open.children[1].children[1].textContent, "Study group");
  assert.equal(open.children[1].children[2].textContent, "Alex: Ready?");
  open.events.click();
  assert.equal(opened, "g:Abcdefgh1234");
});

test("chat deep links open only a conversation present in the authenticated inbox", async () => {
  const source = readFileSync(
    new URL("../public/js/dm-ui.js", import.meta.url),
    "utf8",
  );
  const loadInbox = source.slice(
    source.indexOf("var inboxRequestToken"),
    source.indexOf("function filterinbox()"),
  );
  for (const requested of ["friend", "g:Abcdefgh1234", "unknown"]) {
    const opened = [];
    const context = {
      authtoken: "session",
      requestedConversation: requested,
      document: { hidden: false },
      window: {}, AbortController, setTimeout, clearTimeout,
      authheaders: () => ({}),
      filterinbox() {},
      convokey: (c) => (c.group ? "g:" + c.group : c.with.toLowerCase()),
      openconvo: (key, display) => opened.push([key, display]),
      fetch: async () => ({
        status: 200,
        json: async () => ({
          ok: true,
          conversations: [
            { with: "Friend" },
            { group: "Abcdefgh1234", with: "Study group" },
          ],
        }),
      }),
    };
    context.window.top = context.window;
    vm.runInNewContext(loadInbox, context);
    await context.loadinbox();
    assert.equal(context.requestedConversation, null);
    assert.deepEqual(
      opened,
      requested === "unknown"
        ? []
        : [[requested, requested === "friend" ? "Friend" : "Study group"]],
    );
  }
});

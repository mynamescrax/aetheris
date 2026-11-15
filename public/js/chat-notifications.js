(function () {
  "use strict";

  var session = "";
  var ready = false;
  var seen = new Map();
  var toasts = new Map();
  var region = null;
  var DURATION = 5000;

  function keyFor(conversation) {
    if (
      typeof conversation.group === "string" &&
      /^[A-Za-z0-9_-]{12}$/.test(conversation.group)
    )
      return "g:" + conversation.group;
    return typeof conversation.with === "string" &&
      /^[a-zA-Z0-9_.-]{2,32}$/.test(conversation.with)
      ? conversation.with.toLowerCase()
      : null;
  }

  function dismiss(key, immediate) {
    var toast = toasts.get(key);
    if (!toast) return;
    clearTimeout(toast.timer);
    toasts.delete(key);
    if (immediate) toast.element.remove();
    else {
      toast.element.classList.add("is-leaving");
      setTimeout(function () {
        toast.element.remove();
      }, 180);
    }
  }

  function clear() {
    Array.from(toasts.keys()).forEach(function (key) {
      dismiss(key, true);
    });
    seen.clear();
    ready = false;
    session = "";
  }

  function mount() {
    if (region) return region;
    region = document.createElement("div");
    region.id = "chat-notifications";
    region.setAttribute("aria-label", "New messages");
    document.body.appendChild(region);
    return region;
  }

  function show(key, conversation, message) {
    dismiss(key, true);
    while (toasts.size >= 3) dismiss(toasts.keys().next().value, true);
    var element = document.createElement("div");
    element.className = "chat-notification";
    element.setAttribute("role", "status");
    element.setAttribute("aria-live", "polite");
    element.setAttribute("aria-atomic", "true");

    var open = document.createElement("button");
    open.type = "button";
    open.className = "chat-notification-open";
    open.setAttribute(
      "aria-label",
      "Open conversation with " + conversation.with,
    );
    var avatar = document.createElement("span");
    avatar.className = "chat-notification-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = conversation.group
      ? "#"
      : conversation.with.slice(0, 2).toUpperCase();
    var copy = document.createElement("span");
    copy.className = "chat-notification-copy";
    var label = document.createElement("span");
    label.className = "chat-notification-label";
    label.textContent = "New message";
    var title = document.createElement("span");
    title.className = "chat-notification-title";
    title.textContent = conversation.with;
    var preview = document.createElement("span");
    preview.className = "chat-notification-preview";
    preview.textContent =
      (conversation.group ? message.from + ": " : "") + message.message;
    copy.append(label, title, preview);
    open.append(avatar, copy);
    open.addEventListener("click", function () {
      dismiss(key, true);
      if (typeof api.onOpen === "function") api.onOpen(key, conversation.with);
    });

    var close = document.createElement("button");
    close.type = "button";
    close.className = "chat-notification-close";
    close.setAttribute("aria-label", "Dismiss message notification");
    close.textContent = "\u00d7";
    close.addEventListener("click", function () {
      dismiss(key);
    });
    element.append(open, close);
    mount().appendChild(element);
    var toast = {
      element: element,
      timer: null,
      remaining: DURATION,
      started: 0,
      hovered: false,
      focused: false,
    };
    function resume() {
      if (
        toast.hovered ||
        toast.focused ||
        !toasts.has(key) ||
        toast.timer !== null
      )
        return;
      toast.started = Date.now();
      toast.timer = setTimeout(function () {
        dismiss(key);
      }, toast.remaining);
    }
    function pause() {
      if (toast.timer === null) return;
      clearTimeout(toast.timer);
      toast.timer = null;
      toast.remaining = Math.max(
        0,
        toast.remaining - (Date.now() - toast.started),
      );
    }
    element.addEventListener("mouseenter", function () {
      toast.hovered = true;
      pause();
    });
    element.addEventListener("mouseleave", function () {
      toast.hovered = false;
      resume();
    });
    element.addEventListener("focusin", function () {
      toast.focused = true;
      pause();
    });
    element.addEventListener("focusout", function (event) {
      if (element.contains(event.relatedTarget)) return;
      toast.focused = false;
      resume();
    });
    toasts.set(key, toast);
    resume();
  }

  function update(conversations, token, active) {
    if (token !== session) {
      clear();
      session = token;
    }
    if (!token || !Array.isArray(conversations) || document.hidden) return;
    if (active) dismiss(active, true);
    conversations.forEach(function (conversation) {
      if (!conversation || typeof conversation.with !== "string") return;
      var key = keyFor(conversation);
      if (!key) return;
      var message = conversation.notification;
      var time = message && Number(message.time);
      if (!Number.isFinite(time) || time < 0) time = 0;
      var previous = seen.get(key) || 0;
      // Seed the initial inbox quietly. Reloads/logins must not replay old DMs.
      if (
        ready &&
        time > previous &&
        Number(conversation.unread) > 0 &&
        key !== active &&
        typeof message.message === "string" &&
        typeof message.from === "string"
      ) {
        show(key, conversation, message);
      }
      seen.set(
        key,
        Math.max(previous, time || Number(conversation.lastTime) || 0),
      );
    });
    ready = true;
    // Only retain cursors for conversations still in the inbox.
    if (seen.size > 1000) {
      var current = new Set(conversations.filter(Boolean).map(keyFor));
      seen.forEach(function (_, key) {
        if (!current.has(key)) seen.delete(key);
      });
    }
  }

  var api = { update: update, clear: clear, onOpen: null };
  window.Aetheris.chatNotifications = api;
})();

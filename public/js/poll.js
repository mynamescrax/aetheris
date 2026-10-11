// Mandatory site poll (server side: lib/poll.js). Runs in the top-level
// shell (index.html) only, waits for the tutorial, and blocks the site until
// this device has voted. One vote per device id (dmDeviceId), not per IP.
(function () {
  "use strict";
  if (window.top !== window || typeof fetch !== "function") return;

  var store = window.Aetheris && window.Aetheris.storage;
  if (!store) return;
  var DONE_KEY = "pollVoted";

  function deviceid() {
    var id = store.getItem("dmDeviceId");
    if (id && /^[a-f0-9]{64}$/.test(id)) return id;
    if (!window.crypto || !crypto.getRandomValues) return "";
    var bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    id = Array.prototype.map
      .call(bytes, function (b) {
        return (b < 16 ? "0" : "") + b.toString(16);
      })
      .join("");
    store.setItem("dmDeviceId", id);
    return id;
  }

  var css =
    "#poll-backdrop{position:fixed;inset:0;z-index:100001;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(4,5,14,.78);font-family:var(--font-sans,system-ui,sans-serif)}" +
    "#poll-card{width:min(420px,100%);background:#141418;color:#e5e7eb;border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:24px;box-shadow:0 16px 40px rgba(0,0,0,.45)}" +
    "#poll-kicker{margin:0 0 8px;font-size:.75rem;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:rgba(229,231,235,.55)}" +
    "#poll-title{margin:0 0 6px;font-size:1.125rem;font-weight:650;letter-spacing:-.01em;color:#fff}" +
    "#poll-sub{margin:0 0 16px;font-size:.875rem;line-height:1.5;color:rgba(229,231,235,.7)}" +
    "#poll-options{display:flex;flex-direction:column;gap:8px;margin:0 0 16px;padding:0;border:0}" +
    ".poll-opt{display:flex;align-items:center;gap:10px;width:100%;text-align:left;font:inherit;font-size:.9375rem;font-weight:500;color:#fff;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:12px 14px;cursor:pointer}" +
    ".poll-opt:hover{background:rgba(255,255,255,.09)}" +
    ".poll-opt[aria-checked=true]{background:rgba(255,255,255,.14);border-color:#fff}" +
    ".poll-dot{flex:none;width:16px;height:16px;border-radius:50%;border:2px solid rgba(255,255,255,.4)}" +
    ".poll-opt[aria-checked=true] .poll-dot{border-color:#fff;background:radial-gradient(circle,#fff 0 4px,transparent 5px)}" +
    ".poll-opt:focus-visible,#poll-submit:focus-visible{outline:2px solid rgba(255,255,255,.55)!important;outline-offset:2px;box-shadow:none}" +
    "#poll-foot{display:flex;align-items:center;gap:12px}" +
    "#poll-msg{flex:1;margin:0;font-size:.8125rem;color:rgba(229,231,235,.7)}" +
    "#poll-msg.err{color:#fca5a5}" +
    "#poll-submit{font:inherit;font-size:.875rem;font-weight:600;border-radius:8px;padding:9px 18px;cursor:pointer;background:#fff;color:#111827;border:1px solid #fff}" +
    "#poll-submit:disabled{opacity:.45;cursor:not-allowed}";

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    if (text) node.textContent = text;
    return node;
  }

  var root = null;

  function show(poll, id) {
    if (root) return;
    var style = el("style", { id: "poll-style" });
    style.textContent = css;
    document.head.appendChild(style);

    root = el("div", {
      id: "poll-backdrop",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "poll-title",
    });
    var card = el("div", { id: "poll-card" });
    card.appendChild(el("p", { id: "poll-kicker" }, "Quick poll"));
    card.appendChild(el("h2", { id: "poll-title" }, poll.question));
    card.appendChild(
      el(
        "p",
        { id: "poll-sub" },
        "Vote to keep using Aetheris. One vote per person, results are shared when the poll closes.",
      ),
    );
    var group = el("div", {
      id: "poll-options",
      role: "radiogroup",
      "aria-labelledby": "poll-title",
    });
    var choice = "";
    var buttons = [];
    poll.options.forEach(function (o) {
      var b = el("button", {
        type: "button",
        class: "poll-opt",
        role: "radio",
        "aria-checked": "false",
        "data-id": o.id,
      });
      b.appendChild(el("span", { class: "poll-dot", "aria-hidden": "true" }));
      b.appendChild(el("span", {}, o.label));
      b.addEventListener("click", function () {
        choice = o.id;
        buttons.forEach(function (x) {
          x.setAttribute("aria-checked", String(x === b));
        });
        submit.disabled = false;
        msg.textContent = "";
        msg.className = "";
      });
      buttons.push(b);
      group.appendChild(b);
    });
    card.appendChild(group);

    var foot = el("div", { id: "poll-foot" });
    var msg = el("p", { id: "poll-msg", "aria-live": "polite" });
    var submit = el("button", { type: "button", id: "poll-submit" }, "Vote");
    submit.disabled = true;
    foot.appendChild(msg);
    foot.appendChild(submit);
    card.appendChild(foot);
    root.appendChild(card);

    // keep keyboard focus inside the dialog; Escape does nothing
    root.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
      } else if (e.key === "Tab") {
        var f = buttons.concat(submit.disabled ? [] : [submit]);
        var i = f.indexOf(document.activeElement);
        e.preventDefault();
        f[(i + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus();
      }
    });

    submit.addEventListener("click", function () {
      if (!choice || submit.disabled) return;
      submit.disabled = true;
      msg.className = "";
      msg.textContent = "Sending\u2026";
      fetch("/api/poll/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: id, option: choice }),
      })
        .then(function (r) {
          return r
            .json()
            .catch(function () {
              return {};
            })
            .then(function (d) {
              return { status: r.status, data: d };
            });
        })
        .then(function (res) {
          // 409 already voted, 410 closed: either way this device is done
          if (res.data.ok || res.status === 409 || res.status === 410) {
            store.setItem(DONE_KEY, poll.id);
            msg.textContent = "Thanks for voting!";
            setTimeout(hide, 700);
            return;
          }
          throw new Error(res.data.error || "Couldn't send your vote.");
        })
        .catch(function (err) {
          msg.className = "err";
          msg.textContent =
            (err && err.message) || "Couldn't send your vote. Try again.";
          if (/fetch|network|load failed/i.test(msg.textContent))
            msg.textContent = "Couldn't reach the server. Try again.";
          submit.disabled = false;
        });
    });

    document.body.appendChild(root);
    setinert(true);
    buttons[0].focus();
  }

  // the page behind can't be clicked or tabbed into while the poll is up
  function setinert(on) {
    var kids = document.body.children;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i] === root || kids[i].id === "tut-backdrop") continue;
      if (on) kids[i].setAttribute("inert", "");
      else kids[i].removeAttribute("inert");
    }
  }

  function hide() {
    if (!root) return;
    setinert(false);
    root.parentNode.removeChild(root);
    root = null;
  }

  function tutorialbusy() {
    var t = window.AetherisTutorial;
    return !!(t && t.active && t.active());
  }

  function whenready(fn) {
    if (!tutorialbusy()) return fn();
    var timer = setInterval(function () {
      if (tutorialbusy()) return;
      clearInterval(timer);
      fn();
    }, 400);
  }

  function run() {
    var id = deviceid();
    if (!id) return; // can't identify this device, so it can't vote
    fetch("/api/poll?deviceId=" + id)
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (poll) {
        if (!poll || !poll.active) return;
        if (poll.voted) {
          store.setItem(DONE_KEY, poll.id);
          return;
        }
        if (!Array.isArray(poll.options) || !poll.options.length) return;
        whenready(function () {
          show(poll, id);
        });
      })
      .catch(function () {
        // server unreachable: never lock people out over a poll
      });
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", run, { once: true });
  else run();
})();

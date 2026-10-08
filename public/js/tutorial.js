// First-load tutorial for the shell (index.html). Shows once, then can be
// replayed from settings (settings posts { type: "show-tutorial" }).
(function () {
  var DONE_KEY = "tutorialDone";
  var store = window.Aetheris && Aetheris.storage;
  if (!store) return;

  function go(page) {
    return function () {
      if (typeof window.navigateApp === "function") window.navigateApp(page);
    };
  }

  var steps = [
    {
      icon: "👋",
      title: "welcome to aetheris",
      body: "quick tour of how everything works. takes like 30 seconds - you can skip anytime.",
    },
    {
      icon: "☰",
      title: "the menu",
      body: "tap the handle on the left edge to open the menu. that's where games, apps, cheats, search, chat, ai, movies and settings live.",
      action: {
        label: "open the menu",
        run: function () {
          var h = document.querySelector(".nav-handle");
          if (h) h.click();
        },
      },
    },
    {
      icon: "🎮",
      title: "playing games",
      body: "pick a game from games, search for one, or hit random. above the game you get fullscreen, favorites and a report button. if a game won't load, try another source from the dropdown or report it.",
      action: { label: "open games", run: go("games") },
    },
    {
      icon: "🌐",
      title: "apps & search",
      body: "apps has sites like youtube ready to go. search lets you open any site from inside aetheris.",
      action: { label: "open apps", run: go("apps") },
    },
    {
      icon: "🥷",
      title: "panic key",
      body: "set a panic key and pressing it instantly jumps to google classroom (or any url you pick in settings). use a key games don't need, like ` or ;",
      panic: true,
    },
    {
      icon: "🎭",
      title: "tab cloaking",
      body: "in settings you can change the tab name and icon so it looks like a normal site.",
      action: { label: "open settings", run: go("settings") },
    },
    {
      icon: "⚡",
      title: "slow device?",
      body: "turn on performance mode in settings to cut effects. if a game thinks you're on a phone, turn on desktop mode. you can also change the theme or set your own background.",
      action: { label: "open settings", run: go("settings") },
    },
    {
      icon: "💾",
      title: "don't lose your saves",
      body: "settings → data lets you back up your settings and game saves to a file, and load them on another device.",
    },
    {
      icon: "✅",
      title: "you're all set",
      body: "have fun. you can replay this tour anytime from settings.",
    },
  ];

  var css =
    "#tut-backdrop{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(4,5,14,.72);font-family:'JetBrains Mono',monospace}" +
    "#tut-card{width:min(440px,100%);background:#111827;color:#e5e7eb;border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:22px 22px 16px;text-align:left;box-shadow:0 20px 60px rgba(0,0,0,.5)}" +
    "#tut-icon{font-size:30px;line-height:1;margin-bottom:10px}" +
    "#tut-title{margin:0 0 8px;font-size:1.15rem;color:#fff}" +
    "#tut-body{margin:0 0 14px;font-size:.9rem;line-height:1.55;opacity:.9}" +
    "#tut-extra{margin:0 0 14px}" +
    "#tut-extra button,#tut-nav button{font:inherit;font-size:.85rem;border-radius:10px;padding:8px 12px;cursor:pointer;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.08);color:#fff}" +
    "#tut-extra button:hover,#tut-nav button:hover{background:rgba(255,255,255,.14)}" +
    "#tut-extra .tut-note{display:block;margin-top:8px;font-size:.8rem;opacity:.75}" +
    "#tut-dots{display:flex;gap:6px;justify-content:center;margin:4px 0 14px}" +
    "#tut-dots span{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.22)}" +
    "#tut-dots span.on{background:#fff}" +
    "#tut-nav{display:flex;gap:8px;align-items:center}" +
    "#tut-nav .tut-skip{background:none;border-color:transparent;opacity:.7;margin-right:auto}" +
    "#tut-nav .tut-next{background:#fff;color:#111827;border-color:#fff}" +
    "#tut-nav .tut-next:hover{background:#e5e7eb}";

  var root = null;
  var index = 0;
  var capturing = null;

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs)
      Object.keys(attrs).forEach(function (k) {
        n.setAttribute(k, attrs[k]);
      });
    if (text) n.textContent = text;
    return n;
  }

  function stopcapture() {
    if (capturing) document.removeEventListener("keydown", capturing, true);
    capturing = null;
  }

  function panicextra(box) {
    var current = store.getItem("panickey");
    var btn = el("button", { type: "button" }, "set panic key now");
    var note = el(
      "span",
      { class: "tut-note" },
      current ? "current panic key: " + current : "no panic key set yet",
    );
    btn.addEventListener("click", function () {
      stopcapture();
      btn.textContent = "press a key...";
      capturing = function (e) {
        if (e.key === "Escape" || e.key === "Tab") return;
        e.preventDefault();
        e.stopPropagation();
        stopcapture();
        store.setItem("panickey", e.key);
        btn.textContent = "change panic key";
        note.textContent = "panic key set to: " + e.key;
      };
      document.addEventListener("keydown", capturing, true);
    });
    box.appendChild(btn);
    box.appendChild(note);
  }

  function render() {
    stopcapture();
    var step = steps[index];
    var last = index === steps.length - 1;
    root.querySelector("#tut-icon").textContent = step.icon;
    root.querySelector("#tut-title").textContent = step.title;
    root.querySelector("#tut-body").textContent = step.body;

    var extra = root.querySelector("#tut-extra");
    extra.textContent = "";
    extra.hidden = !(step.action || step.panic);
    if (step.panic) panicextra(extra);
    if (step.action) {
      var a = el("button", { type: "button" }, step.action.label);
      a.addEventListener("click", function () {
        step.action.run();
      });
      extra.appendChild(a);
    }

    var dots = root.querySelector("#tut-dots");
    dots.textContent = "";
    steps.forEach(function (_, i) {
      dots.appendChild(el("span", i === index ? { class: "on" } : null));
    });

    root.querySelector(".tut-back").hidden = index === 0;
    root.querySelector(".tut-skip").hidden = last;
    root.querySelector(".tut-next").textContent = last ? "let's go" : "next";
    root.querySelector(".tut-next").focus();
  }

  function close() {
    stopcapture();
    store.setItem(DONE_KEY, "1");
    document.removeEventListener("keydown", onkey, true);
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null;
  }

  function onkey(e) {
    if (!root || capturing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowRight") {
      next();
    } else if (e.key === "ArrowLeft" && index > 0) {
      index--;
      render();
    }
  }

  function next() {
    if (index >= steps.length - 1) return close();
    index++;
    render();
  }

  function start() {
    if (root) return;
    if (!document.getElementById("tut-style")) {
      var style = el("style", { id: "tut-style" });
      style.textContent = css;
      document.head.appendChild(style);
    }
    index = 0;
    root = el("div", {
      id: "tut-backdrop",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "tut-title",
    });
    var card = el("div", { id: "tut-card" });
    card.appendChild(el("div", { id: "tut-icon", "aria-hidden": "true" }));
    card.appendChild(el("h2", { id: "tut-title" }));
    card.appendChild(el("p", { id: "tut-body" }));
    card.appendChild(el("div", { id: "tut-extra" }));
    card.appendChild(el("div", { id: "tut-dots", "aria-hidden": "true" }));
    var nav = el("div", { id: "tut-nav" });
    var skip = el("button", { type: "button", class: "tut-skip" }, "skip");
    var back = el("button", { type: "button", class: "tut-back" }, "back");
    var fwd = el("button", { type: "button", class: "tut-next" }, "next");
    skip.addEventListener("click", close);
    back.addEventListener("click", function () {
      if (index > 0) index--;
      render();
    });
    fwd.addEventListener("click", next);
    nav.appendChild(skip);
    nav.appendChild(back);
    nav.appendChild(fwd);
    card.appendChild(nav);
    root.appendChild(card);
    document.body.appendChild(root);
    document.addEventListener("keydown", onkey, true);
    render();
  }

  window.AetherisTutorial = { start: start };

  window.addEventListener("message", function (e) {
    if (e.origin !== location.origin) return;
    if (e.data && e.data.type === "show-tutorial") start();
  });

  function auto() {
    if (store.getItem(DONE_KEY) !== "1") start();
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", auto, { once: true });
  else auto();
})();

// First-load tutorial for the shell (index.html). Shows once, then can be
// replayed from settings (settings posts { type: "show-tutorial" }).
(function () {
  var DONE_KEY = "tutorialDone";
  // Bump to show the tour once more to everyone (including people who already
  // finished an older version). It's marked done as soon as it opens, so
  // reloading or leaving mid-tour never brings it back.
  var TUTORIAL_VERSION = "2";
  var LINKS_DOC =
    "https://docs.google.com/document/d/1z5KIqm8KPfS-ghA2L14XwcoRG0IOOCfNMGj_JgO8-kU/edit?usp=sharing";
  var store = window.Aetheris && Aetheris.storage;
  if (!store) return;

  function go(page) {
    return function () {
      if (typeof window.navigateApp === "function") window.navigateApp(page);
    };
  }

  var steps = [
    {
      icon: "🔖",
      title: "Bookmark the links doc",
      body: "It always has the latest working links, so you never lose access to the site.",
      action: {
        label: "Open the links doc",
        run: function () {
          window.open(LINKS_DOC, "_blank", "noopener");
        },
      },
    },
    {
      icon: "👋",
      title: "Welcome to Aetheris",
      body: "A quick tour of how everything works. It takes about 30 seconds, and you can skip it anytime.",
    },
    {
      icon: "☰",
      title: "The menu",
      body: "Tap the button in the top-left corner to open the menu. Games, apps, cheats, search, chat, AI, movies and settings all live there.",
      action: {
        label: "Open the menu",
        run: function () {
          var h = document.querySelector(".nav-handle");
          if (h) h.click();
        },
      },
    },
    {
      icon: "🎮",
      title: "Playing games",
      body: "Pick a game, search for one, or hit Random. Above each game you'll find fullscreen, favorites and a report button. If a game won't load, try another source from the dropdown or report it.",
      action: { label: "Open games", run: go("games") },
    },
    {
      icon: "🌐",
      title: "Apps and search",
      body: "Apps has sites like YouTube ready to go. Search lets you open any site from inside Aetheris.",
      action: { label: "Open apps", run: go("apps") },
    },
    {
      icon: "🥷",
      title: "Panic key",
      body: "Set a panic key and pressing it instantly jumps to Google Classroom, or any URL you pick in settings. Use a key games don't need, like ` or ;",
      panic: true,
    },
    {
      icon: "🎭",
      title: "Tab cloaking",
      body: "In settings you can change the tab name and icon so it looks like a normal site.",
      action: { label: "Open settings", run: go("settings") },
    },
    {
      icon: "⚡",
      title: "Slow device?",
      body: "Turn on performance mode in settings to cut effects. If a game thinks you're on a phone, turn on desktop mode. You can also change the theme or set your own background.",
      action: { label: "Open settings", run: go("settings") },
    },
    {
      icon: "💾",
      title: "Don't lose your saves",
      body: "Settings → Data lets you back up your settings and game saves to a file, and load them on another device.",
    },
    {
      icon: "✅",
      title: "You're all set",
      body: "Have fun. You can replay this tour anytime from settings.",
    },
  ];

  var css =
    "#tut-backdrop{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(4,5,14,.72);font-family:var(--font-sans,system-ui,sans-serif)}" +
    "#tut-card{width:min(420px,100%);background:#141418;color:#e5e7eb;border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:24px 24px 16px;text-align:left;box-shadow:0 16px 40px rgba(0,0,0,.45)}" +
    "#tut-icon{font-size:24px;line-height:1;margin-bottom:12px}" +
    "#tut-title{margin:0 0 6px;font-size:1.125rem;font-weight:650;letter-spacing:-.01em;color:#fff}" +
    "#tut-body{margin:0 0 16px;font-size:.9375rem;line-height:1.55;color:rgba(229,231,235,.75)}" +
    "#tut-extra{margin:0 0 16px}" +
    "#tut-extra button,#tut-nav button{font:inherit;font-size:.875rem;font-weight:500;border-radius:8px;padding:8px 14px;cursor:pointer;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#fff;outline-offset:2px}" +
    "#tut-extra button:hover,#tut-nav button:hover{background:rgba(255,255,255,.14)}" +
    "#tut-extra button:focus-visible,#tut-nav button:focus-visible{outline:2px solid rgba(255,255,255,.45)!important;outline-offset:2px;box-shadow:none}" +
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
    var btn = el("button", { type: "button" }, "Set panic key");
    var note = el(
      "span",
      { class: "tut-note" },
      current ? "Current panic key: " + current : "No panic key set yet",
    );
    btn.addEventListener("click", function () {
      stopcapture();
      btn.textContent = "Press a key…";
      capturing = function (e) {
        if (e.key === "Escape" || e.key === "Tab") return;
        e.preventDefault();
        e.stopPropagation();
        stopcapture();
        store.setItem("panickey", e.key);
        btn.textContent = "Change panic key";
        note.textContent = "Panic key set to " + e.key;
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
    root.querySelector(".tut-next").textContent = last ? "Let's go" : "Next";
    root.querySelector(".tut-next").focus();
  }

  // home.html (in an iframe) holds its "whats new" notice while the
  // tutorial is up and shows it once the tutorial closes.
  function tellframes(type) {
    var frames = document.querySelectorAll("iframe");
    for (var i = 0; i < frames.length; i++) {
      try {
        frames[i].contentWindow.postMessage({ type: type }, location.origin);
      } catch (_) {}
    }
  }

  function close() {
    stopcapture();
    store.setItem(DONE_KEY, TUTORIAL_VERSION);
    document.removeEventListener("keydown", onkey, true);
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null;
    tellframes("tutorial-closed");
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
    var skip = el("button", { type: "button", class: "tut-skip" }, "Skip");
    var back = el("button", { type: "button", class: "tut-back" }, "Back");
    var fwd = el("button", { type: "button", class: "tut-next" }, "Next");
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
    tellframes("tutorial-open");
  }

  window.AetherisTutorial = {
    start: start,
    active: function () {
      return !!root;
    },
  };

  window.addEventListener("message", function (e) {
    if (e.origin !== location.origin) return;
    if (e.data && e.data.type === "show-tutorial") start();
  });

  function auto() {
    if (store.getItem(DONE_KEY) === TUTORIAL_VERSION) return;
    store.setItem(DONE_KEY, TUTORIAL_VERSION);
    start();
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", auto, { once: true });
  else auto();
})();

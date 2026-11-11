(function () {
  function gotoapp(page) {
    page = typeof page === "string" && page ? page.replace(/^#/, "") : "home";
    if (window.parent && window.parent !== window) {
      if (typeof window.parent.navigateApp === "function") {
        window.parent.navigateApp(page);
      } else {
        window.parent.postMessage(
          { type: "navigate", page: page },
          location.origin,
        );
      }
    } else {
      // Absolute path on purpose: the server serves 404.html for arbitrary
      // unmatched URLs (for example /foo/bar), where a relative
      // "./index.html" would resolve to /foo/index.html — another 404.
      window.location.href = "/index.html#" + page;
    }
  }

  document.addEventListener("click", function (e) {
    // Let the browser handle new-tab/middle-click/download intents.
    if (
      e.defaultPrevented ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey
    )
      return;
    var target = e.target;
    if (!target || typeof target.closest !== "function") return;
    var link = target.closest("a[href]");
    if (!link) return;

    var pagemap = {
      "./index.html": "home",
      "index.html": "home",
      "/index.html": "home",
      "./home.html": "home",
      "home.html": "home",
      "./settings.html": "settings",
      "settings.html": "settings",
      "./about.html": "about",
      "about.html": "about",
    };

    var page = pagemap[link.getAttribute("href")];
    if (page && window.self !== window.top) {
      e.preventDefault();
      gotoapp(page);
    }
  });

  window.gotoapp = gotoapp;
})();

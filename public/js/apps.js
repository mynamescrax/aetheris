var APP_PLACEHOLDER = Aetheris.placeholder;

function getapps() {
  if (Array.isArray(window.apps)) return window.apps;
  if (typeof apps !== "undefined" && Array.isArray(apps)) return apps;
  return [];
}

function fiximagepath(raw, fallback) {
  if (!fallback) fallback = APP_PLACEHOLDER;
  if (!raw || typeof raw !== "string") return fallback;
  var p = raw.trim();
  if (!p) return fallback;

  if (/^(https?:|data:|blob:)/i.test(p)) return p;
  if (p.charAt(0) === "." || p.charAt(0) === "/") return p;

  return "./" + p.replace(/^\/+/, "");
}

function buildappcards() {
  var apps = getapps();
  var status = document.getElementById("apps-status");
  if (!apps.length) {
    if (status)
      status.textContent = window.appsLoadError
        ? "Apps could not be loaded. Check your connection and reload."
        : "No apps are available.";
    return;
  }

  var grid = document.querySelector("#appcards");
  var favgrid = document.querySelector("#favoritedapps");
  var favlabel = document.querySelector("#favorited-apps-label");
  if (!grid) return;

  grid.innerHTML = "";
  if (favgrid) favgrid.innerHTML = "";

  var favids = Aetheris.readList("favoritedApps");
  if (status) status.textContent = "";

  for (var i = 0; i < apps.length; i++) {
    var app = apps[i];
    var card = document.createElement("a");
    var img = document.createElement("img");
    var label = document.createElement("h4");

    card.classList.add("card-item");
    card.dataset.id = String(app.id || "");
    card.href = "/load.html?app=" + encodeURIComponent(app.id);

    img.loading = "lazy";
    img.decoding = "async";
    img.alt = app.title || "App icon";

    var src = fiximagepath(app.image || app.icon || app.img || "");
    // <img> can display cross-origin images without CORS. Fetching them as
    // no-cors yielded an unreadable empty Blob and broke otherwise valid icons.
    img.referrerPolicy = "no-referrer";
    img.src = src;
    img.onerror = (function (imgref) {
      return function () {
        if (imgref.dataset.fallbackApplied === "true") return;
        imgref.dataset.fallbackApplied = "true";
        imgref.src = APP_PLACEHOLDER;
      };
    })(img);

    label.textContent = app.title || "Untitled";
    card.appendChild(img);
    card.appendChild(label);

    if (favids.indexOf(String(app.id)) !== -1 && favgrid) {
      favgrid.appendChild(card);
    } else {
      grid.appendChild(card);
    }
  }

  if (favlabel && favgrid) {
    favlabel.style.display = favgrid.children.length ? "block" : "none";
  }

  var searchbox = document.querySelector("#search-box");
  if (searchbox) {
    var fresh = searchbox.cloneNode(true);
    searchbox.parentNode.replaceChild(fresh, searchbox);

    fresh.addEventListener("input", function () {
      var q = fresh.value.trim().toLowerCase();
      var cards = document.querySelectorAll(
        "#appcards .card-item, #favoritedapps .card-item",
      );
      for (var j = 0; j < cards.length; j++) {
        var h4 = cards[j].querySelector("h4");
        var title = (h4 ? h4.textContent : "").toLowerCase();
        cards[j].style.display = !q || title.indexOf(q) !== -1 ? "" : "none";
      }
      var visible = Array.from(cards).filter(function (card) {
        return card.style.display !== "none";
      }).length;
      if (status)
        status.textContent = visible ? "" : "No apps match that search.";
      if (favlabel && favgrid)
        favlabel.style.display = Array.from(favgrid.children).some(
          function (card) {
            return card.style.display !== "none";
          },
        )
          ? "block"
          : "none";
    });
  }
}

window.addEventListener("appsloaded", buildappcards, { once: true });

if (getapps().length) buildappcards();

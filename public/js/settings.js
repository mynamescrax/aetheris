document.addEventListener("DOMContentLoaded", function () {
  // --- tab cloak ---

  var TAB_PRESETS = {
    google: { name: "Google", icon: "https://www.google.com/favicon.ico" },
    drive: {
      name: "My Drive - Google Drive",
      icon: "https://ssl.gstatic.com/docs/doclist/images/drive_2022q3_32dp.png",
    },
    docs: {
      name: "Google Docs",
      icon: "https://ssl.gstatic.com/docs/documents/images/kix-favicon7.ico",
    },
    classroom: {
      name: "Home",
      icon: "https://ssl.gstatic.com/classroom/ic_product_classroom_32.png",
    },
    examrevision: {
      name: "Exam Revision",
      icon: "https://examrevision.ie/favicon.ico",
    },
    default: { name: "Aetheris", icon: "/assets/images/icon.png" },
  };

  function changetab(name, icon) {
    var nameinput = document.querySelector("#tabname");
    var iconinput = document.querySelector("#tabicon");

    name = name !== undefined ? name : nameinput.value;
    icon = icon !== undefined ? icon : iconinput.value;
    name = String(name || "Aetheris");
    icon = Aetheris.httpUrl(icon || "/assets/images/icon.png");
    if (!icon) {
      alert("Use an HTTP or HTTPS URL for the tab icon.");
      return;
    }

    localStorage.setItem("tabName", name);
    localStorage.setItem("tabIcon", icon);

    document.title = name;
    var favicon =
      document.querySelector("link[rel='shortcut icon']") ||
      document.querySelector("link[rel='icon']");
    if (favicon) favicon.href = icon;

    if (nameinput) nameinput.value = name;
    if (iconinput) iconinput.value = icon;

    if (window.parent && window.parent !== window) {
      window.parent.postMessage(
        { type: "set-tab", name: name, icon: icon },
        location.origin,
      );
    }
  }

  window.settab = changetab;

  window.settabpreset = function (key) {
    var preset = TAB_PRESETS[key];
    if (!preset) return;
    changetab(preset.name, preset.icon);
  };

  if (localStorage.getItem("tabName"))
    document.querySelector("#tabname").value = localStorage.getItem("tabName");
  if (localStorage.getItem("tabIcon"))
    document.querySelector("#tabicon").value = localStorage.getItem("tabIcon");

  // --- theme selector ---

  var themeselect = document.getElementById("theme-select");
  if (themeselect) {
    var saved = localStorage.getItem("aetheris-theme");
    if (saved) themeselect.value = saved;

    themeselect.addEventListener("change", function () {
      var theme = themeselect.value;
      if (Aetheris.applyTheme) Aetheris.applyTheme(theme);
      document.documentElement.setAttribute("theme", theme);
      if (document.body) document.body.setAttribute("theme", theme);
      localStorage.setItem("aetheris-theme", theme);

      if (window.parent && window.parent !== window) {
        window.parent.postMessage(
          { type: "theme-changed", theme: theme },
          location.origin,
        );
      }
    });
  }

  // --- panic key ---

  if (localStorage.getItem("panickey"))
    document.querySelector("#panickey").value =
      localStorage.getItem("panickey");
  if (localStorage.getItem("panicurl"))
    document.querySelector("#panicurl").value =
      localStorage.getItem("panicurl");

  window.setpanickey = function () {
    localStorage.setItem("panickey", document.querySelector("#panickey").value);
  };

  window.setpanicurl = function () {
    var input = document.querySelector("#panicurl");
    var url = Aetheris.httpUrl(
      input.value.trim() || "https://classroom.google.com/",
    );
    if (!url) {
      alert("Use a valid HTTP or HTTPS panic URL.");
      return;
    }
    input.value = url;
    localStorage.setItem("panicurl", url);
  };

  var waitingforkey = false;

  window.detectpanic = function () {
    var input = document.querySelector("#panickey");
    var btn = document.querySelector("#panickeybtn");

    if (waitingforkey) return;
    waitingforkey = true;
    window.aetherisDetectingPanic = true;
    btn.disabled = true;
    btn.innerHTML = "Press any key...";

    function onkey(e) {
      if (e.isComposing) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      input.value = e.key;
      localStorage.setItem("panickey", e.key);
      finish();
    }
    function finish() {
      btn.innerHTML = "Auto-detect panic key";
      btn.disabled = false;
      waitingforkey = false;
      window.aetherisDetectingPanic = false;
      clearTimeout(timer);
      document.removeEventListener("keydown", onkey, true);
    }
    var timer = setTimeout(finish, 15000);
    document.addEventListener("keydown", onkey, true);
  };

  // --- transport selector ---
  // Apple devices default to epoxy because libcurl's WASM build does not
  // start there; everything else defaults to libcurl. scramjet-init.js uses
  // the same rule and automatically falls back to the other transport when
  // the preferred one fails, so this only picks which one is tried first.
  var ua = navigator.userAgent;
  var isapple =
    /iP(hone|ad|od)/.test(ua) ||
    /Macintosh/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var activetransport =
    localStorage.getItem("proxyTransport") || (isapple ? "epoxy" : "libcurl");

  function highlighttransport(name) {
    document
      .querySelectorAll("#transport-cards .theme-card")
      .forEach(function (c) {
        c.classList.toggle("active", c.dataset.transport === name);
      });
  }

  highlighttransport(activetransport);

  window.selecttransport = function (name) {
    activetransport = name;
    localStorage.setItem("proxyTransport", name);
    highlighttransport(name);

    var status = document.getElementById("transport-status");
    // scramjet v2 constructs a fresh transport per proxy launch (see
    // scramjet-init.js) instead of pushing it into a long-lived bare-mux
    // worker, so there's nothing to eagerly switch here — the localStorage
    // pref just gets picked up the next time a proxy page starts.
    if (status) status.textContent = "saved. takes effect on next proxy use.";
  };

  // --- desktop UA spoof toggle ---

  var spooftoggle = document.getElementById("spoof-ua-toggle");
  if (spooftoggle) {
    function pushspoofstate() {
      try {
        if (navigator.serviceWorker && navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({
            type: "aetheris-set-desktop-ua-spoof",
            enabled: localStorage.getItem("spoofDesktopUA") === "true",
          });
        }
      } catch (_) {}
    }

    spooftoggle.checked = localStorage.getItem("spoofDesktopUA") === "true";
    pushspoofstate();

    spooftoggle.addEventListener("change", function () {
      localStorage.setItem("spoofDesktopUA", String(spooftoggle.checked));
      pushspoofstate();
    });
  }

  // --- custom background ---

  (function () {
    var previewwrap = document.getElementById("bg-preview-wrap");
    var preview = document.getElementById("bg-preview");
    var removebtn = document.getElementById("bg-remove-btn");
    var bgstatus = document.getElementById("bg-status");

    function refreshpreview(url) {
      if (url) {
        if (preview) preview.src = url;
        if (previewwrap) previewwrap.style.display = "block";
        if (removebtn) removebtn.style.display = "";
      } else {
        if (previewwrap) previewwrap.style.display = "none";
        if (removebtn) removebtn.style.display = "none";
      }
    }

    function ensureoverlay() {
      var el = document.getElementById("custom-bg-overlay");
      if (el) return el;
      el = document.createElement("div");
      el.id = "custom-bg-overlay";
      el.style.cssText =
        "position:fixed;top:0;left:0;width:100%;height:100%;z-index:-1;pointer-events:none;background-size:cover;background-position:center;background-repeat:no-repeat;";
      document.body.insertBefore(el, document.body.firstChild);
      return el;
    }

    function clearinlinebg() {
      document.body.style.backgroundSize = "";
      document.body.style.backgroundPosition = "";
      document.body.style.backgroundRepeat = "";
      document.body.style.backgroundAttachment = "";
    }

    refreshpreview(localStorage.getItem("aetheris-customBg"));

    window.uploadbg = function (event) {
      var file = event.target.files[0];
      if (!file) return;
      event.target.value = "";
      if (bgstatus) bgstatus.textContent = "Reading...";

      var reader = new FileReader();
      reader.onload = function (e) {
        var dataurl = e.target.result;
        try {
          localStorage.setItem("aetheris-customBg", dataurl);
        } catch (_) {
          if (bgstatus)
            bgstatus.textContent =
              "Image too large for localStorage. Try something smaller.";
          return;
        }
        document.documentElement.classList.add("has-custom-bg");
        document.body.classList.add("has-custom-bg");
        document.body.style.setProperty(
          "background-image",
          "none",
          "important",
        );
        clearinlinebg();
        ensureoverlay().style.backgroundImage = "url(" + dataurl + ")";
        refreshpreview(dataurl);
        if (bgstatus) bgstatus.textContent = "Background saved.";
        if (window.parent && window.parent !== window) {
          window.parent.postMessage(
            { type: "bg-changed", dataurl: dataurl },
            location.origin,
          );
        }
      };
      reader.onerror = function () {
        if (bgstatus) bgstatus.textContent = "Failed to read image.";
      };
      reader.readAsDataURL(file);
    };

    var themebgs = {
      dark: {
        bg: "linear-gradient(135deg, #0f0f0f 0%, #161616 40%, #0a0a0a 100%)",
        bgc: "#0f0f0f",
      },
      "charcoal-gold": {
        bg: "linear-gradient(135deg, #0f0f0f 0%, #161616 40%, #0a0a0a 100%)",
        bgc: "#0f0f0f",
      },
      "dark-blue": { bg: "linear-gradient(#020617, #000)", bgc: "#020617" },
      halloween: {
        bg:
          "radial-gradient(circle at 86% 12%, rgba(255, 240, 200, 0.2) 0, rgba(255, 214, 140, 0.08) 4.5%, transparent 12%), " +
          "radial-gradient(ellipse at 50% 115%, rgba(255, 106, 0, 0.24) 0, transparent 58%), " +
          "radial-gradient(ellipse at 8% -5%, rgba(124, 58, 237, 0.22) 0, transparent 52%), " +
          "linear-gradient(180deg, #140a20 0%, #0d0715 55%, #070409 100%)",
        bgc: "#0d0715",
      },
    };

    window.removebg = function () {
      localStorage.removeItem("aetheris-customBg");
      document.documentElement.classList.remove("has-custom-bg");
      document.body.classList.remove("has-custom-bg");
      var overlay = document.getElementById("custom-bg-overlay");
      if (overlay && overlay.parentNode)
        overlay.parentNode.removeChild(overlay);

      var t =
        themebgs[
          localStorage.getItem("aetheris-theme") ||
            document.documentElement.getAttribute("theme") ||
            "dark"
        ] || {};
      document.body.style.setProperty(
        "background-image",
        t.bg || "",
        "important",
      );
      document.body.style.setProperty(
        "background-color",
        t.bgc || "#0f0f0f",
        "important",
      );
      clearinlinebg();
      refreshpreview(null);
      if (bgstatus) bgstatus.textContent = "Background removed.";
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(
          { type: "bg-changed", dataurl: null },
          location.origin,
        );
      }
    };
  })();

  // --- misc toggles ---

  var osktoggle = document.getElementById("osk-toggle");
  if (osktoggle) {
    osktoggle.checked = localStorage.getItem("oskEnabled") === "true";
    osktoggle.addEventListener("change", function () {
      localStorage.setItem("oskEnabled", String(osktoggle.checked));
    });
  }

  var perftoggle = document.getElementById("performance-toggle");
  if (perftoggle) {
    perftoggle.checked = localStorage.getItem("performanceMode") === "true";
    perftoggle.addEventListener("change", function () {
      localStorage.setItem("performanceMode", String(perftoggle.checked));
      if (window.parent !== window)
        window.parent.postMessage(
          { type: "performance-changed", enabled: perftoggle.checked },
          location.origin,
        );
      location.reload();
    });
  }
});

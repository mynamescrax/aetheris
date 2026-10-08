document.addEventListener("DOMContentLoaded", function () {
  var store = Aetheris.storage;

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
    default: { name: "Google", icon: "https://www.google.com/favicon.ico" },
  };

  function changetab(name, icon) {
    var nameinput = document.querySelector("#tabname");
    var iconinput = document.querySelector("#tabicon");

    name = name !== undefined ? name : nameinput.value;
    icon = icon !== undefined ? icon : iconinput.value;
    name = String(name || "Google");
    icon = Aetheris.httpUrl(icon || "https://www.google.com/favicon.ico");
    if (!icon) {
      alert("Use an HTTP or HTTPS URL for the tab icon.");
      return;
    }

    store.setItem("tabName", name);
    store.setItem("tabIcon", icon);

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

  if (store.getItem("tabName"))
    document.querySelector("#tabname").value = store.getItem("tabName");
  if (store.getItem("tabIcon"))
    document.querySelector("#tabicon").value = store.getItem("tabIcon");

  // --- theme selector ---

  var themeselect = document.getElementById("theme-select");
  if (themeselect) {
    var saved = store.getItem("aetheris-theme");
    if (saved) themeselect.value = saved;

    themeselect.addEventListener("change", function () {
      var theme = themeselect.value;
      if (!Aetheris.applyTheme(theme)) return;
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(
          { type: "theme-changed", theme: theme },
          location.origin,
        );
      }
    });
  }

  // --- panic key ---

  if (store.getItem("panickey"))
    document.querySelector("#panickey").value = store.getItem("panickey");
  if (store.getItem("panicurl"))
    document.querySelector("#panicurl").value = store.getItem("panicurl");

  window.setpanickey = function () {
    store.setItem("panickey", document.querySelector("#panickey").value);
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
    store.setItem("panicurl", url);
  };

  var waitingforkey = false;

  window.detectpanic = function () {
    var input = document.querySelector("#panickey");
    var btn = document.querySelector("#panickeybtn");

    if (waitingforkey) return;
    waitingforkey = true;
    window.aetherisDetectingPanic = true;
    btn.disabled = true;
    btn.textContent = "Press any key...";

    function onkey(e) {
      if (e.isComposing) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      input.value = e.key;
      store.setItem("panickey", e.key);
      finish();
    }
    function finish() {
      btn.textContent = "Auto detect panic key";
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
  // libcurl's WASM build won't start on Apple devices, so they default to
  // epoxy. Must match the rule in scramjet-init.js.
  var ua = navigator.userAgent;
  var isapple =
    /iP(hone|ad|od)/.test(ua) ||
    /Macintosh/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var activetransport =
    store.getItem("proxyTransport") || (isapple ? "epoxy" : "libcurl");

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
    store.setItem("proxyTransport", name);
    highlighttransport(name);

    var status = document.getElementById("transport-status");
    // read on the next proxy launch; nothing to switch live
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
            enabled: store.getItem("spoofDesktopUA") === "true",
          });
        }
      } catch (_) {}
    }

    spooftoggle.checked = store.getItem("spoofDesktopUA") === "true";
    pushspoofstate();

    spooftoggle.addEventListener("change", function () {
      store.setItem("spoofDesktopUA", String(spooftoggle.checked));
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

    function postbg(dataurl) {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(
          { type: "bg-changed", dataurl: dataurl },
          location.origin,
        );
      }
    }

    refreshpreview(store.getItem("aetheris-customBg"));

    window.uploadbg = function (event) {
      var file = event.target.files[0];
      if (!file) return;
      event.target.value = "";
      if (!/^image\//.test(file.type)) {
        if (bgstatus) bgstatus.textContent = "That file isn't an image.";
        return;
      }
      if (bgstatus) bgstatus.textContent = "Reading...";

      var reader = new FileReader();
      reader.onload = function (e) {
        var dataurl = e.target.result;
        if (!store.setItem("aetheris-customBg", dataurl)) {
          store.removeItem("aetheris-customBg");
          if (bgstatus)
            bgstatus.textContent =
              "Image too large for localStorage. Try something smaller.";
          return;
        }
        Aetheris.refreshBackground();
        refreshpreview(dataurl);
        if (bgstatus) bgstatus.textContent = "Background saved.";
        postbg(dataurl);
      };
      reader.onerror = function () {
        if (bgstatus) bgstatus.textContent = "Failed to read image.";
      };
      reader.readAsDataURL(file);
    };

    window.removebg = function () {
      store.removeItem("aetheris-customBg");
      Aetheris.refreshBackground();
      refreshpreview(null);
      if (bgstatus) bgstatus.textContent = "Background removed.";
      postbg(null);
    };
  })();

  // --- misc toggles ---

  var osktoggle = document.getElementById("osk-toggle");
  if (osktoggle) {
    osktoggle.checked = store.getItem("oskEnabled") === "true";
    osktoggle.addEventListener("change", function () {
      store.setItem("oskEnabled", String(osktoggle.checked));
    });
  }

  var perftoggle = document.getElementById("performance-toggle");
  if (perftoggle) {
    perftoggle.checked = store.getItem("performanceMode") === "true";
    perftoggle.addEventListener("change", function () {
      store.setItem("performanceMode", String(perftoggle.checked));
      if (window.parent !== window)
        window.parent.postMessage(
          { type: "performance-changed", enabled: perftoggle.checked },
          location.origin,
        );
      location.reload();
    });
  }

  var replaytut = document.getElementById("replay-tutorial");
  if (replaytut) {
    replaytut.addEventListener("click", function () {
      if (window.parent !== window)
        window.parent.postMessage({ type: "show-tutorial" }, location.origin);
      else location.href = "/";
    });
  }
});

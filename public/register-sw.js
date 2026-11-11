"use strict";

var SW_PATH = "./sw.js";
var UPDATE_POLL = 30 * 60 * 1000;
var registrationPromise = null;

function registersw() {
  if (!navigator.serviceWorker || !window.isSecureContext)
    return Promise.resolve(null);
  if (registrationPromise) return registrationPromise;
  registrationPromise = installServiceWorker().catch(function (err) {
    console.error("sw registration failed:", err);
    // A cancelled script load (the shell navigating over the first paint,
    // Safari's stricter worker startup) is transient. Retry once instead of
    // leaving the page uncontrolled for the rest of the session.
    return new Promise(function (resolve) {
      setTimeout(resolve, 500);
    })
      .then(installServiceWorker)
      .catch(function (retryerr) {
        registrationPromise = null;
        console.error("sw registration retry failed:", retryerr);
        return null;
      });
  });
  return registrationPromise;
}

async function installServiceWorker() {
  var hadController = !!navigator.serviceWorker.controller;
  var reg = await navigator.serviceWorker.register(SW_PATH, {
    scope: "/",
    updateViaCache: "none",
  });

  reg.addEventListener("updatefound", function () {
    var worker = reg.installing;
    if (!worker) return;
    worker.addEventListener("statechange", function () {
      if (worker.state === "installed" && navigator.serviceWorker.controller) {
        worker.postMessage({ type: "SKIP_WAITING" });
      }
    });
  });

  navigator.serviceWorker.addEventListener("controllerchange", function () {
    // First activation used to reload the shell AND its iframe and could
    // erase a search/draft or restart a game. Never interrupt the user.
    if (hadController) window.dispatchEvent(new Event("aetheris-update-ready"));
    hadController = true;
  });

  function check() {
    reg.update().catch(function () {});
  }
  setInterval(check, UPDATE_POLL);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") check();
  });

  return reg;
}

registersw();

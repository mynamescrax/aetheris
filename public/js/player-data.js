// Load only the relevant catalog; apps no longer download the entire game list.
window.playerDataReady = new Promise(function (resolve, reject) {
  var isApp = new URLSearchParams(location.search).has("app");
  // Deep links can point at any game source, so the player always loads the
  // full list.
  if (!isApp) window.gamesLoadAll = true;
  var script = document.createElement("script");
  script.src = isApp
    ? "/assets/data/apps.js?v=20260907.1"
    : "/assets/data/games.js?v=20261015.1";
  script.onload = function () {
    var ready = isApp ? window.appsready : window.gamesready;
    if (!ready || typeof ready.then !== "function") {
      // A 200 response that is not the catalog script (an error page, a
      // stale build) must fail here, not surface later as "item not found".
      reject(
        new Error(
          "The catalog loader did not initialize. Reload the page and try again.",
        ),
      );
      return;
    }
    Promise.resolve(ready).then(resolve, reject);
  };
  script.onerror = function () {
    reject(
      new Error(
        "The catalog loader could not be downloaded. Check your connection.",
      ),
    );
  };
  document.head.appendChild(script);
});

window.apps = window.apps || [];
window.appsloaded = false;

function freshappurl(url) {
  var fresh = new URL(url, window.location.href);
  fresh.searchParams.set("v", String(Date.now()));
  return fresh;
}

async function loadappsdata() {
  var timer;
  try {
    var controller = new AbortController();
    timer = setTimeout(function () {
      controller.abort();
    }, 8000);
    var res = await fetch(freshappurl("assets/data/apps.json"), {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    var data = await res.json();
    if (Array.isArray(data)) {
      window.apps = data;
    }
  } catch (e) {
    window.appsLoadError = true;
    console.error("Failed to load apps data:", e);
  } finally {
    clearTimeout(timer);
  }

  window.appsloaded = true;
  window.dispatchEvent(new Event("appsloaded"));
  return window.apps;
}

window.appsready = window.appsready || loadappsdata();

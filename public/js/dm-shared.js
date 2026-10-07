// DM session/auth helpers. Used by the chat pages (with dm-ui.js, which
// defines showapp) and by home.html/load.html for getdeviceid.
var autologin = Aetheris.storage.getItem("dmAutoLogin") !== "false";
var authtoken = Aetheris.getToken();
var myusername = Aetheris.storage.getItem("dmUsername") || "";

function savetoken(t) {
  if (typeof t !== "string" || !t) return false;
  authtoken = t;
  try {
    sessionStorage.setItem("dmToken", t);
  } catch (_) {}
  if (autologin) Aetheris.storage.setItem("dmToken", t);
  else Aetheris.storage.removeItem("dmToken");
  return true;
}

function cleartoken() {
  authtoken = "";
  try {
    sessionStorage.removeItem("dmToken");
  } catch (_) {}
  Aetheris.storage.removeItem("dmToken");
}

function ini(n) {
  return String(n || "?")
    .slice(0, 2)
    .toUpperCase();
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function timeago(ts) {
  var d = Date.now() - ts;
  if (d < 60000) return "now";
  if (d < 3600000) return Math.floor(d / 60000) + "m";
  if (d < 86400000) return Math.floor(d / 3600000) + "h";
  return new Date(ts).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

async function getdeviceid() {
  var stored = Aetheris.storage.getItem("dmDeviceId");
  if (stored && /^[a-f0-9]{64}$/.test(stored)) return stored;

  var hex;
  if (crypto.getRandomValues) {
    var bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    hex = Array.from(bytes)
      .map(function (b) {
        return b.toString(16).padStart(2, "0");
      })
      .join("");
  } else if (crypto.subtle && crypto.subtle.digest) {
    // last resort for ancient browsers: hash a fingerprint. still 64 hex chars.
    var raw = [
      navigator.userAgent,
      navigator.language,
      Date.now(),
      Math.random(),
      screen.width,
      screen.height,
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    ].join("|");
    var buf = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(raw),
    );
    hex = Array.from(new Uint8Array(buf))
      .map(function (b) {
        return b.toString(16).padStart(2, "0");
      })
      .join("");
  } else {
    var unavailable = new Error(
      "This browser can't create a secure device id. Enable cookies/localStorage and retry from a modern browser.",
    );
    unavailable.aetherisFriendly = true;
    throw unavailable;
  }

  Aetheris.storage.setItem("dmDeviceId", hex);
  return hex;
}

var currenttab = "login";
var REGISTER_MIN_PASSWORD = 6;
function switchtab(t) {
  if (authSubmitting) return;
  currenttab = t;
  document
    .getElementById("tab-login")
    .classList.toggle("active", t === "login");
  document
    .getElementById("tab-reg")
    .classList.toggle("active", t === "register");
  document
    .getElementById("tab-login")
    .setAttribute("aria-selected", String(t === "login"));
  document
    .getElementById("tab-reg")
    .setAttribute("aria-selected", String(t === "register"));
  document.getElementById("auth-submit").textContent =
    t === "login" ? "Log in" : "Register";
  document.getElementById("auth-err").textContent = "";
  var pass = document.getElementById("f-pass");
  pass.autocomplete = t === "login" ? "current-password" : "new-password";
  // new accounts need 6+ chars; older accounts can still log in with 4+
  if (t === "register") {
    pass.minLength = REGISTER_MIN_PASSWORD;
    pass.placeholder = "Password (6+ characters)";
  } else {
    pass.removeAttribute("minlength");
    pass.placeholder = "Password";
  }
}

var authSubmitting = false;
function togglePassword(button) {
  var input = document.getElementById("f-pass");
  var reveal = input.type === "password";
  input.type = reveal ? "text" : "password";
  button.setAttribute("aria-label", reveal ? "Hide password" : "Show password");
  button.setAttribute("aria-pressed", String(reveal));
}

async function submitauth() {
  if (authSubmitting) return;
  var u = document.getElementById("f-user").value.trim();
  var p = document.getElementById("f-pass").value;
  var e = document.getElementById("auth-err");
  e.textContent = "";
  if (!u || !p) {
    e.textContent = "Fill in both fields.";
    return;
  }
  if (currenttab === "register" && p.length < REGISTER_MIN_PASSWORD) {
    e.textContent =
      "Passwords need at least " + REGISTER_MIN_PASSWORD + " characters.";
    return;
  }
  authSubmitting = true;
  var submit = document.getElementById("auth-submit");
  submit.disabled = true;
  var controller = new AbortController();
  var timer = setTimeout(function () {
    controller.abort();
  }, 15000);
  var ep =
    currenttab === "login" ? "/api/accounts/login" : "/api/accounts/register";
  try {
    var deviceId = await getdeviceid();
    var r = await fetch(ep, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: u, password: p, deviceId: deviceId }),
      signal: controller.signal,
    });
    var d = await r.json();
    if (!d.ok) {
      e.textContent = d.error || "Something went wrong.";
      return;
    }
    // login and register both return a session token
    if (!savetoken(d.token)) {
      e.textContent = "The server did not return a session. Please try again.";
      return;
    }
    myusername = d.username;
    Aetheris.storage.setItem("dmUsername", myusername);
    document.getElementById("f-pass").value = "";
    showapp();
  } catch (error) {
    e.textContent =
      error && error.aetherisFriendly
        ? error.message
        : "Could not sign in. Check your connection and try again.";
  } finally {
    clearTimeout(timer);
    authSubmitting = false;
    submit.disabled = false;
  }
}

// the auth form only exists on the chat pages
if (document.getElementById("f-user") && document.getElementById("f-pass")) {
  document.getElementById("f-user").addEventListener("keydown", function (e) {
    if (e.key === "Enter") document.getElementById("f-pass").focus();
  });
  document.getElementById("f-pass").addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.isComposing) submitauth();
  });
}

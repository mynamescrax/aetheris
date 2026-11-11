// chat.html: page config for dm-ui.js plus the account-management bits only
// this page has. Load order: dm-shared.js, dm-ui.js, chat.js.
/* global startdm, showauth, openmodal, closemodal */
var keepchk = document.getElementById("keep-chk");
keepchk.checked = autologin;
function setautologin(on) {
  autologin = on;
  Aetheris.storage.setItem("dmAutoLogin", autologin ? "true" : "false");
  if (!autologin) Aetheris.storage.removeItem("dmToken");
  else if (authtoken) Aetheris.storage.setItem("dmToken", authtoken);
}
keepchk.addEventListener("change", function () {
  setautologin(keepchk.checked);
});
var openAccountOnSignIn =
  new URLSearchParams(location.search).get("account") === "1";
var accountDialog = document.getElementById("chat-account");
var accountKeep = document.getElementById("account-keep");
accountKeep.addEventListener("change", function () {
  setautologin(accountKeep.checked);
  keepchk.checked = autologin;
});
accountDialog.addEventListener("close", function () {
  document.getElementById("password-form").reset();
});

function closechataccount() {
  accountDialog.close();
}

async function accountrequest(path, body) {
  var controller = new AbortController();
  var timer = setTimeout(function () {
    controller.abort();
  }, 15000);
  try {
    var response = await fetch("/api/accounts/" + path, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + authtoken,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    var data = await response.json();
    if (!response.ok || !data.ok)
      throw new Error(data.error || "Could not update your account.");
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function sessioncount(count) {
  document.getElementById("account-sessions").textContent =
    count === 1
      ? "You’re signed in on this device only."
      : count + " active sessions, including this device.";
  document.getElementById("logout-others").disabled = count <= 1;
}

async function openchataccount() {
  if (!authtoken) return;
  if (!accountDialog.open) accountDialog.showModal();
  document.getElementById("account-username").textContent = "@" + myusername;
  document.getElementById("account-avatar").textContent = ini(myusername);
  document.getElementById("account-created").textContent = "Your chat account";
  accountKeep.checked = autologin;
  document.getElementById("sessions-feedback").textContent = "";
  document.getElementById("password-feedback").textContent = "";
  document.getElementById("account-sessions").textContent = "Loading sessions…";
  document.getElementById("logout-others").disabled = true;
  var token = authtoken;
  try {
    var data = await accountrequest("me");
    if (token !== authtoken || !accountDialog.open) return;
    sessioncount(data.activeSessions);
    if (Number.isFinite(data.createdAt))
      document.getElementById("account-created").textContent =
        "Joined " +
        new Date(data.createdAt).toLocaleDateString(undefined, {
          month: "long",
          year: "numeric",
        });
  } catch (error) {
    if (token === authtoken)
      document.getElementById("account-sessions").textContent =
        error.message ||
        "Could not load your sessions. Reopen settings to retry.";
  }
}

async function logoutothers() {
  var button = document.getElementById("logout-others");
  if (button.disabled) return;
  button.disabled = true;
  var status = document.getElementById("sessions-feedback");
  status.textContent = "Signing out other devices…";
  try {
    var data = await accountrequest("logout-others", {});
    sessioncount(data.activeSessions);
    status.textContent =
      "Other devices are signed out. You’re still signed in here.";
  } catch (error) {
    status.textContent =
      error.message || "Could not sign out other devices. Try again.";
    button.disabled = false;
  }
}

async function changepassword(event) {
  event.preventDefault();
  var button = document.getElementById("password-save");
  if (button.disabled) return;
  var status = document.getElementById("password-feedback");
  var current = document.getElementById("current-password").value;
  var next = document.getElementById("new-password").value;
  if (next !== document.getElementById("new-password-confirm").value) {
    status.textContent = "New passwords don’t match.";
    document.getElementById("new-password-confirm").focus();
    return;
  }
  button.disabled = true;
  status.textContent = "Updating password…";
  try {
    var data = await accountrequest("password", {
      currentPassword: current,
      newPassword: next,
    });
    document.getElementById("password-form").reset();
    sessioncount(data.activeSessions);
    status.textContent =
      "Password updated. Other devices have been signed out.";
  } catch (error) {
    status.textContent =
      error.message || "Could not update your password. Try again.";
  } finally {
    button.disabled = false;
  }
}

async function confirmdelete() {
  try {
    var response = await fetch("/api/accounts/delete", {
      method: "DELETE",
      headers: { Authorization: "Bearer " + authtoken },
    });
    var data = await response.json();
    if (!response.ok || !data.ok)
      throw new Error(data.error || "The account could not be deleted.");
  } catch (error) {
    modalerror(
      "modal-del",
      error.message || "Network error. Account not deleted.",
    );
    return;
  }
  closemodal("modal-del");
  cleartoken();
  myusername = "";
  Aetheris.storage.removeItem("dmUsername");
  showauth();
}

function modalerror(id, message) {
  var modal = document.getElementById(id).querySelector(".modal");
  var error = modal.querySelector(".action-error");
  if (!error) {
    error = document.createElement("p");
    error.className = "action-error";
    error.setAttribute("role", "alert");
    modal.appendChild(error);
  }
  error.textContent = message;
}

function setconversationopen(open) {
  document.getElementById("tg-empty").style.display = open ? "none" : "flex";
  document.getElementById("tg-active").style.display = open ? "flex" : "none";
  document
    .querySelector(".tg-wrap")
    .classList.toggle("conversation-open", open);
}

startdm({
  ids: {
    auth: "auth-page",
    app: "app",
    list: "tg-list",
    msgs: "tg-msgs",
    input: "tg-inp",
    search: "srch",
  },
  appDisplay: "block",
  prefix: "tg",
  inbox: {
    item: "tg-ci",
    av: "av sm",
    body: "tg-cb",
    top: "tg-ct",
    name: "tg-cn",
    time: "tg-ctime",
    prev: "tg-cprev",
    badge: "tg-unread-badge",
  },
  emptyInbox:
    '<div class="tg-empty-l">no matching convos.<br>start one above.</div>',
  onShowApp: function () {
    document.getElementById("my-name").textContent = myusername;
    document.getElementById("my-av").textContent = ini(myusername);
    document.getElementById("account-keep").checked = autologin;
    if (openAccountOnSignIn) {
      openAccountOnSignIn = false;
      openchataccount();
    }
  },
  onShowAuth: function () {
    closechataccount();
    setconversationopen(false);
  },
  onOpenConvo: function () {
    setconversationopen(true);
  },
  onShowInbox: function () {
    document.querySelector(".tg-wrap").classList.remove("conversation-open");
  },
});

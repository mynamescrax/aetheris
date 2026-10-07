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

function syncalbtn() {
  var b = document.getElementById("al-btn");
  if (!b) return;
  b.textContent = autologin ? "🔒" : "🔓";
  b.title = autologin ? "Auto-login ON" : "Auto-login OFF";
  b.style.opacity = autologin ? "1" : "0.45";
}

function toggleautologin() {
  setautologin(!autologin);
  keepchk.checked = autologin;
  syncalbtn();
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

function openwipe() {
  if (!authtoken) {
    document.getElementById("auth-err").textContent =
      "Log in before deleting an account from this device.";
    return;
  }
  document.getElementById("wipe-ok").style.display = "none";
  openmodal("modal-wipe");
}

async function confirmwipe() {
  var deviceid = await getdeviceid();
  // the token is required too: a device id alone must not delete accounts
  try {
    var response = await fetch("/api/accounts/delete-all-mine", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + authtoken,
      },
      body: JSON.stringify({ deviceId: deviceid }),
    });
    var data = await response.json();
    if (!response.ok || !data.ok)
      throw new Error(data.error || "The account could not be deleted.");
  } catch (error) {
    modalerror(
      "modal-wipe",
      error.message || "Network error. Account not deleted.",
    );
    return;
  }
  try {
    sessionStorage.removeItem("dmToken");
    Object.keys(localStorage)
      .filter(function (k) {
        return k.indexOf("dm") === 0;
      })
      .forEach(function (k) {
        localStorage.removeItem(k);
      });
  } catch (_) {}
  ["dmToken", "dmUsername", "dmAutoLogin", "dmDeviceId"].forEach(function (k) {
    Aetheris.storage.removeItem(k);
  });
  authtoken = "";
  myusername = "";
  var ok = document.getElementById("wipe-ok");
  ok.textContent = "Done. You can register a new account.";
  ok.style.display = "block";
  setTimeout(function () {
    closemodal("modal-wipe");
    showauth();
  }, 1600);
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
  document.querySelector(".tg-wrap").classList.toggle("conversation-open", open);
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
    syncalbtn();
  },
  onShowAuth: function () {
    setconversationopen(false);
  },
  onOpenConvo: function () {
    setconversationopen(true);
  },
  onShowInbox: function () {
    document.querySelector(".tg-wrap").classList.remove("conversation-open");
  },
});

// page-specific DM UI for chat.html — shared auth/session/api helpers live in
// dm-shared.js (loaded first): autologin/authtoken/myusername, savetoken,
// cleartoken, getdeviceid, ini, esc, timeago, switchtab, submitauth.
var activeconvo = null,
  polltimer = null,
  inboxtimer = null;
var activedisplay = null;
var inboxcache = [],
  lastmsgtime = 0,
  lastdatelabel = "";
var POLL_MS = 2500;
var conversationVersion = 0;
var messagesLoadingFor = "";
var sending = false;
var drafts = Object.create(null);

var keepchk = document.getElementById("keep-chk");
keepchk.checked = autologin;
keepchk.addEventListener("change", function () {
  autologin = keepchk.checked;
  localStorage.setItem("dmAutoLogin", autologin ? "true" : "false");
  if (!autologin) localStorage.removeItem("dmToken");
  else if (authtoken) localStorage.setItem("dmToken", authtoken);
});

function showapp() {
  document.getElementById("auth-page").style.display = "none";
  document.getElementById("app").style.display = "block";
  document.getElementById("my-name").textContent = myusername;
  document.getElementById("my-av").textContent = ini(myusername);
  syncalbtn();
  loadinbox();
  clearInterval(inboxtimer);
  inboxtimer = setInterval(loadinbox, 6000);
}

function showauth() {
  document.getElementById("app").style.display = "none";
  document.getElementById("auth-page").style.display = "flex";
  clearInterval(polltimer);
  clearInterval(inboxtimer);
  polltimer = inboxtimer = null;
  activeconvo = null;
  activedisplay = null;
  conversationVersion++;
  inboxcache = [];
  drafts = Object.create(null);
  document.getElementById("tg-msgs").replaceChildren();
  document.getElementById("tg-inp").value = "";
  document.getElementById("tg-active").style.display = "none";
  document.getElementById("tg-empty").style.display = "flex";
  document.querySelector(".tg-wrap").classList.remove("conversation-open");
}

(async function () {
  if (!authtoken) return;
  try {
    var r = await fetch("/api/accounts/me", {
      headers: { Authorization: "Bearer " + authtoken },
    });
    var d = await r.json();
    if (d.ok) {
      myusername = d.username;
      localStorage.setItem("dmUsername", myusername);
      showapp();
    } else {
      cleartoken();
      localStorage.removeItem("dmUsername");
      myusername = "";
    }
  } catch (_) {}
})();

function syncalbtn() {
  var b = document.getElementById("al-btn");
  if (!b) return;
  b.textContent = autologin ? "🔒" : "🔓";
  b.title = autologin ? "Auto-login ON" : "Auto-login OFF";
  b.style.opacity = autologin ? "1" : "0.45";
}

function toggleautologin() {
  autologin = !autologin;
  localStorage.setItem("dmAutoLogin", autologin ? "true" : "false");
  keepchk.checked = autologin;
  if (!autologin) localStorage.removeItem("dmToken");
  else if (authtoken) localStorage.setItem("dmToken", authtoken);
  syncalbtn();
}

async function logout() {
  try {
    await fetch("/api/accounts/logout", {
      method: "POST",
      headers: { Authorization: "Bearer " + authtoken },
    });
  } catch (_) {}
  cleartoken();
  myusername = "";
  localStorage.removeItem("dmUsername");
  showauth();
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
  localStorage.removeItem("dmUsername");
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
  // requires the session token as well — the device fingerprint alone must
  // not be enough to destroy an account
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
  ["dmToken", "dmUsername", "dmAutoLogin", "dmDeviceId"].forEach(function (k) {
    localStorage.removeItem(k);
    sessionStorage.removeItem(k);
  });
  Object.keys(localStorage)
    .filter(function (k) {
      return k.indexOf("dm") === 0;
    })
    .forEach(function (k) {
      localStorage.removeItem(k);
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

async function loadinbox() {
  if (!authtoken || document.hidden) return;
  var token = authtoken;
  try {
    var r = await fetch("/api/dm-inbox", {
      headers: { Authorization: "Bearer " + authtoken },
    });
    var d = await r.json();
    if (token !== authtoken) return;
    if (r.status === 401) {
      cleartoken();
      showauth();
      return;
    }
    if (!d.ok) return;
    inboxcache = Array.isArray(d.conversations) ? d.conversations : [];
    filterinbox();
  } catch (_) {}
}

function filterinbox() {
  var q = document.getElementById("srch").value.trim().toLowerCase();
  renderinbox(
    q
      ? inboxcache.filter(function (c) {
          return c.with.toLowerCase().indexOf(q) !== -1;
        })
      : inboxcache,
  );
}

function renderinbox(cs) {
  var el = document.getElementById("tg-list");
  el.innerHTML = "";
  var totalunread = inboxcache.reduce(function (total, convo) {
    return (
      total + (convo.with.toLowerCase() === activeconvo ? 0 : convo.unread || 0)
    );
  }, 0);
  if (!cs.length) {
    el.innerHTML =
      '<div class="tg-empty-l">No matching conversations.<br>Start one above.</div>';
    notifybadge(totalunread);
    return;
  }
  cs.forEach(function (c) {
    var isactive = c.with.toLowerCase() === activeconvo;
    var unread = isactive ? 0 : c.unread || 0;
    var it = document.createElement("div");
    it.className = "tg-ci" + (isactive ? " active" : "");
    it.setAttribute("role", "button");
    it.tabIndex = 0;
    it.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        it.click();
      }
    });
    var badge =
      unread > 0
        ? '<span class="tg-unread-badge">' +
          (unread > 99 ? "99+" : unread) +
          "</span>"
        : "";
    it.innerHTML =
      '<div class="av sm">' +
      ini(c.with) +
      "</div>" +
      '<div class="tg-cb"><div class="tg-ct"><span class="tg-cn">' +
      esc(c.with) +
      "</span>" +
      '<span class="tg-ctime">' +
      timeago(c.lastTime) +
      "</span></div>" +
      '<div class="tg-cprev">' +
      esc(c.lastMessage) +
      "</div></div>" +
      badge;
    it.addEventListener("click", function () {
      openconvo(c.with.toLowerCase(), c.with);
    });
    el.appendChild(it);
  });
  notifybadge(totalunread);
}

function notifybadge(count) {
  try {
    window.parent.postMessage(
      { type: "chat-unread", count: count },
      location.origin,
    );
  } catch (_) {}
}

function openconvo(u, display) {
  if (activeconvo)
    drafts[activeconvo] = document.getElementById("tg-inp").value;
  conversationVersion++;
  activeconvo = u;
  document.getElementById("tg-inp").value = drafts[u] || "";
  document.querySelector(".tg-wrap").classList.add("conversation-open");
  activedisplay = display || u;
  lastmsgtime = 0;
  lastdatelabel = "";
  document.getElementById("tg-empty").style.display = "none";
  var ac = document.getElementById("tg-active");
  ac.style.display = "flex";
  document.getElementById("chat-name").textContent = activedisplay;
  document.getElementById("chat-av").textContent = ini(activedisplay);
  document.getElementById("tg-msgs").innerHTML = "";
  document.querySelectorAll(".tg-ci").forEach(function (el) {
    var name = el.querySelector(".tg-cn");
    el.classList.toggle(
      "active",
      ((name && name.textContent) || "").toLowerCase() === u,
    );
  });
  clearInterval(polltimer);
  loadmsgs();
  polltimer = setInterval(loadmsgs, POLL_MS);
  if (!matchMedia("(pointer: coarse)").matches)
    document.getElementById("tg-inp").focus();
  setTimeout(function () {
    if (inboxcache.length) renderinbox(inboxcache);
  }, 150);
}

function showinbox() {
  if (activeconvo)
    drafts[activeconvo] = document.getElementById("tg-inp").value;
  conversationVersion++;
  activeconvo = null;
  clearInterval(polltimer);
  document.querySelector(".tg-wrap").classList.remove("conversation-open");
  filterinbox();
}

async function loadmsgs() {
  if (!activeconvo || document.hidden) return;
  var convo = activeconvo,
    version = conversationVersion,
    token = authtoken;
  var requestKey = convo + ":" + version;
  if (messagesLoadingFor === requestKey) return;
  messagesLoadingFor = requestKey;
  try {
    var r = await fetch(
      "/api/dm/" + encodeURIComponent(activeconvo) + "?after=" + lastmsgtime,
      { headers: { Authorization: "Bearer " + authtoken } },
    );
    var msgs = await r.json();
    if (
      convo !== activeconvo ||
      version !== conversationVersion ||
      token !== authtoken
    )
      return;
    if (r.status === 401) {
      cleartoken();
      showauth();
      return;
    }
    if (!Array.isArray(msgs) || !msgs.length) return;
    msgs = msgs.filter(function (msg) {
      return msg.time > lastmsgtime;
    });
    if (!msgs.length) return;
    var box = document.getElementById("tg-msgs");
    var atbottom = box.scrollHeight - box.scrollTop <= box.clientHeight + 80;
    msgs.forEach(function (m) {
      var dl = new Date(m.time).toLocaleDateString([], {
        month: "long",
        day: "numeric",
      });
      if (dl !== lastdatelabel) {
        var s = document.createElement("div");
        s.className = "tg-datesep";
        s.innerHTML = "<span>" + dl + "</span>";
        box.appendChild(s);
        lastdatelabel = dl;
      }
      box.appendChild(makemsgel(m));
    });
    lastmsgtime = msgs[msgs.length - 1].time;
    fetch("/api/dm-inbox/read/" + encodeURIComponent(convo), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify({ through: lastmsgtime }),
    }).catch(function () {});
    if (atbottom) box.scrollTop = box.scrollHeight;
  } catch (_) {
  } finally {
    if (messagesLoadingFor === requestKey) messagesLoadingFor = "";
  }
}

function makemsgel(msg) {
  var mine = msg.from.toLowerCase() === myusername.toLowerCase();
  var w = document.createElement("div");
  w.className = "tg-msg " + (mine ? "mine" : "theirs");
  var ts = new Date(msg.time).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  w.innerHTML =
    (!mine ? '<div class="tg-who">' + esc(msg.from) + "</div>" : "") +
    '<div class="tg-bub">' +
    esc(msg.message) +
    "</div>" +
    '<div class="tg-meta"><span class="tg-ts">' +
    ts +
    "</span>" +
    (mine ? '<span class="tg-tick" title="Sent">✓</span>' : "") +
    "</div>";
  return w;
}

async function senddm() {
  if (!activeconvo || sending) return;
  var recipient = activeconvo,
    token = authtoken;
  var inp = document.getElementById("tg-inp");
  var text = inp.value.trim();
  if (!text) return;
  sending = true;
  inp.disabled = true;
  inp.value = "";
  var controller = new AbortController(),
    timeout = setTimeout(function () {
      controller.abort();
    }, 15000);
  try {
    var r = await fetch("/api/dm/" + encodeURIComponent(recipient), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify({ message: text }),
      signal: controller.signal,
    });
    if (token !== authtoken) return;
    if (!r.ok) {
      // put the message back so it isn't silently lost
      drafts[recipient] = text;
      if (activeconvo === recipient) inp.value = text;
      var d = await r.json().catch(function () {
        return {};
      });
      if (token !== authtoken) return;
      alert(d.error || "couldn't send that message.");
      return;
    }
  } catch (_) {
    if (token !== authtoken) return;
    drafts[recipient] = text;
    if (activeconvo === recipient) inp.value = text;
    alert("network error — message not sent.");
    return;
  } finally {
    clearTimeout(timeout);
    sending = false;
    inp.disabled = false;
  }
  delete drafts[recipient];
  loadmsgs();
  loadinbox();
}
document.getElementById("tg-inp").addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.isComposing) senddm();
});

var searchtimer = null;

async function searchusers(q) {
  if (q.length < 2) {
    document.getElementById("user-list").innerHTML = "";
    return;
  }
  var token = authtoken;
  try {
    var r = await fetch("/api/accounts/search?q=" + encodeURIComponent(q), {
      headers: { Authorization: "Bearer " + authtoken },
    });
    var d = await r.json();
    if (
      token !== authtoken ||
      document.getElementById("user-search").value.trim() !== q
    )
      return;
    if (d.ok) renderuserlist(Array.isArray(d.users) ? d.users : []);
  } catch (_) {}
}

function renderuserlist(users) {
  var box = document.getElementById("user-list");
  box.innerHTML = "";
  users.forEach(function (u) {
    var el = document.createElement("div");
    el.className = "uitem";
    el.innerHTML = '<div class="uav">' + ini(u) + "</div>" + esc(u);
    el.addEventListener("click", function () {
      closemodal("modal-newdm");
      openconvo(u.toLowerCase(), u);
      loadinbox();
    });
    box.appendChild(el);
  });
}

function opennewdm() {
  document.getElementById("user-search").value = "";
  document.getElementById("user-list").innerHTML = "";
  openmodal("modal-newdm");
  setTimeout(function () {
    document.getElementById("user-search").focus();
  }, 60);
}

function filterusers() {
  var q = document.getElementById("user-search").value.trim();
  clearTimeout(searchtimer);
  searchtimer = setTimeout(function () {
    searchusers(q);
  }, 200);
}

document.getElementById("user-search").addEventListener("input", filterusers);
document
  .getElementById("user-search")
  .addEventListener("keydown", function (e) {
    if (e.key === "Escape") closemodal("modal-newdm");
  });

function openmodal(id) {
  var modal = document.getElementById(id),
    error = modal.querySelector(".action-error");
  if (error) error.remove();
  modal.style.display = "flex";
}
function closemodal(id) {
  document.getElementById(id).style.display = "none";
}
function bgclose(e, id) {
  if (e.target === e.currentTarget) closemodal(id);
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
document.addEventListener("visibilitychange", function () {
  if (!document.hidden && authtoken) {
    loadinbox();
    loadmsgs();
  }
});

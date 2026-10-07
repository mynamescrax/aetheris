// DM inbox + conversation UI shared by chat.html and minichat.html. Needs
// dm-shared.js first. Each page calls startdm() with its element ids, class
// names and view hooks; the functions stay global for inline handlers.
var dmui = null;
var activeconvo = null,
  activedisplay = null,
  polltimer = null,
  inboxtimer = null,
  searchtimer = null;
var inboxcache = [],
  lastmsgtime = 0,
  lastdatelabel = "";
var POLL_MS = 2500;
var conversationVersion = 0,
  messagesLoadingFor = "",
  sending = false;
var drafts = Object.create(null);

function dmel(key) {
  return document.getElementById(dmui.ids[key]);
}

function dmhook(name) {
  if (typeof dmui[name] === "function") dmui[name]();
}

function dmkeyclick(el) {
  el.setAttribute("role", "button");
  el.tabIndex = 0;
  el.addEventListener("keydown", function (event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      el.click();
    }
  });
}

function showapp() {
  dmel("auth").style.display = "none";
  dmel("app").style.display = dmui.appDisplay;
  dmhook("onShowApp");
  loadinbox();
  clearInterval(inboxtimer);
  inboxtimer = setInterval(loadinbox, 6000);
}

function showauth() {
  dmel("app").style.display = "none";
  dmel("auth").style.display = "flex";
  clearInterval(polltimer);
  clearInterval(inboxtimer);
  polltimer = inboxtimer = null;
  activeconvo = null;
  activedisplay = null;
  conversationVersion++;
  inboxcache = [];
  drafts = Object.create(null);
  dmel("msgs").replaceChildren();
  dmel("input").value = "";
  dmhook("onShowAuth");
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
  Aetheris.storage.removeItem("dmUsername");
  showauth();
}

async function resumesession() {
  if (!authtoken) return;
  try {
    var r = await fetch("/api/accounts/me", {
      headers: { Authorization: "Bearer " + authtoken },
    });
    var d = await r.json();
    if (d.ok) {
      myusername = d.username;
      Aetheris.storage.setItem("dmUsername", myusername);
      showapp();
    } else {
      cleartoken();
      Aetheris.storage.removeItem("dmUsername");
      myusername = "";
    }
  } catch (_) {}
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
  var search = dmui.ids.search && dmel("search");
  var q = search ? search.value.trim().toLowerCase() : "";
  renderinbox(
    q
      ? inboxcache.filter(function (c) {
          return c.with.toLowerCase().indexOf(q) !== -1;
        })
      : inboxcache,
  );
}

function renderinbox(cs) {
  var cls = dmui.inbox;
  var el = dmel("list");
  el.innerHTML = "";
  var totalunread = inboxcache.reduce(function (total, convo) {
    return (
      total +
      (convo.with.toLowerCase() === activeconvo ? 0 : Number(convo.unread) || 0)
    );
  }, 0);
  if (!cs.length) {
    el.innerHTML = dmui.emptyInbox;
    notifybadge(totalunread);
    return;
  }
  cs.forEach(function (c) {
    var isactive = c.with.toLowerCase() === activeconvo;
    var unread = isactive ? 0 : Number(c.unread) || 0;
    var it = document.createElement("div");
    it.className = cls.item + (isactive ? " active" : "");
    dmkeyclick(it);
    var badge =
      unread > 0
        ? '<span class="' +
          cls.badge +
          '">' +
          (unread > 99 ? "99+" : unread) +
          "</span>"
        : "";
    it.innerHTML =
      '<div class="' +
      cls.av +
      '">' +
      esc(ini(c.with)) +
      "</div>" +
      '<div class="' +
      cls.body +
      '"><div class="' +
      cls.top +
      '"><span class="' +
      cls.name +
      '">' +
      esc(c.with) +
      "</span>" +
      '<span class="' +
      cls.time +
      '">' +
      esc(timeago(c.lastTime)) +
      "</span></div>" +
      '<div class="' +
      cls.prev +
      '">' +
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
  var inp = dmel("input");
  if (activeconvo) drafts[activeconvo] = inp.value;
  conversationVersion++;
  activeconvo = u;
  activedisplay = display || u;
  inp.value = drafts[u] || "";
  lastmsgtime = 0;
  lastdatelabel = "";
  document.getElementById("chat-name").textContent = activedisplay;
  document.getElementById("chat-av").textContent = ini(activedisplay);
  dmel("msgs").replaceChildren();
  dmel("list")
    .querySelectorAll("." + dmui.inbox.item)
    .forEach(function (el) {
      var name = el.querySelector("." + dmui.inbox.name);
      el.classList.toggle(
        "active",
        ((name && name.textContent) || "").toLowerCase() === u,
      );
    });
  dmhook("onOpenConvo");
  clearInterval(polltimer);
  loadmsgs();
  polltimer = setInterval(loadmsgs, POLL_MS);
  if (!matchMedia("(pointer: coarse)").matches) inp.focus();
  setTimeout(function () {
    if (inboxcache.length) filterinbox();
  }, 150);
}

function showinbox() {
  if (activeconvo) drafts[activeconvo] = dmel("input").value;
  conversationVersion++;
  activeconvo = null;
  activedisplay = null;
  clearInterval(polltimer);
  polltimer = null;
  dmhook("onShowInbox");
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
      "/api/dm/" + encodeURIComponent(convo) + "?after=" + lastmsgtime,
      { headers: { Authorization: "Bearer " + token } },
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
    var box = dmel("msgs");
    var atbottom = box.scrollHeight - box.scrollTop <= box.clientHeight + 80;
    msgs.forEach(function (m) {
      var dl = new Date(m.time).toLocaleDateString([], {
        month: "long",
        day: "numeric",
      });
      if (dl !== lastdatelabel) {
        var s = document.createElement("div");
        s.className = dmui.prefix + "-datesep";
        var label = document.createElement("span");
        label.textContent = dl;
        s.appendChild(label);
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
  var p = dmui.prefix;
  var mine = msg.from.toLowerCase() === myusername.toLowerCase();
  var w = document.createElement("div");
  w.className = p + "-msg " + (mine ? "mine" : "theirs");
  var ts = new Date(msg.time).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  w.innerHTML =
    (!mine ? '<div class="' + p + '-who">' + esc(msg.from) + "</div>" : "") +
    '<div class="' +
    p +
    '-bub">' +
    esc(msg.message) +
    "</div>" +
    '<div class="' +
    p +
    '-meta"><span class="' +
    p +
    '-ts">' +
    esc(ts) +
    "</span>" +
    (mine ? '<span class="' + p + '-tick" title="Sent">✓</span>' : "") +
    "</div>";
  return w;
}

async function senddm() {
  if (!activeconvo || sending) return;
  var recipient = activeconvo,
    token = authtoken;
  var inp = dmel("input");
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
    dmkeyclick(el);
    el.innerHTML = '<div class="uav">' + esc(ini(u)) + "</div>" + esc(u);
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

function startdm(config) {
  dmui = config;
  dmel("input").addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.isComposing) senddm();
  });
  var usersearch = document.getElementById("user-search");
  usersearch.addEventListener("input", filterusers);
  usersearch.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closemodal("modal-newdm");
  });
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && authtoken) {
      loadinbox();
      loadmsgs();
    }
  });
  resumesession();
}

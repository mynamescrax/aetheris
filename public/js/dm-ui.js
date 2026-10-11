// DM + group chat UI shared by chat.html and minichat.html. Needs
// dm-shared.js first. Each page calls startdm() with its element ids, class
// names and view hooks; the functions stay global for inline handlers.
// Conversation keys: a lowercase username for DMs, "g:<id>" for groups
// (usernames can't contain ":").
var dmui = null;
var activeconvo = null,
  activedisplay = null,
  polltimer = null,
  inboxtimer = null,
  presencetimer = null,
  searchtimer = null;
var inboxcache = [],
  lastmsgtime = 0,
  lastdatelabel = "";
var POLL_MS = 2500,
  PRESENCE_MS = 15000;
var conversationVersion = 0,
  messagesLoadingFor = "",
  sending = false;
var drafts = Object.create(null);
var activegroup = null; // /info for the open group chat
var grouppicks = []; // usernames picked in the new-group dialog

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

function isgroupkey(key) {
  return typeof key === "string" && key.indexOf("g:") === 0;
}

function convokey(c) {
  return c.group ? "g:" + c.group : c.with.toLowerCase();
}

// API paths for a conversation key
function convopath(key) {
  return isgroupkey(key)
    ? "/api/groups/" + encodeURIComponent(key.slice(2))
    : "/api/dm/" + encodeURIComponent(key);
}

function readpath(key) {
  return isgroupkey(key)
    ? convopath(key) + "/read"
    : "/api/dm-inbox/read/" + encodeURIComponent(key);
}

function authheaders(token, json) {
  var headers = { Authorization: "Bearer " + token };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
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
  clearInterval(presencetimer);
  polltimer = inboxtimer = presencetimer = null;
  activeconvo = null;
  activedisplay = null;
  activegroup = null;
  conversationVersion++;
  inboxcache = [];
  drafts = Object.create(null);
  dmel("msgs").replaceChildren();
  dmel("input").value = "";
  ["modal-newgroup", "modal-members"].forEach(function (id) {
    if (document.getElementById(id)) closemodal(id);
  });
  dmhook("onShowAuth");
}

async function logout() {
  try {
    await fetch("/api/accounts/logout", {
      method: "POST",
      headers: authheaders(authtoken),
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
      headers: authheaders(authtoken),
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
    var r = await fetch("/api/dm-inbox", { headers: authheaders(token) });
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
      total + (convokey(convo) === activeconvo ? 0 : Number(convo.unread) || 0)
    );
  }, 0);
  if (!cs.length) {
    el.innerHTML = dmui.emptyInbox;
    notifybadge(totalunread);
    return;
  }
  cs.forEach(function (c) {
    var key = convokey(c);
    var isactive = key === activeconvo;
    var unread = isactive ? 0 : Number(c.unread) || 0;
    var it = document.createElement("div");
    it.className = cls.item + (isactive ? " active" : "");
    it.dataset.key = key;
    dmkeyclick(it);
    var badge =
      unread > 0
        ? '<span class="' +
          cls.badge +
          '">' +
          (unread > 99 ? "99+" : unread) +
          "</span>"
        : "";
    var online = c.group ? c.onlineCount > 0 : !!c.online;
    var avclass =
      cls.av + (c.group ? " dm-group" : "") + (online ? " dm-online" : "");
    var avtitle = c.group
      ? c.members + " members" + (online ? ", " + c.onlineCount + " online" : "")
      : online
        ? "online"
        : "offline";
    it.innerHTML =
      '<div class="' +
      avclass +
      '" title="' +
      esc(avtitle) +
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
      openconvo(key, c.with);
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

function setchatstatus(text, online) {
  var sub = document.getElementById("chat-sub");
  if (sub) {
    sub.textContent = text;
    sub.classList.toggle("dm-online-text", !!online);
  }
  var av = document.getElementById("chat-av");
  if (av) av.classList.toggle("dm-online", !!online);
}

function lastseentext(p) {
  if (!p) return "";
  if (p.online) return "online";
  if (!p.lastSeen) return "offline";
  var ago = Date.now() - p.lastSeen;
  if (ago < 60000) return "last seen just now";
  return "last seen " + timeago(p.lastSeen) + (ago < 86400000 ? " ago" : "");
}

function openconvo(key, display) {
  var inp = dmel("input");
  if (activeconvo) drafts[activeconvo] = inp.value;
  conversationVersion++;
  activeconvo = key;
  activedisplay = display || key;
  activegroup = null;
  inp.value = drafts[key] || "";
  lastmsgtime = 0;
  lastdatelabel = "";
  var av = document.getElementById("chat-av");
  document.getElementById("chat-name").textContent = activedisplay;
  av.textContent = ini(activedisplay);
  av.classList.toggle("dm-group", isgroupkey(key));
  setchatstatus(isgroupkey(key) ? "group chat" : "", false);
  var membersbtn = document.getElementById("chat-members-btn");
  if (membersbtn) membersbtn.style.display = isgroupkey(key) ? "" : "none";
  dmel("msgs").replaceChildren();
  dmel("list")
    .querySelectorAll("." + dmui.inbox.item)
    .forEach(function (el) {
      el.classList.toggle("active", el.dataset.key === key);
    });
  dmhook("onOpenConvo");
  clearInterval(polltimer);
  clearInterval(presencetimer);
  loadmsgs();
  refreshpresence();
  polltimer = setInterval(loadmsgs, POLL_MS);
  presencetimer = setInterval(refreshpresence, PRESENCE_MS);
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
  activegroup = null;
  clearInterval(polltimer);
  clearInterval(presencetimer);
  polltimer = presencetimer = null;
  if (document.getElementById("modal-members")) closemodal("modal-members");
  dmhook("onShowInbox");
  filterinbox();
}

// the open group is gone (we left it, or it no longer exists)
function groupgone() {
  showinbox();
  loadinbox();
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
    var r = await fetch(convopath(convo) + "?after=" + lastmsgtime, {
      headers: authheaders(token),
    });
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
    if (r.status === 404 && isgroupkey(convo)) {
      groupgone();
      return;
    }
    if (!Array.isArray(msgs) || !msgs.length) return;
    msgs = msgs.filter(function (msg) {
      return msg.time > lastmsgtime;
    });
    if (!msgs.length) return;
    var firstload = lastmsgtime === 0;
    var box = dmel("msgs");
    var atbottom = box.scrollHeight - box.scrollTop <= box.clientHeight + 80;
    var membershipchanged = false;
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
      if (m.system) membershipchanged = true;
      box.appendChild(makemsgel(m));
    });
    lastmsgtime = msgs[msgs.length - 1].time;
    fetch(readpath(convo), {
      method: "POST",
      headers: authheaders(token, true),
      body: JSON.stringify({ through: lastmsgtime }),
    }).catch(function () {});
    if (atbottom) box.scrollTop = box.scrollHeight;
    // someone joined or left while we watched: refresh the member count
    if (membershipchanged && !firstload && isgroupkey(convo)) refreshpresence();
  } catch (_) {
  } finally {
    if (messagesLoadingFor === requestKey) messagesLoadingFor = "";
  }
}

function makemsgel(msg) {
  var p = dmui.prefix;
  var w = document.createElement("div");
  var mine = msg.from.toLowerCase() === myusername.toLowerCase();
  if (msg.system) {
    // "alice added bob", "bob left the group"
    w.className = p + "-datesep dm-system";
    var text = document.createElement("span");
    text.textContent = (mine ? "you" : msg.from) + " " + msg.message;
    w.appendChild(text);
    return w;
  }
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
    (mine ? '<span class="' + p + '-tick" title="Sent">\u2713</span>' : "") +
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
    var r = await fetch(convopath(recipient), {
      method: "POST",
      headers: authheaders(token, true),
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
    alert("Network error \u2014 message not sent.");
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

// --- presence ---

async function refreshpresence() {
  if (!activeconvo || document.hidden) return;
  var key = activeconvo,
    version = conversationVersion,
    token = authtoken;
  var url = isgroupkey(key)
    ? convopath(key) + "/info"
    : "/api/presence?users=" + encodeURIComponent(key);
  try {
    var r = await fetch(url, { headers: authheaders(token) });
    var d = await r.json();
    if (
      key !== activeconvo ||
      version !== conversationVersion ||
      token !== authtoken
    )
      return;
    if (r.status === 404 && isgroupkey(key)) {
      groupgone();
      return;
    }
    if (!d.ok) return;
    if (!isgroupkey(key)) {
      var p = d.users && d.users[key];
      setchatstatus(lastseentext(p), p && p.online);
      return;
    }
    activegroup = d;
    activedisplay = d.name;
    document.getElementById("chat-name").textContent = d.name;
    var me = myusername.toLowerCase();
    var online = d.members.filter(function (m) {
      return m.online && m.username.toLowerCase() !== me;
    }).length;
    setchatstatus(
      d.members.length + " members" + (online ? ", " + online + " online" : ""),
      online > 0,
    );
    var modal = document.getElementById("modal-members");
    if (modal && modal.style.display !== "none") rendermembers();
  } catch (_) {}
}

// --- user search (new DM, new group, add to group) ---

async function searchusers(q, inputid, onresults) {
  if (q.length < 2) {
    onresults([]);
    return;
  }
  var token = authtoken;
  try {
    var r = await fetch("/api/accounts/search?q=" + encodeURIComponent(q), {
      headers: authheaders(token),
    });
    var d = await r.json();
    if (
      token !== authtoken ||
      document.getElementById(inputid).value.trim() !== q
    )
      return;
    if (d.ok) onresults(Array.isArray(d.users) ? d.users : []);
  } catch (_) {}
}

function watchsearch(inputid, onresults) {
  var input = document.getElementById(inputid);
  input.addEventListener("input", function () {
    var q = input.value.trim();
    clearTimeout(searchtimer);
    searchtimer = setTimeout(function () {
      searchusers(q, inputid, onresults);
    }, 200);
  });
}

// fills listid with clickable users; note(u) can return a trailing label
function renderusers(listid, users, onpick, note) {
  var box = document.getElementById(listid);
  box.innerHTML = "";
  users.forEach(function (u) {
    var el = document.createElement("div");
    el.className = "uitem";
    dmkeyclick(el);
    var label = note ? note(u) : "";
    el.innerHTML =
      '<div class="uav">' +
      esc(ini(u)) +
      "</div>" +
      esc(u) +
      (label ? '<span class="dm-note">' + esc(label) + "</span>" : "");
    el.addEventListener("click", function () {
      onpick(u);
    });
    box.appendChild(el);
  });
}

function renderuserlist(users) {
  renderusers("user-list", users, function (u) {
    closemodal("modal-newdm");
    openconvo(u.toLowerCase(), u);
    loadinbox();
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

// --- group dialogs (built here so both chat pages share them) ---

function buildmodal(id, title, body) {
  var existing = document.getElementById(id);
  if (existing) return existing;
  var bg = document.createElement("div");
  bg.id = id;
  bg.className = "mbg";
  bg.style.display = "none";
  bg.setAttribute("role", "dialog");
  bg.setAttribute("aria-modal", "true");
  bg.setAttribute("aria-labelledby", id + "-title");
  bg.innerHTML =
    '<div class="modal"><h3 id="' +
    id +
    '-title">' +
    esc(title) +
    "</h3>" +
    body +
    "</div>";
  bg.addEventListener("click", function (e) {
    if (e.target === bg) closemodal(id);
  });
  bg.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closemodal(id);
  });
  document.body.appendChild(bg);
  return bg;
}

function dmmodalerror(id, message) {
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

function opennewgroup() {
  var created = !document.getElementById("modal-newgroup");
  buildmodal(
    "modal-newgroup",
    "new group",
    '<div class="msrch"><input id="group-name" type="text" maxlength="40"' +
      ' placeholder="Group name (optional)" aria-label="Group name"' +
      ' autocomplete="off" /></div>' +
      '<div class="dm-picks" id="group-picks"></div>' +
      '<div class="msrch"><input id="group-search" type="text"' +
      ' placeholder="Add people" aria-label="Search users to add"' +
      ' autocomplete="off" /></div>' +
      '<div class="ulist" id="group-user-list"></div>' +
      '<div class="dm-row"><button class="mbtn" id="group-create"' +
      ' onclick="creategroup()">create group</button>' +
      '<button class="mbtn ghost" onclick="closemodal(\'modal-newgroup\')">' +
      "cancel</button></div>",
  );
  if (created)
    watchsearch("group-search", function (users) {
      renderusers(
        "group-user-list",
        users,
        function (u) {
          if (grouppicks.indexOf(u) === -1) grouppicks.push(u);
          document.getElementById("group-search").value = "";
          document.getElementById("group-user-list").innerHTML = "";
          rendergrouppicks();
          document.getElementById("group-search").focus();
        },
        function (u) {
          return grouppicks.indexOf(u) !== -1 ? "added" : "";
        },
      );
    });
  grouppicks = [];
  document.getElementById("group-name").value = "";
  document.getElementById("group-search").value = "";
  document.getElementById("group-user-list").innerHTML = "";
  rendergrouppicks();
  openmodal("modal-newgroup");
  setTimeout(function () {
    document.getElementById("group-search").focus();
  }, 60);
}

function rendergrouppicks() {
  var box = document.getElementById("group-picks");
  box.innerHTML = "";
  grouppicks.forEach(function (u) {
    var chip = document.createElement("button");
    chip.type = "button";
    chip.className = "dm-chip";
    chip.title = "Remove " + u;
    chip.setAttribute("aria-label", "Remove " + u);
    chip.textContent = u + " \u00d7";
    chip.addEventListener("click", function () {
      grouppicks = grouppicks.filter(function (p) {
        return p !== u;
      });
      rendergrouppicks();
    });
    box.appendChild(chip);
  });
}

async function creategroup() {
  if (!grouppicks.length) {
    dmmodalerror("modal-newgroup", "add at least one person first.");
    return;
  }
  var btn = document.getElementById("group-create");
  btn.disabled = true;
  try {
    var r = await fetch("/api/groups", {
      method: "POST",
      headers: authheaders(authtoken, true),
      body: JSON.stringify({
        name: document.getElementById("group-name").value,
        members: grouppicks,
      }),
    });
    var d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || "couldn't create it.");
    closemodal("modal-newgroup");
    openconvo("g:" + d.id, d.name);
    loadinbox();
  } catch (error) {
    dmmodalerror(
      "modal-newgroup",
      (error && error.message) || "network error \u2014 try again.",
    );
  } finally {
    btn.disabled = false;
  }
}

function openmembers() {
  if (!isgroupkey(activeconvo)) return;
  var created = !document.getElementById("modal-members");
  buildmodal(
    "modal-members",
    "group members",
    '<div class="ulist" id="group-members"></div>' +
      '<div class="msrch"><input id="member-search" type="text"' +
      ' placeholder="Add someone" aria-label="Search users to add"' +
      ' autocomplete="off" /></div>' +
      '<div class="ulist" id="member-user-list"></div>' +
      '<div class="dm-row"><button class="mbtn danger"' +
      ' onclick="leavegroup()">leave group</button>' +
      '<button class="mbtn ghost" onclick="closemodal(\'modal-members\')">' +
      "close</button></div>",
  );
  if (created)
    watchsearch("member-search", function (users) {
      var inside = (activegroup ? activegroup.members : []).map(function (m) {
        return m.username.toLowerCase();
      });
      renderusers("member-user-list", users, addmember, function (u) {
        return inside.indexOf(u.toLowerCase()) !== -1 ? "in group" : "";
      });
    });
  document.getElementById("member-search").value = "";
  document.getElementById("member-user-list").innerHTML = "";
  rendermembers();
  openmodal("modal-members");
  refreshpresence();
}

function rendermembers() {
  var box = document.getElementById("group-members");
  if (!box) return;
  box.innerHTML = "";
  if (!activegroup) return;
  var me = myusername.toLowerCase();
  activegroup.members.forEach(function (m) {
    var el = document.createElement("div");
    el.className = "uitem dm-member";
    var self = m.username.toLowerCase() === me;
    var status = self
      ? "you"
      : lastseentext(m) +
        (m.username === activegroup.owner ? " \u00b7 owner" : "");
    el.innerHTML =
      '<div class="uav' +
      (m.online ? " dm-online" : "") +
      '">' +
      esc(ini(m.username)) +
      "</div>" +
      esc(m.username) +
      '<span class="dm-note' +
      (m.online && !self ? " dm-online-text" : "") +
      '">' +
      esc(status) +
      "</span>";
    if (!self) {
      // tap a member to DM them
      dmkeyclick(el);
      el.addEventListener("click", function () {
        closemodal("modal-members");
        openconvo(m.username.toLowerCase(), m.username);
      });
    }
    box.appendChild(el);
  });
}

async function addmember(username) {
  var key = activeconvo;
  if (!isgroupkey(key)) return;
  try {
    var r = await fetch(convopath(key) + "/members", {
      method: "POST",
      headers: authheaders(authtoken, true),
      body: JSON.stringify({ username: username }),
    });
    var d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || "couldn't add them.");
    document.getElementById("member-search").value = "";
    document.getElementById("member-user-list").innerHTML = "";
    var error = document.querySelector("#modal-members .action-error");
    if (error) error.remove();
    refreshpresence();
    loadmsgs();
  } catch (error) {
    dmmodalerror(
      "modal-members",
      (error && error.message) || "network error \u2014 try again.",
    );
  }
}

async function leavegroup() {
  var key = activeconvo;
  if (!isgroupkey(key) || !confirm("Leave this group?")) return;
  try {
    var r = await fetch(convopath(key) + "/leave", {
      method: "POST",
      headers: authheaders(authtoken),
    });
    if (!r.ok && r.status !== 404) {
      var d = await r.json().catch(function () {
        return {};
      });
      throw new Error(d.error || "couldn't leave the group.");
    }
  } catch (error) {
    dmmodalerror(
      "modal-members",
      (error && error.message) || "network error \u2014 try again.",
    );
    return;
  }
  delete drafts[key];
  closemodal("modal-members");
  if (activeconvo === key) groupgone();
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
  watchsearch("user-search", renderuserlist);
  document
    .getElementById("user-search")
    .addEventListener("keydown", function (e) {
      if (e.key === "Escape") closemodal("modal-newdm");
    });
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && authtoken) {
      loadinbox();
      loadmsgs();
      refreshpresence();
    }
  });
  resumesession();
}

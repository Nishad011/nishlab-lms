/* NISHLAB LMS v2 — app logic (student, trainer, admin) */
(function () {
"use strict";
var B = window.LMS_BACKEND, DB = B.db;
var CERT_START = 2053; // NLC-2026-2051 and 2052 were issued before the LMS

/* ---------------- helpers ---------------- */
var $ = function (s, r) { return (r || document).querySelector(s); };
var $$ = function (s, r) { return [].slice.call((r || document).querySelectorAll(s)); };
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
function today() { var d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function fmtDate(s) {
  if (!s) return "";
  if (s.toDate) s = s.toDate();
  var d = s instanceof Date ? s : new Date(s + (String(s).length === 10 ? "T00:00:00" : ""));
  if (isNaN(d)) return esc(s);
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}
function toast(t, err) {
  $$(".toast").forEach(function (t) { t.remove(); });
  var el = document.createElement("div"); el.className = "toast" + (err ? " err" : ""); el.textContent = t; el.setAttribute("role", "status");
  document.body.appendChild(el); setTimeout(function () { el.remove(); }, err ? 5200 : 2600);
}
function fail(e) { console.error(e); toast(friendly(e), true); }
function friendly(e) {
  var c = (e && (e.code || e.message)) || "";
  if (/permission/i.test(c)) return "You don't have permission for that. If you think you should, ask the admin.";
  if (/unavailable|network|offline/i.test(c)) return "No connection to the server. Check your internet and try again.";
  return "Something went wrong: " + ((e && e.message) || c);
}
function isUrl(u) { return /^https?:\/\/\S+$/i.test(String(u || "").trim()); }
function cleanUrl(u) { u = String(u || "").trim(); return u && !/^https?:\/\//i.test(u) ? "https://" + u : u; }
function driveEmbed(u) {
  if (!u) return null;
  var m = String(u).match(/drive\.google\.com\/file\/d\/([\w-]+)/) || String(u).match(/drive\.google\.com\/open\?id=([\w-]+)/) || String(u).match(/[?&]id=([\w-]+)/);
  if (m && /drive\.google\.com/.test(u)) return "https://drive.google.com/file/d/" + m[1] + "/preview";
  var y = String(u).match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|live\/))([\w-]{11})/);
  if (y) return "https://www.youtube-nocookie.com/embed/" + y[1];
  return null;
}
function link(u, label, cls) { return isUrl(u) ? '<a class="' + (cls || "btn line sm") + '" href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(label) + "</a>" : ""; }
function pct(a, b) { return b ? Math.round((a / b) * 100) : 0; }
function byDay(a, b) { return (a.day || 0) - (b.day || 0); }
function byDate(a, b) { return String(a.date || "").localeCompare(String(b.date || "")) || (a.day || 0) - (b.day || 0); }
function chip(text, kind) { return '<span class="chip ' + (kind || "") + '">' + esc(text) + "</span>"; }
function statusChip(s) {
  if (!s) return "";
  if (s.status === "reviewed") return chip("Reviewed" + (s.grade ? " · " + s.grade : ""), "ok");
  if (s.status === "redo") return chip("Redo", "bad");
  return chip("Submitted", "warn");
}
function spinner() { return '<div class="spinner" role="status" aria-label="Loading"></div>'; }
function verifyUrl(id) { return location.href.replace(/app\.html.*$/, "verify.html?id=" + encodeURIComponent(id)); }

/* ---------------- state ---------------- */
var ME = null; // {uid, email, name, role, isApproved, phone}
var view = $("#view");

/* ---------------- data ---------------- */
var data = {
  courses: async function () {
    var all = await DB.list("courses");
    return all.filter(function (c) { return c.code; }).sort(function (a, b) { return (a.order || 9) - (b.order || 9); });
  },
  lessons: async function (cid) { return (await DB.list("courses/" + cid + "/lessons")).sort(byDay); },
  assignments: async function (cid) { return (await DB.list("courses/" + cid + "/assignments")).sort(byDay); },
  myBatches: async function () {
    if (ME.role === "admin") return DB.list("batches");
    if (ME.role === "trainer") return DB.list("batches", [["trainerId", "==", ME.uid]]);
    return DB.list("batches", [["studentIds", "array-contains", ME.uid]]);
  },
  sessions: async function (bid) { return (await DB.list("batches/" + bid + "/sessions")).sort(byDate); },
  submissions: async function (bid) {
    if (ME.role === "admin") return DB.list("submissions", [["batchId", "==", bid]]);
    if (ME.role === "trainer") return DB.list("submissions", [["trainerId", "==", ME.uid], ["batchId", "==", bid]]);
    return DB.list("submissions", [["batchId", "==", bid], ["studentId", "==", ME.uid]]);
  },
  progress: async function (bid) {
    if (ME.role === "student") { var p = await DB.get("progress/" + bid + "_" + ME.uid); return p ? [p] : []; }
    if (ME.role === "trainer") return DB.list("progress", [["trainerId", "==", ME.uid], ["batchId", "==", bid]]);
    return DB.list("progress", [["batchId", "==", bid]]);
  },
  certsForBatch: async function (bid) { return ME.role === "admin" ? DB.list("certificates", [["batchId", "==", bid]]) : []; },
  myCerts: async function () { return DB.list("certificates", [["studentId", "==", ME.uid]]); },
  users: async function () { return DB.list("users"); }
};
function attendance(uid, sessions) {
  var held = sessions.filter(function (s) { return (s.date || "") <= today(); });
  var present = held.filter(function (s) { return (s.present || []).indexOf(uid) >= 0; }).length;
  return { held: held.length, present: present, pct: held.length ? pct(present, held.length) : null };
}
function nextSession(sessions) {
  var t = today();
  return sessions.filter(function (s) { return (s.date || "") >= t; }).sort(byDate)[0] || null;
}

/* ---------------- boot ---------------- */
B.auth.onChange(async function (u) {
  if (!u) { location.href = "index.html"; return; }
  try {
    var p = await DB.get("users/" + u.uid);
    if (!p) {
      view.innerHTML = '<div class="card" style="max-width:520px"><h2>Profile not found</h2><p class="muted" style="margin-top:8px">Your login works, but there is no LMS profile for ' + esc(u.email) + '. Ask the admin to set it up, or sign out and create the account again.</p></div>';
      showWho({ name: u.email, role: "?" }); return;
    }
    ME = Object.assign({ uid: u.uid, email: u.email }, p);
    showWho(ME);
    if (ME.role === "trainer" && !ME.isApproved) {
      view.innerHTML = '<div class="card" style="max-width:560px"><span class="chip warn">Waiting for approval</span><h2 style="margin-top:12px">Your trainer account is almost ready</h2><p class="muted" style="margin-top:8px">The admin needs to approve trainer accounts before you can see batches. You will have access as soon as that is done. Refresh this page later.</p></div>';
      return;
    }
    buildNav(); route();
  } catch (e) { view.innerHTML = '<div class="err-box">' + esc(friendly(e)) + "</div>"; }
});
function showWho(p) {
  $("#who").hidden = false;
  $("#userName").textContent = p.name || p.email || "";
  $("#avatar").textContent = initials(p.name || p.email);
  $("#roleChip").textContent = p.role === "admin" ? "Admin" : p.role === "trainer" ? "Trainer" : "Student";
  $("#signOut").onclick = function () { B.auth.signOut().then(function () { location.href = "index.html"; }); };
}
function initials(n) { var p = String(n || "?").trim().split(/[\s@.]+/).filter(Boolean); return ((p[0] || "?")[0] + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase(); }
function firstName(n) { var f = String(n || "").trim().split(/\s+/)[0] || ""; return f.charAt(0).toUpperCase() + f.slice(1).toLowerCase(); }
var IC = {
  dash: '<path d="M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z"/>',
  batch: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/><path d="M8 7h8M8 11h6"/>',
  people: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  award: '<circle cx="12" cy="9" r="6"/><path d="m8.2 13.8-1.7 7.7L12 19l5.5 2.5-1.7-7.7"/>',
  user: '<path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="7" r="4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  cal: '<rect x="3" y="4" width="18" height="18" rx="3"/><path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  star: '<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/>'
};
function ico(k) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (IC[k] || "") + "</svg>"; }
var NAV = {
  student: [["#/", "dash", "Dashboard"], ["#/certs", "award", "Certificates"], ["#/profile", "user", "Profile"]],
  trainer: [["#/", "dash", "Dashboard"], ["#/courses", "book", "Course content"], ["#/profile", "user", "Profile"]],
  admin: [["#/", "dash", "Dashboard"], ["#/batches", "batch", "Batches"], ["#/courses", "book", "Courses"], ["#/people", "people", "People"], ["#/certs", "award", "Certificates"]]
};
function buildNav() {
  $("#side").innerHTML = (NAV[ME.role] || NAV.student).map(function (n) { return '<a href="' + n[0] + '">' + ico(n[1]) + "<span>" + esc(n[2]) + "</span></a>"; }).join("");
}
function markNav(h) {
  $$("#side a").forEach(function (a) {
    var href = a.getAttribute("href"), inBatch = h.indexOf("#/b/") === 0;
    var on = inBatch ? (ME.role === "admin" ? href === "#/batches" : href === "#/") : href === "#/" ? (h === "#/" || h === "") : h.indexOf(href) === 0;
    a.classList.toggle("on", on); if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
}
window.addEventListener("hashchange", function () { if (ME) route(); });
var routeToken = 0;
async function route() {
  var h = location.hash || "#/", parts = h.replace(/^#\/?/, "").split("/").filter(Boolean);
  markNav(h);
  var tok = ++routeToken;
  view.innerHTML = spinner();
  window.scrollTo(0, 0);
  var r = ME.role, fn;
  try {
    if (!parts.length) fn = r === "admin" ? adminHome : r === "trainer" ? trainerHome : studentHome;
    else if (parts[0] === "b" && parts[1]) {
      if (r === "student") fn = parts[2] === "d" ? function () { return studentDay(parts[1], +parts[3]); } : function () { return studentBatch(parts[1]); };
      else fn = function () { return manageBatch(parts[1], parts[2] || "classes"); };
    }
    else if (parts[0] === "certs") fn = r === "admin" ? adminCerts : studentCerts;
    else if (parts[0] === "profile") fn = profileView;
    else if (parts[0] === "courses" && r !== "student") fn = coursesView;
    else if (parts[0] === "c" && parts[1] && r !== "student") fn = function () { return courseEditor(parts[1]); };
    else if (parts[0] === "batches" && r === "admin") fn = adminBatches;
    else if (parts[0] === "people" && r === "admin") fn = function () { return adminPeople(parts[1] || "students"); };
    else fn = function () { view.innerHTML = '<div class="empty">Page not found. <a href="#/">Go to the start</a>.</div>'; };
    var html = await fn();
    if (tok !== routeToken) return;
    if (typeof html === "string") view.innerHTML = html;
    if (fn.after) fn.after();
    if (parts.length) refreshRail(false);
  } catch (e) {
    if (tok !== routeToken) return;
    view.innerHTML = '<div class="err-box">' + esc(friendly(e)) + '</div><p><a class="btn line sm" href="#/">Back</a></p>';
    console.error(e);
  }
}
function render(html, after) { view.innerHTML = html; if (after) after(); }

/* ======================================================================
   DASHBOARD (home screens, right rail, next-class countdown)
   ====================================================================== */
var DASH = null, CD_TIMER = null;
var KCOL = ["#9b5cf6", "#ffa53a", "#4f9dff", "#ff3f8e", "#3ecf8e"];

function parseTiming(t) {
  var m = String(t || "").match(/(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*(?:(?:-|–|—|to)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?)?/i);
  if (!m) return { h: 19, m: 0, mins: 60, known: false };
  function hr(h, ap) { h = +h; ap = (ap || "").toLowerCase(); if (ap === "pm" && h < 12) h += 12; else if (ap === "am" && h === 12) h = 0; else if (!ap && h < 8) h += 12; return h; }
  var h1 = hr(m[1], m[3] || m[6]), m1 = +(m[2] || 0), mins = 60;
  if (m[4]) { var h2 = hr(m[4], m[6] || m[3]), e = h2 * 60 + +(m[5] || 0) - (h1 * 60 + m1); if (e > 0 && e <= 300) mins = e; }
  return { h: h1, m: m1, mins: mins, known: true };
}
function eventOf(s, x) {
  var t = parseTiming(x.b.timing), d = new Date((s.date || today()) + "T00:00:00");
  d.setHours(t.h, t.m, 0, 0);
  return { s: s, b: x.b, c: x.c, start: d, end: new Date(d.getTime() + t.mins * 60000), mins: t.mins, known: t.known };
}
function hm(d) { return d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true }).replace(" ", " "); }
function durTxt(m) { return m >= 60 ? (m % 60 ? (m / 60).toFixed(1).replace(".0", "") : m / 60) + (m === 60 ? " hour" : " hours") : m + " mins"; }
function tsDate(v) { if (!v) return null; if (v.toDate) return v.toDate(); if (v.seconds) return new Date(v.seconds * 1000); var d = new Date(v); return isNaN(d) ? null : d; }

async function loadDash(force) {
  if (DASH && !force && Date.now() - DASH.t < 60000) return DASH;
  var r = await Promise.all([data.myBatches(), data.courses()]);
  var cmap = {}; r[1].forEach(function (c) { cmap[c.id] = c; });
  var admin = ME.role === "admin", student = ME.role === "student";
  var list = r[0].slice().sort(function (a, b) { return (a.status === "completed") - (b.status === "completed"); }).slice(0, 20);
  var per = await Promise.all(list.map(async function (b) {
    var x = await Promise.all([
      data.sessions(b.id).catch(function () { return []; }),
      admin ? Promise.resolve([]) : data.submissions(b.id).catch(function () { return []; }),
      student ? data.progress(b.id).catch(function () { return []; }) : Promise.resolve([])
    ]);
    return { b: b, c: cmap[b.courseId] || { title: b.courseTitle || "Course", days: 0 }, ses: x[0], subs: x[1], prog: x[2][0] || null };
  }));
  var D = { t: Date.now(), list: per, courses: r[1], cmap: cmap, users: [], certs: [] };
  if (admin) {
    var a = await Promise.all([data.users(), DB.list("certificates"), DB.list("submissions").catch(function () { return []; })]);
    D.users = a[0]; D.certs = a[1];
    per.forEach(function (x) { x.subs = a[2].filter(function (s) { return s.batchId === x.b.id; }); });
  } else if (student) {
    D.certs = await data.myCerts().catch(function () { return []; });
  }
  D.events = [];
  per.forEach(function (x) { x.ses.forEach(function (s) { if (s.date) D.events.push(eventOf(s, x)); }); });
  D.events.sort(function (p, q) { return p.start - q.start; });
  D.tasks = buildTasks(D);
  DASH = D; return D;
}

function buildTasks(D) {
  var T = [], t = today();
  if (ME.role === "student") {
    if (!D.list.length) T.push({ title: "Get added to your batch", tag: "#enrolment", note: "WhatsApp us", href: "https://wa.me/918424099617" });
    D.list.forEach(function (x) {
      var subs = {}; x.subs.forEach(function (s) { subs[s.key] = s; });
      x.subs.filter(function (s) { return s.status === "redo"; }).forEach(function (s) {
        T.push({ title: "Redo " + (s.key === "capstone" ? "capstone" : "Day " + s.key.slice(1)), tag: "#" + (x.c.code || "course").toLowerCase(), note: "Trainer asked", href: "#/b/" + x.b.id + (s.key === "capstone" ? "" : "/d/" + s.key.slice(1)) });
      });
      var held = x.ses.filter(function (s) { return (s.date || "") <= t; }).slice().reverse();
      var seen = {};
      held.forEach(function (s) {
        var d = +s.day; if (!d || seen[d] || subs["d" + d]) return; seen[d] = 1;
        T.push({ title: "Day " + d + " assignment", tag: "#" + (x.c.code || "course").toLowerCase(), note: s.date === t ? "Due today" : "Pending", href: "#/b/" + x.b.id + "/d/" + d });
      });
    });
  } else {
    if (ME.role === "admin") {
      var pend = D.users.filter(function (u) { return u.role === "trainer" && !u.isApproved; }).length;
      if (pend) T.push({ title: "Approve " + pend + " trainer" + (pend > 1 ? "s" : ""), tag: "#people", note: "Waiting", href: "#/people/trainers" });
      var inAny = {}; D.list.forEach(function (x) { (x.b.studentIds || []).forEach(function (u) { inAny[u] = 1; }); });
      var loose = D.users.filter(function (u) { return u.role === "student" && !inAny[u.id]; }).length;
      if (loose) T.push({ title: loose + " student" + (loose > 1 ? "s" : "") + " not in a batch", tag: "#batches", note: "Add them", href: "#/people/students" });
      if (!D.courses.length) T.push({ title: "Load the course syllabus", tag: "#courses", note: "One click", href: "#/courses" });
    }
    D.list.forEach(function (x) {
      if (x.b.status === "completed") return;
      var code = "#" + (x.c.code || "batch").toLowerCase();
      var due = x.subs.filter(function (s) { return s.status === "submitted"; }).length;
      if (due) T.push({ title: "Review " + due + " submission" + (due > 1 ? "s" : ""), tag: code, note: x.b.name, href: "#/b/" + x.b.id + "/work" });
      var n = (x.b.studentIds || []).length;
      x.ses.filter(function (s) { return (s.date || "") <= t && n && !(s.present || []).length; }).slice(-2).forEach(function (s) {
        T.push({ title: "Mark attendance · Day " + s.day, tag: code, note: fmtDate(s.date), href: "#/b/" + x.b.id + "/classes" });
      });
      if (ME.role === "admin" && !x.b.trainerId) T.push({ title: "Assign a trainer", tag: code, note: x.b.name, href: "#/b/" + x.b.id + "/settings" });
      if (!x.ses.some(function (s) { return (s.date || "") >= t; })) T.push({ title: "Schedule next class", tag: code, note: x.b.name, href: "#/b/" + x.b.id + "/classes" });
    });
  }
  return T;
}

/* ---------- right rail ---------- */
async function refreshRail(force) {
  try { var D = await loadDash(force); renderRail(D); renderSideCard(D); } catch (e) { console.error(e); }
}
function klassCard(ev, i, withJoin) {
  var meet = ev.s.meetLink || ev.b.meetLink;
  var who = ME.role === "student" ? (ev.b.trainerName || "NISHLAB mentor") : ev.b.name;
  var href = ME.role === "student" ? "#/b/" + ev.b.id + "/d/" + ev.s.day : "#/b/" + ev.b.id + "/classes";
  return '<div class="klass" style="--k:' + KCOL[i % KCOL.length] + '"><a href="' + esc(href) + '" style="text-decoration:none"><h4>' + esc(ev.c.code || "") + " · Day " + esc(ev.s.day) + '</h4><p class="small muted" style="margin-top:2px">' + esc(ev.s.topic || ev.c.title || "") + "</p></a>" +
    '<div class="meta"><span>' + ico("user") + esc(who) + "</span><span>" + ico("clock") + durTxt(ev.mins) + "</span></div>" +
    (withJoin && isUrl(meet) ? '<a class="btn sm" href="' + esc(meet) + '" target="_blank" rel="noopener">Join class</a>' : "") + "</div>";
}
function renderRail(D) {
  var now = new Date(), t = today();
  var todays = D.events.filter(function (e) { return e.s.date === t; });
  var html = '<section><div class="rail-h"><div><h2>Your classes</h2><p>Today, ' + now.toLocaleDateString("en-IN", { day: "numeric", month: "short" }).toUpperCase() + '</p></div><a href="#/" aria-label="Dashboard">' + ico("cal") + "</a></div>";
  if (todays.length) {
    var nowPlaced = false, rows = [];
    todays.forEach(function (e, i) {
      if (!nowPlaced && now < e.start) { rows.push('<div class="now"><b>' + hm(now) + "</b><i></i></div>"); nowPlaced = true; }
      rows.push('<div class="slot"><time>' + (e.known ? hm(e.start) : "Today") + "</time>" + klassCard(e, i, now < e.end && now > new Date(e.start.getTime() - 3600000)) + "</div>");
    });
    if (!nowPlaced) rows.push('<div class="now"><b>' + hm(now) + "</b><i></i></div>");
    html += '<div class="sched">' + rows.join("") + "</div>";
  } else {
    var up = D.events.filter(function (e) { return e.end > now; }).slice(0, 2);
    html += '<div class="rail-empty">No class today.' + (up.length ? " Coming up:" : ME.role === "student" ? " Your trainer will schedule the next one." : " Add a class from a batch.") + "</div>" +
      (up.length ? '<div class="sched">' + up.map(function (e, i) { return '<div class="slot"><time>' + e.start.toLocaleDateString("en-IN", { day: "numeric", month: "short" }) + "</time>" + klassCard(e, i + 1, false) + "</div>"; }).join("") + "</div>" : "");
  }
  html += "</section>";
  var T = D.tasks;
  html += '<section><div class="rail-h"><h2>Daily tasks <small class="muted" style="font-size:.78rem;font-weight:500;margin-left:6px">' + T.length + " result" + (T.length === 1 ? "" : "s") + "</small></h2></div>" +
    (T.length ? '<div class="tasks">' + T.slice(0, 4).map(function (k) {
      var ext = /^https?:/.test(k.href);
      return '<a class="task" href="' + esc(k.href) + '"' + (ext ? ' target="_blank" rel="noopener"' : "") + "><div><b>" + esc(k.title) + "</b><small>" + esc(k.tag) + "</small></div><span>" + esc(k.note) + "</span></a>";
    }).join("") + "</div>" + (T.length > 4 ? '<p class="small muted" style="margin-top:10px">+' + (T.length - 4) + " more on your dashboard</p>" : "")
      : '<div class="rail-empty">All caught up. Nothing pending.</div>') + "</section>";
  $("#railBody").innerHTML = html;
  var bell = $("#bell"); if (T.length) bell.setAttribute("data-dot", ""); else bell.removeAttribute("data-dot");
  bell.setAttribute("aria-label", T.length + " pending tasks");
}
function renderSideCard(D) {
  var el = $("#sideCard"), now = new Date();
  var nx = D.events.filter(function (e) { return e.end > now; })[0];
  if (CD_TIMER) { clearInterval(CD_TIMER); CD_TIMER = null; }
  el.hidden = false;
  if (!nx) { el.innerHTML = "<p>No upcoming class yet.</p>" + (ME.role !== "student" && D.list[0] ? '<a class="btn sm block" href="#/b/' + esc(D.list[0].b.id) + '/classes">Add a class</a>' : '<p class="small" style="opacity:.85;margin-top:6px;font-weight:400">You will see a countdown here once it is scheduled.</p>'); return; }
  var meet = nx.s.meetLink || nx.b.meetLink;
  function draw() {
    var ms = nx.start - new Date();
    if (ms <= 0) { el.innerHTML = "<p>" + esc(nx.c.code || "") + " Day " + esc(nx.s.day) + " is live now</p>" + (isUrl(meet) ? '<a class="btn sm block" href="' + esc(meet) + '" target="_blank" rel="noopener">Join class</a>' : ""); return; }
    var m = Math.floor(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
    function u(v, l) { var s = String(Math.min(v, 99)).padStart(2, "0"); return '<div class="u"><div><i>' + s[0] + "</i><i>" + s[1] + "</i></div><span>" + l + "</span></div>"; }
    el.innerHTML = "<p>Next class: " + esc(nx.c.code || "") + " Day " + esc(nx.s.day) + "</p>" + '<div class="cd" aria-label="Starts in ' + d + " days " + h + " hours " + mm + ' minutes">' + u(d, "DAYS") + "<b>:</b>" + u(h, "HOURS") + "<b>:</b>" + u(mm, "MINUTES") + "</div>";
  }
  draw(); CD_TIMER = setInterval(draw, 30000);
}

/* ---------- home building blocks ---------- */
function weekBuckets(n) {
  var d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  var out = []; for (var i = n - 1; i >= 0; i--) { var s = new Date(d); s.setDate(s.getDate() - i * 7); out.push(s); } return out;
}
function bucketIdx(weeks, dt) { if (!dt) return -1; for (var i = weeks.length - 1; i >= 0; i--) if (dt >= weeks[i]) return (i === weeks.length - 1 || dt < weeks[i + 1]) ? i : -1; return -1; }
function smooth(pts) {
  if (!pts.length) return "";
  var d = "M" + pts[0][0] + "," + pts[0][1];
  for (var i = 0; i < pts.length - 1; i++) {
    var p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    d += " C" + (p1[0] + (p2[0] - p0[0]) / 6).toFixed(1) + "," + (p1[1] + (p2[1] - p0[1]) / 6).toFixed(1) + " " + (p2[0] - (p3[0] - p1[0]) / 6).toFixed(1) + "," + (p2[1] - (p3[1] - p1[1]) / 6).toFixed(1) + " " + p2[0] + "," + p2[1];
  }
  return d;
}
function progressChart(D, title) {
  var weeks = weekBuckets(8), A = weeks.map(function () { return 0; }), Bv = A.slice(), now = new Date();
  var student = ME.role === "student";
  D.events.forEach(function (e) {
    if (e.start > now) return;
    if (student && (e.s.present || []).indexOf(ME.uid) < 0) return;
    var i = bucketIdx(weeks, e.start); if (i >= 0) A[i]++;
  });
  D.list.forEach(function (x) { x.subs.forEach(function (s) { var i = bucketIdx(weeks, tsDate(s.submittedAt)); if (i >= 0) Bv[i]++; }); });
  var W = 640, H = 230, L = 34, R = 14, T = 14, Bt = 30, max = Math.max(4, Math.max.apply(null, A.concat(Bv)));
  max = Math.ceil(max / 4) * 4;
  var x = function (i) { return L + i * (W - L - R) / (weeks.length - 1); }, y = function (v) { return T + (H - T - Bt) * (1 - v / max); };
  var pa = A.map(function (v, i) { return [+x(i).toFixed(1), +y(v).toFixed(1)]; }), pb = Bv.map(function (v, i) { return [+x(i).toFixed(1), +y(v).toFixed(1)]; });
  var grid = "";
  for (var g = 0; g <= 4; g++) { var gv = max * g / 4; grid += '<text x="' + (L - 10) + '" y="' + (y(gv) + 4) + '" text-anchor="end" font-size="11" fill="#9b9ecf">' + gv + "</text>"; }
  weeks.forEach(function (w, i) {
    grid += '<line x1="' + x(i) + '" x2="' + x(i) + '" y1="' + T + '" y2="' + (H - Bt) + '" stroke="rgba(255,255,255,.08)"/>' +
      '<text x="' + x(i) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="11" fill="#9b9ecf">' + w.toLocaleDateString("en-IN", { day: "numeric", month: "short" }).toUpperCase() + "</text>";
  });
  var la = smooth(pa), last = pa[pa.length - 1];
  var lab = student ? ["Classes attended", "Assignments sent"] : ["Classes held", "Submissions"];
  var total = A.reduce(function (s, v) { return s + v; }, 0) + Bv.reduce(function (s, v) { return s + v; }, 0);
  return '<section class="panel"><div class="panel-h"><h2>' + esc(title) + '<small>last 8 weeks</small></h2></div><div class="chart-wrap">' +
    '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc(lab[0] + ": " + A.join(", ") + ". " + lab[1] + ": " + Bv.join(", ")) + '">' +
    '<defs><linearGradient id="ga" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff3f8e" stop-opacity=".45"/><stop offset="1" stop-color="#ff3f8e" stop-opacity="0"/></linearGradient></defs>' + grid +
    '<path d="' + la + " L" + last[0] + "," + (H - Bt) + " L" + pa[0][0] + "," + (H - Bt) + ' Z" fill="url(#ga)"/>' +
    '<path d="' + smooth(pb) + '" fill="none" stroke="#4f9dff" stroke-width="2.5" stroke-linecap="round"/>' +
    '<path d="' + la + '" fill="none" stroke="#ff3f8e" stroke-width="3" stroke-linecap="round"/>' +
    '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="6" fill="#ff3f8e" stroke="#fff" stroke-width="2"/></svg>' +
    '<div class="legend"><span><i style="background:#ff3f8e"></i>' + lab[0] + '</span><span><i style="background:#4f9dff"></i>' + lab[1] + "</span></div></div>" +
    (total ? "" : '<p class="small muted" style="margin-top:6px">Your chart fills up as classes are held and work is submitted.</p>') + "</section>";
}
function heroArt() {
  function gear(cx, cy, r, n, depth) {
    var d = "", st = Math.PI * 2 / n;
    for (var i = 0; i < n; i++) {
      var a = i * st, pts = [[a - st * .27, r], [a - st * .17, r + depth], [a + st * .17, r + depth], [a + st * .27, r], [a + st * .73, r]];
      pts.forEach(function (p, j) { d += (i === 0 && j === 0 ? "M" : "L") + (cx + Math.cos(p[0]) * p[1]).toFixed(1) + "," + (cy + Math.sin(p[0]) * p[1]).toFixed(1); });
    }
    return d + "Z";
  }
  return '<svg class="art" viewBox="0 0 320 230" aria-hidden="true"><defs>' +
    '<linearGradient id="hg1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffd27a"/><stop offset="1" stop-color="#ff8a4c"/></linearGradient>' +
    '<linearGradient id="hg2" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff86c0"/><stop offset="1" stop-color="#c94bf0"/></linearGradient>' +
    '<linearGradient id="hg3" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5fb4ff"/><stop offset="1" stop-color="#3d63e8"/></linearGradient>' +
    '<radialGradient id="hg4" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#bfe3ff"/><stop offset="1" stop-color="#4f7dff"/></radialGradient></defs>' +
    '<ellipse cx="170" cy="206" rx="132" ry="18" fill="#2a1f66" opacity=".55"/>' +
    '<g transform="translate(84 58) rotate(-8)"><rect width="150" height="112" rx="8" fill="url(#hg3)"/>' +
    '<g stroke="rgba(255,255,255,.22)" stroke-width="1">' + [18, 36, 54, 72, 90].map(function (v) { return '<line x1="0" x2="150" y1="' + v + '" y2="' + v + '"/>'; }).join("") + [25, 50, 75, 100, 125].map(function (v) { return '<line y1="0" y2="112" x1="' + v + '" x2="' + v + '"/>'; }).join("") + "</g>" +
    '<path d="M22 86 L22 30 L70 30 L70 54 L118 54 L118 86 Z" fill="none" stroke="#fff" stroke-width="2.4" stroke-linejoin="round"/><circle cx="46" cy="58" r="10" fill="none" stroke="#fff" stroke-width="2.4"/><circle cx="98" cy="70" r="6" fill="none" stroke="#fff" stroke-width="2"/></g>' +
    '<path d="' + gear(232, 150, 34, 12, 9) + '" fill="url(#hg2)"/><circle cx="232" cy="150" r="14" fill="#5b3eb6"/><circle cx="232" cy="150" r="6" fill="#ffd1ea"/>' +
    '<path d="' + gear(282, 104, 18, 9, 6) + '" fill="url(#hg1)"/><circle cx="282" cy="104" r="7" fill="#5b3eb6"/>' +
    '<g transform="translate(70 22)"><circle cx="0" cy="0" r="7" fill="#fff"/><path d="M-3 4 L-30 104 M3 4 L26 104" stroke="#fff" stroke-width="5" stroke-linecap="round"/><path d="M-16 54 Q0 64 13 54" stroke="#fff" stroke-width="3" fill="none"/><path d="M26 104 l4 14 l-9 -6 z" fill="url(#hg1)"/></g>' +
    '<circle cx="40" cy="172" r="22" fill="url(#hg4)"/><ellipse cx="40" cy="172" rx="34" ry="8" fill="none" stroke="#ffd27a" stroke-width="2.5" transform="rotate(-18 40 172)"/>' +
    '<path d="M270 30 l4 10 l10 4 l-10 4 l-4 10 l-4 -10 l-10 -4 l10 -4 z" fill="#fff" opacity=".9"/><circle cx="296" cy="64" r="3" fill="#fff" opacity=".7"/><circle cx="24" cy="110" r="3" fill="#ffd27a"/></svg>';
}
function helloHead(sub) {
  return '<header class="hello"><div><h1>Hello ' + esc(firstName(ME.name) || "there") + "!</h1><p>" + esc(sub) + '</p></div><span class="date">' + ico("cal") + new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" }) + "</span></header>";
}
function hero(title, text, btns) {
  return '<section class="hero"><div><h2>' + esc(title) + "</h2><p>" + text + '</p><div class="row">' + btns + "</div></div>" + heroArt() + "</section>";
}
function courseCardHtml(x, student) {
  var c = x.c, b = x.b, total = c.days || 0, done, label, facts, go;
  if (student) {
    done = x.prog ? (x.prog.completedDays || []).length : 0;
    var att = attendance(ME.uid, x.ses);
    facts = [["book", total + " Lessons"], ["clock", (c.hours || "–") + " Hours"], ["batch", (b.studentIds || []).length + " in batch"], ["check", (att.pct == null ? "–" : att.pct + "%") + " attendance"]];
    go = "View Course";
  } else {
    var days = {}; x.ses.filter(function (s) { return (s.date || "") <= today(); }).forEach(function (s) { days[s.day] = 1; });
    done = Object.keys(days).length;
    var due = x.subs.filter(function (s) { return s.status === "submitted"; }).length;
    facts = [["book", total + " Days"], ["clock", (c.hours || "–") + " Hours"], ["batch", (b.studentIds || []).length + ((b.studentIds || []).length === 1 ? " Student" : " Students")], ["list", due + " to review"]];
    go = "Open batch";
  }
  var p = pct(done, total);
  return '<a class="ccard" href="#/b/' + esc(b.id) + '"><div class="top"><div class="row"><h3>' + esc(student ? c.title : b.name) + '</h3><span class="code">' + esc(c.code || "") + "</span></div>" +
    '<div class="by"><span class="avatar sm">' + esc(initials(b.trainerName || "N")) + "</span>" + esc(student ? (b.trainerName || "NISHLAB mentor") : (c.title || "") + (b.trainerName ? " · " + b.trainerName : "")) + "</div></div>" +
    '<div class="facts">' + facts.map(function (f) { return "<span>" + ico(f[0]) + esc(f[1]) + "</span>"; }).join("") + "</div>" +
    '<div class="prog"><span>' + done + "/" + total + '</span><div class="bar"><i style="width:' + p + '%"></i></div><span>' + p + "%</span></div>" +
    '<span class="go">' + go + "</span></a>";
}

/* ---------- the three home screens ---------- */
async function studentHome() {
  var D = await loadDash(true); renderRail(D); renderSideCard(D);
  var now = new Date(), nx = D.events.filter(function (e) { return e.end > now; })[0];
  var cur = D.list.filter(function (x) { return x.b.status !== "completed"; })[0] || D.list[0];
  var btns = "", text;
  if (nx) {
    var meet = nx.s.meetLink || nx.b.meetLink;
    text = "Next class: <b>" + esc(nx.c.code || "") + " Day " + esc(nx.s.day) + "</b>" + (nx.s.topic ? " · " + esc(nx.s.topic) : "") + "<br>" + nx.start.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }) + (nx.known ? ", " + hm(nx.start) : "");
    if (isUrl(meet)) btns += '<a class="btn coral" href="' + esc(meet) + '" target="_blank" rel="noopener">Join live class</a>';
    btns += '<a class="btn line" href="#/b/' + esc(nx.b.id) + "/d/" + esc(nx.s.day) + '" style="color:#fff">Open Day ' + esc(nx.s.day) + "</a>";
  } else if (cur) {
    var dn = cur.prog ? (cur.prog.completedDays || []) : [], nd = 1; while (dn.indexOf(nd) >= 0) nd++;
    text = "Watch the lessons, practise every day and send your work. Your trainer reviews each submission.";
    btns = '<a class="btn coral" href="#/b/' + esc(cur.b.id) + "/d/" + Math.min(nd, cur.c.days || nd) + '">Continue Day ' + Math.min(nd, cur.c.days || nd) + "</a>";
  } else {
    text = "Once your fee is confirmed, the admin adds you to your batch and your course appears here.";
    btns = '<a class="btn coral" href="https://wa.me/918424099617" target="_blank" rel="noopener">WhatsApp us</a>';
  }
  var html = helloHead("Welcome back, keep building every day.") + hero("Draw it. Model it. Simulate it.", text, btns) + progressChart(D, "Your progress") +
    '<div class="sec-h"><h2>Your courses<small>' + D.list.length + " result" + (D.list.length === 1 ? "" : "s") + "</small></h2>" + (D.certs.length ? '<a href="#/certs">My certificates</a>' : "") + "</div>" +
    (D.list.length ? '<div class="ccards">' + D.list.map(function (x) { return courseCardHtml(x, true); }).join("") + "</div>" : '<div class="empty">You are not in a batch yet. Questions? WhatsApp <a href="https://wa.me/918424099617">+91 84240 99617</a>.</div>');
  return render(html);
}

async function trainerHome() {
  var D = await loadDash(true); renderRail(D); renderSideCard(D);
  var now = new Date(), nx = D.events.filter(function (e) { return e.end > now; })[0];
  var todayN = D.events.filter(function (e) { return e.s.date === today(); }).length;
  var text = (todayN ? "You have <b>" + todayN + " class" + (todayN > 1 ? "es" : "") + "</b> today. " : "") + "After each class, tick attendance and paste the recording link so students can revise.";
  var btns = nx ? '<a class="btn coral" href="#/b/' + esc(nx.b.id) + '/classes">Open ' + esc(nx.c.code || "") + " Day " + esc(nx.s.day) + "</a>" : (D.list[0] ? '<a class="btn coral" href="#/b/' + esc(D.list[0].b.id) + '/classes">Add a class</a>' : "");
  btns += '<a class="btn line" href="#/courses" style="color:#fff">Course content</a>';
  var html = helloHead("Here is what your batches need today.") + hero("Teach it once. Make it stick.", text, btns) + progressChart(D, "Batch activity") +
    '<div class="sec-h"><h2>Your batches<small>' + D.list.length + " result" + (D.list.length === 1 ? "" : "s") + "</small></h2></div>" +
    (D.list.length ? '<div class="ccards">' + D.list.map(function (x) { return courseCardHtml(x, false); }).join("") + "</div>" : '<div class="empty">No batch is assigned to you yet. The admin assigns trainers to batches.</div>');
  return render(html);
}

async function adminHome() {
  var D = await loadDash(true); renderRail(D); renderSideCard(D);
  var st = D.users.filter(function (u) { return u.role === "student"; }).length;
  var tr = D.users.filter(function (u) { return u.role === "trainer" && u.isApproved; }).length;
  var running = D.list.filter(function (x) { return x.b.status !== "completed"; });
  var text = "<b>" + st + "</b> students · <b>" + running.length + "</b> running batch" + (running.length === 1 ? "" : "es") + " · <b>" + tr + "</b> trainer" + (tr === 1 ? "" : "s") + " · <b>" + D.certs.length + "</b> certificate" + (D.certs.length === 1 ? "" : "s");
  var btns = '<a class="btn coral" href="#/batches">New batch</a><a class="btn line" href="#/people" style="color:#fff">Copy sign-up link</a>';
  var html = helloHead("Here is how NISHLAB is doing today.") + hero("Run every batch from one place.", text, btns) +
    (!D.courses.length ? '<div class="card next" style="margin-top:20px"><div><h3>Start here: load the course syllabus</h3><p class="muted small" style="margin-top:4px">Creates AutoCAD, SolidWorks and ANSYS with every day from your website syllabus.</p></div><a class="btn" href="#/courses">Load syllabus</a></div>' : "") +
    progressChart(D, "Institute activity") +
    '<div class="sec-h"><h2>Running batches<small>' + running.length + " result" + (running.length === 1 ? "" : "s") + '</small></h2><a href="#/batches">View all</a></div>' +
    (running.length ? '<div class="ccards">' + running.map(function (x) { return courseCardHtml(x, false); }).join("") + "</div>" : '<div class="empty">No running batch. <a href="#/batches">Create one</a>.</div>');
  return render(html);
}

/* ======================================================================
   STUDENT
   ====================================================================== */
async function loadStudentBatch(bid) {
  var b = await DB.get("batches/" + bid);
  if (!b) throw new Error("This batch was not found or you are not in it.");
  var r = await Promise.all([DB.get("courses/" + b.courseId), data.lessons(b.courseId), data.assignments(b.courseId), data.sessions(bid), data.submissions(bid), data.progress(bid), data.myCerts().catch(function () { return []; })]);
  var subs = {}; r[4].forEach(function (s) { subs[s.key] = s; });
  return { b: b, c: r[0] || { title: b.courseTitle, days: 0 }, lessons: r[1], asg: r[2], ses: r[3], subs: subs, prog: r[5][0] || null, cert: r[6].filter(function (x) { return x.batchId === bid; })[0] };
}
async function saveProgress(b, days) {
  await DB.set("progress/" + b.id + "_" + ME.uid, { batchId: b.id, studentId: ME.uid, trainerId: b.trainerId || "", completedDays: days, updatedAt: DB.now() }, true);
}
async function submitWork(b, key, linkV, note) {
  linkV = cleanUrl(linkV);
  if (!isUrl(linkV)) { toast("Paste a full link, for example a Google Drive share link.", true); return false; }
  var id = b.id + "_" + key + "_" + ME.uid;
  await DB.set("submissions/" + id, {
    batchId: b.id, courseId: b.courseId, key: key, studentId: ME.uid, studentName: ME.name || ME.email,
    trainerId: b.trainerId || "", link: linkV, note: note || "", status: "submitted", submittedAt: DB.now()
  }, true);
  toast("Submitted. Your trainer will review it.");
  return true;
}

async function studentBatch(bid) {
  var S = await loadStudentBatch(bid), b = S.b, c = S.c;
  var done = (S.prog && S.prog.completedDays) || [], att = attendance(ME.uid, S.ses), nx = nextSession(S.ses);
  var asgDays = S.asg.length, submitted = S.asg.filter(function (a) { return S.subs["d" + a.day]; }).length, cap = S.subs.capstone;
  var lessons = S.lessons.length ? S.lessons : Array.from({ length: c.days || 0 }, function (_, i) { return { day: i + 1, title: "Day " + (i + 1) }; });
  var meet = (nx && nx.meetLink) || b.meetLink;
  var html = '<p><a class="btn line sm" href="#/">← My courses</a></p>' +
    '<div class="page-head" style="margin-top:14px"><div><p class="mono">' + esc(c.code || "") + " · " + esc(b.name) + "</p><h1>" + esc(c.title) + '</h1><p>Trainer: ' + esc(b.trainerName || "NISHLAB mentor") + (b.timing ? " · " + esc(b.timing) : "") + "</p></div>" +
    (isUrl(meet) ? '<a class="btn" href="' + esc(meet) + '" target="_blank" rel="noopener">Join live class</a>' : "") + "</div>" +
    (nx ? '<div class="card next"><div><p class="mono">Next class</p><h3 style="margin-top:4px">' + fmtDate(nx.date) + " · Day " + esc(nx.day) + ": " + esc(nx.topic || "") + "</h3></div>" + link(nx.meetLink || b.meetLink, "Join on Google Meet", "btn") + "</div>" : "") +
    '<div class="stats" style="margin-top:14px">' +
    '<div class="stat"><b>' + pct(done.length, lessons.length) + '%</b><span>lessons done (' + done.length + "/" + lessons.length + ")</span></div>" +
    '<div class="stat"><b>' + (att.pct == null ? "–" : att.pct + "%") + '</b><span>attendance (' + att.present + "/" + att.held + ")</span></div>" +
    '<div class="stat"><b>' + submitted + "/" + asgDays + '</b><span>assignments sent</span></div>' +
    '<div class="stat"><b>' + (S.cert ? "Issued" : cap && cap.status === "reviewed" ? "Ready" : cap ? "Sent" : "Due") + '</b><span>capstone & certificate</span></div></div>' +
    (S.cert ? '<div class="card cert" style="margin-bottom:14px"><p class="mono">Certificate</p><h3 style="margin-top:6px">' + esc(S.cert.id) + '</h3><p class="muted small" style="margin-top:4px">Issued ' + fmtDate(S.cert.issuedOn || S.cert.issuedAt) + '</p><p style="margin-top:12px"><a class="btn sm" href="' + esc(verifyUrl(S.cert.id)) + '" target="_blank" rel="noopener">Open verification page</a></p></div>' : "") +
    '<h2 style="margin:22px 0 12px">Day-by-day</h2><div class="timeline">' +
    lessons.map(function (l) {
      var isDone = done.indexOf(l.day) >= 0, sub = S.subs["d" + l.day], sess = S.ses.filter(function (s) { return +s.day === +l.day; })[0];
      return '<a class="day' + (isDone ? " done" : "") + '" href="#/b/' + esc(bid) + "/d/" + l.day + '"><span class="n">' + (isDone ? "✓ " : "") + "DAY " + String(l.day).padStart(2, "0") + '</span><span class="t">' + esc(l.title) + '</span><span class="chips">' +
        (sess && sess.recordingUrl ? chip("Recording", "") : "") + (l.videoUrl ? chip("Video", "") : "") + statusChip(sub) + "</span></a>";
    }).join("") + "</div>" +
    '<h2 style="margin:26px 0 12px">Industry capstone</h2><div class="card"><p>' + esc(c.capstone || "Your trainer will share the capstone brief.") + "</p>" +
    workBox(cap, "capstone") + "</div>";
  render(html, function () { bindWork(b, "capstone"); });
}
function workBox(sub, key) {
  return '<div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--line)">' +
    (sub ? '<div class="row" style="margin-bottom:12px">' + statusChip(sub) + link(sub.link, "Open my submission") + "</div>" +
      (sub.feedback ? '<div class="ok-box" style="color:var(--text)"><b>Trainer feedback:</b> ' + esc(sub.feedback) + "</div>" : "") : "") +
    (sub && sub.status === "reviewed" ? "" :
      '<form data-work="' + key + '"><div class="field"><label class="lbl" for="w-' + key + '">' + (sub ? "Send a new link" : "Your Google Drive link") + '</label><input id="w-' + key + '" type="text" inputmode="url" autocapitalize="off" spellcheck="false" placeholder="https://drive.google.com/..." value="' + esc(sub && sub.status === "redo" ? "" : (sub && sub.link) || "") + '"></div>' +
      '<div class="field"><label class="lbl" for="n-' + key + '">Note for your trainer (optional)</label><input id="n-' + key + '" maxlength="300"></div>' +
      '<button class="btn sm" type="submit">' + (sub ? "Update submission" : "Submit") + '</button><p class="small muted" style="margin-top:8px">Set the Drive file or folder to "Anyone with the link can view".</p></form>') + "</div>";
}
function bindWork(b, key, after) {
  var f = $('form[data-work="' + key + '"]'); if (!f) return;
  f.addEventListener("submit", async function (e) {
    e.preventDefault(); var btn = f.querySelector("button"); btn.disabled = true;
    try { if (await submitWork(b, key, $("#w-" + key).value, $("#n-" + key).value)) (after || route)(); else btn.disabled = false; }
    catch (er) { fail(er); btn.disabled = false; }
  });
}

async function studentDay(bid, n) {
  var S = await loadStudentBatch(bid), b = S.b, c = S.c;
  var l = S.lessons.filter(function (x) { return +x.day === n; })[0] || { day: n, title: "Day " + n };
  var a = S.asg.filter(function (x) { return +x.day === n; })[0];
  var sess = S.ses.filter(function (s) { return +s.day === n; });
  var done = ((S.prog && S.prog.completedDays) || []).indexOf(n) >= 0, total = S.lessons.length || c.days || n;
  var emb = driveEmbed(l.videoUrl);
  var recs = sess.filter(function (s) { return isUrl(s.recordingUrl); });
  var html = '<p><a class="btn line sm" href="#/b/' + esc(bid) + '">← ' + esc(c.title) + "</a></p>" +
    '<div class="page-head" style="margin-top:14px"><div><p class="mono">Day ' + String(n).padStart(2, "0") + " of " + total + "</p><h1>" + esc(l.title) + "</h1></div>" +
    '<button class="btn ' + (done ? "line" : "") + '" id="doneBtn" type="button">' + (done ? "✓ Marked as done" : "Mark this day as done") + "</button></div>" +
    '<div class="stack">' +
    (emb ? '<div class="video"><iframe src="' + esc(emb) + '" title="Lesson video: ' + esc(l.title) + '" allow="autoplay; fullscreen" allowfullscreen loading="lazy"></iframe></div>' :
      '<div class="empty">' + (l.videoUrl ? link(l.videoUrl, "Open lesson video", "btn") : "The lesson video for this day hasn't been added yet.") + "</div>") +
    (l.notes ? '<div class="card"><h3>Notes from your trainer</h3><p style="margin-top:8px;white-space:pre-line">' + esc(l.notes) + "</p></div>" : "") +
    ((l.resourceUrl || recs.length) ? '<div class="card"><h3>Files and recordings</h3><div class="row" style="margin-top:12px">' + link(l.resourceUrl, "Practice files") +
      recs.map(function (s) { return link(s.recordingUrl, "Class recording · " + fmtDate(s.date)); }).join("") + "</div></div>" : "") +
    '<div class="card"><p class="mono">Assignment</p><h3 style="margin-top:6px">' + esc((a && a.title) || "Day " + n + " practice") + '</h3><p style="margin-top:8px;white-space:pre-line">' + esc((a && a.instructions) || "Practise today's commands on your own and share your file as a Google Drive link.") + "</p>" + workBox(S.subs["d" + n], "d" + n) + "</div>" +
    '<div class="row" style="justify-content:space-between">' + (n > 1 ? '<a class="btn line sm" href="#/b/' + esc(bid) + "/d/" + (n - 1) + '">← Day ' + (n - 1) + "</a>" : "<span></span>") +
    (n < total ? '<a class="btn line sm" href="#/b/' + esc(bid) + "/d/" + (n + 1) + '">Day ' + (n + 1) + " →</a>" : "") + "</div></div>";
  render(html, function () {
    bindWork(b, "d" + n);
    $("#doneBtn").onclick = async function () {
      var cur = ((S.prog && S.prog.completedDays) || []).slice(), i = cur.indexOf(n);
      if (i >= 0) cur.splice(i, 1); else cur.push(n);
      cur.sort(function (x, y) { return x - y; });
      try { await saveProgress(b, cur); S.prog = { completedDays: cur }; var d = cur.indexOf(n) >= 0; this.textContent = d ? "✓ Marked as done" : "Mark this day as done"; this.classList.toggle("line", d); toast(d ? "Day " + n + " marked as done." : "Unmarked."); } catch (e) { fail(e); }
    };
  });
}

async function studentCerts() {
  var certs = await data.myCerts();
  return render('<div class="page-head"><div><h1>My certificates</h1><p>Each certificate has an ID and a public page employers can open to check it.</p></div></div>' +
    (certs.length ? '<div class="cards">' + certs.map(certCard).join("") + "</div>" :
      '<div class="empty">No certificate yet. You get one after you finish your course with at least 75% attendance and your capstone is reviewed.</div>'));
}
function certCard(x) {
  return '<div class="card cert"><p class="mono">Certificate of completion</p><h3 style="margin-top:6px">' + esc(x.courseTitle) + '</h3><p class="hot" style="margin-top:6px;font-family:var(--mono)">' + esc(x.id) + "</p>" +
    '<div class="kv" style="margin-top:10px"><span>Issued</span><span>' + fmtDate(x.issuedOn || x.issuedAt) + "</span></div>" +
    '<div class="kv"><span>Training</span><span>' + fmtDate(x.trainingFrom) + " – " + fmtDate(x.trainingTo) + "</span></div>" +
    (x.score ? '<div class="kv"><span>Final test</span><span>' + esc(x.score) + "%</span></div>" : "") +
    '<p style="margin-top:12px"><a class="btn sm" href="' + esc(verifyUrl(x.id)) + '" target="_blank" rel="noopener">Verification page</a></p></div>';
}

async function profileView() {
  return render('<div class="page-head"><div><h1>Profile</h1><p>This name is printed on your certificate.</p></div></div>' +
    '<form class="card" id="pf" style="max-width:520px"><div class="field"><label class="lbl" for="pn">Full name</label><input id="pn" value="' + esc(ME.name) + '" required></div>' +
    '<div class="field"><label class="lbl" for="pp">WhatsApp number</label><input id="pp" type="tel" value="' + esc(ME.phone || "") + '"></div>' +
    '<div class="field"><label class="lbl">Email</label><input value="' + esc(ME.email) + '" disabled></div><button class="btn" type="submit">Save</button></form>', function () {
    $("#pf").onsubmit = async function (e) {
      e.preventDefault(); var name = $("#pn").value.trim(); if (!name) return toast("Enter your name.", true);
      try { await DB.update("users/" + ME.uid, { name: name, phone: $("#pp").value.trim() }); ME.name = name; ME.phone = $("#pp").value.trim(); showWho(ME); toast("Profile saved."); } catch (er) { fail(er); }
    };
  });
}

/* ======================================================================
   TRAINER + ADMIN
   ====================================================================== */
function batchCard(b, c) {
  c = c || {};
  return '<a class="card course-card" href="#/b/' + esc(b.id) + '"><div class="row" style="justify-content:space-between"><span class="code">' + esc(c.code || "") + "</span>" + (b.status === "completed" ? chip("Completed", "ok") : chip("Running", "hot")) + "</div>" +
    "<div><h3>" + esc(b.name) + '</h3><p class="small muted" style="margin-top:4px">' + esc(c.title || b.courseTitle || "") + "</p></div>" +
    '<div class="kv"><span>Students</span><span>' + (b.studentIds || []).length + "</span></div>" +
    '<div class="kv"><span>Trainer</span><span>' + esc(b.trainerName || "Not assigned") + "</span></div>" +
    '<div class="kv"><span>Timing</span><span>' + esc(b.timing || "–") + "</span></div></a>";
}

/* ---------- batch management ---------- */
async function manageBatch(bid, tab) {
  var b = await DB.get("batches/" + bid);
  if (!b) throw new Error("Batch not found.");
  var r = await Promise.all([DB.get("courses/" + b.courseId), data.lessons(b.courseId), data.sessions(bid), data.submissions(bid), data.progress(bid), data.certsForBatch(bid), data.assignments(b.courseId)]);
  var M = { b: b, c: r[0] || { title: b.courseTitle, days: 0 }, lessons: r[1], ses: r[2], subs: r[3], prog: r[4], certs: r[5], asg: r[6] };
  var pendingWork = M.subs.filter(function (s) { return s.status === "submitted"; }).length;
  var tabs = [["classes", "Classes & attendance"], ["students", "Students"], ["work", "Submissions" + (pendingWork ? " (" + pendingWork + ")" : "")], ["settings", "Settings"]];
  var head = '<p><a class="btn line sm" href="' + (ME.role === "admin" ? "#/batches" : "#/") + '">← Batches</a></p>' +
    '<div class="page-head" style="margin-top:14px"><div><p class="mono">' + esc(M.c.code || "") + " · " + esc(M.c.title) + "</p><h1>" + esc(b.name) + "</h1><p>" + esc(b.trainerName || "No trainer") + (b.timing ? " · " + esc(b.timing) : "") + " · " + (b.studentIds || []).length + ((b.studentIds || []).length === 1 ? " student" : " students") + "</p></div>" +
    link(b.meetLink, "Open Meet link", "btn line") + "</div>" +
    '<nav class="tabs" aria-label="Batch sections">' + tabs.map(function (t) { return '<a href="#/b/' + esc(bid) + "/" + t[0] + '" class="' + (t[0] === tab ? "on" : "") + '">' + esc(t[1]) + "</a>"; }).join("") + "</nav>";
  var body = tab === "students" ? tabStudents(M) : tab === "work" ? tabWork(M) : tab === "settings" ? await tabSettings(M) : tabClasses(M);
  render(head + body.html, body.bind);
}

function tabClasses(M) {
  var b = M.b, students = b.students || [];
  var lessonOpts = (M.lessons.length ? M.lessons : Array.from({ length: M.c.days || 0 }, function (_, i) { return { day: i + 1, title: "Day " + (i + 1) }; }));
  var nextDay = M.ses.length ? Math.min(lessonOpts.length || 99, Math.max.apply(null, M.ses.map(function (s) { return +s.day || 0; })) + 1) : 1;
  var html = '<form class="card" id="addClass"><h3>Add a class</h3><div class="grid3" style="margin-top:14px">' +
    '<div class="field"><label class="lbl" for="sd">Date</label><input id="sd" type="date" value="' + today() + '" required></div>' +
    '<div class="field"><label class="lbl" for="sday">Syllabus day</label><select id="sday">' + lessonOpts.map(function (l) { return '<option value="' + l.day + '"' + (l.day === nextDay ? " selected" : "") + ">Day " + l.day + " · " + esc(l.title) + "</option>"; }).join("") + "</select></div>" +
    '<div class="field"><label class="lbl" for="smeet">Meet link</label><input id="smeet" type="text" inputmode="url" autocapitalize="off" spellcheck="false" value="' + esc(b.meetLink || "") + '" placeholder="https://meet.google.com/..."></div></div>' +
    '<button class="btn" type="submit">Add class</button></form>' +
    '<h2 style="margin:24px 0 12px">Classes (' + M.ses.length + ")</h2>" +
    (M.ses.length ? M.ses.slice().reverse().map(function (s) {
      var pres = s.present || [];
      return '<details class="edit"><summary><span class="n">DAY ' + String(s.day).padStart(2, "0") + '</span><span class="t">' + esc(s.topic || "") + '<br><span class="small muted">' + fmtDate(s.date) + "</span></span>" +
        ((s.date || "") > today() ? chip("Upcoming", "") : chip(pres.length + "/" + students.length + " present", pres.length ? "ok" : "warn")) + (s.recordingUrl ? chip("Recording", "") : "") + "</summary>" +
        '<div class="body"><form data-ses="' + esc(s.id) + '"><p class="mono">Attendance</p>' +
        (students.length ? '<div class="att">' + students.map(function (st) {
          return '<label><input type="checkbox" value="' + esc(st.uid) + '"' + (pres.indexOf(st.uid) >= 0 ? " checked" : "") + "> <span>" + esc(st.name) + "</span></label>";
        }).join("") + '</div><p class="row" style="margin-bottom:14px"><button type="button" class="btn line sm" data-all>Mark all present</button></p>' : '<p class="muted small" style="margin:8px 0 14px">No students in this batch yet.</p>') +
        '<div class="grid2"><div class="field"><label class="lbl" for="rec-' + esc(s.id) + '">Recording link (Google Drive)</label><input id="rec-' + esc(s.id) + '" type="text" inputmode="url" autocapitalize="off" spellcheck="false" value="' + esc(s.recordingUrl || "") + '" placeholder="https://drive.google.com/file/d/..."></div>' +
        '<div class="field"><label class="lbl" for="ml-' + esc(s.id) + '">Meet link</label><input id="ml-' + esc(s.id) + '" type="text" inputmode="url" autocapitalize="off" spellcheck="false" value="' + esc(s.meetLink || "") + '"></div></div>' +
        '<div class="row"><button class="btn sm" type="submit">Save class</button><button class="btn danger sm" type="button" data-del>Delete class</button></div></form></div></details>';
    }).join("") : '<div class="empty">No classes yet. Add the first one above; students see it as their next class.</div>');
  return { html: html, bind: function () {
    $("#addClass").onsubmit = async function (e) {
      e.preventDefault(); var day = +$("#sday").value, l = lessonOpts.filter(function (x) { return x.day === day; })[0];
      var meet = cleanUrl($("#smeet").value);
      if (meet && !isUrl(meet)) return toast("The Meet link doesn't look right.", true);
      try { await DB.add("batches/" + b.id + "/sessions", { date: $("#sd").value || today(), day: day, topic: l ? l.title : "", meetLink: meet || "", recordingUrl: "", present: [], createdAt: DB.now() }); toast("Class added."); route(); } catch (er) { fail(er); }
    };
    $$("form[data-ses]").forEach(function (f) {
      var sid = f.getAttribute("data-ses");
      var all = f.querySelector("[data-all]"); if (all) all.onclick = function () { $$('input[type=checkbox]', f).forEach(function (x) { x.checked = true; }); };
      f.querySelector("[data-del]").onclick = async function () {
        if (this.dataset.confirm !== "1") { this.dataset.confirm = "1"; this.textContent = "Tap again to delete"; return; }
        try { await DB.del("batches/" + b.id + "/sessions/" + sid); toast("Class deleted."); route(); } catch (er) { fail(er); }
      };
      f.onsubmit = async function (e) {
        e.preventDefault();
        var present = $$('input[type=checkbox]:checked', f).map(function (x) { return x.value; });
        var rec = cleanUrl($("#rec-" + sid).value), ml = cleanUrl($("#ml-" + sid).value);
        if (rec && !isUrl(rec)) return toast("The recording link doesn't look right.", true);
        try { await DB.update("batches/" + b.id + "/sessions/" + sid, { present: present, recordingUrl: rec || "", meetLink: ml || "" }); toast("Saved: " + present.length + " present."); route(); } catch (er) { fail(er); }
      };
    });
  } };
}

function studentStats(M, uid) {
  var att = attendance(uid, M.ses);
  var p = M.prog.filter(function (x) { return x.studentId === uid; })[0];
  var subs = M.subs.filter(function (s) { return s.studentId === uid; });
  var cap = subs.filter(function (s) { return s.key === "capstone"; })[0];
  var cert = M.certs.filter(function (x) { return x.studentId === uid; })[0];
  return { att: att, done: p ? (p.completedDays || []).length : 0, sent: subs.filter(function (s) { return s.key !== "capstone"; }).length, cap: cap, cert: cert,
    eligible: att.pct != null && att.pct >= 75 && cap && cap.status === "reviewed" };
}
function tabStudents(M) {
  var b = M.b, students = b.students || [], admin = ME.role === "admin";
  var html = (admin ? '<form class="card" id="addStu" style="margin-bottom:14px"><h3>Add a student</h3><p class="small muted" style="margin:4px 0 12px">The student must first create an account on the LMS sign-in page.</p><div class="row"><select id="stuSel" style="flex:1;min-width:220px"><option value="">Loading students…</option></select><button class="btn" type="submit">Add to batch</button></div></form>' : "") +
    (students.length ? '<div class="table-wrap"><table><thead><tr><th>Student</th><th>Attendance</th><th>Lessons</th><th>Assignments</th><th>Capstone</th><th>Certificate</th>' + (admin ? "<th></th>" : "") + "</tr></thead><tbody>" +
      students.map(function (st) {
        var x = studentStats(M, st.uid);
        var certCell = x.cert ? '<a class="hot" href="' + esc(verifyUrl(x.cert.id)) + '" target="_blank" rel="noopener">' + esc(x.cert.id) + "</a>" :
          admin ? '<button class="btn sm ' + (x.eligible ? "" : "line") + '" type="button" data-issue="' + esc(st.uid) + '">Issue</button>' : x.eligible ? chip("Eligible", "ok") : chip("Not yet", "");
        return "<tr><td><b>" + esc(st.name) + '</b><br><span class="small muted">' + esc(st.email || "") + (st.phone ? " · " + esc(st.phone) : "") + "</span></td>" +
          "<td>" + (x.att.pct == null ? "–" : '<span class="' + (x.att.pct < 75 ? "hot" : "") + '">' + x.att.pct + "%</span> <span class=\"small muted\">(" + x.att.present + "/" + x.att.held + ")</span>") + "</td>" +
          "<td>" + x.done + "/" + (M.lessons.length || M.c.days || 0) + "</td><td>" + x.sent + "/" + M.asg.length + "</td><td>" + (x.cap ? statusChip(x.cap) : chip("Not sent", "")) + "</td><td>" + certCell + "</td>" +
          (admin ? '<td><button class="btn danger sm" type="button" data-rm="' + esc(st.uid) + '">Remove</button></td>' : "") + "</tr>" +
          (admin && !x.cert ? '<tr data-issue-row="' + esc(st.uid) + '" hidden><td colspan="7">' + issueForm(M, st, x) + "</td></tr>" : "");
      }).join("") + "</tbody></table></div>" : '<div class="empty">No students in this batch yet.</div>');
  return { html: html, bind: function () {
    if (!admin) return;
    (async function () {
      try {
        var users = await data.users(), inB = b.studentIds || [];
        var opts = users.filter(function (u) { return u.role === "student" && inB.indexOf(u.id) < 0; }).sort(function (x, y) { return String(x.name).localeCompare(y.name); });
        $("#stuSel").innerHTML = opts.length ? '<option value="">Choose a student</option>' + opts.map(function (u) { return '<option value="' + esc(u.id) + '">' + esc(u.name) + " · " + esc(u.email) + "</option>"; }).join("") : '<option value="">No other students have signed up</option>';
        $("#addStu").onsubmit = async function (e) {
          e.preventDefault(); var id = $("#stuSel").value; if (!id) return toast("Choose a student first.", true);
          var u = opts.filter(function (x) { return x.id === id; })[0];
          try { await DB.update("batches/" + b.id, { studentIds: DB.arrayUnion(id), students: (b.students || []).concat([{ uid: id, name: u.name || u.email, email: u.email || "", phone: u.phone || "" }]) }); toast(u.name + " added."); route(); } catch (er) { fail(er); }
        };
      } catch (er) { fail(er); }
    })();
    $$("[data-rm]").forEach(function (btn) {
      btn.onclick = async function () {
        if (this.dataset.confirm !== "1") { this.dataset.confirm = "1"; this.textContent = "Tap to confirm"; return; }
        var uid = this.getAttribute("data-rm");
        try { await DB.update("batches/" + b.id, { studentIds: DB.arrayRemove(uid), students: (b.students || []).filter(function (s) { return s.uid !== uid; }) }); toast("Student removed from batch."); route(); } catch (er) { fail(er); }
      };
    });
    $$("[data-issue]").forEach(function (btn) {
      btn.onclick = function () { var row = $('[data-issue-row="' + this.getAttribute("data-issue") + '"]'); row.hidden = !row.hidden; };
    });
    $$("form[data-issue-form]").forEach(function (f) {
      f.onsubmit = async function (e) {
        e.preventDefault(); var uid = f.getAttribute("data-issue-form"), st = students.filter(function (s) { return s.uid === uid; })[0], x = studentStats(M, uid);
        if (!x.eligible && !f.querySelector("[name=override]").checked) return toast("Not eligible yet. Tick 'Issue anyway' to override.", true);
        var btn = f.querySelector("button"); btn.disabled = true;
        try {
          var n = await DB.nextCounter("certificates", CERT_START), id = "NLC-" + new Date().getFullYear() + "-" + n;
          await DB.set("certificates/" + id, { certId: id, studentId: uid, studentName: f.querySelector("[name=sname]").value.trim() || st.name, courseId: M.b.courseId, courseTitle: M.c.title,
            batchId: M.b.id, batchName: M.b.name, trainingFrom: f.querySelector("[name=from]").value, trainingTo: f.querySelector("[name=to]").value,
            attendancePct: x.att.pct, score: f.querySelector("[name=score]").value, issuedOn: today(), issuedAt: DB.now(), issuedBy: ME.name || ME.email, status: "valid" });
          toast("Certificate " + id + " issued."); route();
        } catch (er) { fail(er); btn.disabled = false; }
      };
    });
  } };
}
function issueForm(M, st, x) {
  return '<form data-issue-form="' + esc(st.uid) + '" style="padding:8px 0"><p class="small" style="margin-bottom:12px">' +
    (x.eligible ? '<span class="chip ok">Eligible</span> ' : '<span class="chip warn">Not eligible yet</span> ') +
    "Attendance " + (x.att.pct == null ? "–" : x.att.pct + "%") + " (needs 75%) · Capstone " + (x.cap ? esc(x.cap.status) : "not sent") + " (needs reviewed)</p>" +
    '<div class="grid3"><div class="field"><label class="lbl">Name on certificate</label><input name="sname" value="' + esc(st.name) + '"></div>' +
    '<div class="field"><label class="lbl">Training from</label><input name="from" type="date" value="' + esc(M.b.startDate || "") + '"></div>' +
    '<div class="field"><label class="lbl">Training to</label><input name="to" type="date" value="' + today() + '"></div>' +
    '<div class="field"><label class="lbl">Final test score %</label><input name="score" type="number" min="0" max="100" inputmode="numeric"></div></div>' +
    '<label class="row small" style="margin-bottom:12px"><input type="checkbox" name="override"> Issue anyway</label><button class="btn sm" type="submit">Issue certificate</button></form>';
}

function tabWork(M) {
  var lmap = {}; M.lessons.forEach(function (l) { lmap["d" + l.day] = l.title; });
  var list = M.subs.slice().sort(function (a, b) {
    var w = function (s) { return s.status === "submitted" ? 0 : s.status === "redo" ? 1 : 2; };
    return w(a) - w(b) || ((b.submittedAt && b.submittedAt.seconds) || 0) - ((a.submittedAt && a.submittedAt.seconds) || 0);
  });
  var html = list.length ? '<div class="stack">' + list.map(function (s) {
    var label = s.key === "capstone" ? "Industry capstone" : "Day " + s.key.slice(1) + (lmap[s.key] ? " · " + lmap[s.key] : "");
    return '<form class="card" data-sub="' + esc(s.id) + '"><div class="row" style="justify-content:space-between"><div><p class="mono">' + esc(label) + '</p><h3 style="margin-top:4px">' + esc(s.studentName) + "</h3></div>" + statusChip(s) + "</div>" +
      '<div class="row" style="margin:12px 0">' + link(s.link, "Open submission", "btn sm") + (s.submittedAt ? '<span class="small muted">Sent ' + fmtDate(s.submittedAt) + "</span>" : "") + "</div>" +
      (s.note ? '<p class="small" style="margin-bottom:12px">Student note: ' + esc(s.note) + "</p>" : "") +
      '<div class="grid2"><div class="field"><label class="lbl" for="g-' + esc(s.id) + '">Grade</label><select id="g-' + esc(s.id) + '">' + ["", "A+", "A", "B", "C", "D"].map(function (g) { return '<option value="' + g + '"' + (s.grade === g ? " selected" : "") + ">" + (g || "No grade") + "</option>"; }).join("") + "</select></div>" +
      '<div class="field"><label class="lbl" for="f-' + esc(s.id) + '">Feedback</label><input id="f-' + esc(s.id) + '" value="' + esc(s.feedback || "") + '" maxlength="500"></div></div>' +
      '<div class="row"><button class="btn sm" type="submit" value="reviewed">Mark reviewed</button><button class="btn line sm" type="submit" value="redo">Ask to redo</button></div></form>';
  }).join("") + "</div>" : '<div class="empty">No submissions yet. They appear here when students send their Drive links.</div>';
  return { html: html, bind: function () {
    $$("form[data-sub]").forEach(function (f) {
      f.onsubmit = async function (e) {
        e.preventDefault(); var id = f.getAttribute("data-sub"), st = (e.submitter && e.submitter.value) || "reviewed";
        try { await DB.update("submissions/" + id, { grade: $("#g-" + id).value, feedback: $("#f-" + id).value.trim(), status: st, reviewedAt: DB.now(), reviewedBy: ME.name || ME.email }); toast(st === "redo" ? "Sent back for redo." : "Marked reviewed."); route(); } catch (er) { fail(er); }
      };
    });
  } };
}

async function tabSettings(M) {
  var b = M.b, admin = ME.role === "admin", trainers = [];
  if (admin) trainers = (await data.users()).filter(function (u) { return (u.role === "trainer" && u.isApproved) || u.role === "admin"; });
  var html = '<form class="card" id="bset" style="max-width:720px"><div class="grid2">' +
    (admin ? '<div class="field"><label class="lbl" for="bn">Batch name</label><input id="bn" value="' + esc(b.name) + '" required></div>' +
      '<div class="field"><label class="lbl" for="bt">Trainer</label><select id="bt"><option value="">Not assigned</option>' + trainers.map(function (t) { return '<option value="' + esc(t.id) + '"' + (t.id === b.trainerId ? " selected" : "") + ">" + esc(t.name) + (t.role === "admin" ? " (admin)" : "") + "</option>"; }).join("") + "</select></div>" +
      '<div class="field"><label class="lbl" for="bs">Start date</label><input id="bs" type="date" value="' + esc(b.startDate || "") + '"></div>' : "") +
    '<div class="field"><label class="lbl" for="bti">Timing</label><input id="bti" value="' + esc(b.timing || "") + '" placeholder="Mon–Fri · 8–10 PM IST"></div>' +
    '<div class="field"><label class="lbl" for="bm">Default Google Meet link</label><input id="bm" type="text" inputmode="url" autocapitalize="off" spellcheck="false" value="' + esc(b.meetLink || "") + '" placeholder="https://meet.google.com/..."></div>' +
    '<div class="field"><label class="lbl" for="bst">Status</label><select id="bst"><option value="running"' + (b.status !== "completed" ? " selected" : "") + '>Running</option><option value="completed"' + (b.status === "completed" ? " selected" : "") + ">Completed</option></select></div></div>" +
    '<div class="row"><button class="btn" type="submit">Save settings</button>' + (admin ? '<button class="btn danger" type="button" id="bdel">Delete batch</button>' : "") + "</div></form>";
  return { html: html, bind: function () {
    $("#bset").onsubmit = async function (e) {
      e.preventDefault(); var meet = cleanUrl($("#bm").value);
      if (meet && !isUrl(meet)) return toast("The Meet link doesn't look right.", true);
      var upd = { timing: $("#bti").value.trim(), meetLink: meet || "", status: $("#bst").value };
      if (admin) {
        var tid = $("#bt").value, t = trainers.filter(function (x) { return x.id === tid; })[0];
        upd.name = $("#bn").value.trim() || b.name; upd.trainerId = tid; upd.trainerName = t ? t.name : ""; upd.startDate = $("#bs").value;
      }
      try {
        await DB.update("batches/" + b.id, upd);
        if (admin && upd.trainerId !== (b.trainerId || "")) await retagTrainer(b.id, upd.trainerId);
        toast("Settings saved."); route();
      } catch (er) { fail(er); }
    };
    var del = $("#bdel"); if (del) del.onclick = async function () {
      if (this.dataset.confirm !== "1") { this.dataset.confirm = "1"; this.textContent = "Tap again: delete batch and its classes"; return; }
      try {
        var ops = M.ses.map(function (s) { return { type: "delete", path: "batches/" + b.id + "/sessions/" + s.id }; });
        ops.push({ type: "delete", path: "batches/" + b.id });
        await DB.batchWrite(ops); toast("Batch deleted."); location.hash = "#/batches";
      } catch (er) { fail(er); }
    };
  } };
}
// when the trainer changes, move existing work and progress to the new trainer so they can see it
async function retagTrainer(bid, tid) {
  var r = await Promise.all([DB.list("submissions", [["batchId", "==", bid]]), DB.list("progress", [["batchId", "==", bid]])]);
  var ops = r[0].map(function (s) { return { type: "update", path: "submissions/" + s.id, data: { trainerId: tid } }; })
    .concat(r[1].map(function (p) { return { type: "update", path: "progress/" + p.id, data: { trainerId: tid } }; }));
  if (ops.length) await DB.batchWrite(ops);
}

/* ---------- admin: batches ---------- */
async function adminBatches() {
  var res = await Promise.all([DB.list("batches"), data.courses(), data.users()]);
  var batches = res[0], courses = res[1], users = res[2], cmap = {};
  courses.forEach(function (c) { cmap[c.id] = c; });
  var trainers = users.filter(function (u) { return (u.role === "trainer" && u.isApproved) || u.role === "admin"; });
  var mon = new Date().toLocaleDateString("en-IN", { month: "short", year: "numeric" });
  var html = '<div class="page-head"><div><h1>Batches</h1><p>Create a batch, then add students and classes inside it.</p></div></div>' +
    (courses.length ? '<form class="card" id="nb"><h3>New batch</h3><div class="grid3" style="margin-top:14px">' +
      '<div class="field"><label class="lbl" for="nbc">Course</label><select id="nbc">' + courses.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.title) + "</option>"; }).join("") + "</select></div>" +
      '<div class="field"><label class="lbl" for="nbn">Batch name</label><input id="nbn" required></div>' +
      '<div class="field"><label class="lbl" for="nbt">Trainer</label><select id="nbt"><option value="">Assign later</option>' + trainers.map(function (t) { return '<option value="' + esc(t.id) + '">' + esc(t.name) + (t.role === "admin" ? " (admin)" : "") + "</option>"; }).join("") + "</select></div>" +
      '<div class="field"><label class="lbl" for="nbs">Start date</label><input id="nbs" type="date" value="' + today() + '"></div>' +
      '<div class="field"><label class="lbl" for="nbti">Timing</label><input id="nbti" placeholder="Mon–Fri · 8–10 PM IST"></div>' +
      '<div class="field"><label class="lbl" for="nbm">Google Meet link</label><input id="nbm" type="text" inputmode="url" autocapitalize="off" spellcheck="false" placeholder="https://meet.google.com/..."></div></div>' +
      '<button class="btn" type="submit">Create batch</button></form>' : '<div class="card next"><div><h3>Load the course syllabus first</h3><p class="small muted">Batches need a course.</p></div><a class="btn" href="#/courses">Go to Courses</a></div>') +
    '<h2 style="margin:24px 0 12px">All batches (' + batches.length + ")</h2>" +
    (batches.length ? '<div class="cards">' + batches.sort(function (a, b) { return (a.status === "completed") - (b.status === "completed") || String(b.startDate).localeCompare(a.startDate); }).map(function (b) { return batchCard(b, cmap[b.courseId]); }).join("") + "</div>" : '<div class="empty">No batches yet.</div>');
  render(html, function () {
    var f = $("#nb"); if (!f) return;
    var setName = function () { var c = cmap[$("#nbc").value]; if (c && !$("#nbn").dataset.touched) $("#nbn").value = c.title.replace(" Professional", "") + " · " + mon; };
    $("#nbc").onchange = setName; $("#nbn").oninput = function () { this.dataset.touched = "1"; }; setName();
    f.onsubmit = async function (e) {
      e.preventDefault(); var cid = $("#nbc").value, c = cmap[cid], tid = $("#nbt").value, t = trainers.filter(function (x) { return x.id === tid; })[0];
      var meet = cleanUrl($("#nbm").value); if (meet && !isUrl(meet)) return toast("The Meet link doesn't look right.", true);
      try {
        var id = await DB.add("batches", { courseId: cid, courseTitle: c.title, name: $("#nbn").value.trim(), trainerId: tid, trainerName: t ? t.name : "", startDate: $("#nbs").value, timing: $("#nbti").value.trim(), meetLink: meet || "", status: "running", studentIds: [], students: [], createdAt: DB.now() });
        toast("Batch created. Now add students."); location.hash = "#/b/" + id + "/students";
      } catch (er) { fail(er); }
    };
  });
}

/* ---------- courses ---------- */
async function coursesView() {
  var courses = await data.courses(), have = {}, admin = ME.role === "admin";
  courses.forEach(function (c) { have[c.id] = c; });
  var syl = window.NL_SYLLABUS || [];
  var missing = syl.filter(function (s) { return !have[s.id]; });
  var html = '<div class="page-head"><div><h1>Course content</h1><p>Each course has a lesson and an assignment for every day. Add your Google Drive video links here.</p></div></div>' +
    (admin && missing.length ? '<div class="card next" style="margin-bottom:14px"><div><h3>Load syllabus for ' + missing.map(function (s) { return esc(s.title.replace(" Professional", "").replace(" Workbench", "")); }).join(", ") + '</h3><p class="small muted" style="margin-top:4px">Creates the course with every day from your website syllabus. Existing courses are not touched.</p></div><button class="btn" type="button" id="seed">Load syllabus</button></div>' : "") +
    (courses.length ? '<div class="cards">' + courses.map(function (c) {
      return '<a class="card course-card" href="#/c/' + esc(c.id) + '"><span class="code" style="align-self:flex-start">' + esc(c.code) + "</span><div><h3>" + esc(c.title) + '</h3><p class="small muted" style="margin-top:4px">' + esc(c.summary || "") + "</p></div>" +
        '<div class="kv"><span>Days</span><span>' + esc(c.days) + '</span></div><div class="kv"><span>Live hours</span><span>' + esc(c.hours) + "</span></div></a>";
    }).join("") + "</div>" : '<div class="empty">No courses yet.' + (admin ? " Use Load syllabus above." : " Ask the admin to load the syllabus.") + "</div>");
  render(html, function () {
    var s = $("#seed"); if (!s) return;
    s.onclick = async function () {
      s.disabled = true; s.textContent = "Loading…";
      try {
        var ops = [];
        missing.forEach(function (c, i) {
          ops.push({ type: "set", path: "courses/" + c.id, data: { code: c.code, title: c.title, summary: c.summary, days: c.days, hours: c.hours, learn: c.learn, tools: c.tools, capstone: c.capstone, submitHint: c.submitHint, order: syl.indexOf(c) + 1, published: true, createdAt: DB.now() } });
          c.lessons.forEach(function (l) {
            ops.push({ type: "set", path: "courses/" + c.id + "/lessons/d" + l.day, data: { day: l.day, title: l.title, notes: "", videoUrl: "", resourceUrl: "" } });
            ops.push({ type: "set", path: "courses/" + c.id + "/assignments/d" + l.day, data: { day: l.day, title: "Day " + l.day + " practice: " + l.title,
              instructions: "Practise today's topic (" + l.title + ") on your own.\nSave your work and share it as a Google Drive link.\nWhat to upload: " + c.submitHint + "." } });
          });
        });
        await DB.batchWrite(ops); toast("Syllabus loaded."); route();
      } catch (er) { fail(er); s.disabled = false; s.textContent = "Load syllabus"; }
    };
  });
}

async function courseEditor(cid) {
  var r = await Promise.all([DB.get("courses/" + cid), data.lessons(cid), data.assignments(cid)]);
  var c = r[0]; if (!c) throw new Error("Course not found.");
  var amap = {}; r[2].forEach(function (a) { amap[a.day] = a; });
  var admin = ME.role === "admin";
  var html = '<p><a class="btn line sm" href="#/courses">← Courses</a></p><div class="page-head" style="margin-top:14px"><div><p class="mono">' + esc(c.code) + " · " + esc(c.days) + " days · " + esc(c.hours) + " hrs</p><h1>" + esc(c.title) + "</h1><p>Open a day to add its video, notes, files and assignment. Students see changes at once.</p></div></div>" +
    '<form class="card" id="capf" style="margin-bottom:18px"><label class="lbl" for="capt">Industry capstone brief</label><textarea id="capt" rows="3"' + (admin ? "" : " disabled") + ">" + esc(c.capstone || "") + "</textarea>" + (admin ? '<button class="btn sm" type="submit" style="margin-top:10px">Save capstone</button>' : '<p class="small muted" style="margin-top:6px">Only the admin can change the capstone.</p>') + "</form>" +
    r[1].map(function (l) {
      var a = amap[l.day] || {};
      return '<details class="edit"><summary><span class="n">DAY ' + String(l.day).padStart(2, "0") + '</span><span class="t">' + esc(l.title) + "</span>" + (l.videoUrl ? chip("Video", "ok") : chip("No video", "warn")) + "</summary>" +
        '<div class="body"><form data-day="' + l.day + '"><div class="field"><label class="lbl">Lesson title</label><input name="title" value="' + esc(l.title) + '" required></div>' +
        '<div class="grid2"><div class="field"><label class="lbl">Video link (Google Drive or YouTube)</label><input name="videoUrl" type="text" inputmode="url" autocapitalize="off" spellcheck="false" value="' + esc(l.videoUrl || "") + '" placeholder="https://drive.google.com/file/d/..."></div>' +
        '<div class="field"><label class="lbl">Practice files (Drive file or folder)</label><input name="resourceUrl" type="text" inputmode="url" autocapitalize="off" spellcheck="false" value="' + esc(l.resourceUrl || "") + '"></div></div>' +
        '<div class="field"><label class="lbl">Notes for students</label><textarea name="notes" rows="3">' + esc(l.notes || "") + "</textarea></div>" +
        '<div class="field"><label class="lbl">Assignment title</label><input name="atitle" value="' + esc(a.title || "Day " + l.day + " practice") + '"></div>' +
        '<div class="field"><label class="lbl">Assignment instructions</label><textarea name="ainst" rows="3">' + esc(a.instructions || "") + "</textarea></div>" +
        '<button class="btn sm" type="submit">Save day ' + l.day + "</button></form></div></details>";
    }).join("");
  render(html, function () {
    if (admin) $("#capf").onsubmit = async function (e) { e.preventDefault(); try { await DB.update("courses/" + cid, { capstone: $("#capt").value.trim() }); toast("Capstone saved."); } catch (er) { fail(er); } };
    else $("#capf").onsubmit = function (e) { e.preventDefault(); };
    $$("form[data-day]").forEach(function (f) {
      f.onsubmit = async function (e) {
        e.preventDefault(); var d = +f.getAttribute("data-day"), g = function (n) { return f.querySelector("[name=" + n + "]").value.trim(); };
        var v = cleanUrl(g("videoUrl")), rs = cleanUrl(g("resourceUrl"));
        if ((v && !isUrl(v)) || (rs && !isUrl(rs))) return toast("One of the links doesn't look right.", true);
        try {
          await DB.batchWrite([
            { type: "set", merge: true, path: "courses/" + cid + "/lessons/d" + d, data: { day: d, title: g("title"), videoUrl: v || "", resourceUrl: rs || "", notes: g("notes") } },
            { type: "set", merge: true, path: "courses/" + cid + "/assignments/d" + d, data: { day: d, title: g("atitle"), instructions: g("ainst") } }
          ]);
          var sum = f.closest("details").querySelector("summary"); sum.querySelector(".t").textContent = g("title");
          var ch = sum.querySelector(".chip"); ch.textContent = v ? "Video" : "No video"; ch.className = "chip " + (v ? "ok" : "warn");
          toast("Day " + d + " saved.");
        } catch (er) { fail(er); }
      };
    });
  });
}

/* ---------- admin: people ---------- */
async function adminPeople(tab) {
  var users = await data.users();
  var groups = { students: users.filter(function (u) { return u.role === "student"; }), trainers: users.filter(function (u) { return u.role === "trainer" || u.role === "admin"; }) };
  var pend = users.filter(function (u) { return u.role === "trainer" && !u.isApproved; }).length;
  var list = (groups[tab] || groups.students).sort(function (a, b) { return (a.isApproved === false ? -1 : 0) - (b.isApproved === false ? -1 : 0) || String(a.name).localeCompare(b.name); });
  var signup = location.href.replace(/app\.html.*$/, "index.html");
  var html = '<div class="page-head"><div><h1>People</h1><p>Students and trainers create their own accounts here: <a class="hot" href="' + esc(signup) + '" target="_blank" rel="noopener">' + esc(signup) + "</a></p></div>" +
    '<button class="btn line sm" type="button" id="copyLink">Copy sign-up link</button></div>' +
    '<nav class="tabs"><a href="#/people/students" class="' + (tab !== "trainers" ? "on" : "") + '">Students (' + groups.students.length + ')</a><a href="#/people/trainers" class="' + (tab === "trainers" ? "on" : "") + '">Trainers & admins (' + groups.trainers.length + ")" + (pend ? " · " + pend + " waiting" : "") + "</a></nav>" +
    (list.length ? '<div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>WhatsApp</th><th>Role</th><th></th></tr></thead><tbody>' + list.map(function (u) {
      var act = u.role === "trainer" && !u.isApproved ? '<button class="btn sm" type="button" data-approve="' + esc(u.id) + '">Approve</button>' : "";
      if (u.id !== ME.uid && u.role !== "admin") act += ' <button class="btn danger sm" type="button" data-delu="' + esc(u.id) + '">Remove</button>';
      return "<tr><td><b>" + esc(u.name) + "</b></td><td>" + esc(u.email) + "</td><td>" + esc(u.phone || "–") + "</td><td>" + chip(u.role === "trainer" && !u.isApproved ? "trainer · waiting" : u.role, u.role === "admin" ? "hot" : u.isApproved === false ? "warn" : "") + '</td><td style="text-align:right;white-space:nowrap">' + act + "</td></tr>";
    }).join("") + "</tbody></table></div>" : '<div class="empty">Nobody here yet.</div>');
  render(html, function () {
    $("#copyLink").onclick = function () { navigator.clipboard.writeText(signup).then(function () { toast("Sign-up link copied."); }, function () { toast(signup); }); };
    $$("[data-approve]").forEach(function (b) { b.onclick = async function () { try { await DB.update("users/" + this.getAttribute("data-approve"), { isApproved: true }); toast("Trainer approved."); route(); } catch (er) { fail(er); } }; });
    $$("[data-delu]").forEach(function (b) { b.onclick = async function () {
      if (this.dataset.confirm !== "1") { this.dataset.confirm = "1"; this.textContent = "Tap to confirm"; return; }
      try { await DB.del("users/" + this.getAttribute("data-delu")); toast("Profile removed. Their login still exists in Firebase Authentication."); route(); } catch (er) { fail(er); }
    }; });
  });
}

/* ---------- admin: certificates ---------- */
async function adminCerts() {
  var certs = (await DB.list("certificates")).sort(function (a, b) { return String(b.id).localeCompare(String(a.id)); });
  var html = '<div class="page-head"><div><h1>Certificates</h1><p>Issue new certificates from a batch\'s Students tab. Each ID has a public verification page.</p></div></div>' +
    '<details class="edit" style="margin-bottom:18px"><summary><span class="t">Add a certificate issued before the LMS (e.g. NLC-2026-2051)</span></summary><div class="body"><form id="oldc"><div class="grid3">' +
    '<div class="field"><label class="lbl">Certificate ID</label><input name="id" required placeholder="NLC-2026-2051"></div>' +
    '<div class="field"><label class="lbl">Student name</label><input name="name" required></div>' +
    '<div class="field"><label class="lbl">Course</label><input name="course" required placeholder="SolidWorks Professional"></div>' +
    '<div class="field"><label class="lbl">Training from</label><input name="from" type="date"></div>' +
    '<div class="field"><label class="lbl">Training to</label><input name="to" type="date"></div>' +
    '<div class="field"><label class="lbl">Issued on</label><input name="on" type="date" value="' + today() + '"></div>' +
    '<div class="field"><label class="lbl">Final test score %</label><input name="score" type="number" min="0" max="100"></div></div><button class="btn sm" type="submit">Add certificate</button></form></div></details>' +
    (certs.length ? '<div class="table-wrap"><table><thead><tr><th>ID</th><th>Student</th><th>Course</th><th>Issued</th><th>Status</th><th></th></tr></thead><tbody>' + certs.map(function (x) {
      return '<tr><td><a class="hot" href="' + esc(verifyUrl(x.id)) + '" target="_blank" rel="noopener" style="font-family:var(--mono)">' + esc(x.id) + "</a></td><td>" + esc(x.studentName) + "</td><td>" + esc(x.courseTitle) + "</td><td>" + fmtDate(x.issuedOn || x.issuedAt) + "</td><td>" + (x.status === "revoked" ? chip("Revoked", "bad") : chip("Valid", "ok")) +
        '</td><td style="text-align:right"><button class="btn line sm" type="button" data-rev="' + esc(x.id) + '" data-st="' + esc(x.status) + '">' + (x.status === "revoked" ? "Restore" : "Revoke") + "</button></td></tr>";
    }).join("") + "</tbody></table></div>" : '<div class="empty">No certificates yet.</div>');
  render(html, function () {
    $("#oldc").onsubmit = async function (e) {
      e.preventDefault(); var f = this, g = function (n) { return f.querySelector("[name=" + n + "]").value.trim(); }, id = g("id").toUpperCase();
      if (!/^[A-Z0-9-]{4,40}$/.test(id)) return toast("Use letters, numbers and dashes only, like NLC-2026-2051.", true);
      try {
        if (await DB.get("certificates/" + id)) return toast(id + " already exists.", true);
        await DB.set("certificates/" + id, { certId: id, studentId: "", studentName: g("name"), courseTitle: g("course"), trainingFrom: g("from"), trainingTo: g("to"), issuedOn: g("on"), score: g("score"), status: "valid", issuedAt: DB.now(), issuedBy: ME.name || ME.email, imported: true });
        toast(id + " added."); route();
      } catch (er) { fail(er); }
    };
    $$("[data-rev]").forEach(function (b) { b.onclick = async function () {
      var id = this.getAttribute("data-rev"), st = this.getAttribute("data-st") === "revoked" ? "valid" : "revoked";
      try { await DB.update("certificates/" + id, { status: st }); toast(id + (st === "revoked" ? " revoked." : " restored.")); route(); } catch (er) { fail(er); }
    }; });
  });
}
})();

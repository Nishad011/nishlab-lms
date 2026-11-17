/* NISHLAB LMS: file upload / download (Google Drive via Apps Script), ZIP builder and 3D viewer */
(function () {
"use strict";
var MAX = 20 * 1024 * 1024;
var OK_EXT = ["stp", "step", "igs", "iges", "pdf", "png", "jpg", "jpeg", "zip", "7z", "rar", "wbpz", "dwg", "dxf", "sldprt", "sldasm", "slddrw", "txt"];
function url() { return window.LMS_FILES_URL || ""; }
function enabled() { return !!url(); }
function ext(n) { return String(n || "").split(".").pop().toLowerCase(); }
function human(b) { b = +b || 0; return b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB"; }

async function call(body) {
  var r = await fetch(url(), { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(body) });
  var j; try { j = await r.json(); } catch (e) { throw new Error("The file service did not answer. Try again."); }
  if (!j.ok) throw new Error(j.error || "The file service reported an error.");
  return j;
}
function readB64(file) {
  return new Promise(function (res, rej) {
    var fr = new FileReader();
    fr.onload = function () { res(String(fr.result).split(",")[1] || ""); };
    fr.onerror = function () { rej(new Error("Could not read that file.")); };
    fr.readAsDataURL(file);
  });
}
function check(file) {
  if (!file) return "Choose a file first.";
  if (OK_EXT.indexOf(ext(file.name)) < 0) return "That file type is not allowed. Use STEP, IGES, PDF, PNG/JPG, ZIP or a SolidWorks/ANSYS file.";
  if (file.size > MAX) return "That file is " + human(file.size) + ". The limit is 20 MB; put big files in a ZIP or share a Drive link.";
  return "";
}
async function upload(file, getToken, scope) {
  var bad = check(file); if (bad) throw new Error(bad);
  var token = await getToken();
  var data = await readB64(file);
  var j = await call({ action: "upload", token: token, scope: scope || "", name: file.name, mime: file.type || "application/octet-stream", data: data });
  return { fileId: j.fileId, fileName: file.name, fileSize: file.size };
}
function b64Blob(b64, mime) {
  var bin = atob(b64), n = bin.length, out = new Uint8Array(n);
  for (var i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
  return new Blob([out], { type: mime || "application/octet-stream" });
}
// docPath: the Firestore document that points at this file (access is decided by its security rules)
async function download(fileId, docPath, getToken) {
  var token = getToken ? await getToken() : "";
  var j = await call({ action: "download", token: token, fileId: fileId, docPath: docPath });
  return { blob: b64Blob(j.data, j.mime), name: j.name };
}
function saveBlob(blob, name) {
  var a = document.createElement("a"), u = URL.createObjectURL(blob);
  a.href = u; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(function () { a.remove(); URL.revokeObjectURL(u); }, 4000);
}

/* ---------- minimal ZIP (store only) ---------- */
var CRC = (function () { var t = [], c, n, k; for (n = 0; n < 256; n++) { c = n; for (k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { var c = 0xFFFFFFFF; for (var i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
async function zip(files) { // files: [{name, blob}]
  var parts = [], central = [], off = 0, enc = new TextEncoder(), used = {};
  for (var i = 0; i < files.length; i++) {
    var nm = files[i].name.replace(/[\\/:*?"<>|]+/g, "_"); if (used[nm]) nm = (++used[nm]) + "_" + nm; else used[nm] = 1;
    var u8 = new Uint8Array(await files[i].blob.arrayBuffer()), name = enc.encode(nm), crc = crc32(u8);
    var lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true); lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, u8.length, true); lh.setUint32(22, u8.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name, u8);
    var ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(12, 0, true); ch.setUint16(14, 0x21, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, u8.length, true); ch.setUint32(24, u8.length, true); ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
    central.push(ch.buffer, name);
    off += 30 + name.length + u8.length;
  }
  var csize = 0; central.forEach(function (c) { csize += c.byteLength || c.length; });
  var end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, csize, true); end.setUint32(16, off, true);
  return new Blob(parts.concat(central, [end.buffer]), { type: "application/zip" });
}

/* ---------- 3D viewer (STEP / IGES) ---------- */
var THREE_SRC = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js";
var OCCT_BASE = "https://cdn.jsdelivr.net/npm/occt-import-js@0.0.23/dist/";
var libs = null;
function loadScript(src) { return new Promise(function (res, rej) { var s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = function () { rej(new Error("Could not load the 3D engine. Check your internet.")); }; document.head.appendChild(s); }); }
function loadLibs() {
  if (!libs) libs = (window.THREE ? Promise.resolve() : loadScript(THREE_SRC)).then(function () { return window.occtimportjs ? 0 : loadScript(OCCT_BASE + "occt-import-js.js"); })
    .then(function () { return window.occtimportjs({ locateFile: function (f) { return OCCT_BASE + f; } }); });
  return libs;
}
function creaseGeo(pos, ix, span, deg) {
  var nf = ix.length / 3, cs = Math.cos(deg * Math.PI / 180), q = 1 / (span * 1e-5), fn = new Float32Array(nf * 3), map = new Map(), vk = new Array(nf * 3), f, c, i;
  function key(v) { return Math.round(pos[v * 3] * q) + "," + Math.round(pos[v * 3 + 1] * q) + "," + Math.round(pos[v * 3 + 2] * q); }
  for (f = 0; f < nf; f++) {
    var a = ix[f * 3], b = ix[f * 3 + 1], d = ix[f * 3 + 2];
    var ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2], vx = pos[d * 3] - pos[a * 3], vy = pos[d * 3 + 1] - pos[a * 3 + 1], vz = pos[d * 3 + 2] - pos[a * 3 + 2];
    fn[f * 3] = uy * vz - uz * vy; fn[f * 3 + 1] = uz * vx - ux * vz; fn[f * 3 + 2] = ux * vy - uy * vx;
    for (c = 0; c < 3; c++) { var k = key(ix[f * 3 + c]); var L = map.get(k); if (!L) { L = []; map.set(k, L); } L.push(f); vk[f * 3 + c] = k; }
  }
  var P = new Float32Array(nf * 9), N = new Float32Array(nf * 9);
  for (f = 0; f < nf; f++) {
    var fx = fn[f * 3], fy = fn[f * 3 + 1], fz = fn[f * 3 + 2], fl = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
    for (c = 0; c < 3; c++) {
      var v = ix[f * 3 + c], o = f * 9 + c * 3; P[o] = pos[v * 3]; P[o + 1] = pos[v * 3 + 1]; P[o + 2] = pos[v * 3 + 2];
      var L2 = map.get(vk[f * 3 + c]), nx = 0, ny = 0, nz = 0;
      for (i = 0; i < L2.length; i++) { var h = L2[i], hx = fn[h * 3], hy = fn[h * 3 + 1], hz = fn[h * 3 + 2], hl = Math.sqrt(hx * hx + hy * hy + hz * hz) || 1; if ((fx * hx + fy * hy + fz * hz) / (fl * hl) > cs) { nx += hx; ny += hy; nz += hz; } }
      var nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1; N[o] = nx / nl; N[o + 1] = ny / nl; N[o + 2] = nz / nl;
    }
  }
  var g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(P, 3)); g.setAttribute("normal", new THREE.BufferAttribute(N, 3)); return g;
}
var PAL = [0x7f93a8, 0xff6a1a, 0xd9dee4, 0x3b4550, 0x5d7a96, 0xb8c4d0, 0x2b3540];

// Opens a full-screen 3D viewer. getBuf() resolves with {buf, name}.
function view3d(title, getBuf) {
  var m = document.createElement("div"); m.className = "v3";
  m.innerHTML = '<div class="v3-bar"><b></b><span class="v3-msg">Loading…</span><button type="button" class="btn line sm" data-w>Wireframe</button><button type="button" class="btn line sm" data-x>Close</button></div><div class="v3-stage"></div>';
  m.querySelector("b").textContent = title; document.body.appendChild(m);
  var msg = m.querySelector(".v3-msg"), stage = m.querySelector(".v3-stage"), stop = false;
  m.querySelector("[data-x]").onclick = function () { stop = true; m.remove(); };
  function say(t) { msg.textContent = t; }
  (async function () {
    try {
      say("Downloading…"); var f = await getBuf(); if (stop) return;
      say("Starting 3D engine…"); var oc = await loadLibs(); if (stop) return;
      say("Building model…"); await new Promise(function (r) { setTimeout(r, 30); });
      var e = ext(f.name), opt = { linearUnit: "millimeter", linearDeflectionType: "bounding_box_ratio", linearDeflection: .002, angularDeflection: .4 }, u8 = new Uint8Array(f.buf);
      var r = (e === "igs" || e === "iges") ? oc.ReadIgesFile(u8, opt) : oc.ReadStepFile(u8, opt);
      if (!r || !r.success || !r.meshes.length) throw new Error("This file could not be read as a 3D model.");
      say("Drag to rotate · scroll to zoom");
      var canvas = document.createElement("canvas"); stage.appendChild(canvas);
      var R = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true }); R.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      var scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(32, 1, .01, 1e5);
      scene.add(new THREE.AmbientLight(0xffffff, .6)); var d1 = new THREE.DirectionalLight(0xffffff, .9); d1.position.set(1, 1.4, 1.8); scene.add(d1);
      var grp = new THREE.Group(), bb = new THREE.Box3(), meshes = [], lines = [], tris = 0;
      r.meshes.forEach(function (mm) { tris += mm.index.array.length / 3; });
      r.meshes.forEach(function (mm) { var p = mm.attributes.position.array; for (var i = 0; i < p.length; i += 3) bb.expandByPoint(new THREE.Vector3(p[i], p[i + 1], p[i + 2])); });
      var span = bb.getSize(new THREE.Vector3()).length() || 1, ctr = bb.getCenter(new THREE.Vector3());
      r.meshes.forEach(function (mm, k) {
        var pos = mm.attributes.position.array, ix = mm.index.array, g;
        if (tris < 250000) g = creaseGeo(pos, ix, span, 35); else { g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(pos, 3)); g.setIndex(new THREE.BufferAttribute(ix, 1)); g.computeVertexNormals(); }
        var col = mm.color ? new THREE.Color(mm.color[0], mm.color[1], mm.color[2]) : new THREE.Color(PAL[k % PAL.length]);
        var me = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: col, metalness: .4, roughness: .45, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })); grp.add(me); meshes.push(me);
        var el = new THREE.LineSegments(new THREE.EdgesGeometry(g, tris < 250000 ? 30 : 45), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: .28 })); grp.add(el); lines.push(el);
        var wl = new THREE.LineSegments(new THREE.EdgesGeometry(g, 6), new THREE.LineBasicMaterial({ color: 0xcfe0f2, transparent: true, opacity: .6, depthWrite: false })); wl.visible = false; grp.add(wl); me.userData.wire = wl;
      });
      grp.position.set(-ctr.x, -ctr.y, -ctr.z);
      var holder = new THREE.Group(); holder.add(grp); scene.add(holder); holder.scale.setScalar(2.7 / span);
      var dist = 4.6, rx = .5, ry = -.6, auto = true, drag = null, wire = false;
      function size() { var w = stage.clientWidth, h = stage.clientHeight; R.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); }
      size(); window.addEventListener("resize", size);
      canvas.addEventListener("pointerdown", function (ev) { drag = { x: ev.clientX, y: ev.clientY }; auto = false; canvas.setPointerCapture(ev.pointerId); });
      canvas.addEventListener("pointermove", function (ev) { if (!drag) return; ry += (ev.clientX - drag.x) * .008; rx += (ev.clientY - drag.y) * .008; rx = Math.max(-1.5, Math.min(1.5, rx)); drag.x = ev.clientX; drag.y = ev.clientY; });
      canvas.addEventListener("pointerup", function () { drag = null; });
      canvas.addEventListener("wheel", function (ev) { ev.preventDefault(); dist = Math.max(1.6, Math.min(12, dist * (ev.deltaY > 0 ? 1.08 : .92))); }, { passive: false });
      m.querySelector("[data-w]").onclick = function () { wire = !wire; meshes.forEach(function (x) { x.visible = !wire; x.userData.wire.visible = wire; }); lines.forEach(function (l) { l.visible = !wire; }); };
      (function loop() { if (stop || !document.body.contains(m)) { window.removeEventListener("resize", size); R.dispose(); return; } requestAnimationFrame(loop); if (auto) ry += .004; holder.rotation.set(rx, ry, 0); cam.position.set(0, 0, dist); cam.lookAt(0, 0, 0); R.render(scene, cam); })();
    } catch (er) { say(er.message || "Could not open the model."); }
  })();
}

window.NLFILES = { api: call, enabled: enabled, check: check, upload: upload, download: download, saveBlob: saveBlob, zip: zip, view3d: view3d, human: human, ext: ext, MAX: MAX };
})();

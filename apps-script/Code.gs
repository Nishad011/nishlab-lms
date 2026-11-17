/* NISHLAB LMS file service (Google Apps Script web app)
   - upload: stores a student's file in the owner's Drive (private folder per user)
   - download: returns a file only if Firestore security rules let the caller read the document that points to it
   - mailRecording: emails a new class recording to the batch's students (admin or batch trainer only)
   Deploy: Execute as Me, access Anyone. */
var PROJECT = 'nishlab-lms';
var API_KEY = 'AIzaSyANtAy5s9-IfcUzg1YnZZ4-xVtfpwpXCHw'; // Firebase web key (public by design)
var ROOT_NAME = 'NISHLAB LMS Uploads';
var MAX_BYTES = 20 * 1024 * 1024;
var EXT = ['stp','step','igs','iges','pdf','png','jpg','jpeg','zip','7z','rar','wbpz','dwg','dxf','sldprt','sldasm','slddrw','txt'];
var LMS_URL = 'https://lms.nishlabcreations.online/app.html';

function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function doGet() { return out_({ ok: true, service: 'NISHLAB LMS files' }); }
function doPost(e) {
  try {
    var d = JSON.parse(e.postData.contents);
    if (d.action === 'upload') return out_(upload_(d));
    if (d.action === 'download') return out_(download_(d));
    if (d.action === 'mailRecording') return out_(mail_(d));
    return out_({ ok: false, error: 'Unknown request.' });
  } catch (err) { return out_({ ok: false, error: String(err && err.message || err) }); }
}

function who_(token) {
  if (!token) return null;
  var r = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + API_KEY, { method: 'post', contentType: 'application/json', payload: JSON.stringify({ idToken: token }), muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) return null;
  var u = JSON.parse(r.getContentText()).users;
  return u && u[0] ? { uid: u[0].localId, email: u[0].email } : null;
}
// Reads a Firestore document as the caller, so the security rules decide what they may see.
function fsGet_(path, token) {
  var h = {}; if (token) h.Authorization = 'Bearer ' + token;
  var r = UrlFetchApp.fetch('https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents/' + path, { headers: h, muteHttpExceptions: true });
  return r.getResponseCode() === 200 ? JSON.parse(r.getContentText()) : null;
}
function val_(f) {
  if (!f) return '';
  if ('stringValue' in f) return f.stringValue;
  if ('booleanValue' in f) return f.booleanValue;
  if ('integerValue' in f) return Number(f.integerValue);
  if ('arrayValue' in f) return (f.arrayValue.values || []).map(val_);
  if ('mapValue' in f) { var o = {}, m = f.mapValue.fields || {}; for (var k in m) o[k] = val_(m[k]); return o; }
  return '';
}
function folderFor_(uid) {
  var p = PropertiesService.getScriptProperties(), rid = p.getProperty('ROOT'), root;
  try { root = rid ? DriveApp.getFolderById(rid) : null; } catch (e) { root = null; }
  if (!root) { var it = DriveApp.getFoldersByName(ROOT_NAME); root = it.hasNext() ? it.next() : DriveApp.createFolder(ROOT_NAME); p.setProperty('ROOT', root.getId()); }
  var sub = root.getFoldersByName(uid);
  return sub.hasNext() ? sub.next() : root.createFolder(uid);
}

function upload_(d) {
  var u = who_(d.token); if (!u) throw new Error('Please sign in again.');
  var name = String(d.name || 'file').replace(/[\\\/:*?"<>|]+/g, '_').slice(0, 120);
  var ext = name.split('.').pop().toLowerCase();
  if (EXT.indexOf(ext) < 0) throw new Error('That file type is not allowed.');
  var bytes = Utilities.base64Decode(d.data || '');
  if (!bytes.length) throw new Error('The file is empty.');
  if (bytes.length > MAX_BYTES) throw new Error('The file is larger than 20 MB.');
  var f = folderFor_(u.uid).createFile(Utilities.newBlob(bytes, d.mime || 'application/octet-stream', name));
  f.setDescription(u.uid);
  return { ok: true, fileId: f.getId() };
}

function download_(d) {
  var path = String(d.docPath || '');
  if (!/^(submissions|portfolio)\/[A-Za-z0-9_\-]+$/.test(path)) throw new Error('Bad request.');
  var doc = fsGet_(path, d.token || '');
  if (!doc || !doc.fields) throw new Error('You do not have access to this file.');
  var fid = val_(doc.fields.fileId);
  if (!fid || fid !== d.fileId) throw new Error('This file is not attached to that record.');
  var f = DriveApp.getFileById(fid);
  if (f.getDescription() !== val_(doc.fields.studentId)) throw new Error('This file does not belong to that student.');
  if (f.getSize() > MAX_BYTES) throw new Error('File too large.');
  var b = f.getBlob();
  return { ok: true, name: f.getName(), mime: b.getContentType(), data: Utilities.base64Encode(b.getBytes()) };
}

function esc_(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function mail_(d) {
  var u = who_(d.token); if (!u) throw new Error('Please sign in again.');
  var bid = String(d.batchId || ''); if (!/^[A-Za-z0-9_\-]+$/.test(bid)) throw new Error('Bad request.');
  var batch = fsGet_('batches/' + bid, d.token); if (!batch) throw new Error('Batch not found.');
  var fl = batch.fields || {}, allowed = val_(fl.trainerId) === u.uid;
  if (!allowed) { var me = fsGet_('users/' + u.uid, d.token); allowed = !!(me && me.fields && val_(me.fields.role) === 'admin'); }
  if (!allowed) throw new Error('Only the batch trainer or admin can email students.');
  var url = String(d.url || ''); if (!/^https:\/\/\S+$/.test(url)) throw new Error('Bad link.');
  var topic = String(d.topic || 'Class recording').slice(0, 140), date = String(d.date || '');
  var course = val_(fl.courseTitle) || 'your course', students = val_(fl.students) || [], sent = 0, seen = {};
  students.forEach(function (s) {
    var em = s && s.email; if (!em || seen[em] || !/^\S+@\S+$/.test(em)) return; seen[em] = 1;
    var first = String(s.name || '').split(' ')[0] || 'there';
    MailApp.sendEmail({
      to: em, name: 'NISHLAB CREATIONS', replyTo: 'nishad@nishlabcreations.com',
      subject: 'New class recording: ' + topic,
      htmlBody: '<div style="font-family:Arial,sans-serif;font-size:15px;color:#1d1e42;max-width:520px">' +
        '<p>Hi ' + esc_(first) + ',</p><p>The recording of your <b>' + esc_(course) + '</b> class is ready' + (date ? ' (' + esc_(date) + ')' : '') + ':</p>' +
        '<p style="font-size:17px"><b>' + esc_(topic) + '</b></p>' +
        '<p><a href="' + esc_(url) + '" style="background:#7f4ce6;color:#fff;padding:10px 20px;border-radius:999px;text-decoration:none;display:inline-block">Watch recording</a></p>' +
        '<p style="color:#555">You can also find every recording in the LMS: <a href="' + LMS_URL + '#/b/' + esc_(bid) + '/rec">Class recordings</a>.</p>' +
        '<p>Keep practising,<br>NISHLAB CREATIONS</p></div>'
    });
    sent++;
  });
  return { ok: true, sent: sent };
}

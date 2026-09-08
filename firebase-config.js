// ============================================================
// STEP 1: Go to https://console.firebase.google.com
// Create a project -> Add a Web App -> copy the config below
// Enable: Authentication (Email/Password) and Firestore Database
// ============================================================
const firebaseConfig = {
  apiKey: "AIzaSyANtAy5s9-IfcUzg1YnZZ4-xVtfpwpXCHw",
  authDomain: "nishlab-lms.firebaseapp.com",
  projectId: "nishlab-lms",
  storageBucket: "nishlab-lms.firebasestorage.app",
  messagingSenderId: "736583316168",
  appId: "1:736583316168:web:a3ed7df97e51ae0122ebfd",
  measurementId: "G-214K2GDS8T"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// ------- Shared helper: require login + specific role -------
function requireRole(allowedRoles, onReady) {
  auth.onAuthStateChanged(async (user) => {
    if (!user) { window.location.href = "login.html"; return; }
    const doc = await db.collection("users").doc(user.uid).get();
    if (!doc.exists) { window.location.href = "login.html"; return; }
    const data = doc.data();
    if (!allowedRoles.includes(data.role)) {
      alert("Aapko is page ki permission nahi hai.");
      redirectToDashboard(data.role);
      return;
    }
    onReady(user, data);
  });
}

function redirectToDashboard(role) {
  if (role === "admin") window.location.href = "admin-dashboard.html";
  else if (role === "trainer") window.location.href = "trainer-dashboard.html";
  else window.location.href = "student-dashboard.html";
}

function logout() {
  auth.signOut().then(() => window.location.href = "login.html");
}

// ------- Shared helper: get studentIds enrolled in a course -------
async function getEnrolledStudentIds(courseId) {
  const snap = await db.collection("enrollments").where("courseId", "==", courseId).get();
  return snap.docs.map(d => d.data().studentId);
}

// ------- Shared helper: send an in-app notification to a list of students -------
// notif = { courseId, type, title, message, link }
async function notifyStudents(studentIds, notif) {
  if (!studentIds || !studentIds.length) return;
  const batch = db.batch();
  studentIds.forEach(uid => {
    const ref = db.collection("notifications").doc();
    batch.set(ref, {
      userId: uid,
      courseId: notif.courseId || null,
      type: notif.type || "info",
      title: notif.title || "",
      message: notif.message || "",
      link: notif.link || null,
      read: false,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  });
  await batch.commit();
}

// ------- Shared helper: notification bell (call after requireRole on student pages) -------
function initNotificationBell(currentUser) {
  const bell = document.getElementById("notifBell");
  if (!bell) return;
  bell.classList.remove("hidden");
  db.collection("notifications").where("userId", "==", currentUser.uid)
    .onSnapshot(snap => {
      const items = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
      const unread = items.filter(n => !n.read).length;
      const badge = document.getElementById("notifBadge");
      if (badge) {
        badge.textContent = unread;
        badge.classList.toggle("hidden", unread === 0);
      }
      const list = document.getElementById("notifList");
      if (list) {
        list.innerHTML = items.length ? items.map(n => `
          <div class="notif-item ${n.read ? '' : 'notif-unread'}" onclick="openNotif('${n.id}', ${n.link ? `'${n.link}'` : 'null'})">
            <strong>${n.title}</strong>
            <p class="muted" style="margin:4px 0 0;">${n.message}</p>
          </div>
        `).join("") : '<p class="muted" style="padding:14px;">No notifications yet.</p>';
      }
    });
}
function toggleNotifPanel() {
  document.getElementById("notifPanel").classList.toggle("hidden");
}
async function openNotif(notifId, link) {
  await db.collection("notifications").doc(notifId).update({ read: true });
  if (link) window.location.href = link;
}

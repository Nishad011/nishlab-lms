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

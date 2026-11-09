// ============================================================
// NISHLAB LMS v2 — Firebase connection (project: nishlab-lms)
// Same project as v1, so existing logins keep working.
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

// Small data layer so the app never talks to Firebase directly.
// (Makes the app easy to test and to move to another backend later.)
(function () {
  if (window.LMS_BACKEND) return; // a test backend was injected
  firebase.initializeApp(firebaseConfig);
  const auth = firebase.auth();
  const db = firebase.firestore();
  const FV = firebase.firestore.FieldValue;

  function ref(path) {
    const parts = path.split("/");
    return parts.length % 2 === 0 ? db.doc(path) : db.collection(path);
  }
  const snapDoc = (d) => (d.exists ? Object.assign({ id: d.id }, d.data()) : null);

  window.LMS_BACKEND = {
    auth: {
      onChange: (cb) => auth.onAuthStateChanged((u) => cb(u ? { uid: u.uid, email: u.email } : null)),
      signIn: (email, pw) => auth.signInWithEmailAndPassword(email, pw).then((c) => ({ uid: c.user.uid, email: c.user.email })),
      signUp: (email, pw) => auth.createUserWithEmailAndPassword(email, pw).then((c) => ({ uid: c.user.uid, email: c.user.email })),
      reset: (email) => auth.sendPasswordResetEmail(email),
      signOut: () => auth.signOut()
    },
    db: {
      get: async (path) => snapDoc(await db.doc(path).get()),
      // filters: [[field, op, value], ...]
      list: async (path, filters) => {
        let q = db.collection(path);
        (filters || []).forEach((f) => { q = q.where(f[0], f[1], f[2]); });
        const s = await q.get();
        return s.docs.map((d) => Object.assign({ id: d.id }, d.data()));
      },
      set: (path, data, merge) => db.doc(path).set(data, merge ? { merge: true } : {}),
      update: (path, data) => db.doc(path).update(data),
      add: async (path, data) => (await db.collection(path).add(data)).id,
      del: (path) => db.doc(path).delete(),
      now: () => FV.serverTimestamp(),
      arrayUnion: (v) => FV.arrayUnion(v),
      arrayRemove: (v) => FV.arrayRemove(v),
      // write many docs at once: ops = [{type:'set'|'update'|'delete', path, data, merge}]
      batchWrite: async (ops) => {
        for (let i = 0; i < ops.length; i += 400) {
          const b = db.batch();
          ops.slice(i, i + 400).forEach((o) => {
            if (o.type === "delete") b.delete(db.doc(o.path));
            else if (o.type === "update") b.update(db.doc(o.path), o.data);
            else b.set(db.doc(o.path), o.data, o.merge ? { merge: true } : {});
          });
          await b.commit();
        }
      },
      // atomically take the next certificate number
      nextCounter: (name, start) => db.runTransaction(async (t) => {
        const r = db.doc("counters/" + name);
        const s = await t.get(r);
        const n = s.exists ? s.data().next : start;
        t.set(r, { next: n + 1 });
        return n;
      })
    }
  };
})();

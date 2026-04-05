import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, serverTimestamp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

export const firebaseConfig = {
  apiKey: "AIzaSyDPNmHSjioHB6k1vGS2g05SIHQ30Vw54aM",
  authDomain: "rigsync-38f79.firebaseapp.com",
  projectId: "rigsync-38f79",
  storageBucket: "rigsync-38f79.firebasestorage.app",
  messagingSenderId: "770902977179",
  appId: "1:770902977179:web:02283e644faae6cf22343e",
};

export const firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const firebaseAuth = getAuth(firebaseApp);
export const firebaseDb = getFirestore(firebaseApp);
export const firebaseServerTimestamp = serverTimestamp;

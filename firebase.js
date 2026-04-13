import { initializeApp } from "firebase/app";
import { getFirestore, collection, addDoc } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDYnezOndO4OUXdFdumwSobgOBf8n6fLdM",
  authDomain: "anomaly-intelligence.firebaseapp.com",
  projectId: "anomaly-intelligence",
  storageBucket: "anomaly-intelligence.firebasestorage.app",
  messagingSenderId: "341282991733",
  appId: "1:341282991733:web:eb2c2d7649c4ba2c61923c",
  measurementId: "G-V97R44ZV3V"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// 💾 Save anomaly report to Firestore
export async function saveReport(data) {
  try {
    await addDoc(collection(db, "daily_reports"), data);
    console.log("Saved to Firebase");
  } catch (err) {
    console.error("Firebase save error:", err);
  }
}

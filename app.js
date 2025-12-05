// ========================
//  INIT FIREBASE
// ========================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { 
    getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged 
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { 
    getFirestore, collection, doc, setDoc, getDocs, query, orderBy 
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyBjmg3ZQqSOWS0X8MRZ97EoRYDrPCiRzj8",
  authDomain: "dnmstasker-3b85f.firebaseapp.com",
  projectId: "dnmstasker-3b85f",
  storageBucket: "dnmstasker-3b85f.firebasestorage.app",
  messagingSenderId: "1053072513804",
  appId: "1:1053072513804:web:27b52ec9b9a23035b2c729"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth();
const db = getFirestore(app);

// DOM
const loginSection = document.getElementById("login-section");
const appSection = document.getElementById("app-section");

const taskOutput = document.getElementById("taskOutput");

// ========================
//  LOGIN GOOGLE
// ========================
document.getElementById("btnGoogleLogin").addEventListener("click", async () => {
    const provider = new GoogleAuthProvider();
    await signInWithPopup(auth, provider);
});

onAuthStateChanged(auth, user => {
    if (user) {
        loginSection.style.display = "none";
        appSection.style.display = "block";
        loadTasks();
    } else {
        loginSection.style.display = "block";
        appSection.style.display = "none";
    }
});

// ========================
//  AUTO INCREMENT TASK ID
// ========================
async function getNextTaskId(uid) {
    const q = query(collection(db, `users/${uid}/tasks`), orderBy("taskId", "desc"));
    const snapshot = await getDocs(q);
    if (snapshot.empty) return 1;

    const maxId = snapshot.docs[0].data().taskId;
    return maxId + 1;
}

// ========================
//  SAVE MAIN TASK
// ========================
document.getElementById("mainTaskForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const user = auth.currentUser;
    if (!user) return;

    const taskId = await getNextTaskId(user.uid);

    const data = {
        taskId, 
        type: "main",
        title: document.getElementById("main-title").value,
        estimateMinutes: parseInt(document.getElementById("main-estimate").value),
        deadline: document.getElementById("main-deadline").value,
        isParallel: document.getElementById("main-isParallel").checked,
        priority: document.getElementById("main-priority").value,
        createdAt: Date.now()
    };

    await setDoc(doc(db, `users/${user.uid}/tasks`, `${taskId}`), data);

    alert("Main Task đã được tạo!");
    loadTasks();
});

// ========================
//  SAVE BACKGROUND TASK
// ========================
document.getElementById("bgTaskForm").addEventListener("submit", async (e) => {
    e.preventDefault();

    const user = auth.currentUser;
    if (!user) return;

    const taskId = await getNextTaskId(user.uid);

    const repeatType = document.getElementById("bg-repeatType").value;
    let repeatConfig = {};

    if (repeatType === "weekly") {
        const raw = document.getElementById("bg-weekDays").value;
        repeatConfig.daysOfWeek = raw.split(",").map(x => parseInt(x.trim()));
    }

    const data = {
        taskId,
        type: "background",
        title: document.getElementById("bg-title").value,
        startTime: document.getElementById("bg-start").value,
        endTime: document.getElementById("bg-end").value,
        isParallel: document.getElementById("bg-isParallel").checked,
        repeatType,
        repeatConfig,
        createdAt: Date.now()
    };

    await setDoc(doc(db, `users/${user.uid}/tasks`, `${taskId}`), data);

    alert("Background Task đã được tạo!");
    loadTasks();
});

// ========================
//  LOAD ALL TASKS FOR DEBUG
// ========================
async function loadTasks() {
    const user = auth.currentUser;
    if (!user) return;

    const q = query(collection(db, `users/${user.uid}/tasks`), orderBy("taskId", "asc"));
    const snapshot = await getDocs(q);

    let output = [];
    snapshot.forEach(doc => output.push(doc.data()));

    taskOutput.textContent = JSON.stringify(output, null, 2);
}

// ========================
//  SHOW WEEKLY CONFIG FIELD
// ========================
document.getElementById("bg-repeatType").addEventListener("change", (e) => {
    const v = e.target.value;
    document.getElementById("weekly-config").style.display = (v === "weekly") ? "block" : "none";
});

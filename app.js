/* ==========================================================
   ===============   FIREBASE INIT   =========================
   ========================================================== */

import {
    initializeApp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";

import {
    getAuth,
    GoogleAuthProvider,
    signInWithPopup,
    onAuthStateChanged,
    signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
    getFirestore,
    collection,
    addDoc,
    doc,
    getDoc,
    getDocs,
    setDoc,
    updateDoc,
    deleteDoc,
    query,
    where,
    orderBy
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

/* --- CONFIG --- */
const firebaseConfig = {
    apiKey: "AIzaSyBw6vBtXo6RRu_VfRQNW64sbgSlyWjwhOU",
    authDomain: "dnmtaskmanager.firebaseapp.com",
    projectId: "dnmtaskmanager",
    storageBucket: "dnmtaskmanager.appspot.com",
    messagingSenderId: "606685816362",
    appId: "1:606685816362:web:bf4e80d51323c079c70553"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

const db = getFirestore(app);
let tasksCol;
let settingsDocRef;

/* ==========================================================
   ===============   STATE & HELPERS   ========================
   ========================================================== */

let state = {
    user: null,
    tasks: [],
    settings: {
        quickBoost: 200,
        timeMatchMultiplier: 1.5,
        deadlinePenaltyFactor: 0.8,
        estimatedWeight: 0.3,
        hideDone: false
    }
};

let editingTaskId = null;

/* ==========================================================
   ===============   AUTH UI  =================================
   ========================================================== */

const loginBtn = document.getElementById("loginBtn");
const logoutBtn = document.getElementById("logoutBtn");
const userInfo = document.getElementById("userInfo");
const userName = document.getElementById("userName");
const loginArea = document.getElementById("loginArea");
const appContent = document.getElementById("appContent");
const notLoggedInMessage = document.getElementById("notLoggedInMessage");

loginBtn.onclick = () => {
    signInWithPopup(auth, provider).catch(err => {
        alert("Lỗi đăng nhập: " + err.message);
    });
};

logoutBtn.onclick = () => signOut(auth);

onAuthStateChanged(auth, async user => {
    if (user) {
        state.user = user;
        userName.innerText = user.displayName;
        loginArea.classList.add("hidden");
        userInfo.classList.remove("hidden");
        notLoggedInMessage.classList.add("hidden");
        appContent.classList.remove("hidden");

        tasksCol = collection(db, `users/${user.uid}/tasks`);
        settingsDocRef = doc(db, `users/${user.uid}/settings/default`);

        await loadSettings();
        await loadTasks();

        switchTab("list");
    } else {
        state.user = null;
        loginArea.classList.remove("hidden");
        userInfo.classList.add("hidden");
        appContent.classList.add("hidden");
        notLoggedInMessage.classList.remove("hidden");
    }
});

/* ==========================================================
   ===============   SETTINGS   ===============================
   ========================================================== */

async function loadSettings() {
    try {
        let s = await getDoc(settingsDocRef);
        if (s.exists()) {
            state.settings = s.data();
        } else {
            await setDoc(settingsDocRef, state.settings);
        }
        renderSettings();
    } catch (err) {
        console.error("Load settings error:", err);
    }
}

function renderSettings() {
    document.getElementById("settingQuickBoost").value = state.settings.quickBoost;
    document.getElementById("settingTimeMatchMultiplier").value = state.settings.timeMatchMultiplier;
    document.getElementById("settingDeadlinePenalty").value = state.settings.deadlinePenaltyFactor;
    document.getElementById("settingEstimatedWeight").value = state.settings.estimatedWeight;
    document.getElementById("settingHideDone").checked = state.settings.hideDone;

    document.getElementById("settingsNowInfo").innerHTML =
        "Giờ hiện tại: " + new Date().toLocaleString();
}

async function updateNumericSetting(field, value) {
    let v = Number(value);
    if (Number.isNaN(v)) return;
    state.settings[field] = v;
    await updateDoc(settingsDocRef, { [field]: v });
}

async function updateBoolSetting(field, value) {
    state.settings[field] = value;
    await updateDoc(settingsDocRef, { [field]: value });
}

/* ==========================================================
   ===============   LOAD TASKS   =============================
   ========================================================== */

async function loadTasks() {
    try {
        let qy = query(tasksCol, orderBy("seqId", "asc"));
        let snap = await getDocs(qy);
        state.tasks = [];
        snap.forEach(docSnap => {
            let t = docSnap.data();
            t.id = docSnap.id;
            state.tasks.push(t);
        });
        renderTasks();
    } catch (err) {
        console.error("Load tasks error:", err);
    }
}

/* ==========================================================
   ===============   ADD TASK   ===============================
   ========================================================== */

function gatherSelectedValues(cls) {
    let arr = [];
    document.querySelectorAll(`.${cls}.active`).forEach(btn => {
        arr.push(btn.dataset.value);
    });
    return arr;
}

function onPendingAddChange(checked) {
    let pills = document.querySelectorAll(".weekday-pill-add, .session-pill-add, input[name='modeAdd']");
    pills.forEach(el => el.disabled = checked);
}

async function addTask() {
    let name = document.getElementById("name").value.trim();
    if (!name) {
        alert("Nhập tên công việc.");
        return;
    }

    let desc = document.getElementById("description").value.trim();
    let est = Number(document.getElementById("estimated").value);
    let deadline = document.getElementById("deadline").value;

    let pending = document.getElementById("pendingAdd").checked;

    let mode = document.querySelector("input[name='modeAdd']:checked")?.value || "PREFER";
    let weekdays = gatherSelectedValues("weekday-pill-add");
    let sessions = gatherSelectedValues("session-pill-add");

    let seqId = state.tasks.length > 0
        ? Math.max(...state.tasks.map(t => t.seqId || 0)) + 1
        : 1;

    let newTask = {
        name,
        description: desc,
        estimated: est,
        deadline,
        mode,
        weekdays,
        sessions,
        pending,
        done: false,
        seqId
    };

    try {
        await addDoc(tasksCol, newTask);
        await loadTasks();
        clearAddForm();
    } catch (err) {
        alert("Lỗi thêm công việc: " + err.message);
    }
}

function clearAddForm() {
    document.getElementById("name").value = "";
    document.getElementById("description").value = "";
    document.getElementById("estimated").value = 10;
    document.getElementById("deadline").value = "";
    document.getElementById("pendingAdd").checked = false;

    document.querySelectorAll(".weekday-pill-add, .session-pill-add")
        .forEach(b => b.classList.remove("active"));
}

/* ==========================================================
   ===============   SCORE COMPUTE   ==========================
   ========================================================== */

function computeScore(task) {
    if (task.done) return -1;
    if (task.pending) return -0.5;

    const cfg = state.settings;
    const now = Date.now();
    const dl = task.deadline ? new Date(task.deadline).getTime() : now + 999999999;
    let timeLeft = (dl - now) / 60000;
    if (timeLeft < 1) timeLeft = 1;

    const t = Number(task.estimated) || 1;
    let score;

    if (t <= 5) {
        score = cfg.quickBoost;
    } else {
        score = (1 / timeLeft) * cfg.timeMatchMultiplier;
        score += (1 / t) * cfg.estimatedWeight;
        score -= (timeLeft / 1000) * cfg.deadlinePenaltyFactor;
    }

    return score;
}

/* ==========================================================
   ===============   RENDER TASK LIST   =======================
   ========================================================== */

function renderTasks() {
    let listDiv = document.getElementById("taskList");
    listDiv.innerHTML = "";

    let tasks = [...state.tasks];

    tasks.forEach(t => t.score = computeScore(t));

    tasks.sort((a, b) => {
        if (a.score === b.score) return b.seqId - a.seqId;
        return b.score - a.score;
    });

    tasks.forEach(task => {
        if (state.settings.hideDone && task.done) return;

        let div = document.createElement("div");
        div.className = "task-card";
        if (task.pending) div.classList.add("pending");
        if (task.done) div.classList.add("done");

        div.innerHTML = `
            <h3>${task.name}</h3>
            <p>${task.description || ""}</p>
            <p>Thời gian: ${task.estimated} phút</p>
            <p>Deadline: ${task.deadline || "Không có"}</p>
            <p>Score: ${task.score.toFixed(3)}</p>
        `;

        if (task.pending) {
            div.innerHTML += `<p>[PENDING]</p>`;
        }

        let ctrl = document.createElement("div");
        ctrl.className = "task-controls";

        if (!task.pending && !task.done) {
            let doneBtn = document.createElement("button");
            doneBtn.innerText = "Done";
            doneBtn.onclick = () => markDone(task);
            ctrl.appendChild(doneBtn);
        }

        if (task.done) {
            let undoneBtn = document.createElement("button");
            undoneBtn.innerText = "Undone";
            undoneBtn.onclick = () => markUndone(task);
            ctrl.appendChild(undoneBtn);
        }

        let editBtn = document.createElement("button");
        editBtn.innerText = "Sửa";
        editBtn.onclick = () => openEditPopup(task);
        ctrl.appendChild(editBtn);

        let delBtn = document.createElement("button");
        delBtn.innerText = "Xóa";
        delBtn.onclick = () => deleteTask(task);
        ctrl.appendChild(delBtn);

        div.appendChild(ctrl);
        listDiv.appendChild(div);
    });
}

/* ==========================================================
   ===============   TASK UPDATE   ============================
   ========================================================== */

async function markDone(task) {
    await updateDoc(doc(tasksCol, task.id), { done: true });
    loadTasks();
}

async function markUndone(task) {
    await updateDoc(doc(tasksCol, task.id), { done: false });
    loadTasks();
}

async function deleteTask(task) {
    if (!confirm("Xóa công việc này?")) return;
    await deleteDoc(doc(tasksCol, task.id));
    loadTasks();
}

/* ==========================================================
   ===============   EDIT POPUP   =============================
   ========================================================== */

function openEditPopup(task) {
    editingTaskId = task.id;

    document.getElementById("editName").value = task.name;
    document.getElementById("editDescription").value = task.description;
    document.getElementById("editEstimated").value = task.estimated;
    document.getElementById("editDeadline").value = task.deadline;

    document.querySelectorAll(".weekday-pill-edit, .session-pill-edit")
        .forEach(b => b.classList.remove("active"));

    task.weekdays?.forEach(w => {
        document.querySelector(`.weekday-pill-edit[data-value='${w}']`)?.classList.add("active");
    });
    task.sessions?.forEach(s => {
        document.querySelector(`.session-pill-edit[data-value='${s}']`)?.classList.add("active");
    });

    document.getElementsByName("modeEdit").forEach(r => {
        r.checked = (r.value === task.mode);
    });

    document.getElementById("editPending").checked = task.pending;

    onPendingEditChange(task.pending);

    document.getElementById("editPopup").classList.remove("hidden");
}

function togglePill(btn) {
    btn.classList.toggle("active");
}

function onPendingEditChange(checked) {
    let elems = document.querySelectorAll(".weekday-pill-edit, .session-pill-edit, input[name='modeEdit']");
    elems.forEach(e => e.disabled = checked);
}

function closePopup() {
    document.getElementById("editPopup").classList.add("hidden");
}

async function saveEdit() {
    if (!editingTaskId) return;

    let name = document.getElementById("editName").value.trim();
    let desc = document.getElementById("editDescription").value.trim();
    let est = Number(document.getElementById("editEstimated").value);
    let deadline = document.getElementById("editDeadline").value;

    let pending = document.getElementById("editPending").checked;

    let mode = document.querySelector("input[name='modeEdit']:checked")?.value || "PREFER";
    let weekdays = gatherSelectedValues("weekday-pill-edit");
    let sessions = gatherSelectedValues("session-pill-edit");

    let updateObj = {
        name,
        description: desc,
        estimated: est,
        deadline,
        pending,
        mode,
        weekdays,
        sessions
    };

    await updateDoc(doc(tasksCol, editingTaskId), updateObj);
    closePopup();
    loadTasks();
}

/* ==========================================================
   ===============   TAB SWITCH   =============================
   ========================================================== */

function switchTab(tab) {
    ["timeline", "list", "settings"].forEach(t => {
        document.getElementById(`tab-${t}`).classList.add("hidden");
    });

    document.getElementById(`tab-${tab}`).classList.remove("hidden");

    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("tab-active"));
    document.getElementById(`tab-btn-${tab}`).classList.add("tab-active");

    if (tab === "timeline") renderTimeline();
    if (tab === "list") renderTasks();
    if (tab === "settings") renderSettings();
}

/* ==========================================================
   ===============   TIMELINE ENGINE V4   =====================
   ========================================================== */

/* Helper: phút trong ngày */
function minutesOfDay(d) {
    return d.getHours() * 60 + d.getMinutes();
}

/* Convert time (minute offset) → % width */
function timeToPercent(min, total = 1440) {
    return (min / total) * 100;
}

/* Tạo danh sách nhãn giờ trong rolling window */
function buildHourLabels() {
    const labels = [];

    let now = new Date();
    let startHour = now.getHours();
    let startMinute = now.getMinutes();

    let currentTimeMinutes = startHour * 60 + startMinute;

    for (let i = 0; i <= 24; i++) {
        let h = (startHour + i) % 24;
        labels.push(h.toString().padStart(2, "0"));
    }
    return labels;
}

/* Render Timeline */
function renderTimeline() {
    let scaleDiv = document.getElementById("timelineScale");
    let infoDiv = document.getElementById("timelineInfo");
    let bgToday = document.getElementById("timelineBgToday");
    let bgFuture = document.getElementById("timelineBgFuture");
    let marker = document.getElementById("timelineCurrentMarker");

    let now = new Date();
    let nowMin = minutesOfDay(now);

    /* Rolling window: từ bây giờ → +24h */
    let total = 1440;

    infoDiv.innerHTML = "Từ: " + now.toLocaleString() + " → +24 giờ";

    /* Scale giờ */
    let labels = buildHourLabels();
    scaleDiv.innerHTML = "";
    labels.forEach(lbl => {
        let span = document.createElement("div");
        span.innerText = lbl;
        scaleDiv.appendChild(span);
    });

    /* Tính vị trí midnight tiếp theo */
    let tomorrowMidnight = new Date(now);
    tomorrowMidnight.setHours(24, 0, 0, 0);
    let diffToMidnight = (tomorrowMidnight - now) / 60000;

    let todayWidthPercent = timeToPercent(diffToMidnight, total);
    let futureWidthPercent = 100 - todayWidthPercent;

    bgToday.style.left = "0%";
    bgToday.style.width = todayWidthPercent + "%";

    bgFuture.style.left = todayWidthPercent + "%";
    bgFuture.style.width = futureWidthPercent + "%";

    /* Current time marker */
    marker.style.left = "0%";

    setTimeout(() => updateMarker(), 50);
}

/* Update marker mỗi phút */
function updateMarker() {
    let marker = document.getElementById("timelineCurrentMarker");
    let now = new Date();

    let tomorrowMidnight = new Date(now);
    tomorrowMidnight.setHours(24, 0, 0, 0);
    let diffToMidnight = (tomorrowMidnight - now) / 60000;

    let sinceStartWindow = 1440 - diffToMidnight;
    let percent = timeToPercent(sinceStartWindow, 1440);

    marker.style.left = percent + "%";

    setTimeout(updateMarker, 60000);
}

/* LOG */
console.log("V4 loaded.");

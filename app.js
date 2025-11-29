// ========== Firebase init ==========
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import {
    getAuth,
    GoogleAuthProvider,
    signInWithPopup,
    signOut,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js";
import {
    getFirestore,
    collection,
    doc,
    addDoc,
    setDoc,
    deleteDoc,
    onSnapshot,
    query,
    where,
    getDoc,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";

// Config Firebase của bạn
const firebaseConfig = {
  apiKey: "AIzaSyBw6vBtXo6RKu_VfRQNW64sbgSlyWjwhOU",
  authDomain: "dnmtaskmanager.firebaseapp.com",
  projectId: "dnmtaskmanager",
  storageBucket: "dnmtaskmanager.firebasestorage.app",
  messagingSenderId: "606685816362",
  appId: "1:606685816362:web:bf4e80d51323c079c70553"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

// ========== STATE ==========
const state = {
    currentUser: null,
    tasks: [],
    currentTab: "list",
    settings: {
        quickBoost: 999999,
        timeMatchMultiplier: 1.5,
        deadlinePenaltyFactor: 1,
        estimatedWeight: 1,
        hideDone: false
    }
};

// ========== LOCAL SETTINGS ==========
const SETTINGS_KEY = "dnmSettingsV3";

function loadSettingsFromLocalStorage() {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (!raw) return;
        const obj = JSON.parse(raw);
        if (typeof obj.quickBoost === "number") state.settings.quickBoost = obj.quickBoost;
        if (typeof obj.timeMatchMultiplier === "number") state.settings.timeMatchMultiplier = obj.timeMatchMultiplier;
        if (typeof obj.deadlinePenaltyFactor === "number") state.settings.deadlinePenaltyFactor = obj.deadlinePenaltyFactor;
        if (typeof obj.estimatedWeight === "number") state.settings.estimatedWeight = obj.estimatedWeight;
        if (typeof obj.hideDone === "boolean") state.settings.hideDone = obj.hideDone;
    } catch(e) {
        console.error("Error loading settings:", e);
    }
}

function saveSettingsToLocalStorage() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

loadSettingsFromLocalStorage();

// ========== AUTH ==========
const loginBtn = document.getElementById("loginBtn");
const logoutBtn = document.getElementById("logoutBtn");
const userInfoDiv = document.getElementById("userInfo");
const loginAreaDiv = document.getElementById("loginArea");
const userNameSpan = document.getElementById("userName");
const notLoggedInMessage = document.getElementById("notLoggedInMessage");
const appContent = document.getElementById("appContent");
const taskListDiv = document.getElementById("taskList");

const provider = new GoogleAuthProvider();
loginBtn.onclick = () => signInWithPopup(auth, provider);
logoutBtn.onclick = () => signOut(auth);

onAuthStateChanged(auth, user => {
    state.currentUser = user || null;

    if (!user) {
        userInfoDiv.classList.add("hidden");
        loginAreaDiv.classList.remove("hidden");
        notLoggedInMessage.classList.remove("hidden");
        appContent.classList.add("hidden");
        state.tasks = [];
        taskListDiv.innerHTML = "";
        return;
    }

    userNameSpan.textContent = user.displayName || user.email;
    userInfoDiv.classList.remove("hidden");
    loginAreaDiv.classList.add("hidden");
    notLoggedInMessage.classList.add("hidden");
    appContent.classList.remove("hidden");

    listenTasks();
});

// ========== TAB SWITCH ==========
window.switchTab = function(tab) {
    state.currentTab = tab;

    document.getElementById("tab-timeline").classList.add("hidden");
    document.getElementById("tab-list").classList.add("hidden");
    document.getElementById("tab-settings").classList.add("hidden");

    document.getElementById(`tab-${tab}`).classList.remove("hidden");

    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("tab-active"));
    document.getElementById(`tab-btn-${tab}`).classList.add("tab-active");

    if (tab === "list") renderTasks();
    if (tab === "settings") renderSettings();
};

// ========== TIME HELPERS ==========
function getWeekdayKey(date) {
    return ["SUN","MON","TUE","WED","THU","FRI","SAT"][date.getDay()];
}

function getCurrentSessionKey() {
    const now = new Date();
    const m = now.getHours()*60 + now.getMinutes();
    if (m>=4*60 && m<6*60) return "DAWN";
    if (m>=6*60 && m<11*60) return "MORNING";
    if (m>=11*60 && m<13*60) return "NOON";
    if (m>=13*60 && m<17*60) return "AFTERNOON";
    if (m>=17*60 && m<23*60) return "EVENING";
    return "NIGHT";
}

// ========== SCORE ==========
function computeScore(task) {
    if (task.done) return -1;

    const cfg = state.settings;
    const now = Date.now();
    const dl = new Date(task.deadline).getTime();
    let timeLeft = (dl - now)/60000;
    if (timeLeft < 1) timeLeft = 1;

    const t = Number(task.estimated) || 1;

    let score;
    if (t <= 5) {
        score = cfg.quickBoost;
    } else {
        const num = Math.pow(Math.max(t,1), cfg.estimatedWeight || 1);
        const den = Math.pow(Math.max(timeLeft,1), cfg.deadlinePenaltyFactor || 1);
        score = num / den;
    }

    const weekdays = task.weekdays || [];
    const sessions = task.sessions || [];
    const mode = task.mode || "PREFER";

    const today = getWeekdayKey(new Date());
    const nowSession = getCurrentSessionKey();

    const matchDay = weekdays.length === 0 || weekdays.includes(today);
    const matchSession = sessions.length === 0 || sessions.includes(nowSession);
    const hasConstraint = weekdays.length > 0 || sessions.length > 0;
    const matched = hasConstraint && matchDay && matchSession;

    if (mode === "STRICT") {
        if (matched) score *= cfg.timeMatchMultiplier;
        else score = 0;
    } else {
        if (matched) score *= cfg.timeMatchMultiplier;
    }

    return score;
}

// ========== seqId ==========
async function getNextTaskSeqId() {
    if (!state.currentUser) throw new Error("No user");

    const ref = doc(db, "meta", state.currentUser.uid);
    const snap = await getDoc(ref);

    let current = 0;
    if (snap.exists()) {
        current = snap.data().lastTaskSeq || 0;
    }

    const next = current + 1;
    await setDoc(ref, { lastTaskSeq: next }, { merge: true });

    return next;
}

// ========== LISTEN TASKS ==========
function listenTasks() {
    const q = query(collection(db, "tasks"), where("uid","==",state.currentUser.uid));
    onSnapshot(q, snap => {
        const arr = [];
        snap.forEach(d => arr.push({ id: d.id, ...d.data() }));
        state.tasks = arr;

        if (state.currentTab === "list") renderTasks();
    });
}

// ========== ADD TASK ==========
window.addTask = async function() {
    const name = document.getElementById("name").value.trim();
    const description = document.getElementById("description").value.trim();
    const estimated = Number(document.getElementById("estimated").value);
    const deadline = document.getElementById("deadline").value;

    if (!name || !deadline || !estimated) {
        alert("Thiếu tên, thời lượng hoặc deadline.");
        return;
    }

    if (!state.currentUser) {
        alert("Hãy đăng nhập.");
        return;
    }

    const seqId = await getNextTaskSeqId();

    const modeEl = document.querySelector('input[name="modeAdd"]:checked');
    const mode = modeEl ? modeEl.value : "PREFER";

    const weekdays = getSelectedValues(".weekday-pill-add");
    const sessions = getSelectedValues(".session-pill-add");

    await addDoc(collection(db, "tasks"), {
        uid: state.currentUser.uid,
        seqId,
        done: false,
        name,
        description,
        estimated,
        deadline,
        mode,
        weekdays,
        sessions,
        createdAt: serverTimestamp()
    });

    document.getElementById("name").value = "";
    document.getElementById("description").value = "";
};

// ========== RENDER TASKS ==========
function renderTasks() {
    taskListDiv.innerHTML = "";

    if (!state.tasks.length) {
        taskListDiv.innerHTML = "<p>Chưa có công việc nào.</p>";
        return;
    }

    const sortedAll = state.tasks
        .map(t => ({ ...t, score: computeScore(t) }))
        .sort((a,b) => {
            if (a.done !== b.done) return a.done ? 1 : -1;
            if (b.score !== a.score) return b.score - a.score;
            return (b.seqId||0) - (a.seqId||0);
        });

    const list = state.settings.hideDone ? sortedAll.filter(t => !t.done) : sortedAll;

    if (!list.length) {
        taskListDiv.innerHTML = "<p>Không có task (có thể đang ẩn task Done).</p>";
        return;
    }

    list.forEach(t => {
        const div = document.createElement("div");
        div.className = "task-card" + (t.done ? " task-done" : "");

        const dateStr = new Date(t.deadline).toLocaleString();
        const weekdayText = t.weekdays?.length ? "Thứ: " + t.weekdays.join(", ") : "Thứ: bất kỳ";
        const sessionText = t.sessions?.length ? "Buổi: " + t.sessions.join(", ") : "Buổi: bất kỳ";

        const hasConstraint = (t.weekdays?.length || 0) > 0 || (t.sessions?.length || 0) > 0;
        const matched = hasConstraint &&
                        (!t.weekdays.length || t.weekdays.includes(getWeekdayKey(new Date()))) &&
                        (!t.sessions.length || t.sessions.includes(getCurrentSessionKey()));

        let modeText = t.mode === "STRICT" ? "CHỈ" : "ƯU TIÊN";
        if (matched) {
            modeText = `<span style="color:#2e7d32;font-weight:bold">${modeText}</span>`;
        } else {
            modeText = `<span style="color:#777">${modeText}</span>`;
        }

        div.innerHTML = `
            <div class="task-title">#${t.seqId} ${t.name}</div>
            <div>${t.description || ""}</div>
            <div>Thời gian: ${t.estimated} phút</div>
            <div>Deadline: ${dateStr}</div>
            <div>${modeText} | ${weekdayText} | ${sessionText}</div>
            <div>Score: ${t.score.toFixed(2)}</div>

            <div class="task-footer">
                <button class="edit-btn">Sửa</button>

                ${
                    t.done
                    ? `<button class="done-btn" style="background:#009688">UNDONE</button>`
                    : `
                        <button class="calendar-btn">Calendar</button>
                        <button class="calendar-open-btn">OpenCal</button>
                        <button class="done-btn" style="background:#009688">Done</button>
                    `
                }

                <button class="delete-btn">Xóa</button>
            </div>
        `;

        const btns = div.querySelectorAll("button");

        if (!t.done) {
            btns[0].onclick = () => openEditPopup(t);
            btns[1].onclick = () => addToCalendar(t);
            btns[2].onclick = () => openCalendarDate(t);
            btns[3].onclick = () => markDone(t);
            btns[4].onclick = () => deleteTask(t);
        } else {
            btns[0].onclick = () => openEditPopup(t);
            btns[1].onclick = () => unDone(t);
            btns[2].onclick = () => deleteTask(t);
        }

        taskListDiv.appendChild(div);
    });
}

// ========== DONE / UNDONE / DELETE ==========
async function markDone(task) {
    await setDoc(doc(db,"tasks",task.id), { done: true }, { merge:true });
}

async function unDone(task) {
    await setDoc(doc(db,"tasks",task.id), { done: false }, { merge:true });
}

async function deleteTask(task) {
    if (!confirm("Xóa công việc này?")) return;
    await deleteDoc(doc(db,"tasks",task.id));
}

// ========== EDIT POPUP ==========
let editingTask = null;

window.openEditPopup = function(task) {
    editingTask = task;

    document.getElementById("editName").value = task.name;
    document.getElementById("editDescription").value = task.description || "";
    document.getElementById("editEstimated").value = task.estimated;
    document.getElementById("editDeadline").value = task.deadline;

    document.querySelectorAll('input[name="modeEdit"]').forEach(r => r.checked = false);
    const modeRadio = document.querySelector(`input[name="modeEdit"][value="${task.mode}"]`);
    if (modeRadio) modeRadio.checked = true;

    document.querySelectorAll(".weekday-pill-edit, .session-pill-edit")
        .forEach(el => el.classList.remove("pill-selected"));

    (task.weekdays || []).forEach(v => {
        const el = document.querySelector(`.weekday-pill-edit[data-value="${v}"]`);
        if (el) el.classList.add("pill-selected");
    });

    (task.sessions || []).forEach(v => {
        const el = document.querySelector(`.session-pill-edit[data-value="${v}"]`);
        if (el) el.classList.add("pill-selected");
    });

    document.getElementById("editPopup").classList.remove("hidden");
};

window.closePopup = function() {
    editingTask = null;
    document.getElementById("editPopup").classList.add("hidden");
};

window.saveEdit = async function() {
    if (!editingTask) return closePopup();

    const name = document.getElementById("editName").value.trim();
    const desc = document.getElementById("editDescription").value.trim();
    const est  = Number(document.getElementById("editEstimated").value);
    const dl   = document.getElementById("editDeadline").value;

    if (!name || !dl || !est) {
        alert("Thiếu thông tin.");
        return;
    }

    const modeEl = document.querySelector('input[name="modeEdit"]:checked');
    const mode = modeEl ? modeEl.value : "PREFER";

    const weekdays = getSelectedValues(".weekday-pill-edit");
    const sessions = getSelectedValues(".session-pill-edit");

    await setDoc(doc(db, "tasks", editingTask.id), {
        name,
        description: desc,
        estimated: est,
        deadline: dl,
        mode,
        weekdays,
        sessions
    }, { merge: true });

    closePopup();
};

// ========== CALENDAR ==========
function addToCalendar(task) {
    const title = encodeURIComponent(task.name);
    const details = encodeURIComponent(task.description || "");

    const start = new Date(task.deadline);
    const end   = new Date(start.getTime() + (Number(task.estimated)||0)*60000);

    const fmt = d => d.toISOString().replace(/[-:]/g,"").replace(".000","");

    const url =
        `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}` +
        `&dates=${fmt(start)}/${fmt(end)}&details=${details}`;

    window.open(url, "_blank");
}

function openCalendarDate(task) {
    const d = new Date(task.deadline);
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,"0");
    const day = String(d.getDate()).padStart(2,"0");

    const url = `https://calendar.google.com/calendar/r/day/${y}/${m}/${day}`;
    window.open(url, "_blank");
}

// ========== SETTINGS ==========
function renderSettings() {
    const s = state.settings;

    document.getElementById("settingQuickBoost").value = s.quickBoost;
    document.getElementById("settingTimeMatchMultiplier").value = s.timeMatchMultiplier;
    document.getElementById("settingDeadlinePenalty").value = s.deadlinePenaltyFactor;
    document.getElementById("settingEstimatedWeight").value = s.estimatedWeight;

    const hide = document.getElementById("settingHideDone");
    hide.checked = s.hideDone;

    updateNowInfo();
}

function updateNowInfo() {
    const el = document.getElementById("settingsNowInfo");
    if (!el) return;

    const now = new Date();
    const wd = getWeekdayKey(now);
    const sess = getCurrentSessionKey();

    const dayMap = {
        MON:"Thứ 2",TUE:"Thứ 3",WED:"Thứ 4",THU:"Thứ 5",
        FRI:"Thứ 6",SAT:"Thứ 7",SUN:"Chủ nhật"
    };
    const sessMap = {
        DAWN:"Sáng sớm",MORNING:"Sáng",NOON:"Trưa",
        AFTERNOON:"Chiều",EVENING:"Tối",NIGHT:"Đêm"
    };

    el.textContent = `Hôm nay: ${dayMap[wd] || wd} – Buổi: ${sessMap[sess] || sess}`;
}

window.updateNumericSetting = function(key, value) {
    const v = parseFloat(value);
    if (isNaN(v)) return;
    state.settings[key] = v;
    saveSettingsToLocalStorage();
    if (state.currentTab === "list") renderTasks();
};

window.updateBoolSetting = function(key, checked) {
    state.settings[key] = !!checked;
    saveSettingsToLocalStorage();
    if (state.currentTab === "list") renderTasks();
};

// ========== PILLS ==========
window.togglePill = function(el) {
    el.classList.toggle("pill-selected");
};

function getSelectedValues(selector) {
    return Array.from(document.querySelectorAll(selector))
        .filter(el => el.classList.contains("pill-selected"))
        .map(el => el.dataset.value);
}

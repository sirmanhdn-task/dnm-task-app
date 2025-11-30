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

// Config Firebase
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

// zoom level cho timeline
let zoomLevel = 1; // 1=100%, 2=200%, 4=400%

// Giới hạn scheduler / shading: 14 ngày
const MAX_FILL_DAYS = 14;
const MAX_FILL_MINUTES = MAX_FILL_DAYS * 1440;

// ========== STATE ==========
const state = {
    currentUser: null,
    tasks: [],
    backgroundTasks: [],
    currentTab: "timeline",
    settings: {
        quickBoost: 999999,
        timeMatchMultiplier: 1.5,
        deadlinePenaltyFactor: 1,
        estimatedWeight: 1,
        hideDone: false
    },
    timeline: {
        todayStart: null,
        totalMinutes: 1440
    }
};

// ========== LOCAL SETTINGS ==========
const SETTINGS_KEY = "dnmSettingsV6";

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
        state.backgroundTasks = [];
        taskListDiv.innerHTML = "";
        return;
    }

    userNameSpan.textContent = user.displayName || user.email;
    userInfoDiv.classList.remove("hidden");
    loginAreaDiv.classList.add("hidden");
    notLoggedInMessage.classList.add("hidden");
    appContent.classList.remove("hidden");

    listenTasks();
    listenBackgroundTasks();
});

// ========== TAB ==========
window.switchTab = function(tab) {
    state.currentTab = tab;

    document.getElementById("tab-timeline").classList.add("hidden");
    document.getElementById("tab-background").classList.add("hidden");
    document.getElementById("tab-settings").classList.add("hidden");

    document.getElementById(`tab-${tab}`).classList.remove("hidden");

    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("tab-active"));
    document.getElementById(`tab-btn-${tab}`).classList.add("tab-active");

    if (tab === "timeline") {
        renderTasks();
        renderTimeline();
    }
    if (tab === "background") {
        renderBackgroundTasks();
    }
    if (tab === "settings") {
        renderSettings();
    }
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

function getTodayStart() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
}

// ========== TYPE HELPER ==========
function getTaskType(task) {
    if (task.type === "normal" || task.type === "pending" || task.type === "background") {
        return task.type;
    }
    if (task.pending === true) return "pending";
    return "normal";
}

// ========== SCORE ==========
function computeScore(task) {
    const type = getTaskType(task);

    if (task.done) return -1;
    if (type === "pending") return -0.5;
    if (type === "background") return -1;

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

// ========== STATUS RANK ==========
function taskStatusRank(t) {
    const type = getTaskType(t);
    if (t.done) return 3;
    if (type === "background") return 2;
    if (type === "pending") return 1;
    return 0;
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

        renderTasks();
        if (state.currentTab === "timeline") renderTimeline();
    });
}

// ========== LISTEN BACKGROUND TASKS ==========
function listenBackgroundTasks() {
    const q = query(collection(db, "backgroundTasks"), where("uid","==",state.currentUser.uid));
    onSnapshot(q, snap => {
        const arr = [];
        snap.forEach(d => arr.push({ id: d.id, ...d.data() }));

        arr.sort((a,b) => {
            if (a.date !== b.date) return (a.date || "").localeCompare(b.date || "");
            return (a.startTime || "").localeCompare(b.startTime || "");
        });

        state.backgroundTasks = arr;

        if (state.currentTab === "background") renderBackgroundTasks();
        if (state.currentTab === "timeline") renderTimeline();
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

    const typeEl = document.querySelector('input[name="typeAdd"]:checked');
    const type = typeEl ? typeEl.value : "normal";

    let mode = "PREFER";
    let weekdays = [];
    let sessions = [];

    if (type === "normal") {
        const modeEl = document.querySelector('input[name="modeAdd"]:checked');
        mode = modeEl ? modeEl.value : "PREFER";

        weekdays = getSelectedValues(".weekday-pill-add");
        sessions = getSelectedValues(".session-pill-add");
    }

    const pending = (type === "pending");

    await addDoc(collection(db, "tasks"), {
        uid: state.currentUser.uid,
        seqId,
        done: false,
        type,
        pending,
        name,
        description,
        estimated,
        deadline,
        mode,
        weekdays,
        sessions,
        canRunParallel: document.getElementById("addCanParallel").checked,
        createdAt: serverTimestamp()
    });

    document.getElementById("name").value = "";
    document.getElementById("description").value = "";
    document.getElementById("estimated").value = 10;
    document.getElementById("deadline").value = "";
    document.getElementById("addCanParallel").checked = false;

    document.querySelectorAll(".weekday-pill-add, .session-pill-add")
        .forEach(el => el.classList.remove("pill-selected"));
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
            const ra = taskStatusRank(a);
            const rb = taskStatusRank(b);
            if (ra !== rb) return ra - rb;
            if (b.score !== a.score) return b.score - a.score;
            return (b.seqId||0) - (a.seqId||0);
        });

    const list = state.settings.hideDone
        ? sortedAll.filter(t => !t.done)
        : sortedAll;

    if (!list.length) {
        taskListDiv.innerHTML = "<p>Không có task (có thể đang ẩn task Done).</p>";
        return;
    }

    list.forEach(t => {
        const type = getTaskType(t);

        let classes = "task-card";
        if (t.done) classes += " task-done";
        if (type === "pending") classes += " task-pending";

        const div = document.createElement("div");
        div.className = classes;

        const dateStr = new Date(t.deadline).toLocaleString();
        const weekdaysArr = t.weekdays || [];
        const sessionsArr = t.sessions || [];

        const weekdayText = weekdaysArr.length ? "Thứ: " + weekdaysArr.join(", ") : "Thứ: bất kỳ";
        const sessionText = sessionsArr.length ? "Buổi: " + sessionsArr.join(", ") : "Buổi: bất kỳ";

        const hasConstraint = weekdaysArr.length > 0 || sessionsArr.length > 0;
        const matched = hasConstraint &&
                        (weekdaysArr.length === 0 || weekdaysArr.includes(getWeekdayKey(new Date()))) &&
                        (sessionsArr.length === 0 || sessionsArr.includes(getCurrentSessionKey()));

        let modeText;
        if (type === "pending") {
            modeText = "PENDING";
        } else {
            modeText = (t.mode || "PREFER") === "STRICT" ? "CHỈ" : "ƯU TIÊN";
            if (matched) {
                modeText = `<span style="color:#2e7d32;font-weight:bold">${modeText}</span>`;
            } else {
                modeText = `<span style="color:#777">${modeText}</span>`;
            }
        }

        const scoreStr = (type === "pending" || type === "background") ? "-" : t.score.toFixed(2);

        let footerHtml = "";

        if (t.done) {
            footerHtml = `
                <button class="edit-btn">Sửa</button>
                <button class="done-btn" style="background:#009688">UNDONE</button>
                <button class="delete-btn">Xóa</button>
            `;
        } else if (type === "pending") {
            footerHtml = `
                <button class="edit-btn">Sửa</button>
                <button class="delete-btn">Xóa</button>
            `;
        } else {
            footerHtml = `
                <button class="edit-btn">Sửa</button>
                <button class="calendar-btn">Calendar</button>
                <button class="calendar-open-btn">OpenCal</button>
                <button class="done-btn" style="background:#009688">Done</button>
                <button class="delete-btn">Xóa</button>
            `;
        }

        div.innerHTML = `
            <div class="task-title">
                #${t.seqId} ${t.name}
                ${type === "pending" ? '<span class="task-badge-pending">PENDING</span>' : ""}
                ${type === "normal" && t.canRunParallel ? '<span class="task-badge-parallel">Parallel OK</span>' : ""}
            </div>
            <div>${t.description || ""}</div>
            <div>Thời gian: ${t.estimated} phút</div>
            <div>Deadline: ${dateStr}</div>
            <div>${modeText} | ${weekdayText} | ${sessionText}</div>
            <div>Score: ${scoreStr}</div>

            <div class="task-footer">
                ${footerHtml}
            </div>
        `;

        const editBtn       = div.querySelector(".edit-btn");
        const doneBtn       = div.querySelector(".done-btn");
        const deleteBtn     = div.querySelector(".delete-btn");
        const calendarBtn   = div.querySelector(".calendar-btn");
        const openCalBtn    = div.querySelector(".calendar-open-btn");

        if (editBtn)    editBtn.onclick    = () => openEditPopup(t);
        if (doneBtn) {
            if (t.done) doneBtn.onclick = () => unDone(t);
            else doneBtn.onclick        = () => markDone(t);
        }
        if (deleteBtn)  deleteBtn.onclick  = () => deleteTask(t);
        if (calendarBtn)calendarBtn.onclick= () => addToCalendar(t);
        if (openCalBtn) openCalBtn.onclick = () => openCalendarDate(t);

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
    const type = getTaskType(task);

    document.getElementById("editName").value = task.name;
    document.getElementById("editDescription").value = task.description || "";
    document.getElementById("editEstimated").value = task.estimated;
    document.getElementById("editDeadline").value = task.deadline;
    document.getElementById("editCanParallel").checked = !!task.canRunParallel;

    document.querySelectorAll('input[name="typeEdit"]').forEach(r => {
        r.checked = (r.value === type);
    });

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

    const typeEl = document.querySelector('input[name="typeEdit"]:checked');
    const type = typeEl ? typeEl.value : "normal";

    let mode = "PREFER";
    let weekdays = [];
    let sessions = [];

    if (type === "normal") {
        const modeEl = document.querySelector('input[name="modeEdit"]:checked');
        mode = modeEl ? modeEl.value : "PREFER";

        weekdays = getSelectedValues(".weekday-pill-edit");
        sessions = getSelectedValues(".session-pill-edit");
    }

    const pending = (type === "pending");

    await setDoc(doc(db, "tasks", editingTask.id), {
        name,
        description: desc,
        estimated: est,
        deadline: dl,
        type,
        pending,
        mode,
        weekdays,
        sessions,
        canRunParallel: document.getElementById("editCanParallel").checked
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
    renderTasks();
};

window.updateBoolSetting = function(key, checked) {
    state.settings[key] = !!checked;
    saveSettingsToLocalStorage();
    renderTasks();
};

// ========== PILLS ==========
window.togglePill = function(el) {
    if (el.disabled) return;
    el.classList.toggle("pill-selected");
};

function getSelectedValues(selector) {
    return Array.from(document.querySelectorAll(selector))
        .filter(el => el.classList.contains("pill-selected"))
        .map(el => el.dataset.value);
}

// ========== BACKGROUND TASKS CRUD ==========

window.addBackgroundTask = async function() {
    const name = document.getElementById("bgName").value.trim();
    const description = document.getElementById("bgDescription").value.trim();
    const date = document.getElementById("bgDate").value;
    const startTime = document.getElementById("bgStartTime").value;
    const endTime = document.getElementById("bgEndTime").value;
    const parallel = document.getElementById("bgParallel").checked;

    if (!state.currentUser) {
        alert("Bạn cần đăng nhập.");
        return;
    }

    if (!name || !date || !startTime || !endTime) {
        alert("Thiếu tên, ngày, giờ bắt đầu hoặc giờ kết thúc.");
        return;
    }

    if (endTime <= startTime) {
        alert("Giờ kết thúc phải sau giờ bắt đầu (chưa hỗ trợ qua ngày).");
        return;
    }

    await addDoc(collection(db, "backgroundTasks"), {
        uid: state.currentUser.uid,
        name,
        description,
        date,
        startTime,
        endTime,
        parallel,
        createdAt: serverTimestamp()
    });

    document.getElementById("bgName").value = "";
    document.getElementById("bgDescription").value = "";
};

window.deleteBackgroundTask = async function(id) {
    if (!confirm("Xóa background task này?")) return;
    await deleteDoc(doc(db, "backgroundTasks", id));
};

function renderBackgroundTasks() {
    const listDiv = document.getElementById("bgTaskList");
    if (!listDiv) return;

    listDiv.innerHTML = "";

    if (!state.backgroundTasks || state.backgroundTasks.length === 0) {
        listDiv.innerHTML = "<p>Chưa có background task nào.</p>";
        return;
    }

    state.backgroundTasks.forEach(bg => {
        const div = document.createElement("div");
        div.className = "task-card";

        const dateStr = bg.date || "";
        const timeStr = bg.startTime && bg.endTime
            ? `${bg.startTime} → ${bg.endTime}`
            : "";

        const parallelText = bg.parallel
            ? "Parallel: cho phép task khác chạy cùng"
            : "Non-parallel: không cho task khác chạy cùng (tạo vùng Unavailable)";

        div.innerHTML = `
            <div class="task-title">${bg.name}</div>
            <div>${bg.description || ""}</div>
            <div>Ngày: ${dateStr}</div>
            <div>Thời gian: ${timeStr}</div>
            <div style="font-size:12px;color:#555;">${parallelText}</div>
            <div class="task-footer">
                <button class="delete-btn" onclick="deleteBackgroundTask('${bg.id}')">Xóa</button>
            </div>
        `;

        listDiv.appendChild(div);
    });
}

// ========== V6.0: BUILD SLOTS (resolution = 10 phút, giới hạn 14 ngày) ==========
function buildSlots() {
    const RES = 10; // phút

    const todayStart = state.timeline.todayStart;
    const totalMinutes = state.timeline.totalMinutes;

    if (!todayStart || !totalMinutes) {
        console.warn("buildSlots: todayStart hoặc totalMinutes chưa sẵn sàng");
        return [];
    }

    const slots = [];
    const bg = state.backgroundTasks || [];

    // Danh sách khoảng unavailable do background non-parallel
    const unavailable = [];

    bg.forEach(b => {
        if (!b.date || !b.startTime || !b.endTime) return;
        if (b.parallel) return; // parallel => không chặn slot

        const baseDate = new Date(b.date + "T00:00:00");
        if (isNaN(baseDate.getTime())) return;

        const dayIndex = Math.floor((baseDate - todayStart) / (24 * 60 * 60000));
        if (dayIndex < 0) return; // trước hôm nay thì bỏ

        const [sh, sm] = b.startTime.split(":").map(Number);
        const [eh, em] = b.endTime.split(":").map(Number);
        if (isNaN(sh) || isNaN(sm) || isNaN(eh) || isNaN(em)) return;

        let startMin = dayIndex * 1440 + (sh * 60 + sm);
        let endMin   = dayIndex * 1440 + (eh * 60 + em);
        if (endMin <= startMin) return;

        // cắt trong phạm vi [0, totalMinutes]
        if (endMin <= 0) return;
        if (startMin >= totalMinutes) return;

        if (startMin < 0) startMin = 0;
        if (endMin > totalMinutes) endMin = totalMinutes;

        unavailable.push({ start: startMin, end: endMin });
    });

    // Chia slot
    for (let m = 0; m < totalMinutes; m += RES) {
        let slotStart = m;
        let slotEnd   = m + RES;
        if (slotEnd > totalMinutes) slotEnd = totalMinutes;

        let status = "available";

        for (const un of unavailable) {
            if (!(slotEnd <= un.start || slotStart >= un.end)) {
                status = "unavailable";
                break;
            }
        }

        slots.push({
            start: slotStart,
            end: slotEnd,
            status
        });
    }

    return slots;
}

// ========== V6.0: DEBUG SLOTS ==========
window.debugSlots = function () {
    const s = buildSlots();
    console.log("=== DEBUG SLOTS (V6.x, RES=10 phút, max 14 ngày) ===");
    console.log(s);
    console.log("Tổng số slot:", s.length);
};

// ========== TIMELINE RENDERING ==========
function renderTimeline() {
    const container = document.getElementById("timelineContainer");
    if (!container) return;

    const laneNormal = document.getElementById("lane-normal");
    const laneBackground = document.getElementById("lane-background");
    const lanePending = document.getElementById("lane-pending");
    const daysContainer = document.getElementById("timelineDays");
    const header = document.getElementById("timelineHeader");
    const availContainer = document.getElementById("timelineAvailability");

    laneNormal.innerHTML = "";
    laneBackground.innerHTML = "";
    lanePending.innerHTML = "";
    daysContainer.innerHTML = "";
    header.innerHTML = "";
    if (availContainer) availContainer.innerHTML = "";

    const tasks = state.tasks || [];
    const bgTasks = state.backgroundTasks || [];
    const todayStart = getTodayStart();
    state.timeline.todayStart = todayStart;

    // Xác định maxEnd dựa trên task & background
    let maxEnd = new Date(todayStart.getTime() + 24*60*60000);

    tasks.forEach(t => {
        if (!t.deadline) return;
        const dl = new Date(t.deadline);
        if (isNaN(dl.getTime())) return;
        if (dl.getTime() > maxEnd.getTime()) {
            maxEnd = dl;
        }
    });

    bgTasks.forEach(bg => {
        if (!bg.date || !bg.endTime) return;
        const [eh, em] = bg.endTime.split(":").map(Number);
        if (isNaN(eh) || isNaN(em)) return;
        const baseDate = new Date(bg.date + "T00:00:00");
        const dayStart = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 0,0,0,0);
        const end = new Date(dayStart.getTime() + (eh*60 + em)*60000);
        if (end.getTime() > maxEnd.getTime()) {
            maxEnd = end;
        }
    });

    // Tính tổng phút, giới hạn 14 ngày
    let rawMinutes = Math.max(1440, Math.ceil((maxEnd - todayStart)/60000));
    rawMinutes = Math.min(rawMinutes, MAX_FILL_MINUTES);
    const totalDays = Math.max(1, Math.ceil(rawMinutes / 1440));
    const totalMinutes = totalDays * 1440;
    state.timeline.totalMinutes = totalMinutes;

    const pxPerMinute = zoomLevel;
    const totalWidth = totalMinutes * pxPerMinute;

    container.style.width = totalWidth + "px";
    if (availContainer) {
        availContainer.style.width = totalWidth + "px";
    }

    // Day strips
    for (let d=0; d<totalDays; d++) {
        const dayDiv = document.createElement("div");
        dayDiv.className = "timeline-day-strip";

        const left = d * 1440 * pxPerMinute;
        const width = 1440 * pxPerMinute;

        dayDiv.style.left = left + "px";
        dayDiv.style.width = width + "px";

        if (d === 0) {
            dayDiv.style.background = "#ffffff";
        } else {
            const shade = 250 - d*10;
            const c = Math.max(210, shade);
            dayDiv.style.background = `rgb(${c},${c},${c})`;
        }

        daysContainer.appendChild(dayDiv);
    }

    // Header labels (mỗi 3h)
    for (let m=0; m<=totalMinutes; m+=180) {
        const label = document.createElement("div");
        label.className = "timeline-header-label";
        const left = m * pxPerMinute;
        label.style.left = left + "px";

        const date = new Date(todayStart.getTime() + m*60000);
        const hh = String(date.getHours()).padStart(2,"0");
        const mm = String(date.getMinutes()).padStart(2,"0");
        label.textContent = `${hh}:${mm}`;
        header.appendChild(label);
    }

    // ========== Availability shading dựa trên slots ==========
    if (availContainer) {
        const slots = buildSlots();
        // Gộp các slot unavailable liền nhau thành 1 block
        let current = null;
        slots.forEach(s => {
            if (s.status === "unavailable") {
                if (!current) {
                    current = { start: s.start, end: s.end };
                } else {
                    current.end = s.end;
                }
            } else {
                if (current) {
                    const block = document.createElement("div");
                    block.className = "availability-block-unavailable";
                    const leftPx = current.start * pxPerMinute;
                    const widthPx = (current.end - current.start) * pxPerMinute;
                    block.style.left = leftPx + "px";
                    block.style.width = Math.max(1, widthPx) + "px";
                    availContainer.appendChild(block);
                    current = null;
                }
            }
        });
        if (current) {
            const block = document.createElement("div");
            block.className = "availability-block-unavailable";
            const leftPx = current.start * pxPerMinute;
            const widthPx = (current.end - current.start) * pxPerMinute;
            block.style.left = leftPx + "px";
            block.style.width = Math.max(1, widthPx) + "px";
            availContainer.appendChild(block);
        }
    }

    // ========== Normal & Pending tasks (vẫn dựa trên deadline) ==========
    tasks.forEach(t => {
        const type = getTaskType(t);
        if (!t.deadline) return;
        const dl = new Date(t.deadline);
        if (isNaN(dl.getTime())) return;

        const estimated = Number(t.estimated) || 0;
        if (estimated <= 0) return;

        let endMin = (dl - todayStart)/60000;
        if (endMin < 0) return;
        if (endMin > totalMinutes) endMin = totalMinutes;

        let startMin = endMin - estimated;
        if (startMin < 0) {
            startMin = 0;
        }

        if (startMin > totalMinutes) return;

        const lane = (type === "pending")
            ? lanePending
            : laneNormal;

        const block = document.createElement("div");
        block.classList.add("timeline-block");

        if (type === "pending") block.classList.add("timeline-block-pending");
        else block.classList.add("timeline-block-normal");

        const leftPx = startMin * pxPerMinute;
        const widthPx = (endMin - startMin) * pxPerMinute;

        block.style.left = leftPx + "px";
        block.style.width = Math.max(10, widthPx) + "px";
        block.textContent = t.name || "(No name)";

        lane.appendChild(block);
    });

    // ========== Background lane ==========
    const msPerDay = 24*60*60000;
    bgTasks.forEach(bg => {
        if (!bg.date || !bg.startTime || !bg.endTime) return;

        const baseDate = new Date(bg.date + "T00:00:00");
        const dayDelta = baseDate.getTime() - todayStart.getTime();
        const dayIndex = Math.floor(dayDelta / msPerDay);
        if (dayIndex < 0) return;

        const [sh, sm] = bg.startTime.split(":").map(Number);
        const [eh, em] = bg.endTime.split(":").map(Number);
        if (isNaN(sh) || isNaN(sm) || isNaN(eh) || isNaN(em)) return;

        let startMinDay = sh*60 + sm;
        let endMinDay   = eh*60 + em;
        if (endMinDay <= startMinDay) return;

        let startGlobal = dayIndex*1440 + startMinDay;
        let endGlobal   = dayIndex*1440 + endMinDay;

        if (startGlobal > totalMinutes) return;
        if (endGlobal > totalMinutes) endGlobal = totalMinutes;
        if (endGlobal <= 0) return;

        const block = document.createElement("div");
        block.classList.add("timeline-block", "timeline-block-background");

        const leftPx = startGlobal * pxPerMinute;
        const widthPx = (endGlobal - startGlobal) * pxPerMinute;

        block.style.left = leftPx + "px";
        block.style.width = Math.max(10, widthPx) + "px";
        block.textContent = bg.name || "(BG)";

        laneBackground.appendChild(block);
    });

    updateTimelineCurrentLine();
}

function updateTimelineCurrentLine() {
    const currentLine = document.getElementById("timelineCurrentLine");
    if (!currentLine) return;
    if (!state.timeline.todayStart) return;

    const todayStart = state.timeline.todayStart;
    const now = new Date();
    const diffMin = (now - todayStart)/60000;
    const totalMinutes = state.timeline.totalMinutes;
    const pxPerMinute = zoomLevel;

    if (diffMin < 0 || diffMin > totalMinutes) {
        currentLine.style.display = "none";
        return;
    }

    currentLine.style.display = "block";
    currentLine.style.left = (diffMin * pxPerMinute) + "px";
}

// cập nhật vạch đỏ mỗi phút
setInterval(() => {
    if (state.currentTab === "timeline") {
        updateTimelineCurrentLine();
    }
}, 60000);

// ========== ZOOM & JUMP TO NOW ==========
window.zoomIn = function () {
    const scrollBox = document.querySelector(".timeline-scroll");
    if (!scrollBox) return;

    if (zoomLevel === 4) return;

    const oldZoom = zoomLevel;
    const centerX = scrollBox.scrollLeft + scrollBox.clientWidth / 2;
    const centerMinute = centerX / oldZoom;

    zoomLevel = zoomLevel * 2;
    document.getElementById("zoomDisplay").innerText = (zoomLevel * 100) + "%";

    renderTimeline();

    const newScrollLeft = centerMinute * zoomLevel - scrollBox.clientWidth / 2;
    scrollBox.scrollLeft = newScrollLeft;
};

window.zoomOut = function () {
    const scrollBox = document.querySelector(".timeline-scroll");
    if (!scrollBox) return;

    if (zoomLevel === 1) return;

    const oldZoom = zoomLevel;
    const centerX = scrollBox.scrollLeft + scrollBox.clientWidth / 2;
    const centerMinute = centerX / oldZoom;

    zoomLevel = zoomLevel / 2;
    document.getElementById("zoomDisplay").innerText = (zoomLevel * 100) + "%";

    renderTimeline();

    const newScrollLeft = centerMinute * zoomLevel - scrollBox.clientWidth / 2;
    scrollBox.scrollLeft = newScrollLeft;
};

window.jumpToNow = function () {
    const line = document.getElementById("timelineCurrentLine");
    const scrollBox = document.querySelector(".timeline-scroll");
    if (!line || !scrollBox) return;

    const lineLeft = line.offsetLeft;
    if (!lineLeft || isNaN(lineLeft)) return;

    scrollBox.scrollTo({
        left: lineLeft - scrollBox.clientWidth/2,
        behavior: "smooth"
    });
};

// ========== SCROLL HORIZONTAL WHEN WHEEL ==========
const scrollArea = document.querySelector(".timeline-scroll");
if (scrollArea) {
    scrollArea.addEventListener("wheel", (ev) => {
        ev.preventDefault();
        scrollArea.scrollLeft += ev.deltaY * 1;
    }, { passive: false });
}

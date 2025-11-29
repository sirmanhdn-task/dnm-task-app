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
    },
    timeline: {
        pxPerMinute: 1,   // 1 phút = 1 px (1 ngày = 1440px)
        todayStart: null,
        totalMinutes: 1440
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
    if (tab === "timeline") renderTimeline();
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
    // Ưu tiên field type, fallback từ pending boolean nếu có
    if (task.type === "normal" || task.type === "pending" || task.type === "background") {
        return task.type;
    }
    if (task.pending === true) return "pending";
    return "normal";
}

// ========== SCORE ==========
function computeScore(task) {
    const type = getTaskType(task);

    // Done luôn -1
    if (task.done) return -1;

    // Pending: không tham gia chấm điểm chính
    if (type === "pending") return -0.5;

    // Background: không tham gia scoring
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

// ========== STATUS RANK (Normal < Pending < Background < Done) ==========
function taskStatusRank(t) {
    const type = getTaskType(t);
    if (t.done) return 3;
    if (type === "background") return 2;
    if (type === "pending") return 1;
    return 0; // normal
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
        createdAt: serverTimestamp()
    });

    document.getElementById("name").value = "";
    document.getElementById("description").value = "";
    document.getElementById("estimated").value = 10;
    document.getElementById("deadline").value = "";

    // reset pills
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
            if (ra !== rb) return ra - rb; // Normal(0) → Pending(1) → Background(2) → Done(3)

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
            // DONE: Sửa + UNDONE + Xóa
            footerHtml = `
                <button class="edit-btn">Sửa</button>
                <button class="done-btn" style="background:#009688">UNDONE</button>
                <button class="delete-btn">Xóa</button>
            `;
        } else if (type === "pending") {
            // PENDING: chỉ Sửa + Xóa
            footerHtml = `
                <button class="edit-btn">Sửa</button>
                <button class="delete-btn">Xóa</button>
            `;
        } else {
            // NORMAL / BACKGROUND (hiện chưa có background UI)
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

    // type
    document.querySelectorAll('input[name="typeEdit"]').forEach(r => {
        r.checked = (r.value === type);
    });

    // mode
    document.querySelectorAll('input[name="modeEdit"]').forEach(r => r.checked = false);
    const modeRadio = document.querySelector(`input[name="modeEdit"][value="${task.mode}"]`);
    if (modeRadio) modeRadio.checked = true;

    // pills
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
    if (el.disabled) return;
    el.classList.toggle("pill-selected");
};

function getSelectedValues(selector) {
    return Array.from(document.querySelectorAll(selector))
        .filter(el => el.classList.contains("pill-selected"))
        .map(el => el.dataset.value);
}

// ========== TIMELINE RENDERING V4 ==========

function renderTimeline() {
    const container = document.getElementById("timelineContainer");
    if (!container) return;

    const laneNormal = document.getElementById("lane-normal");
    const laneBackground = document.getElementById("lane-background");
    const lanePending = document.getElementById("lane-pending");
    const daysContainer = document.getElementById("timelineDays");
    const header = document.getElementById("timelineHeader");
    const currentLine = document.getElementById("timelineCurrentLine");

    laneNormal.innerHTML = "";
    laneBackground.innerHTML = "";
    lanePending.innerHTML = "";
    daysContainer.innerHTML = "";
    header.innerHTML = "";

    const tasks = state.tasks || [];
    const todayStart = getTodayStart();
    state.timeline.todayStart = todayStart;

    let maxEnd = new Date(todayStart.getTime() + 24*60*60000); // tối thiểu 1 ngày

    tasks.forEach(t => {
        if (!t.deadline) return;
        const dl = new Date(t.deadline);
        if (!isNaN(dl.getTime())) {
            if (dl.getTime() > maxEnd.getTime()) {
                maxEnd = dl;
            }
        }
    });

    let totalMinutes = Math.max(1440, Math.ceil((maxEnd - todayStart)/60000));
    // làm tròn theo ngày
    const totalDays = Math.max(1, Math.ceil(totalMinutes / 1440));
    totalMinutes = totalDays * 1440;
    state.timeline.totalMinutes = totalMinutes;

    const pxPerMinute = state.timeline.pxPerMinute;
    const totalWidth = totalMinutes * pxPerMinute;

    container.style.width = totalWidth + "px";

    // vẽ dải ngày
    for (let d=0; d<totalDays; d++) {
        const dayDiv = document.createElement("div");
        dayDiv.className = "timeline-day-strip";

        const left = d * 1440 * pxPerMinute;
        const width = 1440 * pxPerMinute;

        dayDiv.style.left = left + "px";
        dayDiv.style.width = width + "px";

        // ngày 0: trắng, sau đó tối dần
        if (d === 0) {
            dayDiv.style.background = "#ffffff";
        } else {
            const shade = 250 - d*10; // giảm dần
            const c = Math.max(210, shade);
            dayDiv.style.background = `rgb(${c},${c},${c})`;
        }

        daysContainer.appendChild(dayDiv);
    }

    // header: đánh dấu mỗi 3 giờ
    for (let m=0; m<=totalMinutes; m+=180) { // 180 phút = 3h
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

    // vẽ block
    tasks.forEach(t => {
        const type = getTaskType(t);
        if (!t.deadline) return;
        const dl = new Date(t.deadline);
        if (isNaN(dl.getTime())) return;

        const estimated = Number(t.estimated) || 0;
        if (estimated <= 0) return;

        // minutes từ todayStart tới deadline
        let endMin = (dl - todayStart)/60000;
        if (endMin < 0) return; // quá khứ xa

        // anchor theo deadline
        let startMin = endMin - estimated;
        if (startMin < 0) {
            startMin = 0;
            endMin = estimated;
        }

        // clamp
        if (endMin > totalMinutes) endMin = totalMinutes;
        if (startMin > totalMinutes) return;

        const lane = (type === "pending")
            ? lanePending
            : (type === "background" ? laneBackground : laneNormal);

        const block = document.createElement("div");
        block.classList.add("timeline-block");

        if (type === "pending") block.classList.add("timeline-block-pending");
        else if (type === "background") block.classList.add("timeline-block-background");
        else block.classList.add("timeline-block-normal");

        const leftPx = startMin * pxPerMinute;
        const widthPx = (endMin - startMin) * pxPerMinute;

        block.style.left = leftPx + "px";
        block.style.width = Math.max(10, widthPx) + "px"; // tối thiểu 10px cho dễ thấy

        block.textContent = t.name || "(No name)";

        lane.appendChild(block);
    });

    // vẽ current line
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
    const pxPerMinute = state.timeline.pxPerMinute;

    if (diffMin < 0 || diffMin > totalMinutes) {
        currentLine.style.display = "none";
        return;
    }

    currentLine.style.display = "block";
    currentLine.style.left = (diffMin * pxPerMinute) + "px";
}

// Cập nhật vạch đỏ mỗi phút
setInterval(() => {
    if (state.currentTab === "timeline") {
        updateTimelineCurrentLine();
    }
}, 60000);

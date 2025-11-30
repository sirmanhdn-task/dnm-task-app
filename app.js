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
    getDocs,
    query,
    where,
    orderBy
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";

// ========== Firebase config ==========
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
const db = getFirestore(app);

// ========== GLOBAL STATE ==========
const state = {
    user: null,
    tasks: [],
    backgroundTasks: [],
    hideDone: false,
    settings: {
        quickBoost: 50,
        timeMatchMultiplier: 1.5,
        deadlinePenaltyFactor: 1.0,
        estimatedWeight: 1.0
    },
    timeline: {
        totalMinutes: 1440
    }
};

let zoomLevel = 1; // px per minute
const MAX_FILL_DAYS = 14;
const MAX_FILL_MINUTES = MAX_FILL_DAYS * 1440;

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
    } catch(e) {
        console.error("Lỗi load settings:", e);
    }
}

function saveSettingsToLocalStorage() {
    const obj = {
        quickBoost: state.settings.quickBoost,
        timeMatchMultiplier: state.settings.timeMatchMultiplier,
        deadlinePenaltyFactor: state.settings.deadlinePenaltyFactor,
        estimatedWeight: state.settings.estimatedWeight
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(obj));
}

// ========== AUTH UI ==========
const loginBtn = document.getElementById("loginBtn");
const logoutBtn = document.getElementById("logoutBtn");
const userInfoDiv = document.getElementById("userInfo");
const loginAreaDiv = document.getElementById("loginArea");
const userNameSpan = document.getElementById("userName");
const notLoggedInMessage = document.getElementById("notLoggedInMessage");
const appContent = document.getElementById("appContent");

loginBtn.onclick = async () => {
    try {
        const provider = new GoogleAuthProvider();
        await signInWithPopup(auth, provider);
    } catch (err) {
        console.error("Login error:", err);
        alert("Đăng nhập thất bại");
    }
};

logoutBtn.onclick = async () => {
    try {
        await signOut(auth);
    } catch (err) {
        console.error("Logout error:", err);
    }
};

onAuthStateChanged(auth, async (user) => {
    state.user = user;
    if (!user) {
        userInfoDiv.classList.add("hidden");
        loginAreaDiv.classList.remove("hidden");
        notLoggedInMessage.classList.remove("hidden");
        appContent.classList.add("hidden");
        state.tasks = [];
        state.backgroundTasks = [];
        renderTaskList();
        renderBackgroundList();
        renderTimeline();
        return;
    }

    userInfoDiv.classList.remove("hidden");
    loginAreaDiv.classList.add("hidden");
    notLoggedInMessage.classList.add("hidden");
    appContent.classList.remove("hidden");
    userNameSpan.textContent = user.displayName || user.email || "User";

    await loadAllData();
});

// ========== FIRESTORE HELPERS ==========
function tasksCollectionRef() {
    if (!state.user) return null;
    return collection(db, "users", state.user.uid, "tasks");
}

function backgroundCollectionRef() {
    if (!state.user) return null;
    return collection(db, "users", state.user.uid, "backgroundTasks");
}

async function loadAllData() {
    if (!state.user) return;
    await Promise.all([loadTasksFromFirestore(), loadBackgroundFromFirestore()]);
    renderTaskList();
    renderBackgroundList();
    renderTimeline();
}

async function loadTasksFromFirestore() {
    try {
        const colRef = tasksCollectionRef();
        if (!colRef) return;
        const qSnap = await getDocs(colRef);
        const arr = [];
        qSnap.forEach(docSnap => {
            const data = docSnap.data();
            data.id = docSnap.id;
            arr.push(data);
        });
        state.tasks = arr;
    } catch (err) {
        console.error("Load tasks error:", err);
    }
}

async function loadBackgroundFromFirestore() {
    try {
        const colRef = backgroundCollectionRef();
        if (!colRef) return;
        const qSnap = await getDocs(colRef);
        const arr = [];
        qSnap.forEach(docSnap => {
            const data = docSnap.data();
            data.id = docSnap.id;
            arr.push(data);
        });
        state.backgroundTasks = arr;
    } catch (err) {
        console.error("Load background error:", err);
    }
}

// ========== SWITCH TAB ==========
window.switchTab = function(tabName) {
    const tabIds = ["timeline", "list", "background", "settings"];
    tabIds.forEach(t => {
        const div = document.getElementById("tab-" + t);
        const btn = document.getElementById("tab-" + t + "-btn");
        if (!div || !btn) return;
        if (t === tabName) {
            div.classList.remove("hidden");
            btn.classList.add("tab-btn-active");
        } else {
            div.classList.add("hidden");
            btn.classList.remove("tab-btn-active");
        }
    });

    if (tabName === "timeline") {
        renderTimeline();
    } else if (tabName === "list") {
        renderTaskList();
    } else if (tabName === "background") {
        renderBackgroundList();
    }
};

// ========== SCORE & FILTERS ==========
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

// ... (toàn bộ các hàm computeScore, addTask, renderTaskList, edit, delete, DONE/UNDONE, background tasks, buildSlots, zoomIn/zoomOut, jumpToNow, v.v. giữ nguyên như V6.1) ...

// ========== TIMELINE RENDERING ==========
function renderTimeline() {
    const container = document.getElementById("timelineContainer");
    if (!container) return;

    const laneNormal = document.getElementById("lane-normal");
    const laneBackground = document.getElementById("lane-background");
    const lanePending = document.getElementById("lane-pending");
    const daysContainer = document.getElementById("timelineDays");
    const header = document.getElementById("timelineHeader");
    const dayHeader = document.getElementById("timelineDayHeader");
    const availContainer = document.getElementById("timelineAvailability");

    laneNormal.innerHTML = "";
    laneBackground.innerHTML = "";
    lanePending.innerHTML = "";
    daysContainer.innerHTML = "";
    header.innerHTML = "";
    if (dayHeader) dayHeader.innerHTML = "";
    if (availContainer) availContainer.innerHTML = "";

    const tasks = state.tasks || [];
    const bgTasks = state.backgroundTasks || [];

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0,0,0,0);

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
    if (dayHeader) {
        dayHeader.style.width = totalWidth + "px";
        renderDayHeader(dayHeader, todayStart, totalDays, pxPerMinute);
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
            dayDiv.style.background = `rgb(${shade},${shade},${shade})`;
        }
        daysContainer.appendChild(dayDiv);
    }

    // Header giờ (mỗi 60 phút)
    const stepMinutes = 60;
    for (let m=0; m<=totalMinutes; m+=stepMinutes) {
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
        const slots = buildSlots(todayStart, totalMinutes);
        slots.forEach(slot => {
            const div = document.createElement("div");
            div.className = "timeline-availability-slot " +
                (slot.status === "available" ? "timeline-availability-available" : "timeline-availability-unavailable");
            const left = slot.start * pxPerMinute;
            const width = (slot.end - slot.start) * pxPerMinute;
            div.style.left = left + "px";
            div.style.width = width + "px";
            availContainer.appendChild(div);
        });
    }

    // TODO: v6.x tiếp theo: fill normal tasks vào slot.

    updateTimelineCurrentLine();
}

function renderDayHeader(dayHeaderElem, todayStart, totalDays, pxPerMinute) {
    if (!dayHeaderElem || !todayStart || !totalDays || !pxPerMinute) return;

    dayHeaderElem.innerHTML = "";

    for (let d = 0; d < totalDays; d++) {
        const dayDate = new Date(todayStart.getTime() + d * 1440 * 60000);
        const labelDiv = document.createElement("div");
        labelDiv.className = "timeline-day-label";

        const left = d * 1440 * pxPerMinute;
        const width = 1440 * pxPerMinute;

        labelDiv.style.left = left + "px";
        labelDiv.style.width = width + "px";

        const opts = { weekday: "short", day: "2-digit", month: "2-digit" };
        labelDiv.textContent = dayDate.toLocaleDateString("vi-VN", opts);

        dayHeaderElem.appendChild(labelDiv);
    }
}

function updateTimelineCurrentLine() {
    const currentLine = document.getElementById("timelineCurrentLine");
    const container = document.getElementById("timelineContainer");
    if (!currentLine || !container) return;

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0,0,0,0);
    const minutesFromStart = Math.max(0, Math.min(state.timeline.totalMinutes, (now - todayStart)/60000));
    const left = minutesFromStart * zoomLevel;
    currentLine.style.left = left + "px";
}

// Zoom
window.zoomIn = function() {
    zoomLevel *= 1.25;
    if (zoomLevel > 5) zoomLevel = 5;
    document.getElementById("zoomDisplay").textContent = Math.round(zoomLevel*100) + "%";
    renderTimeline();
};

window.zoomOut = function() {
    zoomLevel /= 1.25;
    if (zoomLevel < 0.3) zoomLevel = 0.3;
    document.getElementById("zoomDisplay").textContent = Math.round(zoomLevel*100) + "%";
    renderTimeline();
};

// Jump to now
window.jumpToNow = function() {
    const scroll = document.querySelector(".timeline-scroll");
    if (!scroll) return;
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0,0,0,0);
    const minutesFromStart = (now - todayStart)/60000;
    const x = minutesFromStart * zoomLevel;
    scroll.scrollLeft = Math.max(0, x - scroll.clientWidth/2);
};

// Debug slots
window.debugSlots = function() {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0,0,0,0);
    const s = buildSlots(todayStart, state.timeline.totalMinutes || 1440);
    console.log("Slots (10 phút, tối đa 14 ngày) ===");
    console.log(s);
    console.log("Tổng số slot:", s.length);
};

// ... cuối file giữ nguyên các hàm cho list, background, settings, popup ...

// Khởi động
loadSettingsFromLocalStorage();
renderTimeline();
renderTaskList();
renderBackgroundList();

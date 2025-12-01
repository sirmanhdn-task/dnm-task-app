// ===================================================
// FIREBASE INIT
// ===================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
  getFirestore,
  collection,
  addDoc,
  getDocs,
  serverTimestamp,
  doc,
  getDoc,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyDtF1mKOXncAyMSeEJsiBlEyEaKIKiJUbQ",
  authDomain: "dnmstasker.firebaseapp.com",
  projectId: "dnmstasker",
  storageBucket: "dnmstasker.firebasestorage.app",
  messagingSenderId: "98582966566",
  appId: "1:98582966566:web:465036b33c45b5c8edd1e7"
};


const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ===================================================
// TAB HANDLING
// ===================================================
document.querySelectorAll(".tab-button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const id = btn.dataset.tabTarget;

    document.querySelectorAll(".tab-button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");

    document.querySelectorAll(".tab-panel").forEach(panel => {
      panel.classList.toggle("active", panel.id === id);
    });
  });
});

// ===================================================
// TIMELINE CONSTANTS
// ===================================================
const timelineScroll = document.getElementById("timelineScroll");
const timelineHeader = document.getElementById("timelineHeader");
const nowMarker = document.getElementById("timelineNowMarker");

const MS_PER_HOUR = 3600000;
const MS_PER_DAY = 86400000;
const DAYS_TOTAL = 14;
const HOURS_TOTAL = DAYS_TOTAL * 24;

let pixelsPerHour = 60;
const MIN_PX = 24;
const MAX_PX = 160;

const startOfToday = (() => {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
})();

function formatDayLabel(date) {
  const w = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
  return `${w[date.getDay()]} ${date.getDate()}`;
}

// ===================================================
// RENDER TIMELINE
// ===================================================
function renderTimeline() {
  const totalWidth = HOURS_TOTAL * pixelsPerHour;
  timelineHeader.innerHTML = "";
  timelineHeader.style.width = totalWidth + "px";

  for (let d = 0; d < DAYS_TOTAL; d++) {
    const date = new Date(startOfToday.getTime() + d * MS_PER_DAY);

    const dayDiv = document.createElement("div");
    dayDiv.classList.add("timeline-day");
    if (d === 0) dayDiv.classList.add("today");
    if (d === 1) dayDiv.classList.add("future-1");
    if (d === 2) dayDiv.classList.add("future-2");

    dayDiv.style.width = (24 * pixelsPerHour) + "px";

    const label = document.createElement("div");
    label.className = "timeline-day-label";
    label.textContent = formatDayLabel(date);

    const hoursDiv = document.createElement("div");
    hoursDiv.className = "timeline-day-hours";

    for (let h = 0; h < 24; h++) {
      const hour = document.createElement("div");
      hour.className = "timeline-hour";
      hour.style.width = pixelsPerHour + "px";
      hour.textContent = h % 2 === 0 ? `${h}:00` : "";
      hoursDiv.appendChild(hour);
    }

    dayDiv.appendChild(label);
    dayDiv.appendChild(hoursDiv);
    timelineHeader.appendChild(dayDiv);
  }

  ["laneMainContent", "laneBackgroundContent", "lanePendingContent"].forEach(id => {
    const lane = document.getElementById(id);
    lane.style.width = totalWidth + "px";
  });

  updateNowMarker();
}

function updateNowMarker() {
  const now = new Date();
  const diff = now - startOfToday;

  if (diff < 0 || diff >= DAYS_TOTAL * MS_PER_DAY) {
    nowMarker.style.display = "none";
    return;
  }

  nowMarker.style.display = "block";
  const hours = diff / MS_PER_HOUR;
  nowMarker.style.left = (hours * pixelsPerHour) + "px";
}

// ===================================================
// ZOOM & JUMP
// ===================================================
function zoom(factor) {
  const centerTime =
    (timelineScroll.scrollLeft + timelineScroll.clientWidth / 2) / pixelsPerHour;

  pixelsPerHour = Math.max(MIN_PX, Math.min(MAX_PX, pixelsPerHour * factor));
  renderTimeline();

  timelineScroll.scrollLeft =
    centerTime * pixelsPerHour - timelineScroll.clientWidth / 2;
}

function scrollToTime(hours) {
  timelineScroll.scrollLeft =
    hours * pixelsPerHour - timelineScroll.clientWidth / 2;
}

function jumpNow() {
  const now = new Date();
  const diff = now - startOfToday;
  const hours = diff / MS_PER_HOUR;
  scrollToTime(hours);
}

document.getElementById("zoomInBtn").addEventListener("click", () => zoom(1.2));
document.getElementById("zoomOutBtn").addEventListener("click", () => zoom(1 / 1.2));
document.getElementById("jumpNowBtn").addEventListener("click", jumpNow);

// ===================================================
// CALENDAR MODAL – CLICK ONLY
// ===================================================
const jumpDateButton = document.getElementById("jumpDateButton");
const jumpDateModal = document.getElementById("jumpDateModal");
const calendarGrid = document.getElementById("calendarGrid");
const closeJumpModal = document.getElementById("closeJumpModal");

function handleJumpDateChosen(iso) {
  const chosen = new Date(iso + "T00:00:00");
  const diff = chosen - startOfToday;
  const dayIndex = diff / MS_PER_DAY;
  const hours = dayIndex * 24 + 8;
  scrollToTime(hours);
}

function renderCalendar() {
  calendarGrid.innerHTML = "";

  for (let i = 0; i < DAYS_TOTAL; i++) {
    const d = new Date(startOfToday.getTime() + i * MS_PER_DAY);

    const div = document.createElement("div");
    div.className = "calendar-day";
    if (i === 0) div.classList.add("today");

    div.textContent = d.getDate();

    div.addEventListener("click", () => {
      jumpDateModal.classList.remove("active");
      handleJumpDateChosen(d.toISOString().slice(0, 10));
    });

    calendarGrid.appendChild(div);
  }
}

jumpDateButton.addEventListener("click", () => {
  renderCalendar();
  jumpDateModal.classList.add("active");
});

closeJumpModal.addEventListener("click", () =>
  jumpDateModal.classList.remove("active")
);

jumpDateModal.addEventListener("click", (e) => {
  if (e.target === jumpDateModal) jumpDateModal.classList.remove("active");
});

// ===================================================
// PILL TOGGLE LOGIC
// ===================================================
const pillMainPending = document.getElementById("pillMainPending");
const pillMainParallel = document.getElementById("pillMainParallel");
const cbMainPending = document.getElementById("mainIsPending");
const cbMainParallel = document.getElementById("mainIsParallel");

pillMainPending.addEventListener("click", () => {
  pillMainPending.classList.toggle("active");
  cbMainPending.checked = pillMainPending.classList.contains("active");
});

pillMainParallel.addEventListener("click", () => {
  pillMainParallel.classList.toggle("active");
  cbMainParallel.checked = pillMainParallel.classList.contains("active");
});

const pillBgParallel = document.getElementById("pillBgParallel");
const cbBgParallel = document.getElementById("bgIsParallel");

pillBgParallel.addEventListener("click", () => {
  pillBgParallel.classList.toggle("active");
  cbBgParallel.checked = pillBgParallel.classList.contains("active");
});

// ===================================================
// COUNTER HELPER – GÁN ID TỰ TĂNG
// ===================================================
async function getNextCounter(fieldName) {
  const countersRef = doc(db, "metadata", "counters");
  const snap = await getDoc(countersRef);

  let data;
  if (!snap.exists()) {
    data = { mainTaskCount: 0, backgroundTaskCount: 0 };
  } else {
    data = snap.data();
    if (data.mainTaskCount == null) data.mainTaskCount = 0;
    if (data.backgroundTaskCount == null) data.backgroundTaskCount = 0;
  }

  const newCount = (data[fieldName] || 0) + 1;
  data[fieldName] = newCount;

  await setDoc(countersRef, data);
  return newCount;
}

// ===================================================
// MAIN TASKS – SUBMIT
// ===================================================
document.getElementById("mainTaskForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const title = document.getElementById("mainTitle").value;
  const description = document.getElementById("mainDescription").value;
  const importance = Number(document.getElementById("mainImportance").value);
  const duration = Number(document.getElementById("mainDuration").value);
  const deadlineStr = document.getElementById("mainDeadline").value;

  const isPending = cbMainPending.checked;
  const isParallel = cbMainParallel.checked;

  let deadlineAt = null;
  if (deadlineStr) {
    const d = new Date(deadlineStr);
    deadlineAt = d.toISOString();
  }

  try {
    const taskId = await getNextCounter("mainTaskCount");

    await addDoc(collection(db, "mainTasks"), {
      taskId,
      title,
      description,
      importance,
      duration,
      deadlineAt,
      isPending,
      isParallel,
      createdAt: serverTimestamp()
    });

    e.target.reset();
    pillMainPending.classList.remove("active");
    pillMainParallel.classList.remove("active");
    cbMainPending.checked = false;
    cbMainParallel.checked = false;

    loadAllData();
  } catch (err) {
    console.error("Error adding main task:", err);
    alert("Lỗi khi lưu main task. Kiểm tra console.");
  }
});

// ===================================================
// MAIN TASKS – LOAD & SORT (PRIORITY MỚI)
// ===================================================
async function loadMainTasks() {
  const snap = await getDocs(collection(db, "mainTasks"));
  const items = [];
  snap.forEach(docSnap => items.push({ id: docSnap.id, ...docSnap.data() }));

  const now = Date.now();
  const FORTY_EIGHT_HOURS_MIN = 48 * 60;

  items.forEach(task => {
    // minutesUntilDeadline
    let minutesLeft;
    if (task.deadlineAt) {
      const d = new Date(task.deadlineAt);
      const diffMs = d.getTime() - now;
      minutesLeft = diffMs <= 0 ? 1 : Math.max(1, Math.round(diffMs / 60000));
    } else if (typeof task.deadline === "number") {
      // fallback cho dữ liệu cũ
      minutesLeft = Math.max(1, task.deadline);
    } else {
      minutesLeft = Infinity;
    }

    const duration = Number(task.duration) || 0;
    const priority = (minutesLeft === Infinity || minutesLeft <= 0)
      ? 0
      : duration / minutesLeft;

    const isShortBoost =
      duration <= 10 && minutesLeft <= FORTY_EIGHT_HOURS_MIN;

    task._minutesLeft = minutesLeft;
    task._priority = priority;
    task._isShortBoost = isShortBoost;
  });

  // Sort:
  // 1. isShortBoost = true trước
  // 2. priority giảm dần
  items.sort((a, b) => {
    if (a._isShortBoost && !b._isShortBoost) return -1;
    if (!a._isShortBoost && b._isShortBoost) return 1;

    const pa = a._priority || 0;
    const pb = b._priority || 0;
    return pb - pa;
  });

  const list = document.getElementById("mainTaskList");
  list.innerHTML = "";

  items.forEach(task => {
    const div = document.createElement("div");
    div.className = "task-item task-item-main";

    const idText = typeof task.taskId === "number" ? `#${task.taskId} ` : "";
    const deadlineText = task.deadlineAt
      ? new Date(task.deadlineAt).toLocaleString()
      : "N/A";

    const minutesText =
      task._minutesLeft === Infinity ? "N/A" : `${task._minutesLeft} phút`;
    const priorityText = isFinite(task._priority)
      ? task._priority.toFixed(3)
      : "N/A";

    div.innerHTML = `
      <h4>${idText}${task.title}</h4>
      <p>${task.description || ""}</p>
      <p class="task-meta">
        Importance: ${task.importance} · Duration: ${task.duration} phút
      </p>
      <p class="task-meta">
        Deadline: ${deadlineText} · Còn khoảng: ${minutesText}
      </p>
      <p class="task-meta">
        Short-boost: ${task._isShortBoost ? "Có" : "Không"} ·
        Priority: ${priorityText} ·
        Parallel: ${task.isParallel ? "Có" : "Không"} ·
        Pending: ${task.isPending ? "Có" : "Không"}
      </p>
    `;

    list.appendChild(div);
  });
}

// ===================================================
// BACKGROUND TASKS – SUBMIT
// ===================================================
document.getElementById("backgroundTaskForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const title = document.getElementById("bgTitle").value;
  const description = document.getElementById("bgDescription").value;
  const startTime = document.getElementById("bgStartTime").value;
  const endTime = document.getElementById("bgEndTime").value;
  const isParallel = cbBgParallel.checked;

  try {
    const taskId = await getNextCounter("backgroundTaskCount");

    await addDoc(collection(db, "backgroundTasks"), {
      taskId,
      title,
      description,
      startTime,
      endTime,
      isParallel,
      createdAt: serverTimestamp()
    });

    e.target.reset();
    pillBgParallel.classList.remove("active");
    cbBgParallel.checked = false;

    loadAllData();
  } catch (err) {
    console.error("Error adding background task:", err);
    alert("Lỗi khi lưu background task. Kiểm tra console.");
  }
});

// ===================================================
// BACKGROUND TASKS – LOAD
// ===================================================
async function loadBackgroundTasks() {
  const snap = await getDocs(collection(db, "backgroundTasks"));
  const items = [];
  snap.forEach(docSnap => items.push({ id: docSnap.id, ...docSnap.data() }));

  items.sort((a, b) =>
    (a.startTime || "").localeCompare(b.startTime || "")
  );

  const list = document.getElementById("backgroundTaskList");
  list.innerHTML = "";

  items.forEach(task => {
    const div = document.createElement("div");
    div.className = "task-item task-item-bg";

    const idText = typeof task.taskId === "number" ? `#${task.taskId} ` : "";

    div.innerHTML = `
      <h4>${idText}${task.title}</h4>
      <p>${task.description || ""}</p>
      <p class="task-meta">
        ${task.startTime} – ${task.endTime} ·
        Parallel: ${task.isParallel ? "Có" : "Không"}
      </p>
    `;

    list.appendChild(div);
  });
}

// ===================================================
// LOAD ALL & INIT
// ===================================================
async function loadAllData() {
  await Promise.all([loadMainTasks(), loadBackgroundTasks()]);
}

renderTimeline();
jumpNow();
loadAllData();

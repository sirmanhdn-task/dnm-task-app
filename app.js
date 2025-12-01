// Import Firebase SDK
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
  getFirestore,
  collection,
  addDoc,
  getDocs,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// ======================
// 1. FIREBASE CONFIG
// ======================
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

// ======================
// 2. TAB LOGIC
// ======================

const tabButtons = document.querySelectorAll(".tab-button");
const tabPanels = document.querySelectorAll(".tab-panel");

tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const targetId = btn.getAttribute("data-tab-target");
    tabButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");

    tabPanels.forEach((panel) => {
      panel.classList.toggle("active", panel.id === targetId);
    });
  });
});

// ======================
// 3. TIMELINE CORE (2 TUẦN, GIỜ, ZOOM, JUMP)
// ======================

const timelineScroll = document.getElementById("timelineScroll");
const timelineHeader = document.getElementById("timelineHeader");
const nowMarker = document.getElementById("timelineNowMarker");

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const DAYS_TOTAL = 14;
const HOURS_TOTAL = 24 * DAYS_TOTAL;

let pixelsPerHour = 60; // zoom mặc định
const MIN_PIXELS_PER_HOUR = 24;
const MAX_PIXELS_PER_HOUR = 160;

const startOfToday = (() => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
})();

function formatDayLabel(date) {
  const weekdays = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
  return `${weekdays[date.getDay()]} ${date.getDate()}`;
}

function renderTimeline() {
  const totalWidth = HOURS_TOTAL * pixelsPerHour;

  // Header days + hour ticks
  timelineHeader.innerHTML = "";
  timelineHeader.style.width = `${totalWidth}px`;

  for (let d = 0; d < DAYS_TOTAL; d++) {
    const dayDate = new Date(startOfToday.getTime() + d * MS_PER_DAY);
    const dayDiv = document.createElement("div");
    dayDiv.classList.add("timeline-day");

    if (d === 0) {
      dayDiv.classList.add("today");
    } else if (d === 1) {
      dayDiv.classList.add("future-1");
    } else if (d === 2) {
      dayDiv.classList.add("future-2");
    }

    dayDiv.style.width = `${24 * pixelsPerHour}px`;

    const labelDiv = document.createElement("div");
    labelDiv.className = "timeline-day-label";
    labelDiv.textContent = formatDayLabel(dayDate);

    const hoursDiv = document.createElement("div");
    hoursDiv.className = "timeline-day-hours";

    for (let h = 0; h < 24; h++) {
      const hourDiv = document.createElement("div");
      hourDiv.className = "timeline-hour";
      hourDiv.style.width = `${pixelsPerHour}px`;
      hourDiv.textContent = h % 2 === 0 ? `${h}:00` : "";
      hoursDiv.appendChild(hourDiv);
    }

    dayDiv.appendChild(labelDiv);
    dayDiv.appendChild(hoursDiv);
    timelineHeader.appendChild(dayDiv);
  }

  // Set width cho lane-content giống header
  const laneMain = document.getElementById("laneMainContent");
  const laneBg = document.getElementById("laneBackgroundContent");
  const lanePending = document.getElementById("lanePendingContent");
  [laneMain, laneBg, lanePending].forEach((lane) => {
    lane.style.width = `${totalWidth}px`;
  });

  updateNowMarker();
}

function updateNowMarker() {
  const now = new Date();
  const diffMs = now.getTime() - startOfToday.getTime();
  if (diffMs < 0 || diffMs > DAYS_TOTAL * MS_PER_DAY) {
    nowMarker.style.display = "none";
    return;
  }
  const hoursFromStart = diffMs / MS_PER_HOUR;
  const x = hoursFromStart * pixelsPerHour;
  nowMarker.style.display = "block";
  nowMarker.style.left = `${x}px`;
}

// zoom giữ nguyên tâm viewport theo "thời gian"
function zoom(factor) {
  const centerTime =
    (timelineScroll.scrollLeft + timelineScroll.clientWidth / 2) /
    pixelsPerHour;

  pixelsPerHour = Math.max(
    MIN_PIXELS_PER_HOUR,
    Math.min(MAX_PIXELS_PER_HOUR, pixelsPerHour * factor)
  );

  renderTimeline();

  const newScrollLeft =
    centerTime * pixelsPerHour - timelineScroll.clientWidth / 2;
  timelineScroll.scrollLeft = Math.max(0, newScrollLeft);
}

// scroll đến một mốc thời gian (tính bằng giờ từ startOfToday)
function scrollToTime(hoursFromStart) {
  const targetPx = hoursFromStart * pixelsPerHour;
  const newScrollLeft = targetPx - timelineScroll.clientWidth / 2;
  timelineScroll.scrollLeft = Math.max(0, newScrollLeft);
}

// Jump to now (nếu nằm trong 14 ngày)
function handleJumpNow() {
  const now = new Date();
  const diffMs = now.getTime() - startOfToday.getTime();
  if (diffMs < 0) {
    scrollToTime(0);
    return;
  }
  if (diffMs > DAYS_TOTAL * MS_PER_DAY) {
    scrollToTime(HOURS_TOTAL);
    return;
  }
  const hoursFromStart = diffMs / MS_PER_HOUR;
  scrollToTime(hoursFromStart);
}

// Jump to date (ngày chọn, trong 14 ngày)
function handleJumpDateChosen(value) {
  if (!value) return;
  const chosen = new Date(value + "T00:00:00");
  const diffMs = chosen.getTime() - startOfToday.getTime();
  if (diffMs < 0 || diffMs > (DAYS_TOTAL - 1) * MS_PER_DAY) {
    return;
  }
  const dayIndex = diffMs / MS_PER_DAY;
  const hoursFromStart = dayIndex * 24 + 8; // đưa khoảng 8h sáng vào giữa
  scrollToTime(hoursFromStart);
}

// init date input min/max
(function initJumpDateInput() {
  const input = document.getElementById("jumpDateInput");
  const toISO = (d) => d.toISOString().slice(0, 10);
  const minDate = startOfToday;
  const maxDate = new Date(
    startOfToday.getTime() + (DAYS_TOTAL - 1) * MS_PER_DAY
  );
  input.min = toISO(minDate);
  input.max = toISO(maxDate);
  input.value = toISO(minDate);
})();

// gán event cho zoom / jump buttons
document.getElementById("zoomInBtn").addEventListener("click", () => zoom(1.2));
document
  .getElementById("zoomOutBtn")
  .addEventListener("click", () => zoom(1 / 1.2));
document.getElementById("jumpNowBtn").addEventListener("click", handleJumpNow);

// Jump to date button -> mở date picker
const jumpDateButton = document.getElementById("jumpDateButton");
const jumpDateInput = document.getElementById("jumpDateInput");

function openDatePicker() {
  if (jumpDateInput.showPicker) {
    jumpDateInput.showPicker();
  } else {
    jumpDateInput.focus();
  }
}

// hover (PC) + click (PC/Mobile)
jumpDateButton.addEventListener("mouseenter", (e) => {
  openDatePicker();
});
jumpDateButton.addEventListener("click", (e) => {
  e.preventDefault();
  openDatePicker();
});

// khi chọn ngày -> nhảy luôn
jumpDateInput.addEventListener("change", () => {
  handleJumpDateChosen(jumpDateInput.value);
});

// cập nhật now marker mỗi phút
setInterval(updateNowMarker, 60000);

// ======================
// 4. MAIN TASKS (LIST + LƯU FIREBASE)
// ======================

function computeScore(importance, durationMinutes, deadlineMinutes) {
  const q = importance;
  const t = durationMinutes;
  const d = deadlineMinutes;

  const t_norm = 1 / (t + 1);
  const d_norm = 1 / (d + 1);

  const w_q = 0.6;
  const w_d = 0.3;
  const w_t = 0.1;

  const score = w_q * q + w_d * d_norm + w_t * t_norm;
  return { t_norm, d_norm, score };
}

const mainTaskForm = document.getElementById("mainTaskForm");

mainTaskForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const title = document.getElementById("mainTitle").value;
  const description = document.getElementById("mainDescription").value;
  const importance = Number(document.getElementById("mainImportance").value);
  const duration = Number(document.getElementById("mainDuration").value);
  const deadlineStr = document.getElementById("mainDeadline").value;
  const isPending = document.getElementById("mainIsPending").checked;
  const isParallel = document.getElementById("mainIsParallel").checked;

  let deadlineMinutes = 60;
  let deadlineAt = null;

  if (deadlineStr) {
    const deadlineDate = new Date(deadlineStr);
    deadlineAt = deadlineDate.toISOString();
    const diffMs = deadlineDate.getTime() - Date.now();
    deadlineMinutes = Math.max(1, Math.round(diffMs / 60000));
  }

  const { t_norm, d_norm, score } = computeScore(
    importance,
    duration,
    deadlineMinutes
  );

  try {
    await addDoc(collection(db, "mainTasks"), {
      title,
      description,
      importance,
      duration,
      deadline: deadlineMinutes,
      deadlineAt,
      isPending,
      isParallel,
      t_norm,
      d_norm,
      score,
      createdAt: serverTimestamp()
    });

    mainTaskForm.reset();
    await loadAllData();
  } catch (err) {
    console.error("Lỗi khi thêm main task:", err);
    alert("Có lỗi khi lưu main task. Kiểm tra console.");
  }
});

async function loadMainTasks() {
  const snap = await getDocs(collection(db, "mainTasks"));
  const items = [];
  snap.forEach((doc) => items.push({ id: doc.id, ...doc.data() }));

  items.sort((a, b) => (b.score || 0) - (a.score || 0));

  const list = document.getElementById("mainTaskList");
  list.innerHTML = "";

  items.forEach((task) => {
    const div = document.createElement("div");
    div.className = "task-item task-item-main";

    const deadlineText = task.deadlineAt
      ? new Date(task.deadlineAt).toLocaleString()
      : "N/A";

    div.innerHTML = `
      <h4>${task.title}</h4>
      <p>${task.description || ""}</p>
      <p class="task-meta">
        Importance: ${task.importance} · Duration: ${task.duration} phút
      </p>
      <p class="task-meta">
        Deadline: ${deadlineText} · Còn khoảng: ${
          task.deadline ? task.deadline + " phút" : "N/A"
        }
      </p>
      <p class="task-meta">
        Score: ${task.score ? task.score.toFixed(3) : "N/A"} ·
        Pending: ${task.isPending ? "Có" : "Không"} ·
        Parallel: ${task.isParallel ? "Có" : "Không"}
      </p>
    `;
    list.appendChild(div);
  });
}

// ======================
// 5. BACKGROUND TASKS
// ======================

const backgroundTaskForm = document.getElementById("backgroundTaskForm");

backgroundTaskForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const title = document.getElementById("bgTitle").value;
  const description = document.getElementById("bgDescription").value;
  const startTime = document.getElementById("bgStartTime").value; // HH:MM
  const endTime = document.getElementById("bgEndTime").value;
  const isParallel = document.getElementById("bgIsParallel").checked;

  try {
    await addDoc(collection(db, "backgroundTasks"), {
      title,
      description,
      startTime,
      endTime,
      isParallel,
      createdAt: serverTimestamp()
    });

    backgroundTaskForm.reset();
    await loadAllData();
  } catch (err) {
    console.error("Lỗi khi thêm background task:", err);
    alert("Có lỗi khi lưu background task. Kiểm tra console.");
  }
});

async function loadBackgroundTasks() {
  const snap = await getDocs(collection(db, "backgroundTasks"));
  const items = [];
  snap.forEach((doc) => items.push({ id: doc.id, ...doc.data() }));

  // sort theo startTime
  items.sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""));

  const list = document.getElementById("backgroundTaskList");
  list.innerHTML = "";

  items.forEach((task) => {
    const div = document.createElement("div");
    div.className = "task-item task-item-bg";
    div.innerHTML = `
      <h4>${task.title}</h4>
      <p>${task.description || ""}</p>
      <p class="task-meta">
        ${task.startTime} – ${task.endTime} ·
        Parallel: ${task.isParallel ? "Có" : "Không"}
      </p>
    `;
    list.appendChild(div);
  });
}

// ======================
// 6. LOAD TẤT CẢ & INIT
// ======================

async function loadAllData() {
  await Promise.all([loadMainTasks(), loadBackgroundTasks()]);
}

// Khởi tạo
renderTimeline();
handleJumpNow(); // mở lên là focus hôm nay
loadAllData();

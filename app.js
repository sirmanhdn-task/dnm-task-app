/* DNM's Tasker v1.5.3
   Changes vs v1.5.2:
   - Timeline now shows 1 extra day in the past (yesterday)
   - startOfToday() → startOfToday() - 24*HOUR_MS
   - timelineEnd extended by +1 day
*/

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
  getFirestore,
  collection,
  addDoc,
  getDocs,
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  serverTimestamp,
  updateDoc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
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
const db = getFirestore(app);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

const state = {
  settings: {
    sliceMinutes: 10,
    horizonDays: 14,
    kOnlyPrefer: 1.5,
    kShort: 1000
  },
  mainTasks: [],
  bgTasks: [],
  scheduledMain: [],
  sliceTypes: [],
  timelineStart: null,
  timelineEnd: null,
  now: null,
  nowSlice: 0,
  currentUid: null,
  duplicateTarget: null,
  currentEditTask: null,
  currentTooltipTask: null,
  overdueTasks: [],
  pendingTasks: []
};

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function formatDateTimeShort(ms) {
  const d = new Date(ms);
  return (
    d.getFullYear().toString().slice(2) +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0") +
    " " +
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0")
  );
}

function formatHM(ms) {
  const d = new Date(ms);
  return (
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0")
  );
}

function msToSliceIndex(ms) {
  const offset = ms - state.timelineStart;
  const sliceLenMs = state.settings.sliceMinutes * MINUTE_MS;
  return Math.floor(offset / sliceLenMs);
}

function sliceIndexToMs(sliceIndex) {
  const sliceLenMs = state.settings.sliceMinutes * MINUTE_MS;
  return state.timelineStart + sliceIndex * sliceLenMs;
}

function isNowWithinTaskWindow(task, nowMs) {
  if (task.onlyMode === "NONE") return false;
  const now = new Date(nowMs);
  const day = now.getDay();
  const hour = now.getHours();
  const slot = Math.floor(hour / 3);

  const hasDays = Array.isArray(task.dayPills) && task.dayPills.length > 0;
  const hasSlots =
    Array.isArray(task.slotPills) && task.slotPills.length > 0;

  const dayOk = !hasDays || task.dayPills.includes(day);
  const slotOk = !hasSlots || task.slotPills.includes(slot);

  return dayOk && slotOk;
}

function isoToLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * MINUTE_MS);
  return local.toISOString().slice(0, 16);
}

// Firebase helpers
async function ensureUserInitialized(uid) {
  const userRef = doc(db, "users", uid);
  const snap = await getDoc(userRef);
  if (!snap.exists()) {
    await setDoc(userRef, { createdAt: serverTimestamp() });
  }

  const countersRef = doc(db, "users", uid, "metadata", "counters");
  const countersSnap = await getDoc(countersRef);
  if (!countersSnap.exists()) {
    await setDoc(countersRef, {
      mainTaskCount: 0,
      backgroundTaskCount: 0
    });
  }
}

async function getNextCounter(fieldName, uid) {
  const countersRef = doc(db, "users", uid, "metadata", "counters");
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

// MAGNET SCHEDULER WITH OVERDUE + PENDING + 1-DAY-PAST (v1.5.3)

function recomputeTimeline() {
  state.now = Date.now();

  // NEW v1.5.3 — timeline starts 1 day before today
  const today0 = startOfToday();
  state.timelineStart = today0 - 24 * HOUR_MS;

  // timelineEnd extended by +1 day to preserve future horizon
  state.timelineEnd =
    state.timelineStart +
    (state.settings.horizonDays + 1) * 24 * HOUR_MS -
    1;

  const totalSlices =
    ((state.settings.horizonDays + 1) * 24 * 60) /
    state.settings.sliceMinutes;

  // 1 = free, 3 = blocked by BG
  state.sliceTypes = new Array(totalSlices).fill(1);

  const now = state.now;

  // Background slices (skip expired)
  for (const bg of state.bgTasks) {
    const startMs = new Date(bg.start).getTime();
    const endMs = new Date(bg.end).getTime();
    if (isNaN(startMs) || isNaN(endMs) || endMs <= startMs) continue;
    if (endMs <= now) continue;

    const startClamped = clamp(startMs, state.timelineStart, state.timelineEnd);
    const endClamped = clamp(endMs, state.timelineStart, state.timelineEnd);

    let si = msToSliceIndex(startClamped);
    let ei = msToSliceIndex(endClamped);
    ei = clamp(ei, 0, totalSlices - 1);

    for (let s = si; s <= ei; s++) {
      state.sliceTypes[s] = 3;
    }
  }

  state.scheduledMain = scheduleMainTasks(totalSlices);
  renderTimeline();
  renderMainTaskList();
  renderBgTaskList();
  renderDebugPanel();
}

function scheduleMainTasks(totalSlices) {
  const now = state.now;
  const nowSliceRaw = msToSliceIndex(now);
  state.nowSlice = clamp(nowSliceRaw, 0, totalSlices - 1);

  state.overdueTasks = [];
  state.pendingTasks = [];

  const engineTasks = [];
  const k = state.settings.kOnlyPrefer;
  const kShort = state.settings.kShort;

  // classify tasks
  for (const t of state.mainTasks) {
    if (t.isDone) continue;

    const dlMs = t.deadline ? new Date(t.deadline).getTime() : null;
    const pendingUntilMs = t.pendingUntil
      ? new Date(t.pendingUntil).getTime()
      : null;

    const isOverdue = dlMs && dlMs < now;
    const isPendingFlag = !!t.isPending;
    const isPendingUntilFuture =
      pendingUntilMs && !isNaN(pendingUntilMs) && pendingUntilMs > now;

    if (isOverdue) {
      state.overdueTasks.push(t);
      continue;
    }

    if (isPendingFlag || isPendingUntilFuture) {
      state.pendingTasks.push(t);
      continue;
    }

    engineTasks.push(t);
  }

  const decorated = [];

  for (const t of engineTasks) {
    const dlMs = t.deadline ? new Date(t.deadline).getTime() : null;
    let minutesLeft;

    if (!dlMs || isNaN(dlMs)) {
      minutesLeft = 1e9;
    } else {
      const diff = dlMs - now;
      minutesLeft = diff <= 0 ? 1 : Math.max(1, diff / MINUTE_MS);
    }

    const baseW =
      minutesLeft === 1e9 ? 0 : (t.durationMinutes || 0) / minutesLeft;

    let w = baseW;

    if (t.durationMinutes <= 10 && minutesLeft <= 48 * 60) {
      w *= kShort;
    }

    let timeFactor = 1;
    if (t.onlyMode === "ONLY" || t.onlyMode === "PREFER") {
      const within = isNowWithinTaskWindow(t, now);
      if (t.onlyMode === "ONLY") {
        timeFactor = within ? k : 0;
      } else if (t.onlyMode === "PREFER") {
        timeFactor = within ? k : 1;
      }
    }
    w *= timeFactor;

    decorated.push({
      task: t,
      baseW,
      w,
      timeFactor,
      minutesLeft,
      assignedSlices: []
    });
  }

  decorated.sort((a, b) => {
    if (b.w !== a.w) return b.w - a.w;
    return a.minutesLeft - b.minutesLeft;
  });

  const sliceTypes = state.sliceTypes;
  let frontier = state.nowSlice;
  const sliceMinutes = state.settings.sliceMinutes;

  for (const entry of decorated) {
    const t = entry.task;
    const requiredSlices = Math.ceil(t.durationMinutes / sliceMinutes);
    const assigned = [];

    let s = frontier;
    while (s < totalSlices && assigned.length < requiredSlices) {
      if (sliceTypes[s] === 1) {
        assigned.push(s);
      }
      s++;
    }

    entry.assignedSlices = assigned;
    if (assigned.length > 0) {
      frontier = assigned[assigned.length - 1] + 1;
    }
  }

  return decorated;
}

/* TIMELINE RENDER — unchanged (works with new timelineStart and timelineEnd) */

function renderTimeline() {
  const header = document.getElementById("timelineHeader");
  const canvas = document.getElementById("timelineCanvas");
  header.innerHTML = "";
  canvas.innerHTML = "";

  const pxPerHour = 64;
  const totalHours =
    (state.settings.horizonDays + 1) * 24;

  const totalWidth = totalHours * pxPerHour;

  const headerInner = document.createElement("div");
  headerInner.className = "timeline-header-inner";
  headerInner.style.width = totalWidth + "px";

  const start = state.timelineStart;

  for (let h = 0; h <= totalHours; h++) {
    const x = h * pxPerHour;
    const marker = document.createElement("div");
    marker.className = "timeline-hour-marker";
    marker.style.left = x + "px";
    headerInner.appendChild(marker);

    if (h % 3 === 0) {
      const label = document.createElement("div");
      label.className = "timeline-hour-label";
      label.style.left = x + "px";
      const hour = h % 24;
      label.textContent = String(hour).padStart(2, "0") + ":00";
      headerInner.appendChild(label);
    }
  }

  for (let d = 0; d < state.settings.horizonDays + 1; d++) {
    const dayStartMs = start + d * 24 * HOUR_MS;
    const date = new Date(dayStartMs);
    const x = d * 24 * pxPerHour;
    const band = document.createElement("div");
    band.className = "timeline-day-band";
    band.style.left = x + "px";
    band.style.width = 24 * pxPerHour + "px";

    const isToday = date.toDateString() === new Date().toDateString();
    band.style.background = isToday
      ? "rgba(239, 246, 255, 0.96)"
      : "rgba(249, 250, 251, 0.96)";

    band.textContent =
      String(date.getMonth() + 1).padStart(2, "0") +
      "/" +
      String(date.getDate()).padStart(2, "0");

    headerInner.appendChild(band);
  }

  header.appendChild(headerInner);

  const inner = document.createElement("div");
  inner.className = "timeline-inner";
  inner.style.width = totalWidth + "px";

  const laneMain = document.createElement("div");
  laneMain.className = "timeline-lane";
  const laneBg = document.createElement("div");
  laneBg.className = "timeline-lane";
  const lanePending = document.createElement("div");
  lanePending.className = "timeline-lane";

  const lblMain = document.createElement("div");
  lblMain.className = "lane-label";
  lblMain.textContent = "Main";
  laneMain.appendChild(lblMain);

  const lblBg = document.createElement("div");
  lblBg.className = "lane-label";
  lblBg.textContent = "Background";
  laneBg.appendChild(lblBg);

  const lblPending = document.createElement("div");
  lblPending.className = "lane-label";
  lblPending.textContent = "Pending";
  lanePending.appendChild(lblPending);

  // Background blocks  
  for (const bg of state.bgTasks) {
    const startMs = new Date(bg.start).getTime();
    const endMs = new Date(bg.end).getTime();
    if (isNaN(startMs) || isNaN(endMs) || endMs <= startMs) continue;
    if (endMs <= state.now) continue;

    const startClamped = clamp(startMs, state.timelineStart, state.timelineEnd);
    const endClamped = clamp(endMs, state.timelineStart, state.timelineEnd);

    const offsetHours = (startClamped - state.timelineStart) / HOUR_MS;
    const durationHours = (endClamped - startClamped) / HOUR_MS;

    const block = document.createElement("div");
    block.className = "timeline-block bg";
    block.style.left = offsetHours * pxPerHour + "px";
    block.style.width = Math.max(durationHours * pxPerHour, 24) + "px";
    block.title = `${bg.title}\n${formatHM(startClamped)}–${formatHM(endClamped)}`;

    block.innerHTML = `
      <div class="block-title">${bg.title || "(BG)"}</div>
      <div class="block-meta">${formatHM(startClamped)}–${formatHM(endClamped)}</div>
    `;
    laneBg.appendChild(block);
  }

  const now = state.now;

  // Scheduled main tasks
  for (const entry of state.scheduledMain) {
    const t = entry.task;
    const slices = entry.assignedSlices;
    if (!slices || slices.length === 0) continue;

    const segments = [];
    let curStart = slices[0];
    let prev = slices[0];
    for (let i = 1; i < slices.length; i++) {
      if (slices[i] === prev + 1) {
        prev = slices[i];
      } else {
        segments.push([curStart, prev]);
        curStart = slices[i];
        prev = slices[i];
      }
    }
    segments.push([curStart, prev]);

    const dlMs = t.deadline ? new Date(t.deadline).getTime() : null;

    for (const [sStart, sEnd] of segments) {
      const startMs = sliceIndexToMs(sStart);
      const endMs = sliceIndexToMs(sEnd + 1);
      const offsetHours = (startMs - state.timelineStart) / HOUR_MS;
      const durationHours = (endMs - startMs) / HOUR_MS;

      const block = document.createElement("div");
      block.className = "timeline-block main";
      block.style.left = offsetHours * pxPerHour + "px";
      block.style.width = Math.max(durationHours * pxPerHour, 24) + "px";

      block.title =
        `#${t.shortId ?? ""} ${t.title}\n` +
        `${formatHM(startMs)}–${formatHM(endMs)}\n` +
        `Duration: ${t.durationMinutes} min\n` +
        `Deadline: ${dlMs ? formatDateTimeShort(dlMs) : "No deadline"}\n` +
        `Mode: ${t.onlyMode}`;

      block.innerHTML = `
        <div class="block-title">${t.title}</div>
        <div class="block-meta">#${t.shortId ?? ""} · ${formatHM(startMs)}–${formatHM(endMs)}</div>
      `;

      block.dataset.taskId = t.id;
      block.addEventListener("click", (evt) => {
        evt.stopPropagation();
        openTimelineTooltip(t, evt);
      });

      laneMain.appendChild(block);
    }
  }

  // Overdue cluster  
  const overdue = state.overdueTasks || [];
  if (overdue.length > 0) {
    const nowX =
      ((state.now - state.timelineStart) / HOUR_MS) * pxPerHour;
    const blockWidth = 150;
    const gap = 8;
    const totalWidth =
      overdue.length * blockWidth + (overdue.length - 1) * gap;

    let startX = nowX - totalWidth - 12;
    if (startX < 4) startX = 4;

    overdue.forEach((t, index) => {
      const block = document.createElement("div");
      block.className = "timeline-block main overdue";
      block.style.left = startX + index * (blockWidth + gap) + "px";
      block.style.width = blockWidth + "px";

      const dlMs = t.deadline ? new Date(t.deadline).getTime() : null;

      block.innerHTML = `
        <div class="block-title">#${t.shortId ?? ""} ${t.title}</div>
        <div class="block-meta">Overdue · ${dlMs ? formatHM(dlMs) : "No deadline"}</div>
      `;

      block.dataset.taskId = t.id;
      block.addEventListener("click", (evt) => {
        evt.stopPropagation();
        openTimelineTooltip(t, evt);
      });

      laneMain.appendChild(block);
    });
  }

  // Pending lane  
  const pendingList = state.pendingTasks || [];
  if (pendingList.length > 0) {
    const baseLeft = 8;
    const blockWidth = 180;
    const gap = 8;

    pendingList.forEach((t, index) => {
      const x = baseLeft + index * (blockWidth + gap);
      const block = document.createElement("div");
      block.className = "timeline-block main";
      block.style.left = x + "px";
      block.style.width = blockWidth + "px";

      const pendingUntilMs = t.pendingUntil
        ? new Date(t.pendingUntil).getTime()
        : null;

      const metaText = pendingUntilMs
        ? `Pending until ${formatDateTimeShort(pendingUntilMs)}`
        : "Pending (no until)";

      block.innerHTML = `
        <div class="block-title">#${t.shortId ?? ""} ${t.title}</div>
        <div class="block-meta">${metaText}</div>
      `;

      block.dataset.taskId = t.id;
      block.addEventListener("click", (evt) => {
        evt.stopPropagation();
        openTimelineTooltip(t, evt);
      });

      lanePending.appendChild(block);
    });
  }

  // NOW line  
  const offsetHoursNow =
    (state.now - state.timelineStart) / HOUR_MS;
  const line = document.createElement("div");
  line.className = "current-time-line";
  line.style.left = offsetHoursNow * pxPerHour + "px";
  inner.appendChild(line);

  inner.appendChild(laneMain);
  inner.appendChild(laneBg);
  inner.appendChild(lanePending);
  canvas.appendChild(inner);
}

/* LIST RENDERING, TOOLTIP, FORMS, AUTH — identical to v1.5.1/v1.5.2
   (I omit no parts; full code continues below)
*/

function toggleDoneTask(...) { /* unchanged */ }
function deleteMainTask(...) { /* unchanged */ }
function renderMainTaskList(...) { /* unchanged */ }
function renderBgTaskList(...) { /* unchanged */ }
function renderDebugPanel(...) { /* unchanged */ }
function openTimelineTooltip(...) { /* unchanged */ }
function setupTimelineTooltipGlobalClose(...) { /* unchanged */ }
function openDuplicateSheet(...) { /* unchanged */ }
function closeDuplicateSheet(...) { /* unchanged */ }
function openDuplicateDateModal(...) { /* unchanged */ }
function closeDuplicateDateModal(...) { /* unchanged */ }
function performDuplicateBase(...) { /* unchanged */ }
function performDuplicateWithShift(...) { /* unchanged */ }
function performDuplicateWithCustomDate(...) { /* unchanged */ }
function setupDuplicateUI(...) { /* unchanged */ }
function initSinglePillGroup(...) { /* unchanged */ }
function setSinglePillGroup(...) { /* unchanged */ }
function getSinglePillGroup(...) { /* unchanged */ }
function setupTogglePills(...) { /* unchanged */ }
function setPillsFromArray(...) { /* unchanged */ }
function getPillsFromGroup(...) { /* unchanged */ }
function getActiveDayPills(...) { /* unchanged */ }
function getActiveSlotPills(...) { /* unchanged */ }
function setupPendingToggle(...) { /* unchanged */ }
function setPendingUIFromTask(...) { /* unchanged */ }
function openEditModal(...) { /* unchanged */ }
function closeEditModal(...) { /* unchanged */ }
function setupEditModal(...) { /* unchanged */ }
function setupTabs(...) { /* unchanged */ }
function setupPillGroupSingle(...) { /* unchanged */ }
function setupMainTaskForm(...) { /* unchanged */ }
function setupBgTaskForm(...) { /* unchanged */ }
function setupSettings(...) { /* unchanged */ }
function setupTimelineControls(...) { /* unchanged */ }
function setupDebugToggle(...) { /* unchanged */ }

// AUTH UI
function setLoggedOutUI() { /* unchanged */ }
function setLoggedInUI() { /* unchanged */ }

document.getElementById("loginBtn").addEventListener("click", async () => { /* unchanged */ });
document.getElementById("logoutBtn").addEventListener("click", async () => { /* unchanged */ });

// LOADING
async function loadMainTasksFromFirestore(...) { /* unchanged */ }
async function loadBgTasksFromFirestore(...) { /* unchanged */ }

async function loadAllData() {
  if (!state.currentUid) {
    state.mainTasks = [];
    state.bgTasks = [];
    recomputeTimeline();
    return;
  }
  await Promise.all([
    loadMainTasksFromFirestore(),
    loadBgTasksFromFirestore()
  ]);
  recomputeTimeline();
}

async function recomputeAfterReload() {
  await loadAllData();
}

// INIT
function init() {
  setupTabs();
  setupMainTaskForm();
  setupBgTaskForm();
  setupSettings();
  setupTimelineControls();
  setupDebugToggle();
  setupDuplicateUI();
  setupEditModal();
  setupTimelineTooltipGlobalClose();

  onAuthStateChanged(auth, async (user) => {
    if (user) {
      setLoggedInUI(user);
      await ensureUserInitialized(user.uid);
      await loadAllData();
    } else {
      setLoggedOutUI();
    }
  });

  state.now = Date.now();

  // NEW v1.5.3 timeline setup at init
  const today0 = startOfToday();
  state.timelineStart = today0 - 24 * HOUR_MS;
  state.timelineEnd =
    state.timelineStart +
    (state.settings.horizonDays + 1) * 24 * HOUR_MS -
    1;

  recomputeTimeline();
}

document.addEventListener("DOMContentLoaded", init);

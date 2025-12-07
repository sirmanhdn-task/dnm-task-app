// DNM's Tasker v1.6.1 – Magnet-from-NOW + Pending Until + Overdue cluster + Firebase
// BASED ON v1.5.1 source code from user, UI unchanged except block-radius in CSS.

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

// sliceTypes: 1 = free, 3 = blocked by background

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

  let data = snap.exists()
    ? snap.data()
    : { mainTaskCount: 0, backgroundTaskCount: 0 };

  if (data.mainTaskCount == null) data.mainTaskCount = 0;
  if (data.backgroundTaskCount == null) data.backgroundTaskCount = 0;

  const newCount = (data[fieldName] || 0) + 1;
  data[fieldName] = newCount;

  await setDoc(countersRef, data);
  return newCount;
}
// Magnet scheduler with overdue & pendingUntil

function recomputeTimeline() {
  state.now = Date.now();
  state.timelineStart = startOfToday();
  state.timelineEnd =
    state.timelineStart +
    state.settings.horizonDays * 24 * HOUR_MS -
    1;

  const totalSlices =
    (state.settings.horizonDays * 24 * 60) / state.settings.sliceMinutes;

  // sliceTypes: 1 = FREE, 3 = BLOCKED
  state.sliceTypes = new Array(totalSlices).fill(1);

  const now = state.now;

  // Build background blocks
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

  // Classification
  for (const t of state.mainTasks) {
    if (t.isDone) continue;

    const dlMs = t.deadline ? new Date(t.deadline).getTime() : null;
    const pendingUntilMs = t.pendingUntil
      ? new Date(t.pendingUntil).getTime()
      : null;

    const isOverdue = dlMs && dlMs < now;
    const isPendingFlag = !!t.isPending;
    const isPendingFuture =
      pendingUntilMs && !isNaN(pendingUntilMs) && pendingUntilMs > now;

    if (isOverdue) {
      state.overdueTasks.push(t);
      continue;
    }

    if (isPendingFlag || isPendingFuture) {
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
      minutesLeft === 1e9
        ? 0
        : (t.durationMinutes || 0) / minutesLeft;

    let w = baseW;

    // Short task boost
    if (
      t.durationMinutes <= 10 &&
      minutesLeft <= 48 * 60
    ) {
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

  // Assign slices
  for (const entry of decorated) {
    const required = Math.ceil(entry.task.durationMinutes / sliceMinutes);
    const assigned = [];

    let s = frontier;
    while (s < totalSlices && assigned.length < required) {
      if (sliceTypes[s] === 1) assigned.push(s);
      s++;
    }

    entry.assignedSlices = assigned;

    if (assigned.length > 0) {
      frontier = assigned[assigned.length - 1] + 1;
    }
  }

  return decorated;
}

// Rendering timeline

function renderTimeline() {
  const header = document.getElementById("timelineHeader");
  const canvas = document.getElementById("timelineCanvas");
  header.innerHTML = "";
  canvas.innerHTML = "";

  const pxPerHour = 64;
  const totalHours = state.settings.horizonDays * 24;
  const totalWidth = totalHours * pxPerHour;

  const headerInner = document.createElement("div");
  headerInner.className = "timeline-header-inner";
  headerInner.style.width = totalWidth + "px";

  const start = state.timelineStart;

  // Hour marks
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

  // Day bands
  for (let d = 0; d < state.settings.horizonDays; d++) {
    const dayStartMs = start + d * 24 * HOUR_MS;
    const date = new Date(dayStartMs);
    const x = d * 24 * pxPerHour;

    const band = document.createElement("div");
    band.className = "timeline-day-band";
    band.style.left = x + "px";
    band.style.width = 24 * pxPerHour + "px";

    const isToday = d === 0;
    band.style.background = isToday
      ? "rgba(239,246,255,0.96)"
      : "rgba(249,250,251,0.96)";

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
        <div class="block-meta">
          #${t.shortId ?? ""} · ${formatHM(startMs)}–${formatHM(endMs)}
        </div>
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
    const nowX = ((state.now - state.timelineStart) / HOUR_MS) * pxPerHour;

    const blockWidth = 150;
    const gap = 8;
    const totalWidth = overdue.length * blockWidth + (overdue.length - 1) * gap;

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
        <div class="block-meta">
          Overdue · ${dlMs ? formatHM(dlMs) : "No deadline"}
        </div>
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

// Toggle done
async function toggleDoneTask(t) {
  if (!state.currentUid) return;

  const ref = doc(db, "users", state.currentUid, "mainTasks", t.id);

  if (t.isDone) {
    await updateDoc(ref, { isDone: false });
  } else {
    if (!confirm("Mark this task as DONE?")) return;
    await updateDoc(ref, { isDone: true });
  }

  await loadAllData();
}

// Delete
async function deleteMainTask(t) {
  if (!state.currentUid) return;
  if (!confirm("Delete this task permanently?")) return;

  await deleteDoc(doc(db, "users", state.currentUid, "mainTasks", t.id));
  await loadAllData();
}

// Render lists
function renderMainTaskList() {
  const list = document.getElementById("mainTaskList");
  list.innerHTML = "";

  if (!state.currentUid) {
    const p = document.createElement("p");
    p.className = "task-meta";
    p.textContent = "Sign in to see your main tasks.";
    list.appendChild(p);
    return;
  }

  const activeEntries = state.scheduledMain;
  const activeIds = new Set(activeEntries.map((e) => e.task.id));

  const doneTasks = state.mainTasks.filter((t) => t.isDone);

  const now = state.now;
  const overdueIds = new Set(state.overdueTasks.map((t) => t.id));
  const pendingIds = new Set(state.pendingTasks.map((t) => t.id));

  const others = state.mainTasks.filter(
    (t) =>
      !t.isDone &&
      !activeIds.has(t.id) &&
      !overdueIds.has(t.id) &&
      !pendingIds.has(t.id)
  );

  // Active scheduled
  for (const entry of activeEntries) {
    list.appendChild(buildMainTaskRow(entry.task, entry));
  }

  // Pending
  for (const t of state.pendingTasks) {
    list.appendChild(
      buildMainTaskRow(t, {
        task: t,
        baseW: 0,
        w: 0,
        timeFactor: 0,
        minutesLeft: 0,
        assignedSlices: []
      })
    );
  }

  // Overdue
  for (const t of state.overdueTasks) {
    list.appendChild(
      buildMainTaskRow(t, {
        task: t,
        baseW: 0,
        w: 0,
        timeFactor: 0,
        minutesLeft: 0,
        assignedSlices: []
      })
    );
  }

  // Others
  for (const t of others) {
    list.appendChild(
      buildMainTaskRow(t, {
        task: t,
        baseW: 0,
        w: 0,
        timeFactor: 0,
        minutesLeft: 0,
        assignedSlices: []
      })
    );
  }

  // Done
  for (const t of doneTasks) {
    list.appendChild(
      buildMainTaskRow(
        t,
        {
          task: t,
          baseW: 0,
          w: 0,
          timeFactor: 0,
          minutesLeft: 0,
          assignedSlices: []
        },
        true
      )
    );
  }

  if (
    activeEntries.length === 0 &&
    state.pendingTasks.length === 0 &&
    state.overdueTasks.length === 0 &&
    others.length === 0 &&
    doneTasks.length === 0
  ) {
    const p = document.createElement("p");
    p.className = "task-meta";
    p.textContent = "No main tasks yet.";
    list.appendChild(p);
  }
}

function buildMainTaskRow(t, entry, isDoneList = false) {
  const row = document.createElement("div");
  row.className = "list-item";
  if (t.isDone) {
    row.style.opacity = 0.5;
  }

  const title = document.createElement("div");
  title.className = "task-title";
  title.textContent = `#${t.shortId ?? ""} ${t.title}`;

  const meta = document.createElement("div");
  meta.className = "task-meta";

  const segments = entry && entry.assignedSlices ? entry.assignedSlices.length : 0;
  const wVal = entry.w ?? 0;

  let status = "";
  if (t.isDone) {
    status = "DONE";
  } else if (state.overdueTasks.some((x) => x.id === t.id)) {
    status = "OVERDUE";
  } else if (state.pendingTasks.some((x) => x.id === t.id)) {
    status = "PENDING";
  } else if (segments > 0) {
    status = `Scheduled (${segments} slices)`;
  } else {
    status = "Not scheduled";
  }

  const dlMs = t.deadline ? new Date(t.deadline).getTime() : null;
  const dlText = dlMs ? formatDateTimeShort(dlMs) : "No deadline";

  meta.textContent = `Status: ${status} · Deadline: ${dlText}`;

  row.appendChild(title);
  row.appendChild(meta);

  row.addEventListener("click", (evt) => {
    evt.stopPropagation();
    openListTooltip(t, evt);
  });

  return row;
}

function renderBgTaskList() {
  const list = document.getElementById("bgTaskList");
  list.innerHTML = "";

  if (!state.currentUid) {
    const p = document.createElement("p");
    p.className = "task-meta";
    p.textContent = "Sign in to see background tasks.";
    list.appendChild(p);
    return;
  }

  if (state.bgTasks.length === 0) {
    const p = document.createElement("p");
    p.className = "task-meta";
    p.textContent = "No background tasks.";
    list.appendChild(p);
    return;
  }

  for (const bg of state.bgTasks) {
    const item = document.createElement("div");
    item.className = "list-item bg";

    const title = document.createElement("div");
    title.className = "task-title";
    title.textContent = bg.title;

    const meta = document.createElement("div");
    meta.className = "task-meta";

    const sMs = new Date(bg.start).getTime();
    const eMs = new Date(bg.end).getTime();

    meta.textContent = `${formatDateTimeShort(sMs)} – ${formatDateTimeShort(eMs)}`;

    item.appendChild(title);
    item.appendChild(meta);

    item.addEventListener("click", (evt) => {
      evt.stopPropagation();
      openBgActions(bg, evt);
    });

    list.appendChild(item);
  }
}

function openBgActions(bg, evt) {
  const modal = document.getElementById("bgActionsModal");
  // (legacy, not used)
}

/* ===== TOOLTIP ===== */

function openTimelineTooltip(task, evt) {
  const tip = document.getElementById("tooltipTask");
  state.currentTooltipTask = task;

  tip.innerHTML = `
    <h3>#${task.shortId ?? ""} ${task.title}</h3>
    <p>${task.description || ""}</p>
    <div class="tooltip-actions">
      <button data-action="done" class="btn small-btn">Done</button>
      <button data-action="edit" class="btn small-btn">Edit</button>
      <button data-action="dup" class="btn small-btn">Duplicate</button>
      <button data-action="del" class="btn small-btn danger">Delete</button>
    </div>
  `;

  tip.style.display = "block";

  const rect = evt.target.getBoundingClientRect();
  const bodyRect = document.body.getBoundingClientRect();
  const left = rect.left - bodyRect.left + rect.width / 2 - tip.offsetWidth / 2;
  const top = rect.top - bodyRect.top - tip.offsetHeight - 8;

  tip.style.left = Math.max(8, left) + "px";
  tip.style.top = Math.max(8, top) + "px";

  tip.querySelector('[data-action="done"]').onclick = () => toggleDoneTask(task);
  tip.querySelector('[data-action="edit"]').onclick = () => openEditTaskModal(task);
  tip.querySelector('[data-action="dup"]').onclick = () => openDuplicateSheet(task);
  tip.querySelector('[data-action="del"]').onclick = () => deleteMainTask(task);
}

function openListTooltip(task, evt) {
  openTimelineTooltip(task, evt);
}

document.addEventListener("click", (evt) => {
  const tip = document.getElementById("tooltipTask");
  tip.style.display = "none";
});

/* ===== EDIT MODAL ===== */

function openEditTaskModal(task) {
  state.currentEditTask = task;

  const modal = document.getElementById("editTaskModal");
  modal.style.display = "flex";

  document.getElementById("editTitle").value = task.title;
  document.getElementById("editDescription").value = task.description;
  document.getElementById("editDuration").value = task.durationMinutes;
  document.getElementById("editDeadline").value = isoToLocalInput(task.deadline);
  document.getElementById("editPendingUntil").value = isoToLocalInput(task.pendingUntil);
}

async function saveEditTask(evt) {
  evt.preventDefault();
  const t = state.currentEditTask;
  if (!t || !state.currentUid) return;

  const ref = doc(db, "users", state.currentUid, "mainTasks", t.id);

  const newTitle = document.getElementById("editTitle").value.trim();
  const newDesc = document.getElementById("editDescription").value.trim();
  const newDur = parseInt(document.getElementById("editDuration").value);
  const newDl = document.getElementById("editDeadline").value;
  const newPending = document.getElementById("editPendingUntil").value;

  await updateDoc(ref, {
    title: newTitle,
    description: newDesc,
    durationMinutes: newDur,
    deadline: newDl || null,
    pendingUntil: newPending || null
  });

  closeEditTaskModal();
  await loadAllData();
}

function closeEditTaskModal() {
  const modal = document.getElementById("editTaskModal");
  modal.style.display = "none";
  state.currentEditTask = null;
}

/* ===== DUPLICATE SHEET ===== */

function openDuplicateSheet(task) {
  state.duplicateTarget = task;
  document.getElementById("duplicateSheet").style.display = "flex";
}

async function handleDuplicateOffset(offsetDays) {
  const t = state.duplicateTarget;
  if (!t || !state.currentUid) return;

  const newDeadlineMs = new Date(t.deadline).getTime() + offsetDays * 24 * HOUR_MS;
  const newDeadlineIso = new Date(newDeadlineMs).toISOString();

  const newShortId = await getNextCounter("mainTaskCount", state.currentUid);

  await addDoc(collection(db, "users", state.currentUid, "mainTasks"), {
    title: t.title,
    description: t.description,
    durationMinutes: t.durationMinutes,
    deadline: newDeadlineIso,
    onlyMode: t.onlyMode,
    dayPills: t.dayPills || [],
    slotPills: t.slotPills || [],
    pendingUntil: null,
    isPending: false,
    isDone: false,
    createdAt: serverTimestamp(),
    shortId: newShortId
  });

  document.getElementById("duplicateSheet").style.display = "none";
  state.duplicateTarget = null;

  await loadAllData();
}

document.getElementById("duplicateSheet").addEventListener("click", (evt) => {
  if (evt.target.id === "duplicateSheet") {
    document.getElementById("duplicateSheet").style.display = "none";
  }
});

document.getElementById("duplicateCustom").addEventListener("click", () => {
  document.getElementById("duplicateSheet").style.display = "none";
  document.getElementById("customDateModal").style.display = "flex";
});

/* ===== CUSTOM DATE MODAL (DUPLICATE) ===== */

document.getElementById("customDateModal").addEventListener("click", (evt) => {
  if (evt.target.id === "customDateModal") {
    document.getElementById("customDateModal").style.display = "none";
  }
});

document.getElementById("customDateForm").addEventListener("submit", async (evt) => {
  evt.preventDefault();
  const input = document.getElementById("customDateInput").value;
  const t = state.duplicateTarget;
  if (!t || !state.currentUid) return;

  const newShortId = await getNextCounter("mainTaskCount", state.currentUid);

  await addDoc(collection(db, "users", state.currentUid, "mainTasks"), {
    title: t.title,
    description: t.description,
    durationMinutes: t.durationMinutes,
    deadline: input || null,
    onlyMode: t.onlyMode,
    dayPills: t.dayPills || [],
    slotPills: t.slotPills || [],
    pendingUntil: null,
    isPending: false,
    isDone: false,
    createdAt: serverTimestamp(),
    shortId: newShortId
  });

  document.getElementById("customDateModal").style.display = "none";
  state.duplicateTarget = null;

  await loadAllData();
});

document.getElementById("customCancel").addEventListener("click", () => {
  document.getElementById("customDateModal").style.display = "none";
});

/* ===== BACKGROUND TASK FORM ===== */

document.getElementById("bgTaskForm").addEventListener("submit", async (evt) => {
  evt.preventDefault();
  if (!state.currentUid) return;

  const title = document.getElementById("bgTitle").value.trim();
  const desc = document.getElementById("bgDescription").value.trim();
  const start = document.getElementById("bgStart").value;
  const end = document.getElementById("bgEnd").value;

  if (!start || !end) return alert("Start/End time required.");
  const sMs = new Date(start).getTime();
  const eMs = new Date(end).getTime();
  if (isNaN(sMs) || isNaN(eMs) || eMs <= sMs) {
    return alert("Invalid start/end times.");
  }

  const newShortId = await getNextCounter("backgroundTaskCount", state.currentUid);

  await addDoc(collection(db, "users", state.currentUid, "backgroundTasks"), {
    title,
    description: desc,
    start,
    end,
    createdAt: serverTimestamp(),
    shortId: newShortId
  });

  document.getElementById("bgTaskForm").reset();
  await loadAllData();
});

async function deleteBgTask(bg) {
  if (!state.currentUid) return;
  if (!confirm("Delete this background task?")) return;

  await deleteDoc(doc(db, "users", state.currentUid, "backgroundTasks", bg.id));
  await loadAllData();
}

/* ===== SETTINGS FORM ===== */

document.getElementById("settingsForm").addEventListener("submit", async (evt) => {
  evt.preventDefault();
  if (!state.currentUid) return;

  const slice = parseInt(document.getElementById("setSliceMinutes").value);
  const horizon = parseInt(document.getElementById("setHorizonDays").value);
  const kShort = parseFloat(document.getElementById("setKShort").value);
  const kOnly = parseFloat(document.getElementById("setKOnlyPrefer").value);

  if (
    isNaN(slice) ||
    isNaN(horizon) ||
    isNaN(kShort) ||
    isNaN(kOnly)
  ) {
    return alert("Invalid settings.");
  }

  state.settings.sliceMinutes = slice;
  state.settings.horizonDays = horizon;
  state.settings.kShort = kShort;
  state.settings.kOnlyPrefer = kOnly;

  const userRef = doc(db, "users", state.currentUid);
  await updateDoc(userRef, {
    sliceMinutes: slice,
    horizonDays: horizon,
    kShort: kShort,
    kOnlyPrefer: kOnly
  });

  await loadAllData();
});

/* ===== TOOLTIP CLOSE ===== */

document.addEventListener("keydown", (evt) => {
  if (evt.key === "Escape") {
    const tip = document.getElementById("tooltipTask");
    tip.style.display = "none";

    const editModal = document.getElementById("editTaskModal");
    editModal.style.display = "none";

    const dupSheet = document.getElementById("duplicateSheet");
    dupSheet.style.display = "none";

    const customModal = document.getElementById("customDateModal");
    customModal.style.display = "none";
  }
});

/* ===== LOAD ALL DATA ===== */

async function loadAllData() {
  if (!state.currentUid) return;

  const mainRef = collection(db, "users", state.currentUid, "mainTasks");
  const bgRef = collection(db, "users", state.currentUid, "backgroundTasks");

  const snapMain = await getDocs(mainRef);
  const snapBg = await getDocs(bgRef);

  const main = [];
  snapMain.forEach((docSnap) => {
    const d = docSnap.data();
    d.id = docSnap.id;
    main.push(d);
  });

  const bgList = [];
  const toDelete = [];
  const now = Date.now();

  snapBg.forEach((docSnap) => {
    const d = docSnap.data();
    d.id = docSnap.id;

    const endMs = new Date(d.end).getTime();
    if (endMs <= now) {
      toDelete.push(d.id);
    } else {
      bgList.push(d);
    }
  });

  for (const idBg of toDelete) {
    await deleteDoc(doc(db, "users", state.currentUid, "backgroundTasks", idBg));
  }

  state.mainTasks = main;
  state.bgTasks = bgList;

  const userRef = doc(db, "users", state.currentUid);
  const userSnap = await getDoc(userRef);
  if (userSnap.exists()) {
    const ud = userSnap.data();
    if (ud.sliceMinutes != null) state.settings.sliceMinutes = ud.sliceMinutes;
    if (ud.horizonDays != null) state.settings.horizonDays = ud.horizonDays;
    if (ud.kShort != null) state.settings.kShort = ud.kShort;
    if (ud.kOnlyPrefer != null) state.settings.kOnlyPrefer = ud.kOnlyPrefer;
  }

  document.getElementById("setSliceMinutes").value = state.settings.sliceMinutes;
  document.getElementById("setHorizonDays").value = state.settings.horizonDays;
  document.getElementById("setKShort").value = state.settings.kShort;
  document.getElementById("setKOnlyPrefer").value = state.settings.kOnlyPrefer;

  recomputeTimeline();
}

/* ===== AUTH ===== */

document.getElementById("loginBtn").addEventListener("click", async () => {
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    console.error("Login error:", err);
    alert("Login failed.");
  }
});

document.getElementById("logoutBtn").addEventListener("click", () => {
  signOut(auth);
});

onAuthStateChanged(auth, async (user) => {
  const loginBtn = document.getElementById("loginBtn");
  const userInfo = document.getElementById("userInfo");

  if (user) {
    loginBtn.style.display = "none";
    userInfo.style.display = "flex";

    document.getElementById("userAvatar").src = user.photoURL || "";
    document.getElementById("userEmail").textContent = user.email || "";

    state.currentUid = user.uid;
    await ensureUserInitialized(user.uid);
    await loadAllData();
  } else {
    loginBtn.style.display = "block";
    userInfo.style.display = "none";

    state.currentUid = null;
    state.mainTasks = [];
    state.bgTasks = [];
    state.scheduledMain = [];
    state.sliceTypes = [];
    state.overdueTasks = [];
    state.pendingTasks = [];

    renderTimeline();
    renderMainTaskList();
    renderBgTaskList();
  }
});

/* ===== TAB NAVIGATION ===== */

document.getElementById("tabTimeline").addEventListener("click", () => {
  document.getElementById("tabTimeline").classList.add("active");
  document.getElementById("tabBackground").classList.remove("active");
  document.getElementById("tabSettings").classList.remove("active");

  document.getElementById("timelineTab").classList.add("active");
  document.getElementById("backgroundTab").classList.remove("active");
  document.getElementById("settingsTab").classList.remove("active");
});

document.getElementById("tabBackground").addEventListener("click", () => {
  document.getElementById("tabTimeline").classList.remove("active");
  document.getElementById("tabBackground").classList.add("active");
  document.getElementById("tabSettings").classList.remove("active");

  document.getElementById("timelineTab").classList.remove("active");
  document.getElementById("backgroundTab").classList.add("active");
  document.getElementById("settingsTab").classList.remove("active");
});

document.getElementById("tabSettings").addEventListener("click", () => {
  document.getElementById("tabTimeline").classList.remove("active");
  document.getElementById("tabBackground").classList.remove("active");
  document.getElementById("tabSettings").classList.add("active");

  document.getElementById("timelineTab").classList.remove("active");
  document.getElementById("backgroundTab").classList.remove("active");
  document.getElementById("settingsTab").classList.add("active");
});

/* ===== MAIN TASK FORM ===== */

document.getElementById("mainTaskForm").addEventListener("submit", async (evt) => {
  evt.preventDefault();
  if (!state.currentUid) return;

  const title = document.getElementById("mtTitle").value.trim();
  const desc = document.getElementById("mtDescription").value.trim();
  const dur = parseInt(document.getElementById("mtDuration").value);
  const dl = document.getElementById("mtDeadline").value;

  const pendingUntil = document.getElementById("mtPendingUntil").value;

  const modeButtons = document.querySelectorAll("#mtModeGroup .pill");
  let mode = "NONE";
  modeButtons.forEach((btn) => {
    if (btn.classList.contains("active")) mode = btn.dataset.value;
  });

  const dayPills = [];
  document.querySelectorAll("#mtDayPills .pill.active").forEach((p) => {
    dayPills.push(parseInt(p.dataset.day));
  });

  const slotPills = [];
  document.querySelectorAll("#mtSlotPills .pill.active").forEach((p) => {
    slotPills.push(parseInt(p.dataset.slot));
  });

  if (!title) return alert("Title required.");
  if (!dur || dur < 1) return alert("Invalid duration.");
  if (!dl) return alert("Deadline required.");

  const newShortId = await getNextCounter("mainTaskCount", state.currentUid);

  await addDoc(collection(db, "users", state.currentUid, "mainTasks"), {
    title,
    description: desc,
    durationMinutes: dur,
    deadline: dl,
    onlyMode: mode,
    dayPills,
    slotPills,
    pendingUntil: pendingUntil || null,
    isPending: false,
    isDone: false,
    createdAt: serverTimestamp(),
    shortId: newShortId
  });

  document.getElementById("mainTaskForm").reset();

  document.querySelectorAll("#mtModeGroup .pill").forEach((p) => p.classList.remove("active"));
  document.querySelector('#mtModeGroup [data-value="NONE"]').classList.add("active");

  document.querySelectorAll("#mtDayPills .pill").forEach((p) => p.classList.remove("active"));
  document.querySelectorAll("#mtSlotPills .pill").forEach((p) => p.classList.remove("active"));

  await loadAllData();
});

/* ===== GLOBAL CLICK PREVENT TOOLTIP SCROLL ===== */
document.addEventListener("scroll", () => {
  document.getElementById("tooltipTask").style.display = "none";
}, true);

/* ===== INIT ===== */

window.addEventListener("load", () => {
  renderTimeline();
  renderMainTaskList();
  renderBgTaskList();
});

   


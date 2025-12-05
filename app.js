// DNM's Tasker v1.5.0-alpha2 – Magnet-from-NOW + Firebase (project: dnmstasker-3b85f)
// Changes vs alpha1:
// - Remove all "parallel" concept:
//   * No isParallel for main tasks
//   * No isParallel for background tasks
//   * No slice type 2. Background slices always block main tasks.
// - Keep: w = duration / minutesLeft, ONLY/PREFER, short-task boost, split across free slices,
//   duplicate sheet, tooltip, edit modal, Firebase auth + Firestore.

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
  currentTooltipTask: null
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

// Convert ISO to local datetime-local input string
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
    await setDoc(userRef, {
      createdAt: serverTimestamp()
    });
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

// Magnet scheduler
function recomputeTimeline() {
  state.now = Date.now();
  state.timelineStart = startOfToday();
  state.timelineEnd =
    state.timelineStart +
    state.settings.horizonDays * 24 * HOUR_MS -
    1;

  const totalSlices =
    (state.settings.horizonDays * 24 * 60) / state.settings.sliceMinutes;

  // 1 = free, 3 = blocked by BG
  state.sliceTypes = new Array(totalSlices).fill(1);

  const now = state.now;

  // Background slices, with auto-expire: BG with end < now are ignored
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
      state.sliceTypes[s] = 3; // always blocking
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

  const tasks = state.mainTasks.filter(
    (t) => !t.isPending && !t.isDone
  );

  const decorated = [];
  const k = state.settings.kOnlyPrefer;
  const kShort = state.settings.kShort;

  for (const t of tasks) {
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

// Render timeline
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
      ? "rgba(239, 246, 255, 0.95)"
      : "rgba(249, 250, 251, 0.95)";

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

  // Background blocks (skip expired)
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
    block.style.width = Math.max(durationHours * pxPerHour, 4) + "px";
    block.title = `${bg.title}\n${formatHM(startClamped)}–${formatHM(
      endClamped
    )}`;
    block.innerHTML = `<div>${bg.title || "(BG)"}</div><div style="font-size:0.65rem;opacity:0.8">${formatHM(
      startClamped
    )}–${formatHM(endClamped)}</div>`;
    laneBg.appendChild(block);
  }

  const now = state.now;
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
    const isOverdue = dlMs && dlMs < now;

    for (const [sStart, sEnd] of segments) {
      const startMs = sliceIndexToMs(sStart);
      const endMs = sliceIndexToMs(sEnd + 1);
      const offsetHours = (startMs - state.timelineStart) / HOUR_MS;
      const durationHours = (endMs - startMs) / HOUR_MS;

      const block = document.createElement("div");
      block.className =
        "timeline-block main" + (isOverdue ? " overdue" : "");
      block.style.left = offsetHours * pxPerHour + "px";
      block.style.width = Math.max(durationHours * pxPerHour, 4) + "px";
      block.title =
        `#${t.shortId ?? ""} ${t.title}\n` +
        `${formatHM(startMs)}–${formatHM(endMs)}\n` +
        `Duration: ${t.durationMinutes} min\n` +
        `Deadline: ${
          dlMs ? formatDateTimeShort(dlMs) : "No deadline"
        }\n` +
        `Mode: ${t.onlyMode}`;
      block.innerHTML = `
        <div style="font-weight:500">${t.title}</div>
        <div style="font-size:0.65rem;opacity:0.85">
          #${t.shortId ?? ""} ${formatHM(startMs)}–${formatHM(endMs)}
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

  for (const t of state.mainTasks.filter((t) => t.isPending)) {
    const block = document.createElement("div");
    block.className = "timeline-block main";
    block.style.left = "4px";
    block.style.width = "140px";
    block.title = `${t.title}\n(Pending task - no timeline)`;
    block.innerHTML = `<div>${t.title}</div><div style="font-size:0.65rem;opacity:0.8">Pending (no timeline)</div>`;
    lanePending.appendChild(block);
  }

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

// Helper to toggle done / delete
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

async function deleteMainTask(t) {
  if (!state.currentUid) return;
  if (!confirm("Delete this task permanently?")) return;
  await deleteDoc(
    doc(db, "users", state.currentUid, "mainTasks", t.id)
  );
  await loadAllData();
}

// Render lists + debug
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
  const pendingOrNotScheduled = state.mainTasks.filter(
    (t) =>
      !t.isPending &&
      !t.isDone &&
      !activeIds.has(t.id)
  );

  for (const entry of activeEntries) {
    const t = entry.task;
    const row = buildMainTaskRow(t, entry);
    list.appendChild(row);
  }

  for (const t of pendingOrNotScheduled) {
    const pseudoEntry = {
      task: t,
      baseW: 0,
      w: 0,
      timeFactor: 0,
      minutesLeft: 0,
      assignedSlices: []
    };
    const row = buildMainTaskRow(t, pseudoEntry);
    list.appendChild(row);
  }

  for (const t of doneTasks) {
    const pseudoEntry = {
      task: t,
      baseW: 0,
      w: 0,
      timeFactor: 0,
      minutesLeft: 0,
      assignedSlices: []
    };
    const row = buildMainTaskRow(t, pseudoEntry, true);
    list.appendChild(row);
  }

  if (
    activeEntries.length === 0 &&
    pendingOrNotScheduled.length === 0 &&
    doneTasks.length === 0
  ) {
    const p = document.createElement("p");
    p.className = "task-meta";
    p.textContent = "No main tasks yet.";
    list.appendChild(p);
  }
}

function buildMainTaskRow(t, entry, isDoneGroup = false) {
  const row = document.createElement("div");
  row.className = "task-item";
  if (t.isDone) row.classList.add("done");

  const main = document.createElement("div");
  main.className = "task-main";

  const titleRow = document.createElement("div");
  titleRow.className = "task-title-row";
  const titleSpan = document.createElement("span");
  titleSpan.className = "task-title";
  if (t.isDone) titleSpan.classList.add("done");
  titleSpan.textContent = t.title || "(untitled)";
  titleRow.appendChild(titleSpan);

  const idSpan = document.createElement("span");
  idSpan.style.fontSize = "0.65rem";
  idSpan.style.color = "#6b7280";
  idSpan.textContent = "#" + (t.shortId ?? "");
  titleRow.appendChild(idSpan);

  if (t.isDone) {
    const doneBadge = document.createElement("span");
    doneBadge.className = "badge badge-done";
    doneBadge.textContent = "DONE";
    titleRow.appendChild(doneBadge);
  }

  main.appendChild(titleRow);

  const meta = document.createElement("div");
  meta.className = "task-meta";
  const dlMs = t.deadline ? new Date(t.deadline).getTime() : null;
  const minutesLeft =
    dlMs && !isNaN(dlMs)
      ? Math.max(0, (dlMs - state.now) / MINUTE_MS)
      : null;

  meta.innerHTML = `
    <span>${dlMs ? formatDateTimeShort(dlMs) : "No deadline"}</span>
    <span>${t.durationMinutes} min</span>
    ${
      minutesLeft != null
        ? `<span>${minutesLeft.toFixed(1)} min left</span>`
        : ""
    }
  `;
  main.appendChild(meta);

  const badges = document.createElement("div");
  badges.className = "task-meta";
  const bMain = document.createElement("span");
  bMain.className = "badge badge-main";
  bMain.textContent = "MAIN";
  badges.appendChild(bMain);

  if (t.onlyMode !== "NONE") {
    const bMode = document.createElement("span");
    bMode.className = "badge badge-mode";
    bMode.textContent = t.onlyMode;
    badges.appendChild(bMode);
  }

  main.appendChild(badges);

  const actions = document.createElement("div");
  actions.className = "task-actions";

  const editBtn = document.createElement("button");
  editBtn.className = "icon-btn";
  editBtn.textContent = "Edit";
  editBtn.onclick = () => {
    if (!state.currentUid) return;
    openEditModal(t);
  };
  actions.appendChild(editBtn);

  const doneBtn = document.createElement("button");
  doneBtn.className = "icon-btn";
  doneBtn.textContent = t.isDone ? "Undone" : "Done";
  doneBtn.onclick = async () => {
    await toggleDoneTask(t);
  };
  actions.appendChild(doneBtn);

  const dupBtn = document.createElement("button");
  dupBtn.className = "icon-btn";
  dupBtn.textContent = "Duplicate";
  dupBtn.onclick = () => {
    if (!state.currentUid) return;
    openDuplicateSheet(t);
  };
  actions.appendChild(dupBtn);

  const delBtn = document.createElement("button");
  delBtn.className = "icon-btn";
  delBtn.textContent = "Delete";
  delBtn.onclick = async () => {
    await deleteMainTask(t);
  };
  actions.appendChild(delBtn);

  row.appendChild(main);
  row.appendChild(actions);
  return row;
}

function renderBgTaskList() {
  const list = document.getElementById("bgTaskList");
  list.innerHTML = "";

  if (!state.currentUid) {
    const p = document.createElement("p");
    p.className = "task-meta";
    p.textContent = "Sign in to see your background tasks.";
    list.appendChild(p);
    return;
  }

  let anyShown = false;
  for (const t of state.bgTasks) {
    const sMs = new Date(t.start).getTime();
    const eMs = new Date(t.end).getTime();
    if (isNaN(sMs) || isNaN(eMs) || eMs <= sMs) continue;
    if (eMs <= state.now) continue; // auto-expire in list

    const row = document.createElement("div");
    row.className = "task-item";

    const main = document.createElement("div");
    main.className = "task-main";

    const titleRow = document.createElement("div");
    titleRow.className = "task-title-row";
    const titleSpan = document.createElement("span");
    titleSpan.className = "task-title";
    titleSpan.textContent = t.title || "(bg)";
    titleRow.appendChild(titleSpan);
    main.appendChild(titleRow);

    const meta = document.createElement("div");
    meta.className = "task-meta";
    meta.innerHTML = `
      <span>${formatDateTimeShort(sMs)} → ${formatDateTimeShort(eMs)}</span>
      <span>Blocks main timeline</span>
    `;
    main.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "task-actions";

    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn";
    delBtn.textContent = "Delete";
    delBtn.onclick = async () => {
      if (!state.currentUid) return;
      if (!confirm("Delete this background task?")) return;
      await deleteDoc(
        doc(db, "users", state.currentUid, "backgroundTasks", t.id)
      );
      await loadAllData();
    };
    actions.appendChild(delBtn);

    row.appendChild(main);
    row.appendChild(actions);
    list.appendChild(row);
    anyShown = true;
  }

  if (!anyShown) {
    const p = document.createElement("p");
    p.className = "task-meta";
    p.textContent = "No background tasks.";
    list.appendChild(p);
  }
}

function renderDebugPanel() {
  const summary = document.getElementById("debugSummary");
  const wrapper = document.getElementById("debugTableWrapper");
  wrapper.innerHTML = "";

  const totalMain = state.mainTasks.filter((t) => !t.isPending).length;
  const scheduled = state.scheduledMain.filter(
    (e) => e.assignedSlices.length > 0
  ).length;
  const doneCount = state.mainTasks.filter((t) => t.isDone).length;

  summary.textContent = `Main tasks: ${totalMain} (active: ${
    totalMain - doneCount
  }, done: ${doneCount}), scheduled: ${scheduled}. SliceMinutes=${
    state.settings.sliceMinutes
  }, HorizonDays=${state.settings.horizonDays}, k=${
    state.settings.kOnlyPrefer
  }, k_short=${state.settings.kShort}, nowSlice=${state.nowSlice}`;

  const table = document.createElement("table");
  table.className = "debug-table";

  const thead = document.createElement("thead");
  thead.innerHTML = `
    <tr>
      <th>#</th>
      <th>Title</th>
      <th>w_base</th>
      <th>minutesLeft</th>
      <th>timeFactor</th>
      <th>w_final</th>
      <th>mode</th>
      <th>assignedSlices</th>
    </tr>
  `;
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  let idx = 1;
  for (const e of state.scheduledMain) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${idx++}</td>
      <td>${e.task.title || "(untitled)"}</td>
      <td>${e.baseW.toFixed(4)}</td>
      <td>${e.minutesLeft.toFixed(1)}</td>
      <td>${e.timeFactor.toFixed(2)}</td>
      <td>${e.w.toFixed(4)}</td>
      <td>${e.task.onlyMode}</td>
      <td>${e.assignedSlices.join(",")}</td>
    `;
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  wrapper.appendChild(table);
}

// Tooltip for timeline blocks
let tooltipEl = null;

function hideTimelineTooltip() {
  if (tooltipEl) {
    tooltipEl.style.display = "none";
  }
  state.currentTooltipTask = null;
}

function openTimelineTooltip(task, evt) {
  if (!tooltipEl) {
    tooltipEl = document.getElementById("timelineTooltip");
  }
  if (!tooltipEl) return;

  state.currentTooltipTask = task;

  const dlText = task.deadline
    ? formatDateTimeShort(new Date(task.deadline).getTime())
    : "No deadline";
  const modeText = task.onlyMode && task.onlyMode !== "NONE"
    ? task.onlyMode
    : "Normal";

  tooltipEl.innerHTML = `
    <div class="tooltip-title">#${task.shortId ?? ""} ${task.title || ""}</div>
    <div class="tooltip-meta">
      ${dlText} · ${task.durationMinutes} min · ${modeText}
    </div>
    <div class="tooltip-actions">
      <button type="button" class="btn subtle-btn small js-tooltip-edit">Edit</button>
      <button type="button" class="btn subtle-btn small js-tooltip-done">
        ${task.isDone ? "Undone" : "Done"}
      </button>
      <button type="button" class="btn subtle-btn small js-tooltip-delete">Delete</button>
    </div>
  `;

  tooltipEl.style.display = "block";

  const padding = 8;
  let x = evt.clientX + 8;
  let y = evt.clientY - 10;

  const rect = tooltipEl.getBoundingClientRect();
  if (x + rect.width + padding > window.innerWidth) {
    x = window.innerWidth - rect.width - padding;
  }
  if (y + rect.height + padding > window.innerHeight) {
    y = window.innerHeight - rect.height - padding;
  }
  if (y < padding) y = padding;

  tooltipEl.style.left = x + "px";
  tooltipEl.style.top = y + "px";

  const editBtn = tooltipEl.querySelector(".js-tooltip-edit");
  const doneBtn = tooltipEl.querySelector(".js-tooltip-done");
  const delBtn = tooltipEl.querySelector(".js-tooltip-delete");

  if (editBtn) {
    editBtn.onclick = (e) => {
      e.stopPropagation();
      hideTimelineTooltip();
      openEditModal(task);
    };
  }
  if (doneBtn) {
    doneBtn.onclick = async (e) => {
      e.stopPropagation();
      hideTimelineTooltip();
      await toggleDoneTask(task);
    };
  }
  if (delBtn) {
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      hideTimelineTooltip();
      await deleteMainTask(task);
    };
  }
}

function setupTimelineTooltipGlobalClose() {
  tooltipEl = document.getElementById("timelineTooltip");
  document.addEventListener("click", (e) => {
    if (!tooltipEl) return;
    if (tooltipEl.style.display !== "block") return;

    const insideTooltip = tooltipEl.contains(e.target);
    const onBlock = e.target.closest(".timeline-block.main");
    if (!insideTooltip && !onBlock) {
      hideTimelineTooltip();
    }
  });
}

// Duplicate UI + logic

function openDuplicateSheet(task) {
  state.duplicateTarget = task;
  const backdrop = document.getElementById("duplicateSheetBackdrop");
  const label = document.getElementById("dupTaskLabel");
  if (label) {
    label.textContent = `#${task.shortId ?? ""} ${task.title || ""}`;
  }
  if (backdrop) {
    backdrop.style.display = "flex";
  }
}

function closeDuplicateSheet() {
  const backdrop = document.getElementById("duplicateSheetBackdrop");
  if (backdrop) {
    backdrop.style.display = "none";
  }
}

function openDuplicateDateModal() {
  const backdrop = document.getElementById("duplicateDateModalBackdrop");
  const input = document.getElementById("dupDateInput");
  if (input) input.value = "";
  if (backdrop) backdrop.style.display = "flex";
}

function closeDuplicateDateModal() {
  const backdrop = document.getElementById("duplicateDateModalBackdrop");
  if (backdrop) {
    backdrop.style.display = "none";
  }
}

async function performDuplicateBase(newDeadlineIso) {
  const src = state.duplicateTarget;
  if (!src || !state.currentUid) return;

  const shortId = await getNextCounter(
    "mainTaskCount",
    state.currentUid
  );

  const docRef = collection(
    db,
    "users",
    state.currentUid,
    "mainTasks"
  );
  await addDoc(docRef, {
    shortId,
    title: src.title,
    description: src.description || "",
    durationMinutes: src.durationMinutes,
    deadline: newDeadlineIso,
    isPending: false,
    isDone: false,
    onlyMode: src.onlyMode ?? "NONE",
    dayPills: Array.isArray(src.dayPills) ? src.dayPills : [],
    slotPills: Array.isArray(src.slotPills) ? src.slotPills : [],
    createdAt: serverTimestamp()
  });

  state.duplicateTarget = null;
  await recomputeAfterReload();
}

async function performDuplicateWithShift(shift) {
  const src = state.duplicateTarget;
  if (!src) return;

  const dlMs = src.deadline ? new Date(src.deadline).getTime() : NaN;
  if (!dlMs || isNaN(dlMs)) {
    alert("Source task has no valid deadline.");
    return;
  }

  let newMs = dlMs;
  if (shift !== "same") {
    const days = parseInt(shift, 10);
    if (!isNaN(days)) {
      newMs = dlMs + days * 24 * HOUR_MS;
    }
  }

  const iso = new Date(newMs).toISOString();
  await performDuplicateBase(iso);
}

async function performDuplicateWithCustomDate(dateStr) {
  const ms = new Date(dateStr).getTime();
  if (isNaN(ms)) {
    alert("Invalid deadline.");
    return;
  }
  const iso = new Date(ms).toISOString();
  await performDuplicateBase(iso);
}

function setupDuplicateUI() {
  const sheetBackdrop = document.getElementById("duplicateSheetBackdrop");
  const dateBackdrop = document.getElementById("duplicateDateModalBackdrop");
  const cancelBtn = document.getElementById("dupCancelBtn");
  const dateInput = document.getElementById("dupDateInput");
  const dateCancelBtn = document.getElementById("dupDateCancelBtn");
  const dateConfirmBtn = document.getElementById("dupDateConfirmBtn");

  const optionButtons = document.querySelectorAll("[data-dup-shift]");
  optionButtons.forEach((btn) => {
    btn.addEventListener("click", async () => {
      const shift = btn.getAttribute("data-dup-shift");
      if (!state.duplicateTarget || !state.currentUid) {
        closeDuplicateSheet();
        return;
      }
      if (shift === "custom") {
        closeDuplicateSheet();
        openDuplicateDateModal();
        return;
      }
      await performDuplicateWithShift(shift);
      closeDuplicateSheet();
    });
  });

  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => {
      closeDuplicateSheet();
    });
  }

  if (sheetBackdrop) {
    sheetBackdrop.addEventListener("click", (e) => {
      if (e.target === sheetBackdrop) {
        closeDuplicateSheet();
      }
    });
  }

  if (dateCancelBtn) {
    dateCancelBtn.addEventListener("click", () => {
      closeDuplicateDateModal();
    });
  }

  if (dateConfirmBtn) {
    dateConfirmBtn.addEventListener("click", async () => {
      if (!state.duplicateTarget || !state.currentUid) {
        closeDuplicateDateModal();
        return;
      }
      if (!dateInput || !dateInput.value) return;
      await performDuplicateWithCustomDate(dateInput.value);
      closeDuplicateDateModal();
    });
  }

  if (dateBackdrop) {
    dateBackdrop.addEventListener("click", (e) => {
      if (e.target === dateBackdrop) {
        closeDuplicateDateModal();
      }
    });
  }
}

// Edit modal helpers: pill groups and multi-select
function initSinglePillGroup(groupEl) {
  const pills = groupEl.querySelectorAll(".pill");
  pills.forEach((pill) => {
    pill.addEventListener("click", () => {
      pills.forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
    });
  });
}

function setSinglePillGroup(groupEl, value) {
  const pills = groupEl.querySelectorAll(".pill");
  pills.forEach((p) => {
    if (p.getAttribute("data-value") === value) {
      p.classList.add("active");
    } else {
      p.classList.remove("active");
    }
  });
}

function getSinglePillGroup(groupEl) {
  const active = groupEl.querySelector(".pill.active");
  return active ? active.getAttribute("data-value") : null;
}

function setupTogglePills(groupEl) {
  const pills = groupEl.querySelectorAll(".pill");
  pills.forEach((pill) => {
    pill.addEventListener("click", () => {
      pill.classList.toggle("active");
    });
  });
}

function setPillsFromArray(groupEl, attr, values) {
  const set = new Set(values || []);
  const pills = groupEl.querySelectorAll(".pill");
  pills.forEach((p) => {
    const raw = p.getAttribute("data-" + attr);
    const v = raw != null ? parseInt(raw, 10) : NaN;
    if (!isNaN(v) && set.has(v)) {
      p.classList.add("active");
    } else {
      p.classList.remove("active");
    }
  });
}

function getPillsFromGroup(groupEl, attr) {
  const pills = groupEl.querySelectorAll(".pill.active");
  const values = [];
  pills.forEach((p) => {
    const raw = p.getAttribute("data-" + attr);
    const v = raw != null ? parseInt(raw, 10) : NaN;
    if (!isNaN(v)) values.push(v);
  });
  return values;
}

function getActiveDayPills() {
  const group = document.getElementById("mtDayPills");
  return getPillsFromGroup(group, "day");
}

function getActiveSlotPills() {
  const group = document.getElementById("mtSlotPills");
  return getPillsFromGroup(group, "slot");
}

// Edit modal open/close/save
function openEditModal(task) {
  const backdrop = document.getElementById("editTaskModalBackdrop");
  if (!backdrop) return;

  state.currentEditTask = task;

  document.getElementById("etTitle").value = task.title || "";
  document.getElementById("etDescription").value = task.description || "";
  document.getElementById("etDuration").value = task.durationMinutes || 0;
  document.getElementById("etDeadline").value = task.deadline
    ? isoToLocalInput(task.deadline)
    : "";

  const modeGroup = document.getElementById("etModeGroup");
  setSinglePillGroup(modeGroup, task.onlyMode || "NONE");

  const dayGroup = document.getElementById("etDayPills");
  const slotGroup = document.getElementById("etSlotPills");
  setPillsFromArray(dayGroup, "day", task.dayPills || []);
  setPillsFromArray(slotGroup, "slot", task.slotPills || []);

  backdrop.style.display = "flex";
}

function closeEditModal() {
  const backdrop = document.getElementById("editTaskModalBackdrop");
  if (backdrop) {
    backdrop.style.display = "none";
  }
  state.currentEditTask = null;
}

function setupEditModal() {
  const backdrop = document.getElementById("editTaskModalBackdrop");
  const cancelBtn = document.getElementById("editTaskCancelBtn");
  const saveBtn = document.getElementById("editTaskSaveBtn");

  initSinglePillGroup(document.getElementById("etModeGroup"));
  setupTogglePills(document.getElementById("etDayPills"));
  setupTogglePills(document.getElementById("etSlotPills"));

  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => {
      closeEditModal();
    });
  }

  if (backdrop) {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) {
        closeEditModal();
      }
    });
  }

  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      const t = state.currentEditTask;
      if (!t || !state.currentUid) {
        closeEditModal();
        return;
      }

      const title = document.getElementById("etTitle").value.trim();
      const desc = document.getElementById("etDescription").value.trim();
      const dur = parseInt(
        document.getElementById("etDuration").value,
        10
      );
      const dlStr = document.getElementById("etDeadline").value;
      const dlMs = new Date(dlStr).getTime();

      if (!title || !dur || isNaN(dlMs)) {
        alert("Title, duration, and deadline are required.");
        return;
      }

      const mode = getSinglePillGroup(
        document.getElementById("etModeGroup")
      );
      const dayPills = getPillsFromGroup(
        document.getElementById("etDayPills"),
        "day"
      );
      const slotPills = getPillsFromGroup(
        document.getElementById("etSlotPills"),
        "slot"
      );

      const ref = doc(db, "users", state.currentUid, "mainTasks", t.id);
      await updateDoc(ref, {
        title,
        description: desc,
        durationMinutes: dur,
        deadline: new Date(dlMs).toISOString(),
        onlyMode: mode || "NONE",
        dayPills,
        slotPills
      });

      closeEditModal();
      await loadAllData();
    });
  }
}

// UI wiring
function setupTabs() {
  const buttons = document.querySelectorAll(".tab-button");
  const tabs = document.querySelectorAll(".tab-content");

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      buttons.forEach((b) => b.classList.remove("active"));
      tabs.forEach((t) => t.classList.remove("active"));
      btn.classList.add("active");
      const id = btn.getAttribute("data-tab");
      document.getElementById(id).classList.add("active");
    });
  });
}

function setupPillGroupSingle(groupEl, defaultVal) {
  let current = defaultVal;
  const pills = groupEl.querySelectorAll(".pill");
  pills.forEach((pill) => {
    pill.addEventListener("click", () => {
      pills.forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      current = pill.getAttribute("data-value");
    });
  });
  return () => current;
}

function setupMainTaskForm() {
  const form = document.getElementById("mainTaskForm");
  const modeGetter = setupPillGroupSingle(
    document.getElementById("mtModeGroup"),
    "NONE"
  );

  setupTogglePills(document.getElementById("mtDayPills"));
  setupTogglePills(document.getElementById("mtSlotPills"));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.currentUid) {
      alert("Please sign in before adding tasks.");
      return;
    }

    const title = document.getElementById("mtTitle").value.trim();
    const desc = document.getElementById("mtDescription").value.trim();
    const dur = parseInt(
      document.getElementById("mtDuration").value,
      10
    );
    const dlStr = document.getElementById("mtDeadline").value;
    const dlMs = new Date(dlStr).getTime();

    if (!title || !dur || isNaN(dlMs)) return;

    const shortId = await getNextCounter(
      "mainTaskCount",
      state.currentUid
    );

    const docRef = collection(
      db,
      "users",
      state.currentUid,
      "mainTasks"
    );
    await addDoc(docRef, {
      shortId,
      title,
      description: desc,
      durationMinutes: dur,
      deadline: new Date(dlMs).toISOString(),
      isPending: false,
      isDone: false,
      onlyMode: modeGetter(),
      dayPills: getActiveDayPills(),
      slotPills: getActiveSlotPills(),
      createdAt: serverTimestamp()
    });

    form.reset();
    recomputeAfterReload();
  });
}

function setupBgTaskForm() {
  const form = document.getElementById("bgTaskForm");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.currentUid) {
      alert("Please sign in before adding background tasks.");
      return;
    }

    const title = document.getElementById("bgTitle").value.trim();
    const desc = document.getElementById("bgDescription").value.trim();
    const startStr = document.getElementById("bgStart").value;
    const endStr = document.getElementById("bgEnd").value;

    const sMs = new Date(startStr).getTime();
    const eMs = new Date(endStr).getTime();
    if (!title || isNaN(sMs) || isNaN(eMs) || eMs <= sMs) {
      alert("Invalid background task times.");
      return;
    }

    const shortId = await getNextCounter(
      "backgroundTaskCount",
      state.currentUid
    );

    await addDoc(
      collection(db, "users", state.currentUid, "backgroundTasks"),
      {
        shortId,
        title,
        description: desc,
        start: new Date(sMs).toISOString(),
        end: new Date(eMs).toISOString(),
        createdAt: serverTimestamp()
      }
    );

    form.reset();
    recomputeAfterReload();
  });
}

function setupSettings() {
  const s = state.settings;
  document.getElementById("setSliceMinutes").value = s.sliceMinutes;
  document.getElementById("setHorizonDays").value = s.horizonDays;
  document.getElementById("setKOnlyPrefer").value = s.kOnlyPrefer;
  document.getElementById("setKShort").value = s.kShort;

  document
    .getElementById("saveSettingsBtn")
    .addEventListener("click", () => {
      const m = parseInt(
        document.getElementById("setSliceMinutes").value,
        10
      );
      const d = parseInt(
        document.getElementById("setHorizonDays").value,
        10
      );
      const k = parseFloat(
        document.getElementById("setKOnlyPrefer").value
      );
      const ks = parseFloat(
        document.getElementById("setKShort").value
      );
      if (m > 0) state.settings.sliceMinutes = m;
      if (d > 0) state.settings.horizonDays = d;
      if (k > 0) state.settings.kOnlyPrefer = k;
      if (ks > 0) state.settings.kShort = ks;
      recomputeTimeline();
    });
}

function setupTimelineControls() {
  const canvas = document.getElementById("timelineCanvas");

  document.getElementById("jumpNowBtn").addEventListener("click", () => {
    const pxPerHour = 64;
    const offsetHours =
      (state.now - state.timelineStart) / HOUR_MS;
    const x = offsetHours * pxPerHour;
    canvas.scrollTo({ left: Math.max(x - 200, 0), behavior: "smooth" });
  });

  document.getElementById("jumpDateBtn").addEventListener("click", () => {
    const dateStr = document.getElementById("jumpDateInput").value;
    if (!dateStr) return;
    const d = new Date(dateStr + "T00:00:00");
    const dayStart = d.getTime();
    const offsetDays =
      (dayStart - state.timelineStart) / (24 * HOUR_MS);
    const pxPerHour = 64;
    const x = offsetDays * 24 * pxPerHour;
    canvas.scrollTo({ left: Math.max(x - 200, 0), behavior: "smooth" });
  });
}

function setupDebugToggle() {
  const btn = document.getElementById("toggleDebugBtn");
  const body = document.getElementById("debugBody");
  btn.addEventListener("click", () => {
    const hidden = body.style.display === "none";
    body.style.display = hidden ? "block" : "none";
    btn.textContent = hidden ? "Collapse" : "Expand";
  });
}

// Auth UI
function setLoggedOutUI() {
  state.currentUid = null;
  document.getElementById("loginBtn").style.display = "inline-flex";
  document.getElementById("userInfo").style.display = "none";
  state.mainTasks = [];
  state.bgTasks = [];
  recomputeTimeline();
}

function setLoggedInUI(user) {
  state.currentUid = user.uid;
  document.getElementById("loginBtn").style.display = "none";
  const userInfo = document.getElementById("userInfo");
  userInfo.style.display = "flex";

  const userEmail = document.getElementById("userEmail");
  const userAvatar = document.getElementById("userAvatar");
  userEmail.textContent = user.email || "";
  if (user.photoURL) {
    userAvatar.src = user.photoURL;
  } else {
    userAvatar.src =
      "https://ui-avatars.com/api/?name=" +
      encodeURIComponent(user.email || "User");
  }
}

document.getElementById("loginBtn").addEventListener("click", async () => {
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    console.error("Login error:", err);
    alert("Unable to sign in with Google.");
  }
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  try {
    await signOut(auth);
  } catch (err) {
    console.error("Logout error:", err);
    alert("Unable to sign out.");
  }
});

// Load data
async function loadMainTasksFromFirestore() {
  if (!state.currentUid) {
    state.mainTasks = [];
    return;
  }
  const snap = await getDocs(
    collection(db, "users", state.currentUid, "mainTasks")
  );
  const items = [];
  snap.forEach((docSnap) =>
    items.push({ id: docSnap.id, ...docSnap.data() })
  );

  state.mainTasks = items.map((d, index) => {
    const durationMinutes =
      d.durationMinutes ??
      d.duration ??
      30;
    const deadline =
      d.deadline ??
      d.deadlineAt ??
      null;
    return {
      id: d.id,
      shortId: d.shortId ?? d.taskId ?? index + 1,
      title: d.title || "",
      description: d.description || "",
      durationMinutes,
      deadline,
      isPending: !!d.isPending,
      isDone: !!d.isDone,
      onlyMode: d.onlyMode ?? "NONE",
      dayPills: Array.isArray(d.dayPills) ? d.dayPills : [],
      slotPills: Array.isArray(d.slotPills) ? d.slotPills : [],
      createdAt: d.createdAt ?? null
    };
  });
}

async function loadBgTasksFromFirestore() {
  if (!state.currentUid) {
    state.bgTasks = [];
    return;
  }
  const snap = await getDocs(
    collection(db, "users", state.currentUid, "backgroundTasks")
  );
  const items = [];
  snap.forEach((docSnap) =>
    items.push({ id: docSnap.id, ...docSnap.data() })
  );

  state.bgTasks = items
    .filter((d) => d.start && d.end)
    .map((d, index) => ({
      id: d.id,
      shortId: d.shortId ?? d.taskId ?? index + 1,
      title: d.title || "",
      description: d.description || "",
      start: d.start,
      end: d.end,
      createdAt: d.createdAt ?? null
    }));
}

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

// Init
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
  state.timelineStart = startOfToday();
  state.timelineEnd =
    state.timelineStart +
    state.settings.horizonDays * 24 * HOUR_MS -
    1;
  recomputeTimeline();
}

document.addEventListener("DOMContentLoaded", init);

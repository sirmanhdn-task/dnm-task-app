// DNM's Tasker v1.4.4b – Magnet-from-NOW + Firebase (project: dnmstasker)

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
  currentUid: null
};

let currentEditTask = null;

// =============================
// Utils
// =============================
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatDateTimeShort(ms) {
  const d = new Date(ms);
  return (
    d.getFullYear().toString().slice(2) +
    "-" +
    pad2(d.getMonth() + 1) +
    "-" +
    pad2(d.getDate()) +
    " " +
    pad2(d.getHours()) +
    ":" +
    pad2(d.getMinutes())
  );
}

function formatHM(ms) {
  const d = new Date(ms);
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
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

function toLocalDatetimeInputValue(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return "";
  return (
    d.getFullYear() +
    "-" +
    pad2(d.getMonth() + 1) +
    "-" +
    pad2(d.getDate()) +
    "T" +
    pad2(d.getHours()) +
    ":" +
    pad2(d.getMinutes())
  );
}

function fromDatetimeLocalInputValue(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

// =============================
// Firebase helpers
// =============================
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

// =============================
// Magnet-from-NOW scheduler
// =============================
function recomputeTimeline() {
  state.now = Date.now();
  state.timelineStart = startOfToday();
  state.timelineEnd =
    state.timelineStart +
    state.settings.horizonDays * 24 * HOUR_MS -
    1;

  const totalSlices =
    (state.settings.horizonDays * 24 * 60) / state.settings.sliceMinutes;
  state.sliceTypes = new Array(totalSlices).fill(1);

  for (const bg of state.bgTasks) {
    const startMs = new Date(bg.start).getTime();
    const endMs = new Date(bg.end).getTime();
    if (isNaN(startMs) || isNaN(endMs) || endMs <= startMs) continue;

    const startClamped = clamp(startMs, state.timelineStart, state.timelineEnd);
    const endClamped = clamp(endMs, state.timelineStart, state.timelineEnd);

    let si = msToSliceIndex(startClamped);
    let ei = msToSliceIndex(endClamped);
    ei = clamp(ei, 0, totalSlices - 1);

    for (let s = si; s <= ei; s++) {
      if (bg.isParallel) {
        if (state.sliceTypes[s] !== 3) state.sliceTypes[s] = 2;
      } else {
        state.sliceTypes[s] = 3;
      }
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
    const allowedTypes = t.isParallel ? [1, 2] : [1];
    const assigned = [];

    let s = frontier;
    while (s < totalSlices && assigned.length < requiredSlices) {
      if (allowedTypes.includes(sliceTypes[s])) {
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

// =============================
// Render timeline
// =============================
function renderTimeline() {
  const header = document.getElementById("timelineHeader");
  const canvas = document.getElementById("timelineCanvas");
  header.innerHTML = "";
  canvas.innerHTML = "";

  const pxPerHour = 60;
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
      label.textContent = pad2(hour) + ":00";
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
      ? "rgba(219, 234, 254, 0.9)"
      : "rgba(241, 245, 249, 0.9)";

    band.textContent =
      pad2(date.getMonth() + 1) + "/" + pad2(date.getDate());
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

    const startClamped = clamp(startMs, state.timelineStart, state.timelineEnd);
    const endClamped = clamp(endMs, state.timelineStart, state.timelineEnd);

    const offsetHours = (startClamped - state.timelineStart) / HOUR_MS;
    const durationHours = (endClamped - startClamped) / HOUR_MS;

    const block = document.createElement("div");
    block.className =
      "timeline-block " + (bg.isParallel ? "bg-parallel" : "bg-nonparallel");
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

  // Main blocks
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
        `Mode: ${t.onlyMode}, Parallel: ${
          t.isParallel ? "Yes" : "No"
        }`;
      block.innerHTML = `
        <div style="font-weight:500">${t.title}</div>
        <div style="font-size:0.65rem;opacity:0.85">
          #${t.shortId ?? ""} ${formatHM(startMs)}–${formatHM(endMs)}
        </div>
      `;
      block.dataset.taskId = t.id;
      block.addEventListener("click", () => {
        const task = state.mainTasks.find((x) => x.id === t.id);
        if (task) openEditModal(task);
      });
      laneMain.appendChild(block);
    }
  }

  // Pending main tasks
  for (const t of state.mainTasks.filter((t) => t.isPending)) {
    const block = document.createElement("div");
    block.className = "timeline-block main";
    block.style.left = "4px";
    block.style.width = "140px";
    block.title = `${t.title}\n(Pending task - no timeline)`;
    block.innerHTML = `<div>${t.title}</div><div style="font-size:0.65rem;opacity:0.8">Pending (no timeline)</div>`;
    lanePending.appendChild(block);
  }

  // Current time marker
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

// =============================
// Render lists + debug
// =============================
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

  const bPar = document.createElement("span");
  bPar.className =
    "badge " + (t.isParallel ? "badge-parallel" : "badge-nonparallel");
  bPar.textContent = t.isParallel ? "Parallel" : "Non-parallel";
  badges.appendChild(bPar);

  if (t.onlyMode !== "NONE") {
    const bMode = document.createElement("span");
    bMode.className = "badge badge-mode";
    bMode.textContent = t.onlyMode;
    badges.appendChild(bMode);
  }

  main.appendChild(badges);

  const actions = document.createElement("div");
  actions.className = "task-actions";

  // Done / Undone
  const doneBtn = document.createElement("button");
  doneBtn.className = "icon-btn";
  doneBtn.textContent = t.isDone ? "Undone" : "Done";
  doneBtn.onclick = async () => {
    if (!state.currentUid) return;
    if (t.isDone) {
      await updateDoc(
        doc(db, "users", state.currentUid, "mainTasks", t.id),
        { isDone: false }
      );
    } else {
      if (!confirm("Mark this task as DONE?")) return;
      await updateDoc(
        doc(db, "users", state.currentUid, "mainTasks", t.id),
        { isDone: true }
      );
    }
    await loadAllData();
  };
  actions.appendChild(doneBtn);

  // Edit
  const editBtn = document.createElement("button");
  editBtn.className = "icon-btn";
  editBtn.textContent = "Edit";
  editBtn.onclick = () => {
    openEditModal(t);
  };
  actions.appendChild(editBtn);

  // Duplicate
  const dupBtn = document.createElement("button");
  dupBtn.className = "icon-btn";
  dupBtn.textContent = "Duplicate";
  dupBtn.onclick = async () => {
    if (!state.currentUid) return;
    const shortId = await getNextCounter(
      "mainTaskCount",
      state.currentUid
    );
    const dlIso = t.deadline || null;
    await addDoc(
      collection(db, "users", state.currentUid, "mainTasks"),
      {
        shortId,
        title: t.title,
        description: t.description,
        durationMinutes: t.durationMinutes,
        deadline: dlIso,
        isParallel: t.isParallel,
        isPending: t.isPending,
        isDone: false,
        onlyMode: t.onlyMode,
        dayPills: Array.isArray(t.dayPills) ? t.dayPills : [],
        slotPills: Array.isArray(t.slotPills) ? t.slotPills : [],
        createdAt: serverTimestamp()
      }
    );
    await loadAllData();
  };
  actions.appendChild(dupBtn);

  // Delete
  const delBtn = document.createElement("button");
  delBtn.className = "icon-btn";
  delBtn.textContent = "Delete";
  delBtn.onclick = async () => {
    if (!state.currentUid) return;
    if (!confirm("Delete this task permanently?")) return;
    await deleteDoc(
      doc(db, "users", state.currentUid, "mainTasks", t.id)
    );
    await loadAllData();
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

  for (const t of state.bgTasks) {
    const row = document.createElement("div");
    row.className = "task-item task-item-bg";

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
    const sMs = new Date(t.start).getTime();
    const eMs = new Date(t.end).getTime();
    meta.innerHTML = `
      <span>${formatDateTimeShort(sMs)} → ${formatDateTimeShort(eMs)}</span>
      <span>${t.isParallel ? "Parallel" : "Non-parallel"}</span>
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
  }

  if (state.bgTasks.length === 0) {
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
      <th>parallel</th>
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
      <td>${e.task.isParallel ? "P" : "NP"}</td>
      <td>${e.assignedSlices.join(",")}</td>
    `;
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  wrapper.appendChild(table);
}

// =============================
// UI helpers / pills
// =============================
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
  if (defaultVal) {
    pills.forEach((p) => {
      if (p.getAttribute("data-value") === defaultVal) {
        p.classList.add("active");
        current = defaultVal;
      }
    });
  }
  return () => current;
}

function setupTogglePills(groupEl) {
  const pills = groupEl.querySelectorAll(".pill");
  pills.forEach((pill) => {
    pill.addEventListener("click", () => {
      pill.classList.toggle("active");
    });
  });
}

// Generic getters/setters for edit modal pills
function setSinglePillValue(groupEl, value) {
  const pills = groupEl.querySelectorAll(".pill");
  pills.forEach((p) => {
    const v = p.getAttribute("data-value");
    p.classList.toggle("active", v === value);
  });
}

function getSinglePillValue(groupEl) {
  const active = groupEl.querySelector(".pill.active");
  return active ? active.getAttribute("data-value") : null;
}

function setMultiPillValues(groupEl, attr, values) {
  const set = new Set(values || []);
  const pills = groupEl.querySelectorAll(".pill");
  pills.forEach((p) => {
    const v = parseInt(p.getAttribute(attr), 10);
    p.classList.toggle("active", set.has(v));
  });
}

function getMultiPillValues(groupEl, attr) {
  const vals = [];
  const actives = groupEl.querySelectorAll(".pill.active");
  actives.forEach((p) => {
    vals.push(parseInt(p.getAttribute(attr), 10));
  });
  return vals;
}

function getActiveDayPills() {
  const group = document.getElementById("mtDayPills");
  return getMultiPillValues(group, "data-day");
}

function getActiveSlotPills() {
  const group = document.getElementById("mtSlotPills");
  return getMultiPillValues(group, "data-slot");
}

// =============================
// Main task form
// =============================
function setupMainTaskForm() {
  const form = document.getElementById("mainTaskForm");
  const parallelGetter = setupPillGroupSingle(
    document.getElementById("mtParallelGroup"),
    "nonparallel"
  );
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
    const dlDate = fromDatetimeLocalInputValue(dlStr);

    if (!title || !dur || !dlDate) return;

    const shortId = await getNextCounter(
      "mainTaskCount",
      state.currentUid
    );

    await addDoc(
      collection(db, "users", state.currentUid, "mainTasks"),
      {
        shortId,
        title,
        description: desc,
        durationMinutes: dur,
        deadline: dlDate.toISOString(),
        isParallel: parallelGetter() === "parallel",
        isPending: false,
        isDone: false,
        onlyMode: modeGetter() || "NONE",
        dayPills: getActiveDayPills(),
        slotPills: getActiveSlotPills(),
        createdAt: serverTimestamp()
      }
    );

    form.reset();
    recomputeAfterReload();
  });
}

// =============================
// Background form
// =============================
function setupBgTaskForm() {
  const form = document.getElementById("bgTaskForm");
  const parallelGetter = setupPillGroupSingle(
    document.getElementById("bgParallelGroup"),
    "nonparallel"
  );

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

    const sDate = fromDatetimeLocalInputValue(startStr);
    const eDate = fromDatetimeLocalInputValue(endStr);
    if (!title || !sDate || !eDate || eDate <= sDate) {
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
        start: sDate.toISOString(),
        end: eDate.toISOString(),
        isParallel: parallelGetter() === "parallel",
        createdAt: serverTimestamp()
      }
    );

    form.reset();
    recomputeAfterReload();
  });
}

// =============================
// Settings
// =============================
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

// =============================
// Timeline controls / debug
// =============================
function setupTimelineControls() {
  const canvas = document.getElementById("timelineCanvas");

  document.getElementById("jumpNowBtn").addEventListener("click", () => {
    const pxPerHour = 60;
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
    const pxPerHour = 60;
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

// =============================
// Edit modal
// =============================
function setupEditModal() {
  const backdrop = document.getElementById("editModalBackdrop");
  const closeBtn = document.getElementById("editModalCloseBtn");
  const cancelBtn = document.getElementById("editModalCancelBtn");
  const saveBtn = document.getElementById("editModalSaveBtn");

  // Pills in modal
  setupEditModalPills();

  function close() {
    backdrop.style.display = "none";
    currentEditTask = null;
  }

  closeBtn.addEventListener("click", close);
  cancelBtn.addEventListener("click", close);

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) {
      close();
    }
  });

  saveBtn.addEventListener("click", async () => {
    if (!currentEditTask || !state.currentUid) {
      close();
      return;
    }

    const title = document.getElementById("editTitle").value.trim();
    const desc = document.getElementById("editDescription").value.trim();
    const dur = parseInt(
      document.getElementById("editDuration").value,
      10
    );
    const dlStr = document.getElementById("editDeadline").value;
    const dlDate = fromDatetimeLocalInputValue(dlStr);

    if (!title || !dur || !dlDate) {
      alert("Please fill title, duration, deadline.");
      return;
    }

    const parallel =
      getSinglePillValue(document.getElementById("editParallelGroup")) ===
      "parallel";
    const mode =
      getSinglePillValue(document.getElementById("editModeGroup")) ||
      "NONE";
    const dayPills = getMultiPillValues(
      document.getElementById("editDayPills"),
      "data-day"
    );
    const slotPills = getMultiPillValues(
      document.getElementById("editSlotPills"),
      "data-slot"
    );

    await updateDoc(
      doc(db, "users", state.currentUid, "mainTasks", currentEditTask.id),
      {
        title,
        description: desc,
        durationMinutes: dur,
        deadline: dlDate.toISOString(),
        isParallel: parallel,
        onlyMode: mode,
        dayPills,
        slotPills
      }
    );

    close();
    await loadAllData();
  });
}

function setupEditModalPills() {
  const parallelGroup = document.getElementById("editParallelGroup");
  const modeGroup = document.getElementById("editModeGroup");
  const dayGroup = document.getElementById("editDayPills");
  const slotGroup = document.getElementById("editSlotPills");

  const parallelPills = parallelGroup.querySelectorAll(".pill");
  parallelPills.forEach((pill) => {
    pill.addEventListener("click", () => {
      parallelPills.forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
    });
  });

  const modePills = modeGroup.querySelectorAll(".pill");
  modePills.forEach((pill) => {
    pill.addEventListener("click", () => {
      modePills.forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
    });
  });

  setupTogglePills(dayGroup);
  setupTogglePills(slotGroup);
}

function openEditModal(task) {
  currentEditTask = task;

  const backdrop = document.getElementById("editModalBackdrop");
  const titleEl = document.getElementById("editTitle");
  const descEl = document.getElementById("editDescription");
  const durEl = document.getElementById("editDuration");
  const dlEl = document.getElementById("editDeadline");
  const titleLabel = document.getElementById("editModalTitle");
  const subtitleLabel = document.getElementById("editModalSubtitle");

  titleEl.value = task.title || "";
  descEl.value = task.description || "";
  durEl.value = task.durationMinutes || 30;
  dlEl.value = toLocalDatetimeInputValue(task.deadline);

  titleLabel.textContent = "Edit task #" + (task.shortId ?? "");
  subtitleLabel.textContent = task.title || "(untitled)";

  setSinglePillValue(
    document.getElementById("editParallelGroup"),
    task.isParallel ? "parallel" : "nonparallel"
  );
  setSinglePillValue(
    document.getElementById("editModeGroup"),
    task.onlyMode || "NONE"
  );
  setMultiPillValues(
    document.getElementById("editDayPills"),
    "data-day",
    Array.isArray(task.dayPills) ? task.dayPills : []
  );
  setMultiPillValues(
    document.getElementById("editSlotPills"),
    "data-slot",
    Array.isArray(task.slotPills) ? task.slotPills : []
  );

  backdrop.style.display = "flex";
}

// =============================
// Auth UI
// =============================
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

// =============================
// Load data from Firestore
// =============================
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
      isParallel: !!d.isParallel,
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
      isParallel: !!d.isParallel,
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

// =============================
// Init
// =============================
function init() {
  setupTabs();
  setupMainTaskForm();
  setupBgTaskForm();
  setupSettings();
  setupTimelineControls();
  setupDebugToggle();
  setupEditModal();

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

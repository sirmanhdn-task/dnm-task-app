// app.js v1.5.2
// - Timeline: hôm qua + hôm nay + tương lai (horizonDays)
// - Magnet-from-NOW engine
// - 2-column layout Timeline tab: form & list

import {
  initializeApp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore,
  doc,
  collection,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  orderBy,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

/* -------------------------------------------------------------------------- */
/*  FIREBASE INIT                                                             */
/* -------------------------------------------------------------------------- */
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

/* -------------------------------------------------------------------------- */
/*  GLOBAL STATE                                                              */
/* -------------------------------------------------------------------------- */

const ONE_MIN = 60 * 1000;
const ONE_HOUR = 60 * ONE_MIN;
const ONE_DAY = 24 * ONE_HOUR;

const state = {
  now: Date.now(),
  currentUid: null,

  settings: {
    sliceMinutes: 10,
    horizonDays: 14, // tương lai
    kOnlyPrefer: 5,
    kShort: 1000
  },

  timelineStart: null,
  timelineEnd: null,
  nowSlice: 0,
  sliceTypes: [],
  scheduledMain: [],

  mainTasks: [],
  bgTasks: [],

  overdueTasks: [],
  pendingTasks: [],

  duplicateTarget: null,
  currentEditTask: null,
  currentTooltipTask: null
};

/* -------------------------------------------------------------------------- */
/*  HELPERS                                                                   */
/* -------------------------------------------------------------------------- */

function toDateInputValue(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n) => n.toString().padStart(2, "0");
  const yyyy = d.getFullYear();
  const MM = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  return `${yyyy}-${MM}-${dd}T${hh}:${mm}`;
}

function fromDateInputValue(v) {
  if (!v) return null;
  const t = new Date(v);
  if (Number.isNaN(t.getTime())) return null;
  return t.getTime();
}

function formatTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  const pad = (n) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDateTimeShort(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  const pad = (n) => n.toString().padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/* -------------------------------------------------------------------------- */
/*  TIMELINE RANGE (v1.5.2: CÓ NGÀY HÔM QUA)                                  */
/* -------------------------------------------------------------------------- */

function computeTimelineRange() {
  state.now = Date.now();
  const now = state.now;

  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  // LÙI LẠI 1 NGÀY -> timelineStart là 0h ngày hôm qua
  start.setDate(start.getDate() - 1);

  state.timelineStart = start.getTime();
  // Thêm 1 ngày quá khứ + horizonDays ngày tương lai
  state.timelineEnd = state.timelineStart + (state.settings.horizonDays + 1) * ONE_DAY;

  const sliceMinutes = state.settings.sliceMinutes;
  const totalSlices = Math.floor((state.timelineEnd - state.timelineStart) / (sliceMinutes * ONE_MIN));
  state.sliceTypes = new Array(totalSlices).fill(1); // 1 = FREE

  const nowSlice = Math.floor((state.now - state.timelineStart) / (sliceMinutes * ONE_MIN));
  state.nowSlice = clamp(nowSlice, 0, totalSlices - 1);
}

/* -------------------------------------------------------------------------- */
/*  ENGINE: CLASSIFY, WEIGHT, SCHEDULE                                        */
/* -------------------------------------------------------------------------- */

function classifyTasks() {
  state.overdueTasks = [];
  state.pendingTasks = [];

  const engineTasks = [];

  const now = state.now;

  for (const t of state.mainTasks) {
    if (t.isDone) continue;

    const isOverdue = t.deadline && t.deadline < now;
    const pendingUntilFuture = t.pendingUntil && t.pendingUntil > now;

    if (isOverdue) {
      state.overdueTasks.push(t);
      continue;
    }

    if (pendingUntilFuture || t.isPending) {
      state.pendingTasks.push(t);
      continue;
    }

    engineTasks.push(t);
  }

  return engineTasks;
}

function isNowWithinTaskWindow(task, now) {
  const d = new Date(now);
  const day = d.getDay(); // 0..6
  const hour = d.getHours();

  const dayOk = !task.dayPills || task.dayPills.length === 0 || task.dayPills.includes(day);
  const slot = Math.floor(hour / 3);
  const slotOk = !task.slotPills || task.slotPills.length === 0 || task.slotPills.includes(slot);

  return dayOk && slotOk;
}

function computeWeight(task, now) {
  let minutesLeft = 1e9;
  let baseW = 0;

  if (task.deadline) {
    const diff = task.deadline - now;
    minutesLeft = Math.max(1, Math.floor(diff / ONE_MIN));
    baseW = task.durationMinutes / minutesLeft;
  }

  let w = baseW;

  // short task boost
  if (task.durationMinutes <= 10 && minutesLeft <= 48 * 60) {
    w *= state.settings.kShort;
  }

  // only/prefer mode
  const within = isNowWithinTaskWindow(task, now);
  let timeFactor = 1;

  if (task.onlyMode === "ONLY") {
    timeFactor = within ? state.settings.kOnlyPrefer : 0;
  } else if (task.onlyMode === "PREFER") {
    timeFactor = within ? state.settings.kOnlyPrefer : 1;
  }

  w *= timeFactor;

  return {
    wBase: baseW,
    minutesLeft,
    timeFactor,
    wFinal: w
  };
}

function applyBackgroundSlices() {
  const sliceMinutes = state.settings.sliceMinutes;
  const totalSlices = state.sliceTypes.length;

  for (const bg of state.bgTasks) {
    if (!bg.start || !bg.end) continue;
    if (bg.end <= state.timelineStart || bg.start >= state.timelineEnd) continue;

    const startIdx = clamp(
      Math.floor((bg.start - state.timelineStart) / (sliceMinutes * ONE_MIN)),
      0,
      totalSlices - 1
    );
    const endIdx = clamp(
      Math.ceil((bg.end - state.timelineStart) / (sliceMinutes * ONE_MIN)),
      0,
      totalSlices
    );

    for (let i = startIdx; i < endIdx; i++) {
      state.sliceTypes[i] = 3; // BACKGROUND BLOCK
    }
  }
}

function scheduleMainTasks() {
  const engineTasks = classifyTasks();
  const sliceMinutes = state.settings.sliceMinutes;
  const now = state.now;

  const totalSlices = state.sliceTypes.length;

  const enriched = engineTasks.map((t) => {
    const wInfo = computeWeight(t, now);
    return {
      task: t,
      ...wInfo
    };
  });

  enriched.sort((a, b) => {
    if (b.wFinal !== a.wFinal) return b.wFinal - a.wFinal;
    return a.minutesLeft - b.minutesLeft;
  });

  let frontier = state.nowSlice;

  const scheduled = [];

  for (const e of enriched) {
    const t = e.task;
    const requiredSlices = Math.ceil(t.durationMinutes / sliceMinutes);
    if (requiredSlices <= 0) continue;

    const assigned = [];
    for (let i = frontier; i < totalSlices; i++) {
      if (state.sliceTypes[i] === 1) {
        assigned.push(i);
      }
      if (assigned.length === requiredSlices) break;
    }

    if (assigned.length > 0) {
      frontier = assigned[assigned.length - 1] + 1;
    }

    scheduled.push({
      task: t,
      assignedSlices: assigned,
      wBase: e.wBase,
      wFinal: e.wFinal,
      minutesLeft: e.minutesLeft,
      timeFactor: e.timeFactor
    });
  }

  state.scheduledMain = scheduled;
}

/* -------------------------------------------------------------------------- */
/*  PUBLIC PIPELINE                                                            */
/* -------------------------------------------------------------------------- */

function recomputeTimeline() {
  computeTimelineRange();
  state.sliceTypes.fill(1);

  applyBackgroundSlices();
  scheduleMainTasks();
  renderAll();
}

/* -------------------------------------------------------------------------- */
/*  FIRESTORE I/O                                                             */
/* -------------------------------------------------------------------------- */

function userDocRef(uid) {
  return doc(db, "users", uid);
}

function mainTasksCol(uid) {
  return collection(db, "users", uid, "mainTasks");
}

function bgTasksCol(uid) {
  return collection(db, "users", uid, "backgroundTasks");
}

function countersDoc(uid) {
  return doc(db, "users", uid, "metadata", "counters");
}

async function ensureUserInitialized(uid) {
  const cRef = countersDoc(uid);
  const snap = await getDoc(cRef);
  if (!snap.exists()) {
    await setDoc(cRef, { mainShortId: 1, bgShortId: 1 });
  }
}

async function getNextShortId(uid, key) {
  const cRef = countersDoc(uid);
  const snap = await getDoc(cRef);
  let current = 1;
  if (snap.exists() && typeof snap.data()[key] === "number") {
    current = snap.data()[key];
  }
  const next = current + 1;
  await setDoc(cRef, { [key]: next }, { merge: true });
  return current;
}

function mapMainDoc(id, data) {
  return {
    id,
    title: data.title || "",
    description: data.description || "",
    durationMinutes: data.durationMinutes ?? data.duration ?? 30,
    deadline: data.deadline ?? data.deadlineAt ?? null,
    onlyMode: data.onlyMode || "NONE",
    dayPills: data.dayPills || [],
    slotPills: data.slotPills || [],
    isPending: data.isPending || false,
    pendingUntil: data.pendingUntil ?? null,
    isDone: data.isDone || false,
    shortId: data.shortId ?? data.taskId ?? null,
    createdAt: data.createdAt ?? null
  };
}

async function loadMainTasksFromFirestore() {
  if (!state.currentUid) return;
  const q = query(mainTasksCol(state.currentUid), orderBy("createdAt", "asc"));
  const snap = await getDocs(q);
  const tasks = [];
  snap.forEach((docSnap) => {
    tasks.push(mapMainDoc(docSnap.id, docSnap.data()));
  });
  state.mainTasks = tasks;
}

function mapBgDoc(id, data) {
  return {
    id,
    title: data.title || "",
    start: data.start ?? data.startAt ?? null,
    end: data.end ?? data.endAt ?? null,
    shortId: data.shortId ?? null,
    createdAt: data.createdAt ?? null
  };
}

async function loadBgTasksFromFirestore() {
  if (!state.currentUid) return;
  const q = query(bgTasksCol(state.currentUid), orderBy("createdAt", "asc"));
  const snap = await getDocs(q);

  const tasks = [];
  const now = state.now;

  for (const docSnap of snap.docs) {
    const data = docSnap.data();
    const mapped = mapBgDoc(docSnap.id, data);
    if (mapped.end && mapped.end <= now) {
      // auto-delete background đã hết hạn
      await deleteDoc(docSnap.ref);
      continue;
    }
    tasks.push(mapped);
  }

  state.bgTasks = tasks;
}

async function loadAllData() {
  if (!state.currentUid) return;
  await Promise.all([loadMainTasksFromFirestore(), loadBgTasksFromFirestore()]);
  recomputeTimeline();
}

/* -------------------------------------------------------------------------- */
/*  RENDERING                                                                 */
/* -------------------------------------------------------------------------- */

function renderAll() {
  renderMainTaskList();
  renderBgTaskList();
  renderTimeline();
  renderSettingsForm();
  renderDebugPanel();
}

/* MAIN TASK LIST ----------------------------------------------------------- */

function renderMainTaskList() {
  const container = document.getElementById("main-task-list");
  if (!container) return;
  container.innerHTML = "";

  const now = state.now;
  const scheduledIds = new Set(
    state.scheduledMain
      .filter((e) => e.assignedSlices && e.assignedSlices.length > 0)
      .map((e) => e.task.id)
  );

  const activeScheduled = [];
  const pending = [];
  const overdue = [];
  const others = [];
  const done = [];

  const overdueSet = new Set(state.overdueTasks.map((t) => t.id));
  const pendingSet = new Set(state.pendingTasks.map((t) => t.id));

  for (const t of state.mainTasks) {
    if (t.isDone) {
      done.push(t);
      continue;
    }
    if (overdueSet.has(t.id)) {
      overdue.push(t);
      continue;
    }
    if (pendingSet.has(t.id)) {
      pending.push(t);
      continue;
    }
    if (scheduledIds.has(t.id)) {
      activeScheduled.push(t);
    } else {
      others.push(t);
    }
  }

  function addSection(title, list, badgeClass) {
    if (!list.length) return;
    const header = document.createElement("div");
    header.className = "task-section-header";
    header.textContent = title;
    header.style.fontSize = "11px";
    header.style.color = "var(--text-subtle)";
    header.style.margin = "4px 0";
    container.appendChild(header);

    for (const t of list) {
      const el = renderTaskItemRow(t, badgeClass);
      container.appendChild(el);
    }
  }

  addSection("Active (scheduled)", activeScheduled, "");
  addSection("Pending", pending, "badge-pending");
  addSection("Overdue", overdue, "badge-overdue");
  addSection("Active (chưa được schedule)", others, "");
  addSection("Done", done, "badge-done");
}

function renderTaskItemRow(task, extraBadgeClass) {
  const now = state.now;
  const item = document.createElement("div");
  item.className = "task-item";

  const header = document.createElement("div");
  header.className = "task-header";

  const title = document.createElement("div");
  title.className = "task-title";
  title.textContent = task.title || "(No title)";
  const idSpan = document.createElement("span");
  idSpan.textContent = `#${task.shortId ?? "?"}`;
  title.appendChild(idSpan);

  const badgeRow = document.createElement("div");
  badgeRow.className = "task-badges";

  const mainBadge = document.createElement("span");
  mainBadge.className = "badge badge-main";
  mainBadge.textContent = "MAIN";
  badgeRow.appendChild(mainBadge);

  const modeBadge = document.createElement("span");
  modeBadge.className = "badge";
  modeBadge.textContent = `Mode: ${task.onlyMode || "NONE"}`;
  badgeRow.appendChild(modeBadge);

  if (task.isDone) {
    const b = document.createElement("span");
    b.className = "badge badge-done";
    b.textContent = "DONE";
    badgeRow.appendChild(b);
  }

  if (extraBadgeClass) {
    const b = document.createElement("span");
    b.className = `badge ${extraBadgeClass}`;
    b.textContent = extraBadgeClass.includes("overdue") ? "OVERDUE" : extraBadgeClass.includes("pending") ? "PENDING" : "";
    badgeRow.appendChild(b);
  } else {
    const isOverdue = task.deadline && task.deadline < now && !task.isDone;
    if (isOverdue) {
      const b = document.createElement("span");
      b.className = "badge badge-overdue";
      b.textContent = "OVERDUE";
      badgeRow.appendChild(b);
    }

    const pendingUntilFuture = task.pendingUntil && task.pendingUntil > now;
    if (pendingUntilFuture || task.isPending) {
      const b = document.createElement("span");
      b.className = "badge badge-pending";
      b.textContent = pendingUntilFuture ? `PENDING UNTIL ${formatDateTimeShort(task.pendingUntil)}` : "PENDING";
      badgeRow.appendChild(b);
    }
  }

  header.appendChild(title);
  header.appendChild(badgeRow);

  const meta = document.createElement("div");
  meta.className = "task-meta";
  const parts = [];
  parts.push(`Duration: ${task.durationMinutes} phút`);
  if (task.deadline) {
    parts.push(`Deadline: ${formatDateTimeShort(task.deadline)}`);
  }
  meta.textContent = parts.join(" • ");

  const actions = document.createElement("div");
  actions.className = "task-actions";

  const btnEdit = document.createElement("button");
  btnEdit.className = "btn small";
  btnEdit.textContent = "Edit";
  btnEdit.addEventListener("click", () => openEditModal(task));

  const btnDone = document.createElement("button");
  btnDone.className = "btn small primary";
  btnDone.textContent = task.isDone ? "Undone" : "Done";
  btnDone.addEventListener("click", () => toggleDoneTask(task));

  const btnDup = document.createElement("button");
  btnDup.className = "btn small";
  btnDup.textContent = "Duplicate";
  btnDup.addEventListener("click", () => openDuplicateSheet(task));

  const btnDel = document.createElement("button");
  btnDel.className = "btn small danger";
  btnDel.textContent = "Delete";
  btnDel.addEventListener("click", () => deleteMainTask(task));

  actions.appendChild(btnEdit);
  actions.appendChild(btnDone);
  actions.appendChild(btnDup);
  actions.appendChild(btnDel);

  item.appendChild(header);
  item.appendChild(meta);
  item.appendChild(actions);

  return item;
}

/* BACKGROUND LIST ---------------------------------------------------------- */

function renderBgTaskList() {
  const container = document.getElementById("bg-task-list");
  if (!container) return;
  container.innerHTML = "";

  for (const t of state.bgTasks) {
    const item = document.createElement("div");
    item.className = "task-item";

    const header = document.createElement("div");
    header.className = "task-header";

    const title = document.createElement("div");
    title.className = "task-title";
    title.textContent = t.title;
    const idSpan = document.createElement("span");
    idSpan.textContent = `#${t.shortId ?? "?"}`;
    title.appendChild(idSpan);

    const meta = document.createElement("div");
    meta.className = "task-meta";
    meta.textContent = `${formatDateTimeShort(t.start)} – ${formatDateTimeShort(t.end)}`;

    const actions = document.createElement("div");
    actions.className = "task-actions";

    const btnDel = document.createElement("button");
    btnDel.className = "btn small danger";
    btnDel.textContent = "Delete";
    btnDel.addEventListener("click", () => deleteBgTask(t));

    actions.appendChild(btnDel);

    header.appendChild(title);
    item.appendChild(header);
    item.appendChild(meta);
    item.appendChild(actions);
    container.appendChild(item);
  }
}

/* TIMELINE RENDER ---------------------------------------------------------- */

function renderTimeline() {
  const timelineRuler = document.getElementById("timeline-ruler");
  const timelineDays = document.getElementById("timeline-days");
  const laneMain = document.getElementById("lane-main");
  const laneBg = document.getElementById("lane-bg");
  const lanePending = document.getElementById("lane-pending");
  const nowLine = document.getElementById("now-line");
  const container = document.getElementById("timeline-container");

  if (!timelineRuler || !timelineDays || !laneMain || !laneBg || !lanePending || !nowLine || !container) return;

  timelineRuler.innerHTML = "";
  timelineDays.innerHTML = "";
  laneMain.innerHTML = "";
  laneBg.innerHTML = "";
  lanePending.innerHTML = "";

  const pxPerHour = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--timeline-hour-width")
  ) || 64;

  const totalHours = (state.timelineEnd - state.timelineStart) / ONE_HOUR;
  const totalWidth = totalHours * pxPerHour;

  container.style.width = `${totalWidth + 80}px`; // +80 để dư chút cho cụm overdue

  // RULER HOURS
  for (let h = 0; h <= totalHours; h++) {
    const x = h * pxPerHour;
    const hourLabel = document.createElement("div");
    hourLabel.className = "ruler-hour";
    hourLabel.style.left = `${x}px`;
    const hourInDay = (h % 24);
    hourLabel.textContent = `${hourInDay.toString().padStart(2, "0")}:00`;
    timelineRuler.appendChild(hourLabel);
  }

  // DAY BANDS (ngày hôm qua + hôm nay + tương lai)
  const totalDays = state.settings.horizonDays + 1;
  for (let d = 0; d < totalDays; d++) {
    const band = document.createElement("div");
    band.className = "day-band";
    const dayStart = state.timelineStart + d * ONE_DAY;
    const left = (dayStart - state.timelineStart) / ONE_HOUR * pxPerHour;
    const width = ONE_DAY / ONE_HOUR * pxPerHour;

    band.style.left = `${left}px`;
    band.style.width = `${width}px`;

    const date = new Date(dayStart);
    const label = date.toLocaleDateString("vi-VN", { weekday: "short", day: "2-digit", month: "2-digit" });
    band.textContent = label;

    const todayRef = new Date(state.now);
    todayRef.setHours(0, 0, 0, 0);
    const bandRef = new Date(dayStart);
    bandRef.setHours(0, 0, 0, 0);

    if (bandRef.getTime() === todayRef.getTime()) {
      band.classList.add("today");
    }

    timelineDays.appendChild(band);
  }

  // NOW LINE
  const nowOffsetHours = (state.now - state.timelineStart) / ONE_HOUR;
  const nowX = nowOffsetHours * pxPerHour;
  nowLine.style.left = `${nowX}px`;

  // BACKGROUND BLOCKS
  for (const bg of state.bgTasks) {
    if (!bg.start || !bg.end) continue;
    if (bg.end <= state.timelineStart || bg.start >= state.timelineEnd) continue;

    const startOffsetHours = (bg.start - state.timelineStart) / ONE_HOUR;
    const endOffsetHours = (bg.end - state.timelineStart) / ONE_HOUR;
    const x = Math.max(0, startOffsetHours * pxPerHour);
    const width = Math.max(8, (endOffsetHours - startOffsetHours) * pxPerHour);

    const block = document.createElement("div");
    block.className = "timeline-block bg";
    block.style.left = `${x}px`;
    block.style.width = `${width}px`;
    block.textContent = `${bg.title} (${formatTime(bg.start)}–${formatTime(bg.end)})`;

    laneBg.appendChild(block);
  }

  // MAIN ACTIVE BLOCKS (segments)
  for (const entry of state.scheduledMain) {
    const { task, assignedSlices } = entry;
    if (!assignedSlices || assignedSlices.length === 0) continue;

    const segments = [];
    let current = [];
    let prev = null;

    for (const idx of assignedSlices) {
      if (prev === null || idx === prev + 1) {
        current.push(idx);
      } else {
        if (current.length) segments.push(current);
        current = [idx];
      }
      prev = idx;
    }
    if (current.length) segments.push(current);

    for (const seg of segments) {
      const startSlice = seg[0];
      const endSlice = seg[seg.length - 1] + 1;

      const sliceMinutes = state.settings.sliceMinutes;
      const startTime = state.timelineStart + startSlice * sliceMinutes * ONE_MIN;
      const endTime = state.timelineStart + endSlice * sliceMinutes * ONE_MIN;

      const startOffsetHours = (startTime - state.timelineStart) / ONE_HOUR;
      const endOffsetHours = (endTime - state.timelineStart) / ONE_HOUR;

      const x = startOffsetHours * pxPerHour;
      const width = Math.max(10, (endOffsetHours - startOffsetHours) * pxPerHour);

      const block = document.createElement("div");
      block.className = "timeline-block main";
      block.style.left = `${x}px`;
      block.style.width = `${width}px`;
      block.textContent = `${task.title} (#${task.shortId ?? "?"})`;

      block.addEventListener("click", (ev) => {
        openTaskTooltip(task, ev.clientX, ev.clientY);
      });

      laneMain.appendChild(block);
    }
  }

  // OVERDUE CLUSTER (bên trái NOW)
  const overdue = state.overdueTasks;
  const blockWidth = 150;
  const gap = 8;
  overdue.forEach((t, index) => {
    let x = nowX - blockWidth * (index + 1) - gap * (index + 1);
    if (x < 4) x = 4;

    const block = document.createElement("div");
    block.className = "timeline-block main overdue";
    block.style.left = `${x}px`;
    block.style.width = `${blockWidth}px`;
    block.textContent = `${t.title} (#${t.shortId ?? "?"})`;

    block.addEventListener("click", (ev) => {
      openTaskTooltip(t, ev.clientX, ev.clientY);
    });

    laneMain.appendChild(block);
  });

  // PENDING LANE
  for (const t of state.pendingTasks) {
    const block = document.createElement("div");
    block.className = "timeline-block pending";

    // đặt các block pending dạng "cluster" từ trái sang phải
    const idx = state.pendingTasks.indexOf(t);
    const x = 10 + idx * (blockWidth + gap);
    block.style.left = `${x}px`;
    block.style.width = `${blockWidth}px`;

    const pendingLabel = t.pendingUntil ? `Pending until ${formatDateTimeShort(t.pendingUntil)}` : "Pending";
    block.textContent = `${t.title} (#${t.shortId ?? "?"}) – ${pendingLabel}`;

    block.addEventListener("click", (ev) => {
      openTaskTooltip(t, ev.clientX, ev.clientY);
    });

    lanePending.appendChild(block);
  }
}

/* SETTINGS RENDER ---------------------------------------------------------- */

function renderSettingsForm() {
  const s = state.settings;
  const sliceInput = document.getElementById("setting-slice");
  const horizonInput = document.getElementById("setting-horizon");
  const konlyInput = document.getElementById("setting-konly");
  const kshortInput = document.getElementById("setting-kshort");

  if (!sliceInput) return;

  sliceInput.value = s.sliceMinutes;
  horizonInput.value = s.horizonDays;
  konlyInput.value = s.kOnlyPrefer;
  kshortInput.value = s.kShort;
}

/* DEBUG PANEL -------------------------------------------------------------- */

function renderDebugPanel() {
  const summaryEl = document.getElementById("debug-summary");
  const tableEl = document.getElementById("debug-table");
  if (!summaryEl || !tableEl) return;

  const total = state.mainTasks.length;
  const done = state.mainTasks.filter((t) => t.isDone).length;
  const active = total - done;
  const scheduled = state.scheduledMain.filter((e) => e.assignedSlices && e.assignedSlices.length > 0).length;
  const overdue = state.overdueTasks.length;
  const pending = state.pendingTasks.length;

  summaryEl.textContent = `Total main: ${total} • Active: ${active} • Scheduled: ${scheduled} • Overdue: ${overdue} • Pending: ${pending} • SliceMinutes: ${state.settings.sliceMinutes} • Horizon+1: ${state.settings.horizonDays + 1} days • nowSlice=${state.nowSlice}`;

  const rows = state.scheduledMain.map((e) => {
    return `<tr>
      <td>${e.task.shortId ?? "?"}</td>
      <td>${e.task.title}</td>
      <td>${e.wBase.toFixed(4)}</td>
      <td>${e.timeFactor.toFixed(2)}</td>
      <td>${e.wFinal.toFixed(4)}</td>
      <td>${e.minutesLeft}</td>
      <td>${e.assignedSlices.join(",")}</td>
    </tr>`;
  });

  tableEl.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Title</th>
          <th>wBase</th>
          <th>timeFactor</th>
          <th>wFinal</th>
          <th>minutesLeft</th>
          <th>slices</th>
        </tr>
      </thead>
      <tbody>${rows.join("")}</tbody>
    </table>
  `;
}

/* -------------------------------------------------------------------------- */
/*  TOOLTIP / MODAL / DUPLICATE                                              */
/* -------------------------------------------------------------------------- */

function openTaskTooltip(task, x, y) {
  const tooltip = document.getElementById("task-tooltip");
  if (!tooltip) return;
  state.currentTooltipTask = task;

  document.getElementById("tooltip-title").textContent = `${task.title} (#${task.shortId ?? "?"})`;

  const parts = [];
  if (task.deadline) parts.push(`Deadline: ${formatDateTimeShort(task.deadline)}`);
  parts.push(`Duration: ${task.durationMinutes} phút`);
  parts.push(`Mode: ${task.onlyMode}`);
  if (task.pendingUntil) parts.push(`PendingUntil: ${formatDateTimeShort(task.pendingUntil)}`);
  document.getElementById("tooltip-meta").textContent = parts.join(" • ");

  tooltip.style.left = `${x + 8}px`;
  tooltip.style.top = `${y + 8}px`;
  tooltip.classList.remove("hidden");
}

function closeTaskTooltip() {
  const tooltip = document.getElementById("task-tooltip");
  if (!tooltip) return;
  tooltip.classList.add("hidden");
  state.currentTooltipTask = null;
}

// EDIT MODAL

function openEditModal(task) {
  state.currentEditTask = task;
  const modal = document.getElementById("edit-modal");
  if (!modal) return;

  document.getElementById("edit-title").value = task.title;
  document.getElementById("edit-desc").value = task.description || "";
  document.getElementById("edit-duration").value = task.durationMinutes;
  document.getElementById("edit-deadline").value = toDateInputValue(task.deadline);
  document.getElementById("edit-mode").value = task.onlyMode || "NONE";

  const dayPills = document.querySelectorAll("#edit-day-pills .pill");
  dayPills.forEach((btn) => {
    const d = Number(btn.dataset.day);
    btn.classList.toggle("active", task.dayPills && task.dayPills.includes(d));
  });

  const slotPills = document.querySelectorAll("#edit-slot-pills .pill");
  slotPills.forEach((btn) => {
    const s = Number(btn.dataset.slot);
    btn.classList.toggle("active", task.slotPills && task.slotPills.includes(s));
  });

  const toggle = document.getElementById("edit-pending-toggle");
  const pendingInput = document.getElementById("edit-pending-until");
  if (task.pendingUntil) {
    toggle.checked = true;
    pendingInput.disabled = false;
    pendingInput.value = toDateInputValue(task.pendingUntil);
  } else {
    toggle.checked = false;
    pendingInput.disabled = true;
    pendingInput.value = "";
  }

  modal.classList.remove("hidden");
}

function closeEditModal() {
  const modal = document.getElementById("edit-modal");
  if (modal) modal.classList.add("hidden");
  state.currentEditTask = null;
}

// DUPLICATE SHEET

function openDuplicateSheet(task) {
  state.duplicateTarget = task;
  const sheet = document.getElementById("duplicate-sheet");
  if (sheet) sheet.classList.remove("hidden");
}

function closeDuplicateSheet() {
  const sheet = document.getElementById("duplicate-sheet");
  if (sheet) sheet.classList.add("hidden");
  state.duplicateTarget = null;
}

function openDuplicateCustomModal() {
  const modal = document.getElementById("duplicate-custom-modal");
  if (modal) modal.classList.remove("hidden");
}

function closeDuplicateCustomModal() {
  const modal = document.getElementById("duplicate-custom-modal");
  if (modal) modal.classList.add("hidden");
}

/* -------------------------------------------------------------------------- */
/*  CRUD MAIN TASKS                                                           */
/* -------------------------------------------------------------------------- */

async function addMainTask(task) {
  if (!state.currentUid) return;
  const shortId = await getNextShortId(state.currentUid, "mainShortId");

  const payload = {
    title: task.title,
    description: task.description || "",
    durationMinutes: task.durationMinutes,
    deadline: task.deadline,
    onlyMode: task.onlyMode || "NONE",
    dayPills: task.dayPills || [],
    slotPills: task.slotPills || [],
    isPending: !!task.isPending,
    pendingUntil: task.pendingUntil || null,
    isDone: false,
    shortId,
    createdAt: serverTimestamp()
  };

  await addDoc(mainTasksCol(state.currentUid), payload);
}

async function updateMainTask(taskId, patch) {
  if (!state.currentUid) return;
  const ref = doc(mainTasksCol(state.currentUid), taskId);
  await updateDoc(ref, patch);
}

async function toggleDoneTask(task) {
  await updateMainTask(task.id, { isDone: !task.isDone });
  await loadAllData();
}

async function deleteMainTask(task) {
  if (!state.currentUid) return;
  await deleteDoc(doc(mainTasksCol(state.currentUid), task.id));
  await loadAllData();
}

async function duplicateTaskWithDeadline(task, newDeadlineTs) {
  await addMainTask({
    ...task,
    deadline: newDeadlineTs,
    isPending: false,
    pendingUntil: null,
    isDone: false
  });
  await loadAllData();
}

/* -------------------------------------------------------------------------- */
/*  CRUD BACKGROUND TASKS                                                     */
/* -------------------------------------------------------------------------- */

async function addBgTask(task) {
  if (!state.currentUid) return;
  const shortId = await getNextShortId(state.currentUid, "bgShortId");

  const payload = {
    title: task.title,
    start: task.start,
    end: task.end,
    shortId,
    createdAt: serverTimestamp()
  };
  await addDoc(bgTasksCol(state.currentUid), payload);
}

async function deleteBgTask(task) {
  if (!state.currentUid) return;
  await deleteDoc(doc(bgTasksCol(state.currentUid), task.id));
  await loadAllData();
}

/* -------------------------------------------------------------------------- */
/*  AUTH UI                                                                   */
/* -------------------------------------------------------------------------- */

function setLoggedInUI(user) {
  const loginBtn = document.getElementById("login-btn");
  const logoutBtn = document.getElementById("logout-btn");
  const userInfo = document.getElementById("user-info");
  const userEmail = document.getElementById("user-email");
  if (!loginBtn || !logoutBtn || !userInfo || !userEmail) return;

  loginBtn.classList.add("hidden");
  userInfo.classList.remove("hidden");
  logoutBtn.classList.remove("hidden");
  userEmail.textContent = user.email || "";
}

function setLoggedOutUI() {
  const loginBtn = document.getElementById("login-btn");
  const logoutBtn = document.getElementById("logout-btn");
  const userInfo = document.getElementById("user-info");
  if (!loginBtn || !logoutBtn || !userInfo) return;

  loginBtn.classList.remove("hidden");
  userInfo.classList.add("hidden");
  logoutBtn.classList.add("hidden");
}

/* -------------------------------------------------------------------------- */
/*  EVENT BINDINGS                                                            */
/* -------------------------------------------------------------------------- */

function bindAuthEvents() {
  const loginBtn = document.getElementById("login-btn");
  const logoutBtn = document.getElementById("logout-btn");

  if (loginBtn) {
    loginBtn.addEventListener("click", async () => {
      try {
        await signInWithPopup(auth, provider);
      } catch (err) {
        console.error("Login error", err);
      }
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      try {
        await signOut(auth);
      } catch (err) {
        console.error("Logout error", err);
      }
    });
  }

  onAuthStateChanged(auth, async (user) => {
    if (user) {
      state.currentUid = user.uid;
      setLoggedInUI(user);
      await ensureUserInitialized(user.uid);
      await loadAllData();
    } else {
      state.currentUid = null;
      setLoggedOutUI();
      state.mainTasks = [];
      state.bgTasks = [];
      state.overdueTasks = [];
      state.pendingTasks = [];
      state.scheduledMain = [];
      recomputeTimeline();
    }
  });
}

function bindTabEvents() {
  const tabBtns = document.querySelectorAll(".tab-btn");
  const panels = document.querySelectorAll(".tab-panel");

  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      tabBtns.forEach((b) => b.classList.toggle("active", b === btn));
      panels.forEach((p) => p.classList.toggle("active", p.id === tab));
    });
  });
}

function bindMainTaskForm() {
  const form = document.getElementById("main-task-form");
  const pendingToggle = document.getElementById("task-pending-toggle");
  const pendingInput = document.getElementById("task-pending-until");

  if (!form) return;

  if (pendingToggle && pendingInput) {
    pendingToggle.addEventListener("change", () => {
      pendingInput.disabled = !pendingToggle.checked;
      if (!pendingToggle.checked) pendingInput.value = "";
    });
  }

  const dayPills = document.querySelectorAll("#day-pills .pill");
  dayPills.forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.classList.toggle("active");
    });
  });

  const slotPills = document.querySelectorAll("#slot-pills .pill");
  slotPills.forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.classList.toggle("active");
    });
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.currentUid) {
      alert("Hãy đăng nhập trước.");
      return;
    }

    const title = document.getElementById("task-title").value.trim();
    const desc = document.getElementById("task-desc").value.trim();
    const duration = Number(document.getElementById("task-duration").value);
    const deadline = fromDateInputValue(document.getElementById("task-deadline").value);
    const mode = document.getElementById("task-mode").value;

    if (!title || !deadline || !duration) {
      alert("Thiếu tiêu đề / deadline / duration");
      return;
    }

    const dayPillsSel = [];
    document.querySelectorAll("#day-pills .pill.active").forEach((btn) => {
      dayPillsSel.push(Number(btn.dataset.day));
    });

    const slotPillsSel = [];
    document.querySelectorAll("#slot-pills .pill.active").forEach((btn) => {
      slotPillsSel.push(Number(btn.dataset.slot));
    });

    let pendingUntil = null;
    let isPending = false;
    if (pendingToggle && pendingToggle.checked) {
      pendingUntil = fromDateInputValue(pendingInput.value);
      if (pendingUntil && pendingUntil > Date.now()) {
        isPending = true;
      }
    }

    await addMainTask({
      title,
      description: desc,
      durationMinutes: duration,
      deadline,
      onlyMode: mode,
      dayPills: dayPillsSel,
      slotPills: slotPillsSel,
      isPending,
      pendingUntil
    });

    form.reset();
    if (pendingInput) {
      pendingInput.disabled = true;
    }
    await loadAllData();
  });
}

function bindBgTaskForm() {
  const form = document.getElementById("bg-task-form");
  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.currentUid) {
      alert("Hãy đăng nhập trước.");
      return;
    }

    const title = document.getElementById("bg-title").value.trim();
    const start = fromDateInputValue(document.getElementById("bg-start").value);
    const end = fromDateInputValue(document.getElementById("bg-end").value);

    if (!title || !start || !end || end <= start) {
      alert("Background không hợp lệ.");
      return;
    }

    await addBgTask({ title, start, end });
    form.reset();
    await loadAllData();
  });
}

function bindSettingsForm() {
  const form = document.getElementById("settings-form");
  if (!form) return;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const slice = Number(document.getElementById("setting-slice").value);
    const horizon = Number(document.getElementById("setting-horizon").value);
    const konly = Number(document.getElementById("setting-konly").value);
    const kshort = Number(document.getElementById("setting-kshort").value);

    if (slice >= 5) state.settings.sliceMinutes = slice;
    if (horizon >= 1) state.settings.horizonDays = horizon;
    if (konly >= 1) state.settings.kOnlyPrefer = konly;
    if (kshort >= 1) state.settings.kShort = kshort;

    recomputeTimeline();
  });
}

function bindEditModalEvents() {
  const modal = document.getElementById("edit-modal");
  const closeBtn = document.getElementById("edit-close");
  const form = document.getElementById("edit-task-form");
  const toggle = document.getElementById("edit-pending-toggle");
  const pendingInput = document.getElementById("edit-pending-until");

  if (!modal || !form) return;

  if (closeBtn) {
    closeBtn.addEventListener("click", () => closeEditModal());
  }

  toggle.addEventListener("change", () => {
    pendingInput.disabled = !toggle.checked;
    if (!toggle.checked) pendingInput.value = "";
  });

  const dayPills = document.querySelectorAll("#edit-day-pills .pill");
  dayPills.forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.classList.toggle("active");
    });
  });

  const slotPills = document.querySelectorAll("#edit-slot-pills .pill");
  slotPills.forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.classList.toggle("active");
    });
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const t = state.currentEditTask;
    if (!t) return;

    const title = document.getElementById("edit-title").value.trim();
    const desc = document.getElementById("edit-desc").value.trim();
    const duration = Number(document.getElementById("edit-duration").value);
    const deadline = fromDateInputValue(document.getElementById("edit-deadline").value);
    const mode = document.getElementById("edit-mode").value;

    if (!title || !duration || !deadline) {
      alert("Thiếu tiêu đề / deadline / duration");
      return;
    }

    const dayPillsSel = [];
    document.querySelectorAll("#edit-day-pills .pill.active").forEach((btn) => {
      dayPillsSel.push(Number(btn.dataset.day));
    });

    const slotPillsSel = [];
    document.querySelectorAll("#edit-slot-pills .pill.active").forEach((btn) => {
      slotPillsSel.push(Number(btn.dataset.slot));
    });

    let pendingUntil = null;
    let isPending = false;
    if (toggle.checked) {
      pendingUntil = fromDateInputValue(pendingInput.value);
      if (pendingUntil && pendingUntil > Date.now()) {
        isPending = true;
      }
    }

    await updateMainTask(t.id, {
      title,
      description: desc,
      durationMinutes: duration,
      deadline,
      onlyMode: mode,
      dayPills: dayPillsSel,
      slotPills: slotPillsSel,
      pendingUntil,
      isPending
    });

    closeEditModal();
    await loadAllData();
  });
}

function bindDuplicateSheetEvents() {
  const sheet = document.getElementById("duplicate-sheet");
  const closeBtn = document.getElementById("duplicate-close");
  const customBtn = document.getElementById("duplicate-custom-open");
  const customModal = document.getElementById("duplicate-custom-modal");
  const customClose = document.getElementById("duplicate-custom-close");
  const customConfirm = document.getElementById("duplicate-custom-confirm");
  const customInput = document.getElementById("duplicate-custom-deadline");

  if (!sheet) return;

  if (closeBtn) {
    closeBtn.addEventListener("click", () => closeDuplicateSheet());
  }

  sheet.querySelectorAll("button[data-shift]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const days = Number(btn.dataset.shift);
      const t = state.duplicateTarget;
      if (!t || !t.deadline) return;
      const newDeadline = t.deadline + days * ONE_DAY;
      await duplicateTaskWithDeadline(t, newDeadline);
      closeDuplicateSheet();
    });
  });

  if (customBtn) {
    customBtn.addEventListener("click", () => {
      openDuplicateCustomModal();
    });
  }

  if (customClose) {
    customClose.addEventListener("click", () => closeDuplicateCustomModal());
  }

  if (customConfirm) {
    customConfirm.addEventListener("click", async () => {
      const t = state.duplicateTarget;
      if (!t) return;
      const ts = fromDateInputValue(customInput.value);
      if (!ts) {
        alert("Deadline không hợp lệ.");
        return;
      }
      await duplicateTaskWithDeadline(t, ts);
      closeDuplicateCustomModal();
      closeDuplicateSheet();
    });
  }
}

function bindTooltipActions() {
  const tooltip = document.getElementById("task-tooltip");
  if (!tooltip) return;

  document.getElementById("tooltip-edit").addEventListener("click", () => {
    if (!state.currentTooltipTask) return;
    openEditModal(state.currentTooltipTask);
    closeTaskTooltip();
  });

  document.getElementById("tooltip-done").addEventListener("click", async () => {
    if (!state.currentTooltipTask) return;
    await toggleDoneTask(state.currentTooltipTask);
    closeTaskTooltip();
  });

  document.getElementById("tooltip-delete").addEventListener("click", async () => {
    if (!state.currentTooltipTask) return;
    await deleteMainTask(state.currentTooltipTask);
    closeTaskTooltip();
  });

  document.getElementById("tooltip-duplicate").addEventListener("click", () => {
    if (!state.currentTooltipTask) return;
    openDuplicateSheet(state.currentTooltipTask);
    closeTaskTooltip();
  });

  document.addEventListener("click", (ev) => {
    // click ngoài tooltip sẽ đóng
    if (!tooltip.classList.contains("hidden")) {
      if (!tooltip.contains(ev.target)) {
        // tránh trường hợp click vào block để mở tooltip
        // (block click handler gọi openTaskTooltip trước)
        // nên delay 0ms để event chain kết thúc
        setTimeout(() => {
          if (!tooltip.contains(document.activeElement)) {
            closeTaskTooltip();
          }
        }, 0);
      }
    }
  });
}

/* -------------------------------------------------------------------------- */
/*  INIT                                                                      */
/* -------------------------------------------------------------------------- */

function init() {
  computeTimelineRange();
  renderAll();

  bindAuthEvents();
  bindTabEvents();
  bindMainTaskForm();
  bindBgTaskForm();
  bindSettingsForm();
  bindEditModalEvents();
  bindDuplicateSheetEvents();
  bindTooltipActions();

  // Cập nhật NOW định kỳ nhẹ
  setInterval(() => {
    state.now = Date.now();
    recomputeTimeline();
  }, 60 * 1000);
}

document.addEventListener("DOMContentLoaded", init);

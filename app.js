// DNM's Tasker v1.5.2-stable
// Magnet Engine + PendingUntil + Overdue Cluster + Yesterday Timeline + Firebase
//
// PHẦN 1/3: Firebase init → Global state → Utility → Firestore loading
// --------------------------------------------------------------------

import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  getDocs,
  getDoc,
  setDoc,
  addDoc,
  deleteDoc,
  orderBy,
  query
} from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";

// ----------------------------------------------------
// Firebase configuration
// ----------------------------------------------------
const firebaseConfig = {
  apiKey: "AIzaSyD7hqFqHGFjawzMQ8-vax4e2_GS3VNpqEo",
  authDomain: "dnmstasker-3b85f.firebaseapp.com",
  projectId: "dnmstasker-3b85f",
  storageBucket: "dnmstasker-3b85f.appspot.com",
  messagingSenderId: "893957095802",
  appId: "1:893957095802:web:d9f3f0c129e4c8e4d8bba3"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

// ----------------------------------------------------
// Global constants / Helpers
// ----------------------------------------------------
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const ONE_DAY = 24 * HOUR_MS;

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

function isoToLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000);
  return local.toISOString().slice(0, 16);
}

function localInputToIso(value) {
  if (!value) return null;
  const d = new Date(value);
  return d.toISOString();
}

function formatHM(ms) {
  const d = new Date(ms);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

// ----------------------------------------------------
// Global app state
// ----------------------------------------------------
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

// ----------------------------------------------------
// Firestore helpers
// ----------------------------------------------------
function mainTasksCol(uid) {
  return collection(db, "users", uid, "mainTasks");
}
function bgTasksCol(uid) {
  return collection(db, "users", uid, "backgroundTasks");
}
function metadataCol(uid) {
  return collection(db, "users", uid, "metadata");
}

async function ensureUserCounters(uid) {
  const countersRef = doc(metadataCol(uid), "counters");
  const snap = await getDoc(countersRef);
  if (!snap.exists()) {
    await setDoc(countersRef, {
      mainShortCounter: 1,
      bgShortCounter: 1
    });
  }
}

async function nextCounter(uid, field) {
  const countersRef = doc(metadataCol(uid), "counters");
  const snap = await getDoc(countersRef);
  if (!snap.exists()) {
    const init = { mainShortCounter: 1, bgShortCounter: 1 };
    await setDoc(countersRef, init);
    return init[field];
  }
  const data = snap.data();
  const current = data[field] ?? 1;
  const next = current + 1;
  await setDoc(countersRef, { ...data, [field]: next });
  return current;
}

// ----------------------------------------------------
// LOAD MAIN TASKS
// ----------------------------------------------------
async function loadMainTasks() {
  if (!state.currentUid) return;

  const q = query(mainTasksCol(state.currentUid), orderBy("createdAt", "asc"));
  const snap = await getDocs(q);

  const list = [];

  snap.forEach(docSnap => {
    const d = docSnap.data();
    const id = docSnap.id;

    const durationMinutes =
      typeof d.durationMinutes === "number"
        ? d.durationMinutes
        : d.duration ?? 30;

    const deadline =
      d.deadline ??
      (d.deadlineAt ? new Date(d.deadlineAt).toISOString() : null);

    const shortId =
      typeof d.shortId === "number"
        ? d.shortId
        : d.taskId ?? null;

    list.push({
      id,
      shortId,
      title: d.title ?? "(untitled)",
      description: d.description ?? "",
      durationMinutes,
      deadline,
      onlyMode: d.onlyMode ?? "NONE",
      dayPills: Array.isArray(d.dayPills) ? d.dayPills : [],
      slotPills: Array.isArray(d.slotPills) ? d.slotPills : [],
      isPending: !!d.isPending,
      pendingUntil: d.pendingUntil ?? null,
      isDone: !!d.isDone,
      createdAt: d.createdAt ?? new Date().toISOString()
    });
  });

  state.mainTasks = list;
}

// ----------------------------------------------------
// LOAD BACKGROUND TASKS
// ----------------------------------------------------
async function loadBgTasks() {
  if (!state.currentUid) return;

  const snap = await getDocs(bgTasksCol(state.currentUid));
  const now = Date.now();
  const list = [];

  for (const ds of snap.docs) {
    const d = ds.data();
    const id = ds.id;

    const start = d.start ?? (d.startAt ? new Date(d.startAt).toISOString() : null);
    const end = d.end ?? (d.endAt ? new Date(d.endAt).toISOString() : null);
    if (!start || !end) continue;

    const endMs = new Date(end).getTime();
    if (endMs <= now) {
      await deleteDoc(doc(bgTasksCol(state.currentUid), id));
      continue;
    }

    list.push({
      id,
      shortId: typeof d.shortId === "number" ? d.shortId : null,
      title: d.title ?? "(untitled)",
      start,
      end,
      createdAt: d.createdAt ?? new Date().toISOString()
    });
  }

  state.bgTasks = list;
}

// ----------------------------------------------------
// Load everything then recompute timeline
// ----------------------------------------------------
async function loadAllData() {
  await loadMainTasks();
  await loadBgTasks();
  recomputeTimeline();
}

// ====================================================================
// PHẦN 2/3 – Magnet Engine + Timeline Rendering
// ====================================================================

// -----------------------------
// Engine helper: is NOW inside task's ONLY/PREFER windows?
// -----------------------------
function isNowWithinTaskWindow(task, nowMs) {
  const d = new Date(nowMs);
  const day = d.getDay();
  const hour = d.getHours();
  const slot = Math.floor(hour / 3);

  const hasDay = task.dayPills?.length > 0;
  const hasSlot = task.slotPills?.length > 0;

  const dayOk = !hasDay || task.dayPills.includes(day);
  const slotOk = !hasSlot || task.slotPills.includes(slot);

  return dayOk && slotOk;
}

// -----------------------------
// Weight calculation
// -----------------------------
function computeWeight(task, nowMs) {
  const dur = task.durationMinutes || 0;
  if (dur <= 0) return { w: 0, baseW: 0, minutesLeft: 1e9, timeFactor: 1, shortBoost: 1 };

  let minutesLeft = 1e9;
  let baseW = 0;

  if (task.deadline) {
    const dl = new Date(task.deadline).getTime();
    const diff = dl - nowMs;
    if (diff > 0) {
      minutesLeft = Math.max(1, diff / MINUTE_MS);
      baseW = dur / minutesLeft;
    } else {
      minutesLeft = 1;
      baseW = 0;
    }
  }

  let w = baseW;
  let shortBoost = 1;

  if (dur <= 10 && minutesLeft <= 48 * 60) {
    shortBoost = state.settings.kShort;
    w *= shortBoost;
  }

  const mode = task.onlyMode || "NONE";
  const within = isNowWithinTaskWindow(task, nowMs);
  let timeFactor = 1;

  if (mode === "ONLY") timeFactor = within ? state.settings.kOnlyPrefer : 0;
  else if (mode === "PREFER") timeFactor = within ? state.settings.kOnlyPrefer : 1;

  w *= timeFactor;

  return { w, baseW, minutesLeft, timeFactor, shortBoost };
}

// -----------------------------
// Engine classification + slice scheduling
// -----------------------------
function scheduleMainTasks(totalSlices) {
  const now = state.now;

  const rawNowSlice = Math.floor((now - state.timelineStart) / (state.settings.sliceMinutes * MINUTE_MS));
  state.nowSlice = clamp(rawNowSlice, 0, totalSlices - 1);

  state.overdueTasks = [];
  state.pendingTasks = [];

  const active = [];

  for (const t of state.mainTasks) {
    if (t.isDone) continue;

    const dlMs = t.deadline ? new Date(t.deadline).getTime() : null;
    const pendingUntilMs = t.pendingUntil ? new Date(t.pendingUntil).getTime() : null;

    const isOverdue = dlMs !== null && dlMs < now;
    const isPending = t.isPending || (pendingUntilMs !== null && pendingUntilMs > now);

    if (isOverdue) {
      state.overdueTasks.push(t);
      continue;
    }
    if (isPending) {
      state.pendingTasks.push(t);
      continue;
    }
    active.push(t);
  }

  const weighted = active.map(t => {
    const w = computeWeight(t, now);
    return { task: t, ...w, assignedSlices: [] };
  });

  weighted.sort((a, b) => {
    if (b.w !== a.w) return b.w - a.w;
    return a.minutesLeft - b.minutesLeft;
  });

  const slices = state.sliceTypes;
  let frontier = state.nowSlice;

  for (const entry of weighted) {
    const need = Math.ceil(entry.task.durationMinutes / state.settings.sliceMinutes);
    const assigned = [];

    for (let s = frontier; s < totalSlices && assigned.length < need; s++) {
      if (slices[s] === 1) assigned.push(s);
    }

    entry.assignedSlices = assigned;
    if (assigned.length > 0) frontier = assigned[assigned.length - 1] + 1;
  }

  return weighted;
}

// ====================================================================
// TIMELINE RANGE (v1.5.2: includes YESTERDAY)
// ====================================================================
function recomputeTimeline() {
  state.now = Date.now();

  const today = new Date(state.now);
  today.setHours(0, 0, 0, 0);
  const todayStart = today.getTime();

  state.timelineStart = todayStart - ONE_DAY;
  state.timelineEnd = todayStart + state.settings.horizonDays * ONE_DAY - 1;

  const totalDays = state.settings.horizonDays + 1;
  const totalSlices = (totalDays * 24 * 60) / state.settings.sliceMinutes;

  state.sliceTypes = new Array(totalSlices).fill(1);

  for (const bg of state.bgTasks) {
    const st = new Date(bg.start).getTime();
    const en = new Date(bg.end).getTime();

    if (en <= state.timelineStart || st >= state.timelineEnd) continue;

    const startCl = Math.max(st, state.timelineStart);
    const endCl = Math.min(en, state.timelineEnd);

    let si = Math.floor((startCl - state.timelineStart) / (state.settings.sliceMinutes * MINUTE_MS));
    let ei = Math.floor((endCl - state.timelineStart) / (state.settings.sliceMinutes * MINUTE_MS));

    si = clamp(si, 0, totalSlices - 1);
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

// ====================================================================
// RENDER TIMELINE
// ====================================================================
function renderTimeline() {
  const header = document.getElementById("timelineHeader");
  const canvas = document.getElementById("timelineCanvas");

  header.innerHTML = "";
  canvas.innerHTML = "";

  const pxHour = 64;
  const totalDays = state.settings.horizonDays + 1;
  const totalHours = totalDays * 24;
  const totalWidth = totalHours * pxHour;

  const headerInner = document.createElement("div");
  headerInner.className = "timeline-header-inner";
  headerInner.style.width = totalWidth + "px";

  const start = state.timelineStart;

  for (let h = 0; h <= totalHours; h++) {
    const x = h * pxHour;
    const m = document.createElement("div");
    m.className = "timeline-hour-marker";
    m.style.left = x + "px";
    headerInner.appendChild(m);

    if (h % 3 === 0) {
      const lbl = document.createElement("div");
      lbl.className = "timeline-hour-label";
      lbl.style.left = x + "px";
      const hh = h % 24;
      lbl.textContent = String(hh).padStart(2, "0") + ":00";
      headerInner.appendChild(lbl);
    }
  }

  const todayStart = (() => {
    const d = new Date(state.now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  })();

  for (let d = 0; d < totalDays; d++) {
    const dayStartMs = start + d * ONE_DAY;
    const band = document.createElement("div");
    band.className = "timeline-day-band";
    band.style.left = (d * 24 * pxHour) + "px";
    band.style.width = (24 * pxHour) + "px";

    band.style.background =
      dayStartMs === todayStart
        ? "rgba(239,246,255,0.96)"
        : "rgba(249,250,251,0.96)";

    const dateObj = new Date(dayStartMs);
    band.textContent =
      `${String(dateObj.getMonth() + 1).padStart(2, "0")}/${String(dateObj.getDate()).padStart(2, "0")}`;

    headerInner.appendChild(band);
  }

  header.appendChild(headerInner);

  const inner = document.createElement("div");
  inner.className = "timeline-inner";
  inner.style.width = totalWidth + "px";

  const laneMain = document.createElement("div");
  const laneBg = document.createElement("div");
  const lanePending = document.createElement("div");
  laneMain.className = "timeline-lane";
  laneBg.className = "timeline-lane";
  lanePending.className = "timeline-lane";

  const lm = document.createElement("div");
  const lb = document.createElement("div");
  const lp = document.createElement("div");
  lm.className = "lane-label"; lm.textContent = "Main";
  lb.className = "lane-label"; lb.textContent = "Background";
  lp.className = "lane-label"; lp.textContent = "Pending";

  laneMain.appendChild(lm);
  laneBg.appendChild(lb);
  lanePending.appendChild(lp);

  // -------------------------------
  // Background blocks
  // -------------------------------
  for (const bg of state.bgTasks) {
    const st = new Date(bg.start).getTime();
    const en = new Date(bg.end).getTime();

    if (en <= state.timelineStart || st >= state.timelineEnd) continue;

    const startCl = Math.max(st, state.timelineStart);
    const endCl = Math.min(en, state.timelineEnd);

    const offH = (startCl - state.timelineStart) / HOUR_MS;
    const spanH = (endCl - startCl) / HOUR_MS;

    const block = document.createElement("div");
    block.className = "timeline-block bg";
    block.style.left = offH * pxHour + "px";
    block.style.width = Math.max(spanH * pxHour, 26) + "px";

    block.innerHTML = `
      <div class="block-title">#${bg.shortId ?? ""} ${bg.title}</div>
      <div class="block-meta">${formatHM(st)}–${formatHM(en)}</div>
    `;

    laneBg.appendChild(block);
  }

  // -------------------------------
  // Overdue cluster (LEFT of NOW)
  // -------------------------------
  const overdue = [...state.overdueTasks];
  overdue.sort((a, b) => {
    const da = a.deadline ? new Date(a.deadline).getTime() : 0;
    const db = b.deadline ? new Date(b.deadline).getTime() : 0;
    return da - db;
  });

  const now = state.now;
  const nowOffH = (now - state.timelineStart) / HOUR_MS;
  const nowX = nowOffH * pxHour;

  const OVERW = 150;
  const OVERG = 8;
  const baseX = Math.max(nowX - (OVERW + OVERG) * overdue.length - 20, 4);

  overdue.forEach((t, i) => {
    const block = document.createElement("div");
    block.className = "timeline-block main overdue";
    block.style.left = (baseX + i * (OVERW + OVERG)) + "px";
    block.style.width = OVERW + "px";

    const dlMs = t.deadline ? new Date(t.deadline).getTime() : null;
    block.innerHTML = `
      <div class="block-title">#${t.shortId ?? ""} ${t.title}</div>
      <div class="block-meta">Overdue · ${dlMs ? formatHM(dlMs) : "-"}</div>
    `;

    block.addEventListener("click", (e) => {
      e.stopPropagation();
      openTooltipForTask(t, { x: baseX + i * (OVERW + OVERG), lane: "main" });
    });

    laneMain.appendChild(block);
  });

  // -------------------------------
  // Pending lane
  // -------------------------------
  const pendingTasks = [...state.pendingTasks];
  pendingTasks.sort((a, b) => {
    const pa = a.pendingUntil ? new Date(a.pendingUntil).getTime() : Infinity;
    const pb = b.pendingUntil ? new Date(b.pendingUntil).getTime() : Infinity;
    return pa - pb;
  });

  let pIndex = 0;
  for (const t of pendingTasks) {
    const W = 160;
    const G = 10;
    const x = 70 + pIndex * (W + G);

    const block = document.createElement("div");
    block.className = "timeline-block pending";
    block.style.left = x + "px";
    block.style.width = W + "px";

    const label = t.pendingUntil
      ? "Pending until " + formatHM(new Date(t.pendingUntil).getTime())
      : "Pending";

    block.innerHTML = `
      <div class="block-title">#${t.shortId ?? ""} ${t.title}</div>
      <div class="block-meta">${label}</div>
    `;

    block.addEventListener("click", (e) => {
      e.stopPropagation();
      openTooltipForTask(t, { x, lane: "pending" });
    });

    lanePending.appendChild(block);
    pIndex++;
  }

  // -------------------------------
  // ACTIVE scheduled main tasks
  // -------------------------------
  for (const entry of state.scheduledMain) {
    const t = entry.task;
    const ss = entry.assignedSlices;
    if (!ss || ss.length === 0) continue;

    const segs = [];
    let startS = ss[0];
    let prev = ss[0];
    for (let i = 1; i < ss.length; i++) {
      if (ss[i] === prev + 1) {
        prev = ss[i];
      } else {
        segs.push([startS, prev]);
        startS = ss[i];
        prev = ss[i];
      }
    }
    segs.push([startS, prev]);

    for (const [s0, s1] of segs) {
      const startMs = state.timelineStart + s0 * state.settings.sliceMinutes * MINUTE_MS;
      const endMs = state.timelineStart + (s1 + 1) * state.settings.sliceMinutes * MINUTE_MS;

      const offH = (startMs - state.timelineStart) / HOUR_MS;
      const spanH = (endMs - startMs) / HOUR_MS;

      const block = document.createElement("div");
      block.className = "timeline-block main";
      block.style.left = offH * pxHour + "px";
      block.style.width = Math.max(spanH * pxHour, 24) + "px";

      block.innerHTML = `
        <div class="block-title">#${t.shortId ?? ""} ${t.title}</div>
        <div class="block-meta">${formatHM(startMs)}–${formatHM(endMs)}</div>
      `;

      block.addEventListener("click", (e) => {
        e.stopPropagation();
        openTooltipForTask(t, { x: offH * pxHour, lane: "main" });
      });

      laneMain.appendChild(block);
    }
  }

  inner.appendChild(laneMain);
  inner.appendChild(laneBg);
  inner.appendChild(lanePending);

  canvas.appendChild(inner);

  const nowLine = document.getElementById("currentTimeLine");
  nowLine.style.left = nowX + "px";
}

// ====================================================================
// PHẦN 3/3 – Task list, Background list, Tooltip, Forms, Auth, Init
// ====================================================================

// -----------------------------
// MAIN TASK LIST
// -----------------------------
function renderMainTaskList() {
  const list = document.getElementById("mainTaskList");
  if (!list) return;
  list.innerHTML = "";

  const activeScheduled = state.scheduledMain
    .filter(e => e.assignedSlices && e.assignedSlices.length > 0)
    .map(e => e.task);

  const pendingTasks = [...state.pendingTasks];
  const overdueTasks = [...state.overdueTasks];

  const otherActive = state.mainTasks.filter(t => {
    if (t.isDone) return false;
    if (pendingTasks.find(p => p.id === t.id)) return false;
    if (overdueTasks.find(o => o.id === t.id)) return false;
    if (activeScheduled.find(a => a.id === t.id)) return false;
    return true;
  });

  const doneTasks = state.mainTasks.filter(t => t.isDone);

  const sections = [];

  if (activeScheduled.length > 0) {
    sections.push({
      title: "ACTIVE – Scheduled",
      kind: "activeScheduled",
      tasks: activeScheduled
    });
  }
  if (pendingTasks.length > 0) {
    sections.push({
      title: "PENDING – PendingUntil / isPending",
      kind: "pending",
      tasks: pendingTasks
    });
  }
  if (overdueTasks.length > 0) {
    sections.push({
      title: "OVERDUE – deadline < NOW",
      kind: "overdue",
      tasks: overdueTasks
    });
  }
  if (otherActive.length > 0) {
    sections.push({
      title: "ACTIVE – Not scheduled",
      kind: "otherActive",
      tasks: otherActive
    });
  }
  if (doneTasks.length > 0) {
    sections.push({
      title: "DONE",
      kind: "done",
      tasks: doneTasks
    });
  }

  if (sections.length === 0) {
    const empty = document.createElement("div");
    empty.style.fontSize = "12px";
    empty.style.color = "#6b7280";
    empty.textContent = "No main tasks. Add one above.";
    list.appendChild(empty);
    return;
  }

  for (const section of sections) {
    const h = document.createElement("div");
    h.style.fontSize = "12px";
    h.style.fontWeight = "600";
    h.style.margin = "4px 0 2px";
    h.textContent = section.title;
    list.appendChild(h);

    for (const t of section.tasks) {
      const row = document.createElement("div");
      row.className = "task-row";

      const left = document.createElement("div");
      left.className = "task-main";

      const titleLine = document.createElement("div");
      titleLine.className = "task-title-line";

      const titleSpan = document.createElement("span");
      titleSpan.className = "task-title";
      titleSpan.textContent = t.title || "(untitled)";

      const idSpan = document.createElement("span");
      idSpan.className = "task-id";
      idSpan.textContent = `#${t.shortId ?? ""}`;

      titleLine.appendChild(titleSpan);
      titleLine.appendChild(idSpan);
      left.appendChild(titleLine);

      if (t.description) {
        const desc = document.createElement("div");
        desc.className = "task-desc";
        desc.textContent = t.description;
        left.appendChild(desc);
      }

      const metaLine = document.createElement("div");
      metaLine.className = "task-meta-line";

      const badgeMain = document.createElement("span");
      badgeMain.className = "badge badge-main";
      badgeMain.textContent = "MAIN";
      metaLine.appendChild(badgeMain);

      const stateBadge = document.createElement("span");
      stateBadge.className = "badge";
      if (section.kind === "done") {
        stateBadge.classList.add("badge-state-done");
        stateBadge.textContent = "DONE";
      } else if (section.kind === "overdue") {
        stateBadge.classList.add("badge-state-overdue");
        stateBadge.textContent = "OVERDUE";
      } else if (section.kind === "pending") {
        stateBadge.classList.add("badge-state-pending");
        stateBadge.textContent = "PENDING";
      } else {
        stateBadge.classList.add("badge-state-active");
        stateBadge.textContent =
          section.kind === "activeScheduled"
            ? "ACTIVE · scheduled"
            : "ACTIVE";
      }
      metaLine.appendChild(stateBadge);

      const modeBadge = document.createElement("span");
      modeBadge.className = "badge";
      modeBadge.textContent = `MODE: ${t.onlyMode || "NONE"}`;
      metaLine.appendChild(modeBadge);

      if (t.deadline) {
        const dlMs = new Date(t.deadline).getTime();
        const dlBadge = document.createElement("span");
        dlBadge.className = "badge";
        dlBadge.textContent = "DL " + formatHM(dlMs);
        metaLine.appendChild(dlBadge);

        const diffMin = Math.round((dlMs - (state.now || Date.now())) / MINUTE_MS);
        const diffBadge = document.createElement("span");
        diffBadge.className = "badge";
        diffBadge.textContent = `T${diffMin >= 0 ? "-" : "+"}${Math.abs(diffMin)}m`;
        metaLine.appendChild(diffBadge);
      }

      const durBadge = document.createElement("span");
      durBadge.className = "badge";
      durBadge.textContent = `${t.durationMinutes}m`;
      metaLine.appendChild(durBadge);

      if (t.pendingUntil) {
        const pm = new Date(t.pendingUntil).getTime();
        const pb = document.createElement("span");
        pb.className = "badge badge-state-pending";
        pb.textContent = "Pending until " + formatHM(pm);
        metaLine.appendChild(pb);
      } else if (t.isPending) {
        const pb = document.createElement("span");
        pb.className = "badge badge-state-pending";
        pb.textContent = "Pending (flag)";
        metaLine.appendChild(pb);
      }

      left.appendChild(metaLine);

      const actions = document.createElement("div");
      actions.className = "task-actions";

      const btnEdit = document.createElement("button");
      btnEdit.className = "btn subtle-btn";
      btnEdit.textContent = "Edit";
      btnEdit.addEventListener("click", () => inlineEditTask(t));
      actions.appendChild(btnEdit);

      const btnDone = document.createElement("button");
      btnDone.className = "btn subtle-btn";
      btnDone.textContent = t.isDone ? "Undo" : "Done";
      btnDone.addEventListener("click", () => toggleDone(t));
      actions.appendChild(btnDone);

      const btnDel = document.createElement("button");
      btnDel.className = "btn ghost-btn";
      btnDel.textContent = "Delete";
      btnDel.addEventListener("click", () => deleteMainTask(t));
      actions.appendChild(btnDel);

      row.appendChild(left);
      row.appendChild(actions);

      list.appendChild(row);
    }
  }
}

// -----------------------------
// BACKGROUND LIST
// -----------------------------
function renderBgTaskList() {
  const list = document.getElementById("bgTaskList");
  if (!list) return;
  list.innerHTML = "";

  if (!state.bgTasks.length) {
    const empty = document.createElement("div");
    empty.style.fontSize = "12px";
    empty.style.color = "#6b7280";
    empty.textContent = "No background blocks.";
    list.appendChild(empty);
    return;
  }

  const tasks = [...state.bgTasks].sort((a, b) => {
    const sa = new Date(a.start).getTime();
    const sb = new Date(b.start).getTime();
    return sa - sb;
  });

  for (const t of tasks) {
    const row = document.createElement("div");
    row.className = "bg-row";

    const left = document.createElement("div");
    left.className = "bg-main";

    const title = document.createElement("div");
    title.className = "bg-title";
    title.textContent = t.title;

    const meta = document.createElement("div");
    meta.className = "bg-meta";
    const s = new Date(t.start).getTime();
    const e = new Date(t.end).getTime();
    meta.textContent = `${formatHM(s)}–${formatHM(e)} (#${t.shortId ?? ""})`;

    left.appendChild(title);
    left.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "bg-actions";

    const btnDel = document.createElement("button");
    btnDel.className = "btn ghost-btn";
    btnDel.textContent = "Delete";
    btnDel.addEventListener("click", () => deleteBgTask(t));
    actions.appendChild(btnDel);

    row.appendChild(left);
    row.appendChild(actions);
    list.appendChild(row);
  }
}

// -----------------------------
// DEBUG PANEL
// -----------------------------
function renderDebugPanel() {
  const summary = document.getElementById("debugSummary");
  const wrapper = document.getElementById("debugTableWrapper");
  if (!summary || !wrapper) return;

  wrapper.innerHTML = "";

  const totalMain = state.mainTasks.length;
  const done = state.mainTasks.filter(t => t.isDone).length;
  const scheduled = state.scheduledMain.filter(e => e.assignedSlices.length > 0).length;

  summary.textContent =
    `Main: ${totalMain} (done ${done}), scheduled: ${scheduled}, ` +
    `overdue: ${state.overdueTasks.length}, pending: ${state.pendingTasks.length}, ` +
    `slice=${state.settings.sliceMinutes}, horizon=${state.settings.horizonDays}, ` +
    `k=${state.settings.kOnlyPrefer}, k_short=${state.settings.kShort}, nowSlice=${state.nowSlice}`;

  const table = document.createElement("table");
  table.className = "debug-table";

  const thead = document.createElement("thead");
  thead.innerHTML = `
    <tr>
      <th>#</th>
      <th>Title</th>
      <th>baseW</th>
      <th>minutesLeft</th>
      <th>timeFactor</th>
      <th>shortBoost</th>
      <th>w</th>
      <th>slices</th>
    </tr>
  `;
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  let idx = 1;
  for (const e of state.scheduledMain) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${idx++}</td>
      <td>${e.task.title}</td>
      <td>${e.baseW.toFixed(4)}</td>
      <td>${e.minutesLeft.toFixed(1)}</td>
      <td>${e.timeFactor.toFixed(2)}</td>
      <td>${e.shortBoost.toFixed(0)}</td>
      <td>${e.w.toFixed(4)}</td>
      <td>${e.assignedSlices.join(",")}</td>
    `;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrapper.appendChild(table);
}

// ====================================================================
// TOOLTIP (fix pointer-events + position)
// ====================================================================
function openTooltipForTask(task, pos) {
  state.currentTooltipTask = task;

  const tooltip = document.getElementById("timelineTooltip");
  if (!tooltip) return;

  const titleEl = document.getElementById("tooltipTitle");
  const deadlineEl = document.getElementById("tooltipDeadline");
  const idEl = document.getElementById("tooltipId");
  const durEl = document.getElementById("tooltipDuration");
  const modeEl = document.getElementById("tooltipMode");
  const pendingEl = document.getElementById("tooltipPending");
  const descEl = document.getElementById("tooltipDescription");

  titleEl.textContent = task.title || "(untitled)";
  idEl.textContent = `#${task.shortId ?? ""}`;
  durEl.textContent = `${task.durationMinutes} min`;

  if (task.deadline) {
    const dlMs = new Date(task.deadline).getTime();
    deadlineEl.textContent = "Deadline: " + formatHM(dlMs);
  } else {
    deadlineEl.textContent = "Deadline: none";
  }

  modeEl.textContent = "Mode: " + (task.onlyMode || "NONE");

  if (task.pendingUntil) {
    const pm = new Date(task.pendingUntil).getTime();
    pendingEl.style.display = "inline-flex";
    pendingEl.textContent = "Pending until " + formatHM(pm);
  } else if (task.isPending) {
    pendingEl.style.display = "inline-flex";
    pendingEl.textContent = "Pending (flag)";
  } else {
    pendingEl.style.display = "none";
  }

  descEl.textContent = task.description || "";

  const wrapper = document.getElementById("timelineCanvasWrapper");
  const rect = wrapper.getBoundingClientRect();

  const x = rect.left + (pos?.x || 0) + 20;
  let y;
  if (pos?.lane === "main") {
    y = rect.top + 40;
  } else if (pos?.lane === "pending") {
    y = rect.top + 140;
  } else {
    y = rect.top + 80;
  }

  tooltip.style.left = x + "px";
  tooltip.style.top = y + "px";
  tooltip.style.display = "block";

  const editBtn = document.getElementById("tooltipEditBtn");
  const doneBtn = document.getElementById("tooltipDoneBtn");
  const delBtn = document.getElementById("tooltipDeleteBtn");

  editBtn.onclick = () => {
    tooltip.style.display = "none";
    inlineEditTask(task);
  };
  doneBtn.onclick = () => {
    tooltip.style.display = "none";
    toggleDone(task);
  };
  delBtn.onclick = () => {
    tooltip.style.display = "none";
    deleteMainTask(task);
  };
}

function closeTooltip() {
  const tooltip = document.getElementById("timelineTooltip");
  if (tooltip) tooltip.style.display = "none";
}

// ====================================================================
// SIMPLE INLINE EDIT (no modal)
// ====================================================================
async function inlineEditTask(task) {
  if (!state.currentUid) return;

  const newTitle = prompt("Edit title:", task.title || "");
  if (newTitle === null) return;

  const newDurStr = prompt(
    "Edit duration (minutes):",
    String(task.durationMinutes || 30)
  );
  if (newDurStr === null) return;
  const newDuration = parseInt(newDurStr, 10) || task.durationMinutes || 30;

  const newDeadlineStr = prompt(
    "Edit deadline (ISO, e.g. 2025-12-31T23:00:00Z):",
    task.deadline || ""
  );
  if (newDeadlineStr === null) return;

  const docRef = doc(mainTasksCol(state.currentUid), task.id);
  await setDoc(
    docRef,
    {
      title: newTitle.trim() || task.title,
      durationMinutes: newDuration,
      deadline: newDeadlineStr.trim() || task.deadline
    },
    { merge: true }
  );

  await loadMainTasks();
  recomputeTimeline();
}

// ====================================================================
// FORMS & UI SETUP
// ====================================================================
function setupTabs() {
  const buttons = document.querySelectorAll(".tab-button");
  const panels = document.querySelectorAll(".tab-panel");

  buttons.forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      buttons.forEach(b => b.classList.remove("active"));
      panels.forEach(p => p.classList.remove("active"));

      btn.classList.add("active");
      document.getElementById(tab).classList.add("active");
    });
  });
}

function setupMainTaskForm() {
  const form = document.getElementById("mainTaskForm");
  if (!form) return;

  const modePills = document.querySelectorAll("#onlyModePills .pill");
  modePills.forEach(p => {
    p.addEventListener("click", () => {
      modePills.forEach(x => x.classList.remove("pill-selected"));
      p.classList.add("pill-selected");
    });
  });

  const dayPills = document.querySelectorAll("#dayPills .pill");
  dayPills.forEach(p => {
    p.addEventListener("click", () => {
      p.classList.toggle("pill-selected");
    });
  });

  const slotPills = document.querySelectorAll("#slotPills .pill");
  slotPills.forEach(p => {
    p.addEventListener("click", () => {
      p.classList.toggle("pill-selected");
    });
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.currentUid) {
      alert("Please sign in first.");
      return;
    }

    const title = document.getElementById("mainTitle").value.trim();
    const description = document.getElementById("mainDescription").value.trim();
    const dur = parseInt(document.getElementById("mainDuration").value, 10);
    const dlInput = document.getElementById("mainDeadline").value;

    if (!title || !dur || !dlInput) {
      alert("Title, duration, deadline required.");
      return;
    }

    const deadline = localInputToIso(dlInput);

    let onlyMode = "NONE";
    modePills.forEach(p => {
      if (p.classList.contains("pill-selected")) {
        onlyMode = p.dataset.mode;
      }
    });

    const days = [];
    dayPills.forEach(p => {
      if (p.classList.contains("pill-selected")) {
        days.push(parseInt(p.dataset.day, 10));
      }
    });

    const slots = [];
    slotPills.forEach(p => {
      if (p.classList.contains("pill-selected")) {
        slots.push(parseInt(p.dataset.slot, 10));
      }
    });

    const pendingInput = document.getElementById("pendingUntil").value;
    const pendingUntil = pendingInput ? localInputToIso(pendingInput) : null;

    const shortId = await nextCounter(state.currentUid, "mainShortCounter");

    await addDoc(mainTasksCol(state.currentUid), {
      shortId,
      title,
      description,
      durationMinutes: dur,
      deadline,
      onlyMode,
      dayPills: days,
      slotPills: slots,
      isPending: false,
      pendingUntil,
      isDone: false,
      createdAt: new Date().toISOString()
    });

    form.reset();
    modePills.forEach(p => p.classList.remove("pill-selected"));
    modePills[0].classList.add("pill-selected");
    dayPills.forEach(p => p.classList.remove("pill-selected"));
    slotPills.forEach(p => p.classList.remove("pill-selected"));

    await loadMainTasks();
    recomputeTimeline();
  });
}

function setupBgTaskForm() {
  const form = document.getElementById("bgTaskForm");
  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.currentUid) {
      alert("Please sign in first.");
      return;
    }

    const title = document.getElementById("bgTitle").value.trim();
    const startInput = document.getElementById("bgStart").value;
    const endInput = document.getElementById("bgEnd").value;

    if (!title || !startInput || !endInput) {
      alert("Title, start, end required.");
      return;
    }

    const start = localInputToIso(startInput);
    const end = localInputToIso(endInput);
    const sMs = new Date(start).getTime();
    const eMs = new Date(end).getTime();
    if (eMs <= sMs) {
      alert("End must be after start.");
      return;
    }

    const shortId = await nextCounter(state.currentUid, "bgShortCounter");

    await addDoc(bgTasksCol(state.currentUid), {
      shortId,
      title,
      start,
      end,
      createdAt: new Date().toISOString()
    });

    form.reset();
    await loadBgTasks();
    recomputeTimeline();
  });
}

function setupSettingsForm() {
  const form = document.getElementById("settingsForm");
  if (!form) return;

  document.getElementById("setSliceMinutes").value = state.settings.sliceMinutes;
  document.getElementById("setHorizonDays").value = state.settings.horizonDays;
  document.getElementById("setKOnlyPrefer").value = state.settings.kOnlyPrefer;
  document.getElementById("setKShort").value = state.settings.kShort;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const sm = parseInt(document.getElementById("setSliceMinutes").value, 10);
    const hd = parseInt(document.getElementById("setHorizonDays").value, 10);
    const k = parseFloat(document.getElementById("setKOnlyPrefer").value);
    const ks = parseFloat(document.getElementById("setKShort").value);

    if (!sm || !hd || !k || !ks) {
      alert("All fields required.");
      return;
    }

    state.settings.sliceMinutes = sm;
    state.settings.horizonDays = hd;
    state.settings.kOnlyPrefer = k;
    state.settings.kShort = ks;

    recomputeTimeline();
  });
}

// ====================================================================
// TIMELINE CONTROLS (NOW button fix)
// ====================================================================
function setupTimelineControls() {
  const wrapper = document.getElementById("timelineCanvasWrapper");
  const canvas = document.getElementById("timelineCanvas");
  if (!wrapper || !canvas) return;

  const pxHour = 64;

  document.getElementById("jumpNowBtn").addEventListener("click", () => {
    const offH = (state.now - state.timelineStart) / HOUR_MS;
    const x = offH * pxHour;
    wrapper.scrollTo({ left: Math.max(x - 200, 0), behavior: "smooth" });
  });

  document.getElementById("jumpDateBtn").addEventListener("click", () => {
    const input = document.getElementById("jumpDateInput").value;
    if (!input) return;
    const d = new Date(input + "T00:00:00");
    const dayStart = d.getTime();
    const offDays = (dayStart - state.timelineStart) / ONE_DAY;
    const x = offDays * 24 * pxHour;
    wrapper.scrollTo({ left: Math.max(x - 200, 0), behavior: "smooth" });
  });
}

function setupDebugToggle() {
  const btn = document.getElementById("toggleDebugBtn");
  const panel = document.getElementById("debugPanel");
  if (!btn || !panel) return;
  btn.addEventListener("click", () => {
    panel.style.display = panel.style.display === "none" ? "block" : "none";
  });
}

// ====================================================================
// TOGGLE DONE / DELETE
// ====================================================================
async function toggleDone(task) {
  if (!state.currentUid) return;
  const ref = doc(mainTasksCol(state.currentUid), task.id);
  await setDoc(ref, { isDone: !task.isDone }, { merge: true });
  await loadMainTasks();
  recomputeTimeline();
}

async function deleteMainTask(task) {
  if (!state.currentUid) return;
  if (!confirm("Delete this main task?")) return;
  const ref = doc(mainTasksCol(state.currentUid), task.id);
  await deleteDoc(ref);
  await loadMainTasks();
  recomputeTimeline();
}

async function deleteBgTask(task) {
  if (!state.currentUid) return;
  if (!confirm("Delete this background block?")) return;
  const ref = doc(bgTasksCol(state.currentUid), task.id);
  await deleteDoc(ref);
  await loadBgTasks();
  recomputeTimeline();
}

// ====================================================================
// AUTH UI
// ====================================================================
function setLoggedInUI(user) {
  const loginBtn = document.getElementById("loginBtn");
  const userInfo = document.getElementById("userInfo");
  const avatar = document.getElementById("userAvatar");
  const emailSpan = document.getElementById("userEmail");

  loginBtn.style.display = "none";
  userInfo.style.display = "flex";

  avatar.src = user.photoURL || "";
  emailSpan.textContent = user.email || "";

  state.currentUid = user.uid;
}

function setLoggedOutUI() {
  const loginBtn = document.getElementById("loginBtn");
  const userInfo = document.getElementById("userInfo");

  loginBtn.style.display = "inline-flex";
  userInfo.style.display = "none";

  state.currentUid = null;
  state.mainTasks = [];
  state.bgTasks = [];
  state.scheduledMain = [];
  state.overdueTasks = [];
  state.pendingTasks = [];
  recomputeTimeline();
}

// ====================================================================
// INIT
// ====================================================================
function init() {
  setupTabs();
  setupMainTaskForm();
  setupBgTaskForm();
  setupSettingsForm();
  setupTimelineControls();
  setupDebugToggle();

  // Global click to close tooltip
  document.addEventListener("click", (e) => {
    const tt = document.getElementById("timelineTooltip");
    if (!tt) return;
    if (!tt.contains(e.target)) {
      closeTooltip();
    }
  });

  document.getElementById("loginBtn").addEventListener("click", async () => {
    try {
      await signInWithPopup(auth, provider);
    } catch (err) {
      console.error(err);
      alert("Login failed");
    }
  });

  document.getElementById("logoutBtn").addEventListener("click", async () => {
    try {
      await signOut(auth);
    } catch (err) {
      console.error(err);
    }
  });

  onAuthStateChanged(auth, async (user) => {
    if (user) {
      setLoggedInUI(user);
      await ensureUserCounters(user.uid);
      await loadAllData();
    } else {
      setLoggedOutUI();
    }
  });

  // Initial empty timeline before auth
  state.now = Date.now();
  recomputeTimeline();
}

document.addEventListener("DOMContentLoaded", init);

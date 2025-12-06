// DNM's Tasker v1.5.2 – Magnet-from-NOW + Pending Until + Overdue cluster + Yesterday timeline + Firebase
// Project: dnmstasker-3b85f
//
// Key logic changes vs v1.5.0-alpha3:
// - Main tasks are classified into 4 states:
//   1) DONE: not in engine.
//   2) OVERDUE (deadline < NOW, !DONE): removed from magnet engine, rendered as red cluster
//      on the left side of NOW in the main lane.
//   3) PENDING (isPending == true OR pendingUntil > NOW): rendered in Pending lane (lane 3),
//      not scheduled by engine.
//   4) ACTIVE (everything else): scheduled by magnet engine with w = duration / minutesLeft,
//      ONLY/PREFER multiplier, short-task boost.
// - Background tasks with end <= NOW are auto-deleted from Firestore and not displayed.
// - New field pendingUntil (ISO string) for main tasks, controlled via form + edit modal.
// - v1.5.1: Overdue cluster + PendingUntil lane + BG auto-delete + Magnet engine v1.0 stable.
// - v1.5.2: timeline range extended to include *yesterday* while keeping the same future horizon;
//           engine logic unchanged (still schedules only from NOW onward).

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
  query,
  where,
  orderBy,
  limit
} from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";

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

// --- Constants & helpers ---

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const ONE_DAY = 24 * HOUR_MS;

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
  return Math.min(Math.max(v, min), max);
}

function isoToLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000);
  return local.toISOString().slice(0, 16);
}

function localInputToIso(val) {
  if (!val) return null;
  const d = new Date(val);
  return d.toISOString();
}

function formatHM(ms) {
  const d = new Date(ms);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
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

// --- Firestore helpers ---

function userDocRef(uid) {
  return doc(db, "users", uid);
}

function mainTasksColRef(uid) {
  return collection(db, "users", uid, "mainTasks");
}

function bgTasksColRef(uid) {
  return collection(db, "users", uid, "backgroundTasks");
}

function metadataColRef(uid) {
  return collection(db, "users", uid, "metadata");
}

async function ensureUserInitialized(uid) {
  const countersRef = doc(metadataColRef(uid), "counters");
  const snap = await getDoc(countersRef);
  if (!snap.exists()) {
    await setDoc(countersRef, {
      mainShortCounter: 1,
      bgShortCounter: 1
    });
  }
}

async function getAndIncrementCounter(uid, fieldName) {
  const countersRef = doc(metadataColRef(uid), "counters");
  const snap = await getDoc(countersRef);
  if (!snap.exists()) {
    const initial = {
      mainShortCounter: 1,
      bgShortCounter: 1
    };
    await setDoc(countersRef, initial);
    return initial[fieldName] || 1;
  }
  const data = snap.data();
  const current = data[fieldName] || 1;
  const next = current + 1;
  await setDoc(countersRef, { ...data, [fieldName]: next });
  return current;
}

// --- Data loading ---

async function loadMainTasksFromFirestore() {
  if (!state.currentUid) return;
  const colRef = mainTasksColRef(state.currentUid);
  const q = query(colRef, orderBy("createdAt", "asc"));
  const snapshot = await getDocs(q);

  const tasks = [];
  snapshot.forEach((docSnap) => {
    const data = docSnap.data();
    const id = docSnap.id;

    const durationMinutes =
      typeof data.durationMinutes === "number"
        ? data.durationMinutes
        : typeof data.duration === "number"
        ? data.duration
        : 30;

    const deadlineIso =
      data.deadline ||
      (data.deadlineAt
        ? new Date(data.deadlineAt).toISOString()
        : null);

    const shortId =
      typeof data.shortId === "number" ? data.shortId : data.taskId || null;

    const onlyMode = data.onlyMode || "NONE";

    const dayPills = Array.isArray(data.dayPills) ? data.dayPills : [];
    const slotPills = Array.isArray(data.slotPills) ? data.slotPills : [];

    const isPending = !!data.isPending;
    const pendingUntil = data.pendingUntil || null;

    const isDone = !!data.isDone;

    const createdAt = data.createdAt || new Date().toISOString();

    tasks.push({
      id,
      shortId,
      title: data.title || "(untitled)",
      description: data.description || "",
      durationMinutes,
      deadline: deadlineIso,
      onlyMode,
      dayPills,
      slotPills,
      isPending,
      pendingUntil,
      isDone,
      createdAt
    });
  });

  state.mainTasks = tasks;
}

async function loadBgTasksFromFirestore() {
  if (!state.currentUid) return;
  const colRef = bgTasksColRef(state.currentUid);
  const snapshot = await getDocs(colRef);

  const now = Date.now();
  const tasks = [];

  for (const docSnap of snapshot.docs) {
    const data = docSnap.data();
    const id = docSnap.id;

    const startIso =
      data.start ||
      (data.startAt ? new Date(data.startAt).toISOString() : null);
    const endIso =
      data.end ||
      (data.endAt ? new Date(data.endAt).toISOString() : null);

    if (!startIso || !endIso) continue;

    const endMs = new Date(endIso).getTime();
    if (endMs <= now) {
      await deleteDoc(doc(db, "users", state.currentUid, "backgroundTasks", id));
      continue;
    }

    const shortId =
      typeof data.shortId === "number" ? data.shortId : data.bgId || null;

    const createdAt = data.createdAt || new Date().toISOString();

    tasks.push({
      id,
      shortId,
      title: data.title || "(untitled)",
      start: startIso,
      end: endIso,
      createdAt
    });
  }

  state.bgTasks = tasks;
}

async function loadAllData() {
  if (!state.currentUid) return;
  await loadMainTasksFromFirestore();
  await loadBgTasksFromFirestore();
  recomputeTimeline();
}

// --- Magnet engine core ---

function isNowWithinTaskWindow(task, nowMs) {
  if (!task.dayPills?.length && !task.slotPills?.length) {
    return true;
  }

  const d = new Date(nowMs);
  const day = d.getDay();

  const hasDays = Array.isArray(task.dayPills) && task.dayPills.length > 0;
  const hasSlots =
    Array.isArray(task.slotPills) && task.slotPills.length > 0;

  const dayOk = !hasDays || task.dayPills.includes(day);

  const hour = d.getHours();
  const slot = Math.floor(hour / 3);
  const slotOk = !hasSlots || task.slotPills.includes(slot);

  return dayOk && slotOk;
}

function computeWeight(task, nowMs) {
  const duration = task.durationMinutes || 0;
  if (duration <= 0) return 0;

  let minutesLeft = 1e9;
  let baseW = 0;

  if (task.deadline) {
    const dl = new Date(task.deadline).getTime();
    const diff = dl - nowMs;
    if (diff <= 0) {
      minutesLeft = 1;
      baseW = 0;
    } else {
      minutesLeft = Math.max(1, diff / MINUTE_MS);
      baseW = duration / minutesLeft;
    }
  }

  let w = baseW;
  let shortBoost = 1;
  if (duration <= 10 && minutesLeft <= 48 * 60) {
    shortBoost = state.settings.kShort;
  }
  w *= shortBoost;

  let timeFactor = 1;
  const mode = task.onlyMode || "NONE";
  const within = isNowWithinTaskWindow(task, nowMs);

  if (mode === "ONLY") {
    timeFactor = within ? state.settings.kOnlyPrefer : 0;
  } else if (mode === "PREFER") {
    timeFactor = within ? state.settings.kOnlyPrefer : 1;
  }

  w *= timeFactor;

  return {
    baseW,
    minutesLeft,
    w,
    timeFactor,
    shortBoost
  };
}

function scheduleMainTasks(totalSlices) {
  const now = state.now;
  const nowSliceRaw = msToSliceIndex(now);
  state.nowSlice = clamp(nowSliceRaw, 0, totalSlices - 1);

  state.overdueTasks = [];
  state.pendingTasks = [];

  const engineTasks = [];

  for (const t of state.mainTasks) {
    if (t.isDone) {
      continue;
    }

    let dlMs = null;
    if (t.deadline) {
      dlMs = new Date(t.deadline).getTime();
    }

    const pendingUntilMs =
      t.pendingUntil != null ? new Date(t.pendingUntil).getTime() : null;

    const isPendingFlag = !!t.isPending;
    const isPendingUntilFuture =
      pendingUntilMs != null && pendingUntilMs > now;

    if (dlMs != null && dlMs < now) {
      state.overdueTasks.push(t);
      continue;
    }

    if (isPendingFlag || isPendingUntilFuture) {
      state.pendingTasks.push(t);
      continue;
    }

    engineTasks.push(t);
  }

  const weighted = [];
  for (const t of engineTasks) {
    const { baseW, minutesLeft, w, timeFactor, shortBoost } = computeWeight(
      t,
      now
    );
    weighted.push({
      task: t,
      baseW,
      minutesLeft,
      w,
      timeFactor,
      shortBoost,
      assignedSlices: []
    });
  }

  weighted.sort((a, b) => {
    if (b.w !== a.w) return b.w - a.w;
    return a.minutesLeft - b.minutesLeft;
  });

  let frontier = state.nowSlice;

  const sliceTypes = state.sliceTypes;

  for (const entry of weighted) {
    const t = entry.task;
    const requiredSlices = Math.ceil(
      (t.durationMinutes || 0) / state.settings.sliceMinutes
    );
    if (requiredSlices <= 0) continue;

    const assigned = [];
    for (
      let s = frontier;
      s < totalSlices && assigned.length < requiredSlices;
      s++
    ) {
      if (sliceTypes[s] === 1) {
        assigned.push(s);
      }
    }

    entry.assignedSlices = assigned;

    if (assigned.length > 0) {
      frontier = assigned[assigned.length - 1] + 1;
    }
  }

  return weighted;
}

function recomputeTimeline() {
  state.now = Date.now();

  // v1.5.2: timeline covers yesterday + today + future horizonDays
  const today = new Date(state.now);
  today.setHours(0, 0, 0, 0);
  const todayStart = today.getTime();

  // Start from yesterday 00:00
  state.timelineStart = todayStart - 24 * HOUR_MS;

  // Keep the same future coverage as v1.5.1 (today + horizonDays-1),
  // just add one extra day in the past.
  state.timelineEnd =
    todayStart +
    state.settings.horizonDays * 24 * HOUR_MS -
    1;

  const totalSlices =
    ((state.settings.horizonDays + 1) * 24 * 60) / state.settings.sliceMinutes;

  // 1 = free, 3 = blocked by BG
  state.sliceTypes = new Array(totalSlices).fill(1);

  const now = state.now;

  // Background slices (skip expired ones, they are deleted at load time)
  for (const bg of state.bgTasks) {
    const startMs = new Date(bg.start).getTime();
    const endMs = new Date(bg.end).getTime();

    const startClamped = Math.max(startMs, state.timelineStart);
    const endClamped = Math.min(endMs, state.timelineEnd);

    if (endClamped <= startClamped) continue;

    let si = msToSliceIndex(startClamped);
    si = clamp(si, 0, totalSlices - 1);

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

// --- Rendering ---

function renderTimeline() {
  const header = document.getElementById("timelineHeader");
  const canvas = document.getElementById("timelineCanvas");
  header.innerHTML = "";
  canvas.innerHTML = "";

  const pxPerHour = 64;
  // v1.5.2: timeline shows yesterday + today + future horizonDays
  const totalDays = state.settings.horizonDays + 1;
  const totalHours = totalDays * 24;
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

  const todayStartForBand = (() => {
    const d0 = new Date(state.now);
    d0.setHours(0, 0, 0, 0);
    return d0.getTime();
  })();

  for (let d = 0; d < totalDays; d++) {
    const dayStartMs = start + d * 24 * HOUR_MS;
    const date = new Date(dayStartMs);
    const x = d * 24 * pxPerHour;
    const band = document.createElement("div");
    band.className = "timeline-day-band";
    band.style.left = x + "px";
    band.style.width = 24 * pxPerHour + "px";

    const isToday = dayStartMs === todayStartForBand;
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

  for (const bg of state.bgTasks) {
    const startMs = new Date(bg.start).getTime();
    const endMs = new Date(bg.end).getTime();

    if (endMs <= state.timelineStart || startMs >= state.timelineEnd) {
      continue;
    }

    const startClamped = Math.max(startMs, state.timelineStart);
    const endClamped = Math.min(endMs, state.timelineEnd);

    const offsetHours = (startClamped - state.timelineStart) / HOUR_MS;
    const durationHours = (endClamped - startClamped) / HOUR_MS;

    const block = document.createElement("div");
    block.className = "timeline-block bg";
    block.style.left = offsetHours * pxPerHour + "px";
    block.style.width =
      Math.max(durationHours * pxPerHour, 26) + "px";

    block.innerHTML = `
      <div class="block-title">#${bg.shortId ?? ""} ${bg.title}</div>
      <div class="block-meta">${formatHM(startMs)}–${formatHM(
      endMs
    )}</div>
    `;

    laneBg.appendChild(block);
  }

  const overdue = state.overdueTasks.slice();
  overdue.sort((a, b) => {
    const da = a.deadline ? new Date(a.deadline).getTime() : 0;
    const db = b.deadline ? new Date(b.deadline).getTime() : 0;
    return da - db;
  });

  const now = state.now;
  const nowOffsetHours = (now - state.timelineStart) / HOUR_MS;
  const nowX = nowOffsetHours * pxPerHour;

  const blockWidth = 150;
  const gap = 8;

  const startX = Math.max(nowX - (blockWidth + gap) * overdue.length - 20, 4);

  overdue.forEach((t, index) => {
    const block = document.createElement("div");
    block.className = "timeline-block main overdue";
    block.style.left = (startX + index * (blockWidth + gap)) + "px";
    block.style.width = blockWidth + "px";

    const dlMs = t.deadline ? new Date(t.deadline).getTime() : null;

    block.innerHTML = `
      <div class="block-title">#${t.shortId ?? ""} ${t.title}</div>
      <div class="block-meta">
        Overdue · ${dlMs ? formatHM(dlMs) : "No deadline"}
      </div>
    `;

    block.dataset.taskId = t.id;
    block.addEventListener("click", (e) => {
      e.stopPropagation();
      openTimelineTooltipForTask(t, {
        x: nowX,
        lane: "main"
      });
    });

    laneMain.appendChild(block);
  });

  const pendingTasks = state.pendingTasks.slice();
  pendingTasks.sort((a, b) => {
    const pa =
      a.pendingUntil != null
        ? new Date(a.pendingUntil).getTime()
        : Number.MAX_SAFE_INTEGER;
    const pb =
      b.pendingUntil != null
        ? new Date(b.pendingUntil).getTime()
        : Number.MAX_SAFE_INTEGER;
    return pa - pb;
  });

  let pendingIndex = 0;
  for (const t of pendingTasks) {
    const width = 160;
    const gapPending = 10;
    const x = 70 + pendingIndex * (width + gapPending);

    const block = document.createElement("div");
    block.className = "timeline-block pending";
    block.style.left = x + "px";
    block.style.width = width + "px";

    let pendingLabel = "Pending";
    if (t.pendingUntil) {
      const pm = new Date(t.pendingUntil).getTime();
      pendingLabel = `Pending until ${formatHM(pm)}`;
    }

    block.innerHTML = `
      <div class="block-title">#${t.shortId ?? ""} ${t.title}</div>
      <div class="block-meta">${pendingLabel}</div>
    `;

    block.dataset.taskId = t.id;
    block.addEventListener("click", (e) => {
      e.stopPropagation();
      openTimelineTooltipForTask(t, {
        x,
        lane: "pending"
      });
    });

    lanePending.appendChild(block);
    pendingIndex++;
  }

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
      block.style.width =
        Math.max(durationHours * pxPerHour, 24) + "px";

      block.title =
        `#${t.shortId ?? ""} ${t.title}\n` +
        `${formatHM(startMs)}–${formatHM(
          endMs
        )} (deadline: ${
          dlMs ? formatHM(dlMs) : "no deadline"
        })`;

      block.innerHTML = `
        <div class="block-title">#${t.shortId ?? ""} ${t.title}</div>
        <div class="block-meta">
          ${formatHM(startMs)}–${formatHM(
        endMs
      )} · ${t.durationMinutes} min
        </div>
      `;

      block.dataset.taskId = t.id;
      block.addEventListener("click", (e) => {
        e.stopPropagation();
        openTimelineTooltipForTask(t, {
          x: offsetHours * pxPerHour,
          lane: "main"
        });
      });

      laneMain.appendChild(block);
    }
  }

  inner.appendChild(laneMain);
  inner.appendChild(laneBg);
  inner.appendChild(lanePending);

  canvas.appendChild(inner);

  const nowLine = document.getElementById("currentTimeLine");
  const nowOffsetH = (state.now - state.timelineStart) / HOUR_MS;
  const nowPos = nowOffsetH * pxPerHour;
  nowLine.style.left = nowPos + "px";
}

// --- Main task list ---

function renderMainTaskList() {
  const list = document.getElementById("mainTaskList");
  list.innerHTML = "";

  const activeEntries = state.scheduledMain.filter(
    (e) => e.assignedSlices && e.assignedSlices.length > 0
  );

  const activeScheduledTasks = activeEntries.map((e) => e.task);

  const pendingTasks = state.pendingTasks.slice();
  const overdueTasks = state.overdueTasks.slice();

  const otherActive = state.mainTasks.filter((t) => {
    if (t.isDone) return false;
    if (pendingTasks.find((p) => p.id === t.id)) return false;
    if (overdueTasks.find((o) => o.id === t.id)) return false;
    if (activeScheduledTasks.find((a) => a.id === t.id)) return false;
    return true;
  });

  const doneTasks = state.mainTasks.filter((t) => t.isDone);

  const sections = [];

  if (activeScheduledTasks.length > 0) {
    sections.push({
      title: "ACTIVE – Scheduled by engine",
      tasks: activeEntries.map((e) => e.task),
      kind: "activeScheduled"
    });
  }

  if (pendingTasks.length > 0) {
    sections.push({
      title: "PENDING – Waiting (PendingUntil / isPending)",
      tasks: pendingTasks,
      kind: "pending"
    });
  }

  if (overdueTasks.length > 0) {
    sections.push({
      title: "OVERDUE – Deadline < NOW (not in engine)",
      tasks: overdueTasks,
      kind: "overdue"
    });
  }

  if (otherActive.length > 0) {
    sections.push({
      title: "ACTIVE – Not scheduled (no slices)",
      tasks: otherActive,
      kind: "otherActive"
    });
  }

  if (doneTasks.length > 0) {
    sections.push({
      title: "DONE",
      tasks: doneTasks,
      kind: "done"
    });
  }

  if (sections.length === 0) {
    const empty = document.createElement("div");
    empty.textContent = "No main tasks yet. Create one from Settings tab.";
    empty.style.fontSize = "12px";
    empty.style.color = "#6b7280";
    list.appendChild(empty);
    return;
  }

  for (const section of sections) {
    const header = document.createElement("div");
    header.className = "task-section-header";
    header.textContent = section.title;
    header.style.fontSize = "12px";
    header.style.fontWeight = "600";
    header.style.margin = "4px 0 2px";
    list.appendChild(header);

    for (const t of section.tasks) {
      const row = document.createElement("div");
      row.className = "task-row";

      const main = document.createElement("div");
      main.className = "task-main";

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

      const desc = document.createElement("div");
      desc.className = "task-desc";
      desc.textContent = t.description || "";

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
      } else if (section.kind === "activeScheduled") {
        stateBadge.classList.add("badge-state-active");
        stateBadge.textContent = "ACTIVE (scheduled)";
      } else {
        stateBadge.classList.add("badge-state-active");
        stateBadge.textContent = "ACTIVE";
      }
      metaLine.appendChild(stateBadge);

      const mode = t.onlyMode || "NONE";
      const modeBadge = document.createElement("span");
      modeBadge.className = "badge";
      modeBadge.textContent = `MODE: ${mode}`;
      metaLine.appendChild(modeBadge);

      if (t.deadline) {
        const dlMs = new Date(t.deadline).getTime();
        const dlBadge = document.createElement("span");
        dlBadge.className = "badge";
        dlBadge.textContent = `DL: ${formatHM(dlMs)}`;
        metaLine.appendChild(dlBadge);

        const now = state.now || Date.now();
        const diffMin = Math.round((dlMs - now) / MINUTE_MS);
        const diffBadge = document.createElement("span");
        diffBadge.className = "badge";
        diffBadge.textContent = `T- ${diffMin} min`;
        metaLine.appendChild(diffBadge);
      } else {
        const dlBadge = document.createElement("span");
        dlBadge.className = "badge";
        dlBadge.textContent = "DL: none";
        metaLine.appendChild(dlBadge);
      }

      const durBadge = document.createElement("span");
      durBadge.className = "badge";
      durBadge.textContent = `${t.durationMinutes} min`;
      metaLine.appendChild(durBadge);

      if (t.pendingUntil) {
        const pm = new Date(t.pendingUntil).getTime();
        const pb = document.createElement("span");
        pb.className = "badge badge-state-pending";
        pb.textContent = `Pending until ${formatHM(pm)}`;
        metaLine.appendChild(pb);
      } else if (t.isPending) {
        const pb = document.createElement("span");
        pb.className = "badge badge-state-pending";
        pb.textContent = "Pending (flag)";
        metaLine.appendChild(pb);
      }

      main.appendChild(titleLine);
      if (t.description) {
        main.appendChild(desc);
      }
      main.appendChild(metaLine);

      const actions = document.createElement("div");
      actions.className = "task-actions";

      const btnEdit = document.createElement("button");
      btnEdit.className = "btn subtle-btn";
      btnEdit.textContent = "Edit";
      btnEdit.addEventListener("click", () => openEditModal(t));
      actions.appendChild(btnEdit);

      const btnDone = document.createElement("button");
      btnDone.className = "btn subtle-btn";
      btnDone.textContent = t.isDone ? "Mark undone" : "Mark done";
      btnDone.addEventListener("click", () => toggleDone(t));
      actions.appendChild(btnDone);

      const btnDup = document.createElement("button");
      btnDup.className = "btn subtle-btn";
      btnDup.textContent = "Duplicate";
      btnDup.addEventListener("click", () => openDuplicateSheet(t));
      actions.appendChild(btnDup);

      const btnDel = document.createElement("button");
      btnDel.className = "btn ghost-btn";
      btnDel.textContent = "Delete";
      btnDel.addEventListener("click", () => deleteMainTask(t));
      actions.appendChild(btnDel);

      row.appendChild(main);
      row.appendChild(actions);

      list.appendChild(row);
    }
  }
}

// --- Background list ---

function renderBgTaskList() {
  const list = document.getElementById("bgTaskList");
  list.innerHTML = "";

  if (!state.bgTasks.length) {
    const empty = document.createElement("div");
    empty.textContent =
      "No background blocks yet. Create one on the left.";
    empty.style.fontSize = "12px";
    empty.style.color = "#6b7280";
    list.appendChild(empty);
    return;
  }

  const tasks = state.bgTasks.slice().sort((a, b) => {
    const sa = new Date(a.start).getTime();
    const sb = new Date(b.start).getTime();
    return sa - sb;
  });

  for (const t of tasks) {
    const row = document.createElement("div");
    row.className = "bg-row";

    const main = document.createElement("div");
    main.className = "bg-main";

    const title = document.createElement("div");
    title.className = "bg-title";
    title.textContent = t.title;

    const meta = document.createElement("div");
    meta.className = "bg-meta";
    const s = new Date(t.start).getTime();
    const e = new Date(t.end).getTime();
    meta.textContent = `${formatHM(s)}–${formatHM(
      e
    )} (#${t.shortId ?? ""})`;

    main.appendChild(title);
    main.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "bg-actions";

    const btnDel = document.createElement("button");
    btnDel.className = "btn ghost-btn";
    btnDel.textContent = "Delete";
    btnDel.addEventListener("click", () => deleteBgTask(t));
    actions.appendChild(btnDel);

    row.appendChild(main);
    row.appendChild(actions);

    list.appendChild(row);
  }
}

// --- Debug panel ---

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
  }, done: ${doneCount}), scheduled (ACTIVE only): ${
    scheduled
  }. Overdue cluster: ${state.overdueTasks.length}, pending: ${
    state.pendingTasks.length
  }. SliceMinutes=${state.settings.sliceMinutes}, HorizonDays=${
    state.settings.horizonDays
  }, k=${state.settings.kOnlyPrefer}, k_short=${
    state.settings.kShort
  }, nowSlice=${state.nowSlice}`;

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
      <td>${e.shortBoost.toFixed(0)}</td>
      <td>${e.w.toFixed(4)}</td>
      <td>${e.assignedSlices.join(",")}</td>
    `;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  wrapper.appendChild(table);
}

// --- Forms & interactions ---

function setupTabs() {
  const buttons = document.querySelectorAll(".tab-button");
  const panels = document.querySelectorAll(".tab-panel");

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.getAttribute("data-tab");

      buttons.forEach((b) => b.classList.remove("active"));
      panels.forEach((p) => p.classList.remove("active"));

      btn.classList.add("active");
      document.getElementById(tab).classList.add("active");
    });
  });
}

function setupMainTaskForm() {
  const form = document.getElementById("mainTaskForm");
  if (!form) return;

  const modePills = document.querySelectorAll("#onlyModePills .pill");
  modePills.forEach((pill) => {
    pill.addEventListener("click", () => {
      modePills.forEach((p) => p.classList.remove("pill-selected"));
      pill.classList.add("pill-selected");
    });
  });

  const dayPills = document.querySelectorAll("#dayPills .pill");
  dayPills.forEach((pill) => {
    pill.addEventListener("click", () => {
      pill.classList.toggle("pill-selected");
    });
  });

  const slotPills = document.querySelectorAll("#slotPills .pill");
  slotPills.forEach((pill) => {
    pill.addEventListener("click", () => {
      pill.classList.toggle("pill-selected");
    });
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.currentUid) {
      alert("Please sign in first.");
      return;
    }

    const title = document.getElementById("mainTitle").value.trim();
    const description = document
      .getElementById("mainDescription")
      .value.trim();
    const duration = parseInt(
      document.getElementById("mainDuration").value,
      10
    );
    const deadlineInput = document.getElementById("mainDeadline").value;
    const deadlineIso = localInputToIso(deadlineInput);

    if (!title || !duration || !deadlineIso) {
      alert("Title, duration and deadline are required.");
      return;
    }

    let onlyMode = "NONE";
    modePills.forEach((pill) => {
      if (pill.classList.contains("pill-selected")) {
        onlyMode = pill.getAttribute("data-mode");
      }
    });

    const selectedDays = [];
    dayPills.forEach((pill) => {
      if (pill.classList.contains("pill-selected")) {
        selectedDays.push(parseInt(pill.getAttribute("data-day"), 10));
      }
    });

    const selectedSlots = [];
    slotPills.forEach((pill) => {
      if (pill.classList.contains("pill-selected")) {
        selectedSlots.push(parseInt(pill.getAttribute("data-slot"), 10));
      }
    });

    const pendingUntilInput =
      document.getElementById("pendingUntil").value;
    const pendingUntilIso = pendingUntilInput
      ? localInputToIso(pendingUntilInput)
      : null;

    const shortId = await getAndIncrementCounter(
      state.currentUid,
      "mainShortCounter"
    );

    const docRef = await addDoc(mainTasksColRef(state.currentUid), {
      shortId,
      title,
      description,
      durationMinutes: duration,
      deadline: deadlineIso,
      onlyMode,
      dayPills: selectedDays,
      slotPills: selectedSlots,
      isPending: false,
      pendingUntil: pendingUntilIso,
      isDone: false,
      createdAt: new Date().toISOString()
    });

    console.log("Created main task", docRef.id);

    form.reset();
    modePills.forEach((p) => p.classList.remove("pill-selected"));
    modePills[0].classList.add("pill-selected");
    dayPills.forEach((p) => p.classList.remove("pill-selected"));
    slotPills.forEach((p) => p.classList.remove("pill-selected"));

    await loadMainTasksFromFirestore();
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

    const startIso = localInputToIso(startInput);
    const endIso = localInputToIso(endInput);

    if (!title || !startIso || !endIso) {
      alert("Title, start, end are required.");
      return;
    }

    const startMs = new Date(startIso).getTime();
    const endMs = new Date(endIso).getTime();
    if (endMs <= startMs) {
      alert("End must be after start.");
      return;
    }

    const shortId = await getAndIncrementCounter(
      state.currentUid,
      "bgShortCounter"
    );

    const docRef = await addDoc(bgTasksColRef(state.currentUid), {
      shortId,
      title,
      start: startIso,
      end: endIso,
      createdAt: new Date().toISOString()
    });

    console.log("Created background task", docRef.id);

    form.reset();

    await loadBgTasksFromFirestore();
    recomputeTimeline();
  });
}

function setupSettings() {
  const form = document.getElementById("settingsForm");
  if (!form) return;

  const s = state.settings;
  document.getElementById("setSliceMinutes").value = s.sliceMinutes;
  document.getElementById("setHorizonDays").value = s.horizonDays;
  document.getElementById("setKOnlyPrefer").value = s.kOnlyPrefer;
  document.getElementById("setKShort").value = s.kShort;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const slice = parseInt(
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

    if (!slice || !d || !k || !ks) {
      alert("All fields are required.");
      return;
    }

    state.settings.sliceMinutes = slice;
    state.settings.horizonDays = d;
    state.settings.kOnlyPrefer = k;
    state.settings.kShort = ks;

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
  const panel = document.getElementById("debugPanel");
  if (!btn || !panel) return;

  btn.addEventListener("click", () => {
    const visible = panel.style.display !== "none";
    panel.style.display = visible ? "none" : "block";
  });
}

// --- Duplicate sheet ---

function openDuplicateSheet(task) {
  state.duplicateTarget = task;
  const sheet = document.getElementById("duplicateSheet");
  sheet.style.display = "block";
}

function closeDuplicateSheet() {
  const sheet = document.getElementById("duplicateSheet");
  sheet.style.display = "none";
  state.duplicateTarget = null;
}

function setupDuplicateUI() {
  const sheet = document.getElementById("duplicateSheet");
  if (!sheet) return;

  const buttons = sheet.querySelectorAll(".sheet-option-btn");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const shift = btn.getAttribute("data-shift");
      if (!state.duplicateTarget) return;

      if (shift === "custom") {
        openCustomDateDialog();
      } else {
        const shiftDays = parseInt(shift, 10);
        performDuplicateWithShift(shiftDays);
        closeDuplicateSheet();
      }
    });
  });

  const cancel = document.getElementById("duplicateCancelBtn");
  cancel.addEventListener("click", () => {
    closeDuplicateSheet();
  });

  const dialog = document.getElementById("customDateDialog");
  const confirmBtn = document.getElementById("customDateConfirmBtn");
  const cancelCustom = document.getElementById("customDateCancelBtn");

  confirmBtn.addEventListener("click", () => {
    const dateStr = document.getElementById("customDateInput").value;
    if (!dateStr || !state.duplicateTarget) {
      alert("Please pick a date.");
      return;
    }
    performDuplicateWithCustomDate(dateStr);
    closeCustomDateDialog();
    closeDuplicateSheet();
  });

  cancelCustom.addEventListener("click", () => {
    closeCustomDateDialog();
  });

  function openCustomDateDialog() {
    dialog.style.display = "block";
  }

  function closeCustomDateDialog() {
    dialog.style.display = "none";
    document.getElementById("customDateInput").value = "";
  }
}

function performDuplicateWithShift(shiftDays) {
  const t = state.duplicateTarget;
  if (!t) return;

  let newDeadline = t.deadline ? new Date(t.deadline) : null;
  if (shiftDays !== 0) {
    if (!newDeadline) newDeadline = new Date();
    newDeadline.setDate(newDeadline.getDate() + shiftDays);
  }

  performDuplicateBase(t, newDeadline ? newDeadline.toISOString() : null);
}

function performDuplicateWithCustomDate(dateStr) {
  const t = state.duplicateTarget;
  if (!t) return;

  const d = new Date(dateStr + "T23:59:00");
  performDuplicateBase(t, d.toISOString());
}

async function performDuplicateBase(task, newDeadlineIso) {
  if (!state.currentUid) {
    alert("Please sign in first.");
    return;
  }

  const shortId = await getAndIncrementCounter(
    state.currentUid,
    "mainShortCounter"
  );

  const payload = {
    shortId,
    title: task.title,
    description: task.description,
    durationMinutes: task.durationMinutes,
    deadline: newDeadlineIso || task.deadline,
    onlyMode: task.onlyMode || "NONE",
    dayPills: Array.isArray(task.dayPills) ? task.dayPills : [],
    slotPills: Array.isArray(task.slotPills) ? task.slotPills : [],
    isPending: false,
    pendingUntil: null,
    isDone: false,
    createdAt: new Date().toISOString()
  };

  await addDoc(mainTasksColRef(state.currentUid), payload);

  await loadMainTasksFromFirestore();
  recomputeTimeline();
}

// --- Edit modal ---

function openEditModal(task) {
  state.currentEditTask = task;

  document.getElementById("editTitle").value = task.title || "";
  document.getElementById("editDescription").value =
    task.description || "";
  document.getElementById("editDuration").value =
    task.durationMinutes || 30;
  document.getElementById("editDeadline").value = isoToLocalInput(
    task.deadline
  );
  document.getElementById("editPendingUntil").value =
    isoToLocalInput(task.pendingUntil);

  const modePills = document.querySelectorAll("#editOnlyModePills .pill");
  modePills.forEach((p) => {
    p.classList.toggle(
      "pill-selected",
      (task.onlyMode || "NONE") === p.getAttribute("data-mode")
    );
  });

  const dayPills = document.querySelectorAll("#editDayPills .pill");
  dayPills.forEach((p) => {
    const day = parseInt(p.getAttribute("data-day"), 10);
    const has = Array.isArray(task.dayPills)
      ? task.dayPills.includes(day)
      : false;
    p.classList.toggle("pill-selected", has);
  });

  const slotPills = document.querySelectorAll("#editSlotPills .pill");
  slotPills.forEach((p) => {
    const slot = parseInt(p.getAttribute("data-slot"), 10);
    const has = Array.isArray(task.slotPills)
      ? task.slotPills.includes(slot)
      : false;
    p.classList.toggle("pill-selected", has);
  });

  document.getElementById("editModal").style.display = "block";
}

function closeEditModal() {
  document.getElementById("editModal").style.display = "none";
  state.currentEditTask = null;
}

function setupEditModal() {
  const form = document.getElementById("editTaskForm");
  const cancelBtn = document.getElementById("editCancelBtn");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.currentEditTask || !state.currentUid) return;

    const t = state.currentEditTask;

    const title = document.getElementById("editTitle").value.trim();
    const description = document
      .getElementById("editDescription")
      .value.trim();
    const duration = parseInt(
      document.getElementById("editDuration").value,
      10
    );
    const deadlineInput = document.getElementById("editDeadline").value;
    const deadlineIso = localInputToIso(deadlineInput);

    if (!title || !duration || !deadlineIso) {
      alert("Title, duration and deadline are required.");
      return;
    }

    const modePills = document.querySelectorAll(
      "#editOnlyModePills .pill"
    );
    let onlyMode = "NONE";
    modePills.forEach((p) => {
      if (p.classList.contains("pill-selected")) {
        onlyMode = p.getAttribute("data-mode");
      }
    });

    const dayPills = document.querySelectorAll("#editDayPills .pill");
    const dayArr = [];
    dayPills.forEach((p) => {
      if (p.classList.contains("pill-selected")) {
        dayArr.push(parseInt(p.getAttribute("data-day"), 10));
      }
    });

    const slotPills = document.querySelectorAll("#editSlotPills .pill");
    const slotArr = [];
    slotPills.forEach((p) => {
      if (p.classList.contains("pill-selected")) {
        slotArr.push(parseInt(p.getAttribute("data-slot"), 10));
      }
    });

    const pendingUntilInput =
      document.getElementById("editPendingUntil").value;
    const pendingUntilIso = pendingUntilInput
      ? localInputToIso(pendingUntilInput)
      : null;

    const docRef = doc(mainTasksColRef(state.currentUid), t.id);
    await setDoc(
      docRef,
      {
        title,
        description,
        durationMinutes: duration,
        deadline: deadlineIso,
        onlyMode,
        dayPills: dayArr,
        slotPills: slotArr,
        pendingUntil: pendingUntilIso
      },
      { merge: true }
    );

    closeEditModal();
    await loadMainTasksFromFirestore();
    recomputeTimeline();
  });

  cancelBtn.addEventListener("click", () => {
    closeEditModal();
  });
}

// --- Toggle done / delete ---

async function toggleDone(task) {
  if (!state.currentUid) return;
  const docRef = doc(mainTasksColRef(state.currentUid), task.id);
  await setDoc(
    docRef,
    {
      isDone: !task.isDone
    },
    { merge: true }
  );
  await loadMainTasksFromFirestore();
  recomputeTimeline();
}

async function deleteMainTask(task) {
  if (!state.currentUid) return;
  if (!confirm("Delete this main task?")) return;
  const docRef = doc(mainTasksColRef(state.currentUid), task.id);
  await deleteDoc(docRef);
  await loadMainTasksFromFirestore();
  recomputeTimeline();
}

async function deleteBgTask(task) {
  if (!state.currentUid) return;
  if (!confirm("Delete this background block?")) return;
  const docRef = doc(bgTasksColRef(state.currentUid), task.id);
  await deleteDoc(docRef);
  await loadBgTasksFromFirestore();
  recomputeTimeline();
}

// --- Timeline tooltip ---

function openTimelineTooltipForTask(task, pos) {
  state.currentTooltipTask = task;

  const tooltip = document.getElementById("timelineTooltip");
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
    deadlineEl.textContent = `Deadline: ${formatHM(dlMs)}`;
  } else {
    deadlineEl.textContent = "Deadline: none";
  }

  modeEl.textContent = `Mode: ${task.onlyMode || "NONE"}`;

  if (task.pendingUntil) {
    const pm = new Date(task.pendingUntil).getTime();
    pendingEl.style.display = "inline-flex";
    pendingEl.textContent = `Pending until ${formatHM(pm)}`;
  } else if (task.isPending) {
    pendingEl.style.display = "inline-flex";
    pendingEl.textContent = "Pending (flag)";
  } else {
    pendingEl.style.display = "none";
  }

  descEl.textContent = task.description || "";

  const canvasRect = document
    .getElementById("timelineCanvasWrapper")
    .getBoundingClientRect();

  const x = canvasRect.left + (pos?.x || 0) - 10;
  const y = canvasRect.top + (pos?.lane === "pending" ? 160 : 80);

  tooltip.style.left = x + "px";
  tooltip.style.top = y + "px";
  tooltip.style.display = "block";

  const editBtn = document.getElementById("tooltipEditBtn");
  const doneBtn = document.getElementById("tooltipDoneBtn");
  const delBtn = document.getElementById("tooltipDeleteBtn");

  editBtn.onclick = () => {
    tooltip.style.display = "none";
    openEditModal(task);
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

function setupTimelineTooltipGlobalClose() {
  const tooltip = document.getElementById("timelineTooltip");
  document.addEventListener("click", (e) => {
    if (!tooltip.contains(e.target)) {
      tooltip.style.display = "none";
    }
  });
}

// --- Auth UI ---

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

// --- Init ---

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

  // Initial empty timeline (before auth & data load)
  recomputeTimeline();
}

document.addEventListener("DOMContentLoaded", init);

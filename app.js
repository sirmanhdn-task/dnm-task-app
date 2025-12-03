// DNM's Tasker v1.4.2 – Magnet-from-NOW scheduling engine
// No Firebase here: tasks are stored in localStorage to focus on engine.
// Core ideas:
//   w0 = duration / minutesLeft
//   shortBoost if duration <= 10 & deadline <= 48h
//   ONLY / PREFER -> multiply by k or 0 as user specified
//   Parallel / non-parallel via slice types (1/2/3)
//   Pack sequentially from frontierSlice = nowSlice, allow splitting

// ----------------- STATE -----------------

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
  nowSlice: 0
};

const STORAGE_KEY = "dnm_tasker_v142_local";

// ----------------- UTILITIES -----------------

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

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

function uuid() {
  return (
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).substring(2, 8)
  );
}

function saveToStorage() {
  const payload = {
    settings: state.settings,
    mainTasks: state.mainTasks,
    bgTasks: state.bgTasks
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.settings) state.settings = { ...state.settings, ...data.settings };
    if (Array.isArray(data.mainTasks)) state.mainTasks = data.mainTasks;
    if (Array.isArray(data.bgTasks)) state.bgTasks = data.bgTasks;
  } catch (e) {
    console.warn("Failed to load local data", e);
  }
}

// Map ms to slice index
function msToSliceIndex(ms) {
  const offset = ms - state.timelineStart;
  const sliceLenMs = state.settings.sliceMinutes * MINUTE_MS;
  return Math.floor(offset / sliceLenMs);
}

function sliceIndexToMs(sliceIndex) {
  const sliceLenMs = state.settings.sliceMinutes * MINUTE_MS;
  return state.timelineStart + sliceIndex * sliceLenMs;
}

// Check NOW in ONLY/PREFER window of a task
function isNowWithinTaskWindow(task, nowMs) {
  if (task.onlyMode === "NONE") return false;

  const now = new Date(nowMs);
  const day = now.getDay(); // 0 Sunday
  const hour = now.getHours();
  const slot = Math.floor(hour / 3); // 0..7

  const hasDays = Array.isArray(task.dayPills) && task.dayPills.length > 0;
  const hasSlots =
    Array.isArray(task.slotPills) && task.slotPills.length > 0;

  const dayOk = !hasDays || task.dayPills.includes(day);
  const slotOk = !hasSlots || task.slotPills.includes(slot);

  return dayOk && slotOk;
}

// ----------------- SCHEDULER CORE -----------------

function recomputeTimeline() {
  // 1) time bounds
  state.now = Date.now();
  state.timelineStart = startOfToday();
  state.timelineEnd =
    state.timelineStart +
    state.settings.horizonDays * 24 * HOUR_MS -
    1;
  const totalSlices =
    (state.settings.horizonDays * 24 * 60) / state.settings.sliceMinutes;

  // 2) slice types from background tasks
  state.sliceTypes = new Array(totalSlices).fill(1); // 1 = blank

  for (const bg of state.bgTasks) {
    const startMs = new Date(bg.start).getTime();
    const endMs = new Date(bg.end).getTime();
    if (isNaN(startMs) || isNaN(endMs) || endMs <= startMs) continue;

    // clamp inside horizon
    const startClamped = clamp(startMs, state.timelineStart, state.timelineEnd);
    const endClamped = clamp(endMs, state.timelineStart, state.timelineEnd);

    let si = msToSliceIndex(startClamped);
    let ei = msToSliceIndex(endClamped);
    ei = clamp(ei, 0, totalSlices - 1);

    for (let s = si; s <= ei; s++) {
      if (bg.isParallel) {
        if (state.sliceTypes[s] !== 3) state.sliceTypes[s] = 2; // parallel bg
      } else {
        state.sliceTypes[s] = 3; // non-parallel bg dominates
      }
    }
  }

  // 3) schedule main tasks with magnet-from-NOW
  state.scheduledMain = scheduleMainTasks(totalSlices);

  // 4) render
  renderTimeline();
  renderMainTaskList();
  renderBgTaskList();
  renderDebugPanel();
}

function scheduleMainTasks(totalSlices) {
  const now = state.now;
  const nowSliceRaw = msToSliceIndex(now);
  state.nowSlice = clamp(nowSliceRaw, 0, totalSlices - 1);

  const tasks = state.mainTasks.filter((t) => !t.isPending);

  const decorated = [];
  const k = state.settings.kOnlyPrefer;
  const kShort = state.settings.kShort;

  for (const t of tasks) {
    const dlMs = new Date(t.deadline).getTime();
    let minutesLeft = (dlMs - now) / MINUTE_MS;
    if (minutesLeft <= 0) minutesLeft = 1; // avoid /0, overdue -> w lớn

    const baseW = t.durationMinutes / minutesLeft;

    let w = baseW;

    // Short task boost
    if (t.durationMinutes <= 10 && minutesLeft <= 48 * 60) {
      w *= kShort;
    }

    // ONLY / PREFER
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

  // Sort by w desc, then by minutesLeft asc (gần deadline hơn ưu tiên)
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

// ----------------- RENDER TIMELINE -----------------

function renderTimeline() {
  const header = document.getElementById("timelineHeader");
  const canvas = document.getElementById("timelineCanvas");
  header.innerHTML = "";
  canvas.innerHTML = "";

  const pxPerHour = 50;
  const totalHours = state.settings.horizonDays * 24;
  const totalWidth = totalHours * pxPerHour;

  // Header: hours + day bands
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
      ? "rgba(148, 163, 184, 0.18)"
      : "rgba(15, 23, 42, 0.9)";

    band.textContent =
      String(date.getMonth() + 1).padStart(2, "0") +
      "/" +
      String(date.getDate()).padStart(2, "0");
    headerInner.appendChild(band);
  }

  header.appendChild(headerInner);

  // Canvas: lanes + blocks
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

    // group contiguous slices into segments
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

    const dlMs = new Date(t.deadline).getTime();
    const isOverdue = dlMs < now;

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
      block.innerHTML = `
        <div style="font-weight:500">${t.title}</div>
        <div style="font-size:0.65rem;opacity:0.85">
          #${t.shortId || ""} ${formatHM(startMs)}–${formatHM(endMs)}
        </div>
      `;
      laneMain.appendChild(block);
    }
  }

  // Pending tasks: just list them loosely
  for (const t of state.mainTasks.filter((t) => t.isPending)) {
    const block = document.createElement("div");
    block.className = "timeline-block main";
    block.style.left = "4px";
    block.style.width = "120px";
    block.innerHTML = `<div>${t.title}</div><div style="font-size:0.65rem;opacity:0.8">Pending (no timeline)</div>`;
    lanePending.appendChild(block);
  }

  // Current time line
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

// ----------------- RENDER LISTS -----------------

function renderMainTaskList() {
  const list = document.getElementById("mainTaskList");
  list.innerHTML = "";

  for (const entry of state.scheduledMain) {
    const t = entry.task;
    const row = document.createElement("div");
    row.className = "task-item";

    const main = document.createElement("div");
    main.className = "task-main";

    const titleRow = document.createElement("div");
    titleRow.className = "task-title-row";
    const titleSpan = document.createElement("span");
    titleSpan.className = "task-title";
    titleSpan.textContent = t.title || "(untitled)";
    titleRow.appendChild(titleSpan);

    const idSpan = document.createElement("span");
    idSpan.style.fontSize = "0.65rem";
    idSpan.style.color = "#9ca3af";
    idSpan.textContent = "#" + (t.shortId || "");
    titleRow.appendChild(idSpan);
    main.appendChild(titleRow);

    const meta = document.createElement("div");
    meta.className = "task-meta";
    const dlMs = new Date(t.deadline).getTime();
    meta.innerHTML = `
      <span>${formatDateTimeShort(dlMs)}</span>
      <span>${t.durationMinutes} min</span>
      <span>mode: ${t.onlyMode}</span>
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

    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn";
    delBtn.textContent = "Delete";
    delBtn.onclick = () => {
      state.mainTasks = state.mainTasks.filter((x) => x.id !== t.id);
      saveToStorage();
      recomputeTimeline();
    };
    actions.appendChild(delBtn);

    row.appendChild(main);
    row.appendChild(actions);
    list.appendChild(row);
  }
}

function renderBgTaskList() {
  const list = document.getElementById("bgTaskList");
  list.innerHTML = "";
  for (const t of state.bgTasks) {
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
    delBtn.onclick = () => {
      state.bgTasks = state.bgTasks.filter((x) => x.id !== t.id);
      saveToStorage();
      recomputeTimeline();
    };
    actions.appendChild(delBtn);

    row.appendChild(main);
    row.appendChild(actions);
    list.appendChild(row);
  }
}

// ----------------- DEBUG PANEL -----------------

function renderDebugPanel() {
  const summary = document.getElementById("debugSummary");
  const wrapper = document.getElementById("debugTableWrapper");
  wrapper.innerHTML = "";

  const totalMain = state.mainTasks.filter((t) => !t.isPending).length;
  const scheduled = state.scheduledMain.filter(
    (e) => e.assignedSlices.length > 0
  ).length;

  summary.textContent = `Main tasks: ${totalMain}, scheduled: ${scheduled}. SliceMinutes=${state.settings.sliceMinutes}, HorizonDays=${state.settings.horizonDays}, k=${state.settings.kOnlyPrefer}, k_short=${state.settings.kShort}. nowSlice=${state.nowSlice}`;

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

// ----------------- UI WIRING -----------------

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

function setupTogglePills(groupEl, attrName) {
  const pills = groupEl.querySelectorAll(".pill");
  pills.forEach((pill) => {
    pill.addEventListener("click", () => {
      pill.classList.toggle("active");
    });
  });
}

function getActiveDayPills() {
  const group = document.getElementById("mtDayPills");
  const actives = group.querySelectorAll(".pill.active");
  const days = [];
  actives.forEach((p) => {
    days.push(parseInt(p.getAttribute("data-day"), 10));
  });
  return days;
}

function getActiveSlotPills() {
  const group = document.getElementById("mtSlotPills");
  const actives = group.querySelectorAll(".pill.active");
  const slots = [];
  actives.forEach((p) => {
    slots.push(parseInt(p.getAttribute("data-slot"), 10));
  });
  return slots;
}

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

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const title = document.getElementById("mtTitle").value.trim();
    const desc = document.getElementById("mtDescription").value.trim();
    const dur = parseInt(
      document.getElementById("mtDuration").value,
      10
    );
    const dlStr = document.getElementById("mtDeadline").value;
    const dlMs = new Date(dlStr).getTime();

    if (!title || !dur || isNaN(dlMs)) return;

    const id = uuid();
    const shortId = state.mainTasks.length + 1;

    const task = {
      id,
      shortId,
      title,
      description: desc,
      durationMinutes: dur,
      deadline: new Date(dlMs).toISOString(),
      isParallel: parallelGetter() === "parallel",
      isPending: false,
      onlyMode: modeGetter(),
      dayPills: getActiveDayPills(),
      slotPills: getActiveSlotPills(),
      createdAt: Date.now()
    };

    state.mainTasks.push(task);
    saveToStorage();
    form.reset();
    recomputeTimeline();
  });

  document
    .getElementById("clearTasksBtn")
    .addEventListener("click", () => {
      if (
        confirm(
          "Clear all main tasks stored locally? This cannot be undone."
        )
      ) {
        state.mainTasks = [];
        saveToStorage();
        recomputeTimeline();
      }
    });
}

function setupBgTaskForm() {
  const form = document.getElementById("bgTaskForm");
  const parallelGetter = setupPillGroupSingle(
    document.getElementById("bgParallelGroup"),
    "nonparallel"
  );

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const title = document.getElementById("bgTitle").value.trim();
    const desc = document.getElementById("bgDescription").value.trim();
    const startStr = document.getElementById("bgStart").value;
    const endStr = document.getElementById("bgEnd").value;

    const sMs = new Date(startStr).getTime();
    const eMs = new Date(endStr).getTime();
    if (!title || isNaN(sMs) || isNaN(eMs) || eMs <= sMs) return;

    const t = {
      id: uuid(),
      title,
      description: desc,
      start: new Date(sMs).toISOString(),
      end: new Date(eMs).toISOString(),
      isParallel: parallelGetter() === "parallel",
      createdAt: Date.now()
    };

    state.bgTasks.push(t);
    saveToStorage();
    form.reset();
    recomputeTimeline();
  });

  document
    .getElementById("clearBgTasksBtn")
    .addEventListener("click", () => {
      if (
        confirm(
          "Clear all background tasks stored locally? This cannot be undone."
        )
      ) {
        state.bgTasks = [];
        saveToStorage();
        recomputeTimeline();
      }
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
      saveToStorage();
      recomputeTimeline();
    });
}

function setupTimelineControls() {
  const canvas = document.getElementById("timelineCanvas");

  document.getElementById("jumpNowBtn").addEventListener("click", () => {
    const pxPerHour = 50;
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
    const pxPerHour = 50;
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

// ----------------- INIT -----------------

function init() {
  loadFromStorage();
  setupTabs();
  setupMainTaskForm();
  setupBgTaskForm();
  setupSettings();
  setupTimelineControls();
  setupDebugToggle();
  recomputeTimeline();
}

document.addEventListener("DOMContentLoaded", init);

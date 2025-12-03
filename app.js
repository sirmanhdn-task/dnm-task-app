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
  setDoc,
  updateDoc,
  deleteDoc
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

// ===================================================
// GLOBAL STATE
// ===================================================
let currentUid = null;
let currentEditingTaskId = null;
let currentEditingBgTaskId = null;
let currentDuplicateTask = null;

let backgroundTasksCache = [];
let mainTasksCache = [];

// Availability + scheduling
let availabilitySlots = null; // [dayIndex][slotIndex]
let slotAssignments = null; // [dayIndex][slotIndex] = { taskId, taskRef }

// ===================================================
// TABS
// ===================================================
document.querySelectorAll(".tab-button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const id = btn.dataset.tabTarget;

    document
      .querySelectorAll(".tab-button")
      .forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");

    document.querySelectorAll(".tab-panel").forEach((panel) => {
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

const laneBackgroundContent = document.getElementById("laneBackgroundContent");
const laneMainContent = document.getElementById("laneMainContent");

const MS_PER_HOUR = 3600000;
const MS_PER_DAY = 86400000;
const DAYS_TOTAL = 14;

const SLOT_MINUTES = 10;
const SLOTS_PER_DAY = (24 * 60) / SLOT_MINUTES;
const TOTAL_SLOTS = DAYS_TOTAL * SLOTS_PER_DAY;

let pixelsPerHour = 60;
const MIN_PX = 24;
const MAX_PX = 160;

const startOfToday = (() => {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
})();

function formatDayLabel(date) {
  const w = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `${w[date.getDay()]} ${date.getDate()}`;
}

function formatLocalDateTime(isoString) {
  if (!isoString) return "N/A";
  const d = new Date(isoString);
  if (isNaN(d)) return "N/A";
  const datePart = d.toLocaleDateString("en-GB");
  const timePart = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit"
  });
  return `${timePart} · ${datePart}`;
}

// ===================================================
// RENDER TIMELINE
// ===================================================
function renderTimeline() {
  const HOURS_TOTAL = DAYS_TOTAL * 24;
  const totalWidth = HOURS_TOTAL * pixelsPerHour;
  timelineHeader.innerHTML = "";
  timelineHeader.style.width = totalWidth + "px";

  for (let d = 0; d < DAYS_TOTAL; d++) {
    const date = new Date(startOfToday.getTime() + d * MS_PER_DAY);

    const dayDiv = document.createElement("div");
    dayDiv.classList.add("timeline-day");
    if (d === 0) dayDiv.classList.add("today");

    dayDiv.style.width = 24 * pixelsPerHour + "px";

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

  ["laneMainContent", "laneBackgroundContent", "lanePendingContent"].forEach(
    (id) => {
      const lane = document.getElementById(id);
      lane.style.width = totalWidth + "px";
    }
  );

  updateNowMarker();
  renderBackgroundOnTimeline();
  renderMainTasksOnTimeline();
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
  nowMarker.style.left = hours * pixelsPerHour + "px";
}

// ===================================================
// ZOOM & JUMP
// ===================================================
function zoom(factor) {
  const centerTime =
    (timelineScroll.scrollLeft + timelineScroll.clientWidth / 2) /
    pixelsPerHour;

  pixelsPerHour = Math.max(
    MIN_PX,
    Math.min(MAX_PX, pixelsPerHour * factor)
  );
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

document.getElementById("zoomInBtn").addEventListener("click", () =>
  zoom(1.2)
);
document.getElementById("zoomOutBtn").addEventListener("click", () =>
  zoom(1 / 1.2)
);
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
// PILL TOGGLE LOGIC – MAIN
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

// BACKGROUND PARALLEL PILL
const pillBgParallel = document.getElementById("pillBgParallel");
const cbBgParallel = document.getElementById("bgIsParallel");

pillBgParallel.addEventListener("click", () => {
  pillBgParallel.classList.toggle("active");
  cbBgParallel.checked = pillBgParallel.classList.contains("active");
});

// Background repeat UI (create form)
const bgWeeklyRow = document.getElementById("bgWeeklyRow");
const bgMonthlyRow = document.getElementById("bgMonthlyRow");
const bgSpecificDateRow = document.getElementById("bgSpecificDateRow");
const bgRepeatRadios = document.querySelectorAll(
  'input[name="bgRepeatType"]'
);
const bgWeeklyPillsContainer = document.getElementById("bgWeeklyPills");
const bgRepeatDateInput = document.getElementById("bgRepeatDate");
const bgSpecificDateInput = document.getElementById("bgSpecificDate");

bgRepeatRadios.forEach((r) => {
  r.addEventListener("change", () => {
    const value = r.value;
    if (!r.checked) return;

    bgSpecificDateRow.classList.add("hidden");
    bgWeeklyRow.classList.add("hidden");
    bgMonthlyRow.classList.add("hidden");

    if (value === "none") {
      bgSpecificDateRow.classList.remove("hidden");
    } else if (value === "weekly") {
      bgWeeklyRow.classList.remove("hidden");
    } else if (value === "monthly") {
      bgMonthlyRow.classList.remove("hidden");
    }
  });
});

bgWeeklyPillsContainer
  .querySelectorAll(".pill-toggle")
  .forEach((pill) => {
    pill.addEventListener("click", () => {
      pill.classList.toggle("active");
    });
  });

// ===================================================
// AUTH UI
// ===================================================
const loginBtn = document.getElementById("loginBtn");
const logoutBtn = document.getElementById("logoutBtn");
const userInfo = document.getElementById("userInfo");
const userAvatar = document.getElementById("userAvatar");
const userEmail = document.getElementById("userEmail");

function setLoggedOutUI() {
  currentUid = null;
  loginBtn.style.display = "inline-flex";
  userInfo.style.display = "none";

  const mainList = document.getElementById("mainTaskList");
  const bgList = document.getElementById("backgroundTaskList");
  if (mainList) {
    mainList.innerHTML =
      '<p class="task-meta">Sign in to see your main tasks.</p>';
  }
  if (bgList) {
    bgList.innerHTML =
      '<p class="task-meta">Sign in to see your background tasks.</p>';
  }

  laneBackgroundContent.innerHTML = "";
  laneMainContent.innerHTML = "";
  availabilitySlots = null;
  slotAssignments = null;

  const debugGrid = document.getElementById("availabilityDebugGrid");
  if (debugGrid) debugGrid.innerHTML = "";
}

function setLoggedInUI(user) {
  currentUid = user.uid;
  loginBtn.style.display = "none";
  userInfo.style.display = "flex";

  userEmail.textContent = user.email || "";
  if (user.photoURL) {
    userAvatar.src = user.photoURL;
  } else {
    userAvatar.src =
      "https://ui-avatars.com/api/?name=" +
      encodeURIComponent(user.email || "User");
  }
}

async function ensureUserInitialized(uid) {
  const userRef = doc(db, "users", uid);
  const userSnap = await getDoc(userRef);
  if (!userSnap.exists()) {
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

loginBtn.addEventListener("click", async () => {
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    console.error("Login error:", err);
    alert("Unable to sign in with Google. Please check the console.");
  }
});

logoutBtn.addEventListener("click", async () => {
  try {
    await signOut(auth);
  } catch (err) {
    console.error("Logout error:", err);
    alert("Unable to sign out. Please check the console.");
  }
});

onAuthStateChanged(auth, async (user) => {
  if (user) {
    setLoggedInUI(user);
    await ensureUserInitialized(user.uid);
    await loadAllData();
  } else {
    setLoggedOutUI();
  }
});

// ===================================================
// COUNTER HELPER – PER USER
// ===================================================
async function getNextCounter(fieldName, uid) {
  const countersRef = doc(db, "users", uid, "metadata", "counters");
  const snap = await getDoc(countersRef);

  let data;
  if (!snap.exists()) {
    data = { mainTaskCount: 0, backgroundTaskCount: 0 };
  } else {
    data = snap.data();
    if (data.mainTaskCount == null) data.mainTaskCount = 0;
    if (data.backgroundTaskCount == null)
      data.backgroundTaskCount = 0;
  }

  const newCount = (data[fieldName] || 0) + 1;
  data[fieldName] = newCount;

  await setDoc(countersRef, data);
  return newCount;
}

// ===================================================
// EDIT MAIN TASK MODAL
// ===================================================
const editTaskModal = document.getElementById("editTaskModal");
const editTaskForm = document.getElementById("editTaskForm");

const editTitleInput = document.getElementById("editTitle");
const editDescriptionInput = document.getElementById(
  "editDescription"
);
const editImportanceInput = document.getElementById("editImportance");
const editDurationInput = document.getElementById("editDuration");
const editDeadlineInput = document.getElementById("editDeadline");

const pillEditPending = document.getElementById("pillEditPending");
const pillEditParallel = document.getElementById("pillEditParallel");
const cbEditPending = document.getElementById("editIsPending");
const cbEditParallel = document.getElementById("editIsParallel");

const cancelEditBtn = document.getElementById("cancelEditBtn");

function openEditModal(task) {
  if (!currentUid) {
    alert("Please sign in first.");
    return;
  }

  currentEditingTaskId = task.id;

  editTitleInput.value = task.title || "";
  editDescriptionInput.value = task.description || "";
  editImportanceInput.value = task.importance ?? "";
  editDurationInput.value = task.duration ?? "";

  if (task.deadlineAt) {
    const d = new Date(task.deadlineAt);
    const isoLocal = new Date(
      d.getTime() - d.getTimezoneOffset() * 60000
    )
      .toISOString()
      .slice(0, 16);
    editDeadlineInput.value = isoLocal;
  } else {
    editDeadlineInput.value = "";
  }

  const isPending = !!task.isPending;
  const isParallel = !!task.isParallel;

  cbEditPending.checked = isPending;
  cbEditParallel.checked = isParallel;

  pillEditPending.classList.toggle("active", isPending);
  pillEditParallel.classList.toggle("active", isParallel);

  editTaskModal.classList.add("active");
}

function closeEditModal() {
  editTaskModal.classList.remove("active");
  currentEditingTaskId = null;
  editTaskForm.reset();
  pillEditPending.classList.remove("active");
  pillEditParallel.classList.remove("active");
  cbEditPending.checked = false;
  cbEditParallel.checked = false;
}

pillEditPending.addEventListener("click", () => {
  pillEditPending.classList.toggle("active");
  cbEditPending.checked = pillEditPending.classList.contains("active");
});

pillEditParallel.addEventListener("click", () => {
  pillEditParallel.classList.toggle("active");
  cbEditParallel.checked =
    pillEditParallel.classList.contains("active");
});

cancelEditBtn.addEventListener("click", () => {
  closeEditModal();
});

editTaskModal.addEventListener("click", (e) => {
  if (e.target === editTaskModal) {
    closeEditModal();
  }
});

editTaskForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentUid || !currentEditingTaskId) return;

  const title = editTitleInput.value.trim();
  const description =
    editDescriptionInput.value.trim();
  const importance = Number(editImportanceInput.value);
  const duration = Number(editDurationInput.value);
  const deadlineStr = editDeadlineInput.value;

  if (!title) {
    alert("Task title cannot be empty.");
    return;
  }
  if (!deadlineStr) {
    alert("Please provide a valid deadline.");
    return;
  }
  if (!duration || duration <= 0) {
    alert("Duration must be greater than 0.");
    return;
  }

  let deadlineAt = null;
  if (deadlineStr) {
    const d = new Date(deadlineStr);
    deadlineAt = d.toISOString();
  }

  const isPending = cbEditPending.checked;
  const isParallel = cbEditParallel.checked;

  const docRef = doc(
    db,
    "users",
    currentUid,
    "mainTasks",
    currentEditingTaskId
  );

  try {
    await updateDoc(docRef, {
      title,
      description,
      importance,
      duration,
      deadlineAt,
      isPending,
      isParallel,
      updatedAt: serverTimestamp()
    });

    closeEditModal();
    await loadMainTasks();
  } catch (err) {
    console.error("Error saving edited task:", err);
    alert("Unable to save changes. Please check the console.");
  }
});

// ===================================================
// DUPLICATE MODAL & LOGIC
// ===================================================
const duplicateModal = document.getElementById("duplicateModal");
const duplicateCancelBtn = document.getElementById(
  "duplicateCancelBtn"
);
const duplicateOptionButtons = document.querySelectorAll(
  ".duplicate-option-btn"
);

const DuplicateModal = {
  open(task) {
    if (!currentUid) {
      alert("Please sign in first.");
      return;
    }
    currentDuplicateTask = task;
    duplicateModal.classList.add("active");
  },
  close() {
    duplicateModal.classList.remove("active");
    currentDuplicateTask = null;
  }
};

duplicateCancelBtn.addEventListener("click", () => {
  DuplicateModal.close();
});

duplicateModal.addEventListener("click", (e) => {
  if (e.target === duplicateModal) {
    DuplicateModal.close();
  }
});

function computeNewDeadline(oldIso, mode) {
  if (!oldIso) {
    return null;
  }

  const d = new Date(oldIso);
  if (isNaN(d)) return null;

  if (mode === "keep") {
    return oldIso;
  }

  if (mode === "plus7") {
    d.setDate(d.getDate() + 7);
    return d.toISOString();
  }

  if (mode === "plus1M") {
    const day = d.getDate();
    d.setMonth(d.getMonth() + 1);
    if (d.getDate() < day) {
      d.setDate(0);
    }
    return d.toISOString();
  }

  if (mode === "empty") {
    return null;
  }

  return oldIso;
}

async function duplicateMainTask(task, mode) {
  if (!currentUid) {
    alert("Please sign in first.");
    return;
  }

  const deadlineAt = computeNewDeadline(task.deadlineAt, mode);

  const base = {
    title: task.title || "",
    description: task.description || "",
    importance: task.importance ?? 0,
    duration: task.duration ?? 0,
    isPending: !!task.isPending,
    isParallel: !!task.isParallel,
    deadlineAt
  };

  const now = new Date();
  const createdAtLocal = now.toISOString();
  const taskId = await getNextCounter("mainTaskCount", currentUid);

  const payload = {
    ...base,
    taskId,
    status: "active",
    createdAtLocal,
    createdAt: serverTimestamp()
  };

  await addDoc(collection(db, "users", currentUid, "mainTasks"), payload);
  await loadMainTasks();
}

duplicateOptionButtons.forEach((btn) => {
  btn.addEventListener("click", async () => {
    const mode = btn.dataset.mode;
    if (!currentDuplicateTask) {
      DuplicateModal.close();
      return;
    }
    try {
      await duplicateMainTask(currentDuplicateTask, mode);
    } catch (err) {
      console.error("Error duplicating task:", err);
      alert("Unable to duplicate this task.");
    } finally {
      DuplicateModal.close();
    }
  });
});

// ===================================================
// MAIN TASK ACTIONS
// ===================================================
const TaskActions = {
  async setStatus(task, status) {
    if (!currentUid) {
      alert("Please sign in first.");
      return;
    }
    const docRef = doc(
      db,
      "users",
      currentUid,
      "mainTasks",
      task.id
    );

    const confirmMsg =
      status === "done"
        ? "Mark this task as DONE?"
        : "Move this task back to ACTIVE?";

    if (!confirm(confirmMsg)) return;

    try {
      await updateDoc(docRef, { status, updatedAt: serverTimestamp() });
      await loadMainTasks();
    } catch (err) {
      console.error("Error updating status:", err);
      alert("Unable to update task status.");
    }
  },

  async delete(task) {
    if (!currentUid) {
      alert("Please sign in first.");
      return;
    }
    const docRef = doc(
      db,
      "users",
      currentUid,
      "mainTasks",
      task.id
    );

    if (!confirm("Delete this task? This cannot be undone.")) return;

    try {
      await deleteDoc(docRef);
      await loadMainTasks();
    } catch (err) {
      console.error("Error deleting task:", err);
      alert("Unable to delete this task.");
    }
  },

  openEdit(task) {
    openEditModal(task);
  },

  openDuplicate(task) {
    DuplicateModal.open(task);
  }
};

// ===================================================
// MAIN TASKS – CREATE
// ===================================================
document
  .getElementById("mainTaskForm")
  .addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentUid) {
      alert("Please sign in before adding tasks.");
      return;
    }

    const title = document.getElementById("mainTitle").value.trim();
    const description =
      document.getElementById("mainDescription").value.trim();
    const importance = Number(
      document.getElementById("mainImportance").value
    );
    const duration = Number(
      document.getElementById("mainDuration").value
    );
    const deadlineStr =
      document.getElementById("mainDeadline").value;

    const isPending = cbMainPending.checked;
    const isParallel = cbMainParallel.checked;

    if (!title) {
      alert("Task title cannot be empty.");
      return;
    }
    if (!deadlineStr) {
      alert("Please provide a valid deadline.");
      return;
    }
    if (!duration || duration <= 0) {
      alert("Duration must be greater than 0.");
      return;
    }

    let deadlineAt = null;
    if (deadlineStr) {
      const d = new Date(deadlineStr);
      deadlineAt = d.toISOString();
    }

    const now = new Date();
    const createdAtLocal = now.toISOString();

    try {
      const taskId = await getNextCounter("mainTaskCount", currentUid);

      await addDoc(collection(db, "users", currentUid, "mainTasks"), {
        taskId,
        title,
        description,
        importance,
        duration,
        deadlineAt,
        isPending,
        isParallel,
        status: "active",
        createdAtLocal,
        createdAt: serverTimestamp()
      });

      e.target.reset();
      pillMainPending.classList.remove("active");
      pillMainParallel.classList.remove("active");
      cbMainPending.checked = false;
      cbMainParallel.checked = false;

      await loadMainTasks();
    } catch (err) {
      console.error("Error adding main task:", err);
      alert("Unable to create main task. Please check the console.");
    }
  });

// ===================================================
// BASE PRIORITY HELPER
// ===================================================
function computeBasePriorityForTask(task, nowMs) {
  const now = nowMs || Date.now();

  let minutesLeft;
  if (task.deadlineAt) {
    const d = new Date(task.deadlineAt);
    const diffMs = d.getTime() - now;
    minutesLeft = diffMs <= 0 ? 1 : Math.max(1, Math.round(diffMs / 60000));
  } else if (typeof task.deadline === "number") {
    minutesLeft = Math.max(1, task.deadline);
  } else {
    minutesLeft = Infinity;
  }

  const duration = Number(task.duration) || 0;
  const FORTY_EIGHT_HOURS_MIN = 48 * 60;

  const isShortBoost =
    duration <= 10 && minutesLeft <= FORTY_EIGHT_HOURS_MIN;

  const ratio =
    minutesLeft === Infinity || minutesLeft <= 0
      ? 0
      : duration / minutesLeft;

  const boostedRatio = isShortBoost ? ratio * 2 : ratio;

  task._minutesLeft = minutesLeft;
  task._priority = ratio;
  task._isShortBoost = isShortBoost;
  task._basePriority = boostedRatio;

  return boostedRatio;
}

// ===================================================
// MAIN TASKS – LOAD & SORT
// ===================================================
async function loadMainTasks() {
  const list = document.getElementById("mainTaskList");
  if (!currentUid) {
    if (list) {
      list.innerHTML =
        '<p class="task-meta">Sign in to see your main tasks.</p>';
    }
    mainTasksCache = [];
    slotAssignments = null;
    renderMainTasksOnTimeline();
    return;
  }

  const snap = await getDocs(
    collection(db, "users", currentUid, "mainTasks")
  );
  const items = [];
  snap.forEach((docSnap) => items.push({ id: docSnap.id, ...docSnap.data() }));

  const nowMs = Date.now();
  items.forEach((task) => {
    computeBasePriorityForTask(task, nowMs);
    task.status = task.status || "active";
  });

  items.sort((a, b) => {
    if (a.status === "active" && b.status !== "active") return -1;
    if (a.status !== "active" && b.status === "active") return 1;

    if (a._isShortBoost && !b._isShortBoost) return -1;
    if (!a._isShortBoost && b._isShortBoost) return 1;

    const pa = a._priority || 0;
    const pb = b._priority || 0;
    return pb - pa;
  });

  mainTasksCache = items;

  list.innerHTML = "";

  items.forEach((task) => {
    const div = document.createElement("div");
    div.className = "task-item task-item-main";
    if (task.status === "done") {
      div.classList.add("task-item-done");
    }

    const idText =
      typeof task.taskId === "number" ? `#${task.taskId} ` : "";
    const deadlineText = task.deadlineAt
      ? new Date(task.deadlineAt).toLocaleString()
      : "N/A";

    const minutesText =
      task._minutesLeft === Infinity
        ? "N/A"
        : `${task._minutesLeft} minutes left`;
    const ratioText = isFinite(task._priority)
      ? task._priority.toFixed(3)
      : "N/A";
    const boostedText = isFinite(task._basePriority)
      ? task._basePriority.toFixed(3)
      : "N/A";

    const statusLabel = task.status === "done" ? "DONE" : "ACTIVE";
    const createdText = formatLocalDateTime(task.createdAtLocal);

    const headerHtml = `
      <h4>${idText}${task.title}</h4>
      <p>${task.description || ""}</p>
      <p class="task-meta">
        Importance: ${task.importance} · Duration: ${task.duration} min
      </p>
      <p class="task-meta">
        Deadline: ${deadlineText} · Time remaining: ${minutesText}
      </p>
      <p class="task-meta">
        Created: ${createdText}
      </p>
      <p class="task-meta">
        Status: ${statusLabel} ·
        Short boost: ${task._isShortBoost ? "Yes" : "No"} ·
        Raw ratio: ${ratioText} ·
        Base priority: ${boostedText} ·
        Parallel: ${task.isParallel ? "Yes" : "No"} ·
        Pending: ${task.isPending ? "Yes" : "No"}
      </p>
    `;

    div.innerHTML = headerHtml;

    const actionsDiv = document.createElement("div");
    actionsDiv.className = "task-actions";

    const editBtn = document.createElement("button");
    editBtn.className = "task-btn";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      TaskActions.openEdit(task);
    });

    const duplicateBtn = document.createElement("button");
    duplicateBtn.className = "task-btn";
    duplicateBtn.textContent = "Duplicate";
    duplicateBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      TaskActions.openDuplicate(task);
    });

    const doneBtn = document.createElement("button");
    doneBtn.className = "task-btn task-btn-primary";
    doneBtn.textContent =
      task.status === "done" ? "Mark as active" : "Mark as done";
    doneBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const newStatus = task.status === "done" ? "active" : "done";
      TaskActions.setStatus(task, newStatus);
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "task-btn task-btn-danger";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      TaskActions.delete(task);
    });

    actionsDiv.appendChild(editBtn);
    actionsDiv.appendChild(duplicateBtn);
    actionsDiv.appendChild(doneBtn);
    actionsDiv.appendChild(deleteBtn);

    div.appendChild(actionsDiv);
    list.appendChild(div);
  });

  recomputeMainSchedule();
}

// ===================================================
// REPEAT ENGINE – BACKGROUND TASKS
// ===================================================
function parseTimeToMinutes(t) {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

function getDayCode(date) {
  const idx = date.getDay();
  const map = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  return map[idx];
}

function generateSegmentsForDate(task, baseDate) {
  const startMinutes = parseTimeToMinutes(task.startTime);
  const endMinutes = parseTimeToMinutes(task.endTime);
  if (startMinutes == null || endMinutes == null) return [];

  const dateISO = baseDate.toISOString().slice(0, 10);
  const segments = [];

  if (endMinutes > startMinutes) {
    segments.push({
      date: dateISO,
      startMinutes,
      endMinutes,
      parentId: task.id,
      title: task.title || "",
      isOvernight: false
    });
  } else if (endMinutes < startMinutes) {
    segments.push({
      date: dateISO,
      startMinutes,
      endMinutes: 24 * 60,
      parentId: task.id,
      title: task.title || "",
      isOvernight: true
    });

    const nextDate = new Date(baseDate.getTime() + MS_PER_DAY);
    const nextISO = nextDate.toISOString().slice(0, 10);
    segments.push({
      date: nextISO,
      startMinutes: 0,
      endMinutes,
      parentId: task.id,
      title: task.title || "",
      isOvernight: true
    });
  }

  return segments;
}

function generateBackgroundInstances(task, rangeStart, rangeEnd) {
  const instances = [];
  const repeatType = task.repeatType || "none";

  if (repeatType === "none") {
    if (!task.specificDate) return instances;
    const d = new Date(task.specificDate + "T00:00:00");
    if (d >= rangeStart && d < rangeEnd) {
      instances.push(...generateSegmentsForDate(task, d));
    }
    return instances;
  }

  for (let i = 0; i < DAYS_TOTAL; i++) {
    const d = new Date(rangeStart.getTime() + i * MS_PER_DAY);
    if (d < rangeStart || d >= rangeEnd) continue;

    if (repeatType === "daily") {
      instances.push(...generateSegmentsForDate(task, d));
    } else if (repeatType === "weekly") {
      const dayCode = getDayCode(d);
      const repeatDays = task.repeatDays || [];
      if (repeatDays.includes(dayCode)) {
        instances.push(...generateSegmentsForDate(task, d));
      }
    } else if (repeatType === "monthly") {
      const rDate = task.repeatDate;
      if (!rDate) continue;
      if (d.getDate() === rDate) {
        instances.push(...generateSegmentsForDate(task, d));
      }
    }
  }

  return instances;
}

// ===================================================
// AVAILABILITY ENGINE (10-MINUTE SLOTS)
// ===================================================
function buildAvailabilitySlots() {
  availabilitySlots = [];
  const slotMs = SLOT_MINUTES * 60000;

  for (let d = 0; d < DAYS_TOTAL; d++) {
    const daySlots = [];
    for (let s = 0; s < SLOTS_PER_DAY; s++) {
      const startTime = new Date(
        startOfToday.getTime() + d * MS_PER_DAY + s * slotMs
      );
      const endTime = new Date(startTime.getTime() + slotMs);
      daySlots.push({
        startTime,
        endTime,
        hasParallelBg: false,
        hasNonParallelBg: false,
        type: 1,
        availabilityFactor: 1.0
      });
    }
    availabilitySlots.push(daySlots);
  }

  if (!backgroundTasksCache || backgroundTasksCache.length === 0) {
    return;
  }

  const rangeStart = startOfToday;
  const rangeEnd = new Date(startOfToday.getTime() + DAYS_TOTAL * MS_PER_DAY);

  backgroundTasksCache.forEach((task) => {
    const segments = generateBackgroundInstances(task, rangeStart, rangeEnd);
    const isParallel = !!task.isParallel;

    segments.forEach((seg) => {
      const dateObj = new Date(seg.date + "T00:00:00");
      const diffDays = Math.round((dateObj - startOfToday) / MS_PER_DAY);
      if (diffDays < 0 || diffDays >= DAYS_TOTAL) return;
      const dayIndex = diffDays;

      const startSlotIndex = Math.floor(seg.startMinutes / SLOT_MINUTES);
      const endSlotIndex = Math.ceil(seg.endMinutes / SLOT_MINUTES);

      for (
        let s = startSlotIndex;
        s < endSlotIndex && s < SLOTS_PER_DAY;
        s++
      ) {
        const slot = availabilitySlots[dayIndex][s];
        if (isParallel) slot.hasParallelBg = true;
        else slot.hasNonParallelBg = true;
      }
    });
  });

  for (let d = 0; d < DAYS_TOTAL; d++) {
    for (let s = 0; s < SLOTS_PER_DAY; s++) {
      const slot = availabilitySlots[d][s];
      if (slot.hasNonParallelBg) {
        slot.type = 3;
        slot.availabilityFactor = 0.0;
      } else if (slot.hasParallelBg) {
        slot.type = 2;
        slot.availabilityFactor = 0.7;
      } else {
        slot.type = 1;
        slot.availabilityFactor = 1.0;
      }
    }
  }
}

// Placeholder for ONLY/PREFER factor (currently not wired to UI)
function computeOnlyPreferFactor(task, slotStart) {
  // When ONLY/PREFER fields are added to the task, implement:
  // - ONLY: in-window => 1.5, out-of-window => 0
  // - PREFER: in-window => 1.5, out-of-window => 1.0
  // For now, neutral.
  return 1.0;
}

// ===================================================
// RENDER BACKGROUND BLOCKS ON TIMELINE
// ===================================================
function renderBackgroundOnTimeline() {
  if (!laneBackgroundContent) return;
  laneBackgroundContent.innerHTML = "";

  if (!backgroundTasksCache || backgroundTasksCache.length === 0) return;

  const rangeStart = startOfToday;
  const rangeEnd = new Date(startOfToday.getTime() + DAYS_TOTAL * MS_PER_DAY);

  backgroundTasksCache.forEach((task) => {
    const segments = generateBackgroundInstances(
      task,
      rangeStart,
      rangeEnd
    );
    segments.forEach((seg) => {
      const dateObj = new Date(seg.date + "T00:00:00");
      const diffDays = (dateObj - startOfToday) / MS_PERDAY;
    });
  });
}

// (Fix small typo: MS_PERDAY) – re-implement correctly:

function renderBackgroundOnTimeline() {
  if (!laneBackgroundContent) return;
  laneBackgroundContent.innerHTML = "";

  if (!backgroundTasksCache || backgroundTasksCache.length === 0) return;

  const rangeStart = startOfToday;
  const rangeEnd = new Date(startOfToday.getTime() + DAYS_TOTAL * MS_PER_DAY);

  backgroundTasksCache.forEach((task) => {
    const segments = generateBackgroundInstances(
      task,
      rangeStart,
      rangeEnd
    );
    segments.forEach((seg) => {
      const dateObj = new Date(seg.date + "T00:00:00");
      const diffDays = (dateObj - startOfToday) / MS_PER_DAY;
      if (diffDays < 0 || diffDays >= DAYS_TOTAL) return;

      const dayIndex = diffDays;
      const totalHoursOffset =
        dayIndex * 24 + seg.startMinutes / 60;
      const hoursWidth = (seg.endMinutes - seg.startMinutes) / 60;

      if (hoursWidth <= 0) return;

      const block = document.createElement("div");
      block.className = "timeline-bg-block";
      block.style.left = totalHoursOffset * pixelsPerHour + "px";
      block.style.width = hoursWidth * pixelsPerHour + "px";
      block.textContent = seg.title || "(background)";

      laneBackgroundContent.appendChild(block);
    });
  });
}

// ===================================================
// SIMPLE SCHEDULER FOR MAIN TASKS (AUTO-SPLIT)
// ===================================================
function recomputeMainSchedule() {
  if (!availabilitySlots) {
    buildAvailabilitySlots();
  }
  if (!availabilitySlots) return;

  slotAssignments = [];
  for (let d = 0; d < DAYS_TOTAL; d++) {
    slotAssignments[d] = new Array(SLOTS_PER_DAY).fill(null);
  }

  if (!mainTasksCache || mainTasksCache.length === 0) {
    renderMainTasksOnTimeline();
    return;
  }

  const nowMs = Date.now();

  const activeTasks = mainTasksCache.filter(
    (t) => t.status === "active" && !t.isPending
  );

  // we assume mainTasksCache already sorted by priority
  activeTasks.forEach((task) => {
    let remainingMinutes = Number(task.duration) || 0;
    if (remainingMinutes <= 0) return;

    let deadlineMs = null;
    if (task.deadlineAt) {
      const d = new Date(task.deadlineAt);
      if (!isNaN(d)) {
        deadlineMs = d.getTime();
      }
    }

    for (let d = 0; d < DAYS_TOTAL && remainingMinutes > 0; d++) {
      for (
        let s = 0;
        s < SLOTS_PER_DAY && remainingMinutes > 0;
        s++
      ) {
        const slot = availabilitySlots[d][s];
        const slotStartMs = slot.startTime.getTime();

        if (slotStartMs < nowMs) continue;
        if (deadlineMs && slotStartMs > deadlineMs) continue;

        if (slot.type === 3) continue;
        if (slot.type === 2 && !task.isParallel) continue;

        if (slotAssignments[d][s]) continue;

        const onlyPreferFactor = computeOnlyPreferFactor(
          task,
          slot.startTime
        );
        if (onlyPreferFactor === 0) continue;

        const allocMinutes = Math.min(SLOT_MINUTES, remainingMinutes);

        slotAssignments[d][s] = {
          taskId: task.id,
          taskRef: task
        };

        remainingMinutes -= allocMinutes;
      }
    }
  });

  renderMainTasksOnTimeline();
}

function renderMainTasksOnTimeline() {
  if (!laneMainContent) return;
  laneMainContent.innerHTML = "";

  if (!slotAssignments) return;

  const HOURS_TOTAL = DAYS_TOTAL * 24;

  const totalSlots = TOTAL_SLOTS;
  let prevAssignment = null;
  let blockStartGlobalIndex = null;

  const createBlock = (task, startGlobalIndex, endGlobalIndex) => {
    if (!task) return;
    const slotsCount = endGlobalIndex - startGlobalIndex;
    if (slotsCount <= 0) return;

    const startDayIndex = Math.floor(startGlobalIndex / SLOTS_PER_DAY);
    const startSlotIndex = startGlobalIndex % SLOTS_PER_DAY;

    const hourOffset =
      startDayIndex * 24 + (startSlotIndex * SLOT_MINUTES) / 60;
    const hoursWidth = (slotsCount * SLOT_MINUTES) / 60;

    const block = document.createElement("div");
    block.className = "timeline-main-block";
    block.style.left = hourOffset * pixelsPerHour + "px";
    block.style.width = hoursWidth * pixelsPerHour + "px";
    block.textContent = task.title;

    laneMainContent.appendChild(block);
  };

  for (let globalIndex = 0; globalIndex <= totalSlots; globalIndex++) {
    let current = null;
    if (globalIndex < totalSlots) {
      const dayIndex = Math.floor(globalIndex / SLOTS_PER_DAY);
      const slotIndex = globalIndex % SLOTS_PER_DAY;
      current = slotAssignments[dayIndex][slotIndex];
    }

    const sameTask =
      prevAssignment &&
      current &&
      current.taskId === prevAssignment.taskId;

    if (!sameTask) {
      if (prevAssignment && blockStartGlobalIndex != null) {
        createBlock(
          prevAssignment.taskRef,
          blockStartGlobalIndex,
          globalIndex
        );
      }
      if (current) {
        blockStartGlobalIndex = globalIndex;
      } else {
        blockStartGlobalIndex = null;
      }
    }
    prevAssignment = current;
  }
}

// ===================================================
// BACKGROUND TASKS – CREATE
// ===================================================
document
  .getElementById("backgroundTaskForm")
  .addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentUid) {
      alert("Please sign in before adding background tasks.");
      return;
    }

    const title = document.getElementById("bgTitle").value.trim();
    const description =
      document.getElementById("bgDescription").value.trim();
    const startTime = document.getElementById("bgStartTime").value;
    const endTime = document.getElementById("bgEndTime").value;
    const isParallel = cbBgParallel.checked;

    if (!title) {
      alert("Background task title cannot be empty.");
      return;
    }
    if (!startTime || !endTime) {
      alert("Please provide valid start and end times.");
      return;
    }

    const repeatTypeInput = document.querySelector(
      'input[name="bgRepeatType"]:checked'
    );
    const repeatType = repeatTypeInput ? repeatTypeInput.value : "none";

    let repeatDays = [];
    let repeatDate = null;
    let specificDate = null;

    if (repeatType === "none") {
      specificDate = bgSpecificDateInput.value;
      if (!specificDate) {
        alert("Please select an exact date for this non-repeating task.");
        return;
      }
    } else if (repeatType === "weekly") {
      const activePills = Array.from(
        bgWeeklyPillsContainer.querySelectorAll(".pill-toggle.active")
      );
      repeatDays = activePills.map((p) => p.getAttribute("data-day"));
      if (repeatDays.length === 0) {
        alert("Please choose at least one weekday for the weekly pattern.");
        return;
      }
    } else if (repeatType === "monthly") {
      repeatDate = Number(bgRepeatDateInput.value);
      if (!repeatDate || repeatDate < 1 || repeatDate > 31) {
        alert("Day of month must be between 1 and 31.");
        return;
      }
    }

    const now = new Date();
    const createdAtLocal = now.toISOString();

    try {
      const taskId = await getNextCounter(
        "backgroundTaskCount",
        currentUid
      );

      await addDoc(
        collection(db, "users", currentUid, "backgroundTasks"),
        {
          taskId,
          title,
          description,
          startTime,
          endTime,
          isParallel,
          repeatType,
          repeatDays,
          repeatDate,
          specificDate,
          createdAtLocal,
          createdAt: serverTimestamp()
        }
      );

      e.target.reset();
      pillBgParallel.classList.remove("active");
      cbBgParallel.checked = false;

      bgRepeatRadios.forEach((r) => {
        r.checked = false;
      });
      const noneRadio = document.querySelector(
        'input[name="bgRepeatType"][value="none"]'
      );
      if (noneRadio) noneRadio.checked = true;
      bgSpecificDateRow.classList.remove("hidden");
      bgWeeklyRow.classList.add("hidden");
      bgMonthlyRow.classList.add("hidden");
      bgWeeklyPillsContainer
        .querySelectorAll(".pill-toggle")
        .forEach((p) => p.classList.remove("active"));
      bgRepeatDateInput.value = "";
      bgSpecificDateInput.value = "";

      await loadBackgroundTasks();
    } catch (err) {
      console.error("Error adding background task:", err);
      alert("Unable to create background task. Please check the console.");
    }
  });

// ===================================================
// EDIT BACKGROUND TASK MODAL
// ===================================================
const editBgTaskModal = document.getElementById("editBgTaskModal");
const editBgTaskForm = document.getElementById("editBgTaskForm");

const editBgTitleInput = document.getElementById("editBgTitle");
const editBgDescriptionInput = document.getElementById(
  "editBgDescription"
);
const editBgStartTimeInput = document.getElementById("editBgStartTime");
const editBgEndTimeInput = document.getElementById("editBgEndTime");

const editBgSpecificDateRow = document.getElementById(
  "editBgSpecificDateRow"
);
const editBgWeeklyRow = document.getElementById("editBgWeeklyRow");
const editBgMonthlyRow = document.getElementById("editBgMonthlyRow");

const editBgSpecificDateInput = document.getElementById(
  "editBgSpecificDate"
);
const editBgWeeklyPillsContainer = document.getElementById(
  "editBgWeeklyPills"
);
const editBgRepeatDateInput = document.getElementById(
  "editBgRepeatDate"
);
const editBgRepeatRadios = document.querySelectorAll(
  'input[name="editBgRepeatType"]'
);

const pillEditBgParallel = document.getElementById("pillEditBgParallel");
const cbEditBgParallel = document.getElementById("editBgIsParallel");
const cancelEditBgBtn = document.getElementById("cancelEditBgBtn");

editBgRepeatRadios.forEach((r) => {
  r.addEventListener("change", () => {
    const value = r.value;
    if (!r.checked) return;

    editBgSpecificDateRow.classList.add("hidden");
    editBgWeeklyRow.classList.add("hidden");
    editBgMonthlyRow.classList.add("hidden");

    if (value === "none") {
      editBgSpecificDateRow.classList.remove("hidden");
    } else if (value === "weekly") {
      editBgWeeklyRow.classList.remove("hidden");
    } else if (value === "monthly") {
      editBgMonthlyRow.classList.remove("hidden");
    }
  });
});

editBgWeeklyPillsContainer
  .querySelectorAll(".pill-toggle")
  .forEach((pill) => {
    pill.addEventListener("click", () => {
      pill.classList.toggle("active");
    });
  });

pillEditBgParallel.addEventListener("click", () => {
  pillEditBgParallel.classList.toggle("active");
  cbEditBgParallel.checked =
    pillEditBgParallel.classList.contains("active");
});

function openBgEditModal(task) {
  if (!currentUid) {
    alert("Please sign in first.");
    return;
  }

  currentEditingBgTaskId = task.id;

  editBgTitleInput.value = task.title || "";
  editBgDescriptionInput.value = task.description || "";
  editBgStartTimeInput.value = task.startTime || "";
  editBgEndTimeInput.value = task.endTime || "";

  const repeatType = task.repeatType || "none";

  editBgRepeatRadios.forEach((r) => {
    r.checked = r.value === repeatType;
  });

  editBgSpecificDateRow.classList.add("hidden");
  editBgWeeklyRow.classList.add("hidden");
  editBgMonthlyRow.classList.add("hidden");

  if (repeatType === "none") {
    editBgSpecificDateRow.classList.remove("hidden");
    editBgSpecificDateInput.value = task.specificDate || "";
  } else if (repeatType === "weekly") {
    editBgWeeklyRow.classList.remove("hidden");
    editBgWeeklyPillsContainer
      .querySelectorAll(".pill-toggle")
      .forEach((p) => {
        const day = p.getAttribute("data-day");
        const active = (task.repeatDays || []).includes(day);
        p.classList.toggle("active", active);
      });
  } else if (repeatType === "monthly") {
    editBgMonthlyRow.classList.remove("hidden");
    editBgRepeatDateInput.value = task.repeatDate || "";
  }

  const isParallel = !!task.isParallel;
  cbEditBgParallel.checked = isParallel;
  pillEditBgParallel.classList.toggle("active", isParallel);

  editBgTaskModal.classList.add("active");
}

function closeBgEditModal() {
  editBgTaskModal.classList.remove("active");
  currentEditingBgTaskId = null;
  editBgTaskForm.reset();
  editBgRepeatRadios.forEach((r) => {
    r.checked = false;
  });
  editBgWeeklyPillsContainer
    .querySelectorAll(".pill-toggle")
    .forEach((p) => p.classList.remove("active"));
  editBgSpecificDateRow.classList.add("hidden");
  editBgWeeklyRow.classList.add("hidden");
  editBgMonthlyRow.classList.add("hidden");
  pillEditBgParallel.classList.remove("active");
  cbEditBgParallel.checked = false;
}

cancelEditBgBtn.addEventListener("click", () => {
  closeBgEditModal();
});

editBgTaskModal.addEventListener("click", (e) => {
  if (e.target === editBgTaskModal) {
    closeBgEditModal();
  }
});

editBgTaskForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentUid || !currentEditingBgTaskId) return;

  const title = editBgTitleInput.value.trim();
  const description =
    editBgDescriptionInput.value.trim();
  const startTime = editBgStartTimeInput.value;
  const endTime = editBgEndTimeInput.value;
  const isParallel = cbEditBgParallel.checked;

  if (!title) {
    alert("Background task title cannot be empty.");
    return;
  }
  if (!startTime || !endTime) {
    alert("Please provide valid start and end times.");
    return;
  }

  const repeatTypeInput = Array.from(editBgRepeatRadios).find(
    (r) => r.checked
  );
  const repeatType = repeatTypeInput ? repeatTypeInput.value : "none";

  let repeatDays = [];
  let repeatDate = null;
  let specificDate = null;

  if (repeatType === "none") {
    specificDate = editBgSpecificDateInput.value;
    if (!specificDate) {
      alert("Please select an exact date for this non-repeating task.");
      return;
    }
  } else if (repeatType === "weekly") {
    const activePills = Array.from(
      editBgWeeklyPillsContainer.querySelectorAll(".pill-toggle.active")
    );
    repeatDays = activePills.map((p) => p.getAttribute("data-day"));
    if (repeatDays.length === 0) {
      alert("Please choose at least one weekday for the weekly pattern.");
      return;
    }
  } else if (repeatType === "monthly") {
    repeatDate = Number(editBgRepeatDateInput.value);
    if (!repeatDate || repeatDate < 1 || repeatDate > 31) {
      alert("Day of month must be between 1 and 31.");
      return;
    }
  }

  const docRef = doc(
    db,
    "users",
    currentUid,
    "backgroundTasks",
    currentEditingBgTaskId
  );

  try {
    await updateDoc(docRef, {
      title,
      description,
      startTime,
      endTime,
      isParallel,
      repeatType,
      repeatDays,
      repeatDate,
      specificDate,
      updatedAt: serverTimestamp()
    });

    closeBgEditModal();
    await loadBackgroundTasks();
  } catch (err) {
    console.error("Error updating background task:", err);
    alert("Unable to save changes for this background task.");
  }
});

// ===================================================
// BACKGROUND TASK ACTIONS
// ===================================================
const BackgroundActions = {
  openEdit(task) {
    openBgEditModal(task);
  },

  async delete(task) {
    if (!currentUid) {
      alert("Please sign in first.");
      return;
    }

    if (
      !confirm("Delete this background task? This cannot be undone.")
    )
      return;

    const docRef = doc(
      db,
      "users",
      currentUid,
      "backgroundTasks",
      task.id
    );

    try {
      await deleteDoc(docRef);
      await loadBackgroundTasks();
    } catch (err) {
      console.error("Error deleting background task:", err);
      alert("Unable to delete this background task.");
    }
  }
};

function formatRepeatSummary(task) {
  const type = task.repeatType || "none";
  if (type === "daily") return "Repeat: daily";

  if (type === "weekly") {
    const mapLabel = {
      mon: "Mon",
      tue: "Tue",
      wed: "Wed",
      thu: "Thu",
      fri: "Fri",
      sat: "Sat",
      sun: "Sun"
    };
    const days = (task.repeatDays || [])
      .map((d) => mapLabel[d] || d)
      .join(", ");
    return "Repeat: weekly (" + (days || "no days") + ")";
  }

  if (type === "monthly") {
    return `Repeat: day ${task.repeatDate} of every month`;
  }

  if (task.specificDate) {
    return "Single date: " + task.specificDate;
  }

  return "No repeat pattern";
}

// ===================================================
// BACKGROUND TASKS – LOAD
// ===================================================
async function loadBackgroundTasks() {
  const list = document.getElementById("backgroundTaskList");
  if (!currentUid) {
    if (list) {
      list.innerHTML =
        '<p class="task-meta">Sign in to see your background tasks.</p>';
    }
    backgroundTasksCache = [];
    buildAvailabilitySlots();
    renderBackgroundOnTimeline();
    recomputeMainSchedule();
    return;
  }

  const snap = await getDocs(
    collection(db, "users", currentUid, "backgroundTasks")
  );
  const items = [];
  snap.forEach((docSnap) => items.push({ id: docSnap.id, ...docSnap.data() }));

  items.sort((a, b) =>
    (a.startTime || "").localeCompare(b.startTime || "")
  );

  backgroundTasksCache = items;
  buildAvailabilitySlots();
  renderBackgroundOnTimeline();
  recomputeMainSchedule();

  list.innerHTML = "";

  items.forEach((task) => {
    const div = document.createElement("div");
    div.className = "task-item task-item-bg";

    const idText =
      typeof task.taskId === "number" ? `#${task.taskId} ` : "";
    const repeatText = formatRepeatSummary(task);
    const createdText = formatLocalDateTime(task.createdAtLocal);

    div.innerHTML = `
      <h4>${idText}${task.title}</h4>
      <p>${task.description || ""}</p>
      <p class="task-meta">
        ${task.startTime} – ${task.endTime} ·
        Parallel: ${task.isParallel ? "Yes" : "No"}
      </p>
      <p class="task-meta">${repeatText}</p>
      <p class="task-meta">Created: ${createdText}</p>
    `;

    const actionsDiv = document.createElement("div");
    actionsDiv.className = "task-actions";

    const editBtn = document.createElement("button");
    editBtn.className = "task-btn";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      BackgroundActions.openEdit(task);
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "task-btn task-btn-danger";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      BackgroundActions.delete(task);
    });

    actionsDiv.appendChild(editBtn);
    actionsDiv.appendChild(deleteBtn);
    div.appendChild(actionsDiv);

    list.appendChild(div);
  });
}

// ===================================================
// DEBUG AVAILABILITY UI
// ===================================================
const debugDaySelect = document.getElementById("debugDaySelect");
const renderDebugBtn = document.getElementById("renderDebugBtn");
const availabilityDebugGrid = document.getElementById(
  "availabilityDebugGrid"
);

function renderAvailabilityDebug(dayIndex) {
  if (!availabilityDebugGrid) return;

  if (!availabilitySlots) {
    availabilityDebugGrid.innerHTML =
      '<p class="task-meta">No availability data yet. Add background tasks or reload.</p>';
    return;
  }

  if (dayIndex < 0 || dayIndex >= DAYS_TOTAL) dayIndex = 0;

  const slots = availabilitySlots[dayIndex];
  availabilityDebugGrid.innerHTML = "";

  for (let i = 0; i < SLOTS_PER_DAY; i++) {
    const slot = slots[i];
    const div = document.createElement("div");
    div.classList.add("slot-debug");

    if (slot.type === 1) div.classList.add("slot-type1");
    else if (slot.type === 2) div.classList.add("slot-type2");
    else if (slot.type === 3) div.classList.add("slot-type3");

    if (i % 6 === 0) {
      const hour = Math.floor((i * SLOT_MINUTES) / 60);
      const minute = (i * SLOT_MINUTES) % 60;
      const label = `${hour.toString().padStart(2, "0")}:${minute
        .toString()
        .padStart(2, "0")}`;
      div.title = label;
      div.classList.add("slot-debug-hour-label");
    }

    availabilityDebugGrid.appendChild(div);
  }
}

if (renderDebugBtn && debugDaySelect) {
  renderDebugBtn.addEventListener("click", () => {
    const dayIndex = parseInt(debugDaySelect.value, 10) || 0;
    renderAvailabilityDebug(dayIndex);
  });
}

// ===================================================
// LOAD ALL & INIT
// ===================================================
async function loadAllData() {
  if (!currentUid) {
    setLoggedOutUI();
    return;
  }
  await Promise.all([loadMainTasks(), loadBackgroundTasks()]);
}

renderTimeline();
jumpNow();
setLoggedOutUI();

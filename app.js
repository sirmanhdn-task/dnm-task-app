// FIREBASE
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
  getFirestore, collection, addDoc, getDocs, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// =============================
// FIREBASE CONFIG — THAY BẰNG CỦA BẠN
// =============================
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

// =============================
// TAB UI LOGIC
// =============================
document.querySelectorAll(".tab-button").forEach(btn=>{
  btn.addEventListener("click",()=>{
    const id = btn.dataset.tabTarget;
    document.querySelectorAll(".tab-button").forEach(b=>b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".tab-panel").forEach(p=>{
      p.classList.toggle("active", p.id===id);
    });
  });
});

// =============================
// TIMELINE CORE
// =============================
const timelineScroll = document.getElementById("timelineScroll");
const timelineHeader = document.getElementById("timelineHeader");
const nowMarker = document.getElementById("timelineNowMarker");

const MS_H = 3600000;
const MS_D = 86400000;
const DAYS = 14;
const HOURS = DAYS * 24;

let pxPerHour = 60;
const MIN_PX = 24;
const MAX_PX = 160;

const startToday = (() => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
})();

function dayLabel(d) {
  const w = ["CN","T2","T3","T4","T5","T6","T7"];
  return `${w[d.getDay()]} ${d.getDate()}`;
}

function renderTimeline() {
  const totalWidth = HOURS * pxPerHour;
  timelineHeader.innerHTML = "";
  timelineHeader.style.width = totalWidth + "px";

  for (let i=0; i<DAYS; i++) {
    const date = new Date(startToday.getTime() + i*MS_D);

    const dayDiv = document.createElement("div");
    dayDiv.className = "timeline-day";
    if (i===0) dayDiv.classList.add("today");
    if (i===1) dayDiv.classList.add("future-1");
    if (i===2) dayDiv.classList.add("future-2");

    dayDiv.style.width = (24*pxPerHour)+"px";

    const label = document.createElement("div");
    label.className = "timeline-day-label";
    label.textContent = dayLabel(date);

    const hoursDiv = document.createElement("div");
    hoursDiv.className = "timeline-day-hours";

    for (let h=0; h<24; h++){
      const hourDiv = document.createElement("div");
      hourDiv.className = "timeline-hour";
      hourDiv.style.width = pxPerHour + "px";
      hourDiv.textContent = (h%2===0) ? `${h}:00` : "";
      hoursDiv.appendChild(hourDiv);
    }

    dayDiv.appendChild(label);
    dayDiv.appendChild(hoursDiv);
    timelineHeader.appendChild(dayDiv);
  }

  ["laneMainContent","laneBackgroundContent","lanePendingContent"].forEach(id=>{
    document.getElementById(id).style.width = totalWidth + "px";
  });

  updateNowMarker();
}

function updateNowMarker() {
  const now = new Date();
  const diff = now - startToday;
  if (diff<0 || diff > DAYS*MS_D) {
    nowMarker.style.display="none";
    return;
  }
  nowMarker.style.display="block";
  const hoursFromStart = diff / MS_H;
  nowMarker.style.left = (hoursFromStart * pxPerHour) + "px";
}

function zoom(factor) {
  const centerTime =
    (timelineScroll.scrollLeft + timelineScroll.clientWidth/2) / pxPerHour;

  pxPerHour = Math.max(MIN_PX, Math.min(MAX_PX, pxPerHour*factor));
  renderTimeline();

  timelineScroll.scrollLeft =
    centerTime * pxPerHour - timelineScroll.clientWidth/2;
}

function scrollTo(hours) {
  timelineScroll.scrollLeft = hours*pxPerHour - timelineScroll.clientWidth/2;
}

function jumpNow() {
  const now = new Date();
  const diff = now - startToday;
  scrollTo(diff/MS_H);
}

document.getElementById("zoomInBtn").addEventListener("click",()=>zoom(1.2));
document.getElementById("zoomOutBtn").addEventListener("click",()=>zoom(1/1.2));
document.getElementById("jumpNowBtn").addEventListener("click",jumpNow);

// =============================
// CUSTOM CALENDAR MODAL
// =============================
const modal = document.getElementById("jumpDateModal");
const calendarGrid = document.getElementById("calendarGrid");
const closeModal = document.getElementById("closeJumpModal");
const jumpBtn = document.getElementById("jumpDateButton");

function handleJumpDate(iso) {
  const d = new Date(iso+"T00:00:00");
  const diff = d - startToday;
  const dayIndex = diff/MS_D;
  const hours = dayIndex*24 + 8;
  scrollTo(hours);
}

function renderCalendar() {
  calendarGrid.innerHTML = "";
  for (let i=0;i<DAYS;i++){
    const d = new Date(startToday.getTime() + i*MS_D);
    const div = document.createElement("div");
    div.className = "calendar-day";
    if (i===0) div.classList.add("today");
    div.textContent = d.getDate();
    div.addEventListener("click",()=>{
      modal.classList.remove("active");
      handleJumpDate(d.toISOString().slice(0,10));
    });
    calendarGrid.appendChild(div);
  }
}

// Mở modal (hover + click)
jumpBtn.addEventListener("mouseenter",()=>{
  renderCalendar();
  modal.classList.add("active");
});
jumpBtn.addEventListener("click",(e)=>{
  e.preventDefault();
  renderCalendar();
  modal.classList.add("active");
});

// Nút đóng
closeModal.addEventListener("click",()=>{
  modal.classList.remove("active");
});

// Click ngoài đóng modal
modal.addEventListener("click",(e)=>{
  if (e.target===modal) {
    modal.classList.remove("active");
  }
});

// =============================
// PILL TOGGLES
// =============================
const pillMainPending = document.getElementById("pillMainPending");
const pillMainParallel = document.getElementById("pillMainParallel");
const pillBgParallel = document.getElementById("pillBgParallel");

const cbMainPending = document.getElementById("mainIsPending");
const cbMainParallel = document.getElementById("mainIsParallel");
const cbBgParallel = document.getElementById("bgIsParallel");

pillMainPending.addEventListener("click",()=>{
  pillMainPending.classList.toggle("active");
  cbMainPending.checked = pillMainPending.classList.contains("active");
});

pillMainParallel.addEventListener("click",()=>{
  pillMainParallel.classList.toggle("active");
  cbMainParallel.checked = pillMainParallel.classList.contains("active");
});

pillBgParallel.addEventListener("click",()=>{
  pillBgParallel.classList.toggle("active");
  cbBgParallel.checked = pillBgParallel.classList.contains("active");
});

// =============================
// MAIN TASKS
// =============================
function calcScore(q,t,d){
  const t_norm = 1/(t+1);
  const d_norm = 1/(d+1);
  return {
    t_norm, d_norm,
    score: 0.6*q + 0.3*d_norm + 0.1*t_norm
  };
}

document.getElementById("mainTaskForm").addEventListener("submit", async(e)=>{
  e.preventDefault();

  const title = document.getElementById("mainTitle").value;
  const description = document.getElementById("mainDescription").value;
  const importance = Number(document.getElementById("mainImportance").value);
  const duration = Number(document.getElementById("mainDuration").value);
  const deadlineStr = document.getElementById("mainDeadline").value;
  const isPending = cbMainPending.checked;
  const isParallel = cbMainParallel.checked;

  let deadlineMinutes = 60;
  let deadlineAt = null;

  if (deadlineStr){
    const d = new Date(deadlineStr);
    deadlineAt = d.toISOString();
    const diff = d.getTime() - Date.now();
    deadlineMinutes = Math.max(1, Math.round(diff/60000));
  }

  const {t_norm, d_norm, score} = calcScore(importance, duration, deadlineMinutes);

  await addDoc(collection(db,"mainTasks"), {
    title, description,
    importance, duration,
    deadline: deadlineMinutes,
    deadlineAt,
    isPending, isParallel,
    t_norm, d_norm, score,
    createdAt: serverTimestamp()
  });

  e.target.reset();
  pillMainPending.classList.remove("active");
  pillMainParallel.classList.remove("active");
  cbMainPending.checked = false;
  cbMainParallel.checked = false;

  loadAll();
});

async function loadMainTasks(){
  const snap = await getDocs(collection(db,"mainTasks"));
  const arr=[];
  snap.forEach(doc=>arr.push({id:doc.id,...doc.data()}));
  arr.sort((a,b)=>b.score-a.score);

  const list = document.getElementById("mainTaskList");
  list.innerHTML="";
  arr.forEach(task=>{
    const div=document.createElement("div");
    div.className="task-item task-item-main";
    const dt = task.deadlineAt ? new Date(task.deadlineAt).toLocaleString() : "N/A";
    div.innerHTML=`
      <h4>${task.title}</h4>
      <p>${task.description||""}</p>
      <p class="task-meta">Imp: ${task.importance} | Dur: ${task.duration} phút</p>
      <p class="task-meta">Deadline: ${dt} | Còn: ${task.deadline} phút</p>
      <p class="task-meta">Pending: ${task.isPending?"Có":"Không"} | Parallel: ${task.isParallel?"Có":"Không"}</p>
      <p class="task-meta">Score: ${task.score.toFixed(3)}</p>
    `;
    list.appendChild(div);
  });
}

// =============================
// BACKGROUND TASKS
// =============================
document.getElementById("backgroundTaskForm").addEventListener("submit", async(e)=>{
  e.preventDefault();
  const title = document.getElementById("bgTitle").value;
  const description = document.getElementById("bgDescription").value;
  const startTime = document.getElementById("bgStartTime").value;
  const endTime = document.getElementById("bgEndTime").value;
  const isParallel = cbBgParallel.checked;

  await addDoc(collection(db,"backgroundTasks"),{
    title, description, startTime, endTime, isParallel,
    createdAt: serverTimestamp()
  });

  e.target.reset();
  pillBgParallel.classList.remove("active");
  cbBgParallel.checked = false;

  loadAll();
});

async function loadBackgroundTasks(){
  const snap=await getDocs(collection(db,"backgroundTasks"));
  const arr=[];
  snap.forEach(doc=>arr.push({id:doc.id,...doc.data()}));
  arr.sort((a,b)=>(a.startTime||"").localeCompare(b.startTime||""));

  const list=document.getElementById("backgroundTaskList");
  list.innerHTML="";

  arr.forEach(task=>{
    const div=document.createElement("div");
    div.className="task-item task-item-bg";
    div.innerHTML=`
      <h4>${task.title}</h4>
      <p>${task.description||""}</p>
      <p class="task-meta">${task.startTime} – ${task.endTime} | Parallel: ${task.isParallel?"Có":"Không"}</p>
    `;
    list.appendChild(div);
  });
}

// =============================
// INIT
// =============================
async function loadAll(){
  await Promise.all([loadMainTasks(), loadBackgroundTasks()]);
}

renderTimeline();
jumpNow();
loadAll();

// ===================================================
// FIREBASE INIT
// ===================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
  getFirestore,
  collection,
  addDoc,
  getDocs,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

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

// ===================================================
// TABS
// ===================================================
document.querySelectorAll(".tab-button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const id = btn.dataset.tabTarget;
    document.querySelectorAll(".tab-button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".tab-panel").forEach(panel =>
      panel.classList.toggle("active", panel.id === id)
    );
  });
});

// ===================================================
// TIMELINE
// ===================================================
const timelineScroll = document.getElementById("timelineScroll");
const timelineHeader = document.getElementById("timelineHeader");
const nowMarker = document.getElementById("timelineNowMarker");

const MS_PER_HOUR = 3600000;
const MS_PER_DAY = 86400000;
const DAYS_TOTAL = 14;
const HOURS_TOTAL = DAYS_TOTAL * 24;

let pixelsPerHour = 60;  
const MIN_PX = 24;
const MAX_PX = 160;

const startOfToday = (() => {
  const t = new Date();
  return new Date(t.getFullYear(), t.getMonth(), t.getDate());
})();

function formatDayLabel(date) {
  const w = ["CN","T2","T3","T4","T5","T6","T7"];
  return `${w[date.getDay()]} ${date.getDate()}`;
}

function renderTimeline() {
  const totalWidth = HOURS_TOTAL * pixelsPerHour;
  timelineHeader.innerHTML = "";
  timelineHeader.style.width = totalWidth + "px";

  for (let d=0; d<DAYS_TOTAL; d++) {
    const date = new Date(startOfToday.getTime() + d*MS_PER_DAY);
    const dayDiv = document.createElement("div");
    dayDiv.classList.add("timeline-day");
    if (d===0) dayDiv.classList.add("today");
    if (d===1) dayDiv.classList.add("future-1");
    if (d===2) dayDiv.classList.add("future-2");
    dayDiv.style.width = (24*pixelsPerHour)+"px";

    const label = document.createElement("div");
    label.className="timeline-day-label";
    label.textContent = formatDayLabel(date);

    const hoursDiv = document.createElement("div");
    hoursDiv.className="timeline-day-hours";

    for (let h=0; h<24; h++) {
      const hour = document.createElement("div");
      hour.className="timeline-hour";
      hour.style.width = pixelsPerHour+"px";
      hour.textContent = h%2===0 ? `${h}:00` : "";
      hoursDiv.appendChild(hour);
    }

    dayDiv.appendChild(label);
    dayDiv.appendChild(hoursDiv);
    timelineHeader.appendChild(dayDiv);
  }

  ["laneMainContent","laneBackgroundContent","lanePendingContent"].forEach(id => {
    document.getElementById(id).style.width = totalWidth+"px";
  });

  updateNowMarker();
}

function updateNowMarker() {
  const now = new Date();
  const diff = now - startOfToday;
  if (diff < 0 || diff >= DAYS_TOTAL * MS_PER_DAY) {
    nowMarker.style.display = "none";
    return;
  }
  nowMarker.style.display = "block";
  const hours = diff/MS_PER_HOUR;
  nowMarker.style.left = (hours*pixelsPerHour)+"px";
}

// Zoom
function zoom(f) {
  const center =
    (timelineScroll.scrollLeft + timelineScroll.clientWidth/2) / pixelsPerHour;

  pixelsPerHour = Math.max(MIN_PX, Math.min(MAX_PX, pixelsPerHour * f));
  renderTimeline();

  timelineScroll.scrollLeft =
    center*pixelsPerHour - timelineScroll.clientWidth/2;
}

// Scroll to now
function scrollToTime(h) {
  timelineScroll.scrollLeft =
    h*pixelsPerHour - timelineScroll.clientWidth/2;
}

function jumpNow() {
  const now = new Date();
  const diff = now - startOfToday;
  const hours = diff/MS_PER_HOUR;
  scrollToTime(hours);
}

document.getElementById("zoomInBtn").addEventListener("click",()=>zoom(1.2));
document.getElementById("zoomOutBtn").addEventListener("click",()=>zoom(1/1.2));
document.getElementById("jumpNowBtn").addEventListener("click",jumpNow);

// ===================================================
// CALENDAR MODAL — CHỈ CLICK
// ===================================================
const jumpDateButton = document.getElementById("jumpDateButton");
const jumpDateModal = document.getElementById("jumpDateModal");
const calendarGrid = document.getElementById("calendarGrid");
const closeJumpModal = document.getElementById("closeJumpModal");

function handleJumpDateChosen(iso) {
  const d = new Date(iso+"T00:00:00");
  const diff = d - startOfToday;
  const hours = (diff/MS_PER_DAY)*24 + 8;
  scrollToTime(hours);
}

function renderCalendar() {
  calendarGrid.innerHTML="";
  for (let i=0; i<DAYS_TOTAL; i++){
    const d = new Date(startOfToday.getTime()+i*MS_PER_DAY);

    const div=document.createElement("div");
    div.className="calendar-day";
    if (i===0) div.classList.add("today");
    div.textContent = d.getDate();

    div.addEventListener("click",()=>{
      jumpDateModal.classList.remove("active");
      handleJumpDateChosen(d.toISOString().slice(0,10));
    });

    calendarGrid.appendChild(div);
  }
}

// mở modal (ONLY CLICK)
jumpDateButton.addEventListener("click",()=>{
  renderCalendar();
  jumpDateModal.classList.add("active");
});

// đóng modal
closeJumpModal.addEventListener("click",()=>
  jumpDateModal.classList.remove("active")
);

jumpDateModal.addEventListener("click",(e)=>{
  if (e.target===jumpDateModal) jumpDateModal.classList.remove("active");
});

// ===================================================
// PILL TOGGLE
// ===================================================
const pillMainPending = document.getElementById("pillMainPending");
const pillMainParallel = document.getElementById("pillMainParallel");
const cbMainPending = document.getElementById("mainIsPending");
const cbMainParallel = document.getElementById("mainIsParallel");

pillMainPending.addEventListener("click",()=>{
  pillMainPending.classList.toggle("active");
  cbMainPending.checked = pillMainPending.classList.contains("active");
});

pillMainParallel.addEventListener("click",()=>{
  pillMainParallel.classList.toggle("active");
  cbMainParallel.checked = pillMainParallel.classList.contains("active");
});

const pillBgParallel = document.getElementById("pillBgParallel");
const cbBgParallel = document.getElementById("bgIsParallel");

pillBgParallel.addEventListener("click",()=>{
  pillBgParallel.classList.toggle("active");
  cbBgParallel.checked = pillBgParallel.classList.contains("active");
});

// ===================================================
// SCORING LOGIC
// ===================================================
function computeScore(q,t,d){
  const t_norm = 1/(t+1);
  const d_norm = 1/(d+1);
  return {
    t_norm,
    d_norm,
    score: 0.6*q + 0.3*d_norm + 0.1*t_norm
  };
}

// ===================================================
// MAIN TASK FORM
// ===================================================
document.getElementById("mainTaskForm").addEventListener("submit", async(e)=>{
  e.preventDefault();

  const title=document.getElementById("mainTitle").value;
  const desc=document.getElementById("mainDescription").value;
  const importance=Number(document.getElementById("mainImportance").value);
  const duration=Number(document.getElementById("mainDuration").value);
  const deadlineStr=document.getElementById("mainDeadline").value;

  const isPending=cbMainPending.checked;
  const isParallel=cbMainParallel.checked;

  let deadlineMinutes=60;
  let deadlineAt=null;

  if (deadlineStr){
    const dl=new Date(deadlineStr);
    deadlineAt=dl.toISOString();
    const diff=dl.getTime()-Date.now();
    deadlineMinutes=Math.max(1,Math.round(diff/60000));
  }

  const {t_norm,d_norm,score}=computeScore(
    importance,
    duration,
    deadlineMinutes
  );

  await addDoc(collection(db,"mainTasks"),{
    title: title,
    description: desc,
    importance,
    duration,
    deadline: deadlineMinutes,
    deadlineAt,
    isPending,
    isParallel,
    t_norm,
    d_norm,
    score,
    createdAt: serverTimestamp()
  });

  e.target.reset();
  pillMainPending.classList.remove("active");
  pillMainParallel.classList.remove("active");
  cbMainPending.checked=false;
  cbMainParallel.checked=false;

  loadAllData();
});

// ===================================================
// LOAD MAIN TASK LIST
// ===================================================
async function loadMainTasks(){
  const snap = await getDocs(collection(db,"mainTasks"));
  const items=[];
  snap.forEach(doc=>items.push({id:doc.id,...doc.data()}));

  items.sort((a,b)=> b.score - a.score);

  const list=document.getElementById("mainTaskList");
  list.innerHTML="";

  items.forEach(t=>{
    const div=document.createElement("div");
    div.className="task-item task-item-main";

    const dt = t.deadlineAt
      ? new Date(t.deadlineAt).toLocaleString()
      : "N/A";

    div.innerHTML=`
      <h4>${t.title}</h4>
      <p>${t.description||""}</p>
      <p>Importance: ${t.importance} · Duration: ${t.duration} phút</p>
      <p>Deadline: ${dt} · Còn: ${t.deadline} phút</p>
      <p>Parallel: ${t.isParallel?"Có":"Không"} · Pending: ${t.isPending?"Có":"Không"}</p>
      <p>Score: ${t.score.toFixed(3)}</p>
    `;
    list.appendChild(div);
  });
}

// ===================================================
// BACKGROUND TASK FORM
// ===================================================
document.getElementById("backgroundTaskForm").addEventListener("submit", async(e)=>{
  e.preventDefault();

  const title=document.getElementById("bgTitle").value;
  const desc=document.getElementById("bgDescription").value;
  const start=document.getElementById("bgStartTime").value;
  const end=document.getElementById("bgEndTime").value;
  const isParallel=cbBgParallel.checked;

  await addDoc(collection(db,"backgroundTasks"),{
    title,
    description: desc,
    startTime: start,
    endTime: end,
    isParallel,
    createdAt: serverTimestamp()
  });

  e.target.reset();
  pillBgParallel.classList.remove("active");
  cbBgParallel.checked=false;

  loadAllData();
});

// ===================================================
// LOAD BACKGROUND TASK LIST
// ===================================================
async function loadBackgroundTasks(){
  const snap=await getDocs(collection(db,"backgroundTasks"));
  const items=[];
  snap.forEach(doc=>items.push({id:doc.id,...doc.data()}));

  items.sort((a,b)=>(a.startTime||"").localeCompare(b.startTime||""));

  const list=document.getElementById("backgroundTaskList");
  list.innerHTML="";

  items.forEach(t=>{
    const div=document.createElement("div");
    div.className="task-item task-item-bg";

    div.innerHTML=`
      <h4>${t.title}</h4>
      <p>${t.description||""}</p>
      <p>${t.startTime} – ${t.endTime} · Parallel: ${t.isParallel?"Có":"Không"}</p>
    `;

    list.appendChild(div);
  });
}

// ===================================================
// INIT
// ===================================================
async function loadAllData(){
  await Promise.all([loadMainTasks(),loadBackgroundTasks()]);
}

renderTimeline();
jumpNow();
loadAllData();

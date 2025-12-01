// Firebase SDK
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
  getFirestore,
  collection,
  addDoc,
  getDocs,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// ======================
// FIREBASE CONFIG
// ======================
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

// ======================
// TAB SWITCH
// ======================
document.querySelectorAll(".tab-button").forEach(btn=>{
  btn.addEventListener("click",()=>{
    const id=btn.dataset.tabTarget;
    document.querySelectorAll(".tab-button").forEach(b=>b.classList.remove("active"));
    btn.classList.add("active");

    document.querySelectorAll(".tab-panel").forEach(panel=>{
      panel.classList.toggle("active",panel.id===id);
    });
  });
});

// ======================
// TIMELINE
// ======================
const timelineScroll=document.getElementById("timelineScroll");
const timelineHeader=document.getElementById("timelineHeader");
const nowMarker=document.getElementById("timelineNowMarker");

const MS_HOUR=3600000;
const MS_DAY=86400000;
const DAYS=14;
const HOURS=DAYS*24;

let pxPerHour=60;
const MIN_PX=24;
const MAX_PX=160;

const startOfToday = (()=> {
  const n=new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
})();

function formatDayLabel(date){
  const w=["CN","T2","T3","T4","T5","T6","T7"];
  return `${w[date.getDay()]} ${date.getDate()}`;
}

function renderTimeline(){
  const totalW = HOURS * pxPerHour;
  timelineHeader.innerHTML="";
  timelineHeader.style.width=totalW+"px";

  for (let d=0;d<DAYS;d++){
    const dayDate=new Date(startOfToday.getTime()+d*MS_DAY);
    const day=document.createElement("div");
    day.className="timeline-day";
    if(d===0) day.classList.add("today");
    if(d===1) day.classList.add("future-1");
    if(d===2) day.classList.add("future-2");

    day.style.width=(24*pxPerHour)+"px";

    const label=document.createElement("div");
    label.className="timeline-day-label";
    label.textContent=formatDayLabel(dayDate);

    const hours=document.createElement("div");
    hours.className="timeline-day-hours";
    for(let h=0;h<24;h++){
      const hd=document.createElement("div");
      hd.className="timeline-hour";
      hd.style.width=pxPerHour+"px";
      hd.textContent = (h%2===0)? `${h}:00` : "";
      hours.appendChild(hd);
    }

    day.appendChild(label);
    day.appendChild(hours);
    timelineHeader.appendChild(day);
  }

  ["laneMainContent","laneBackgroundContent","lanePendingContent"].forEach(id=>{
    document.getElementById(id).style.width=totalW+"px";
  });

  updateNowMarker();
}

function updateNowMarker(){
  const now=new Date();
  const diff=now-startOfToday;
  if(diff<0 || diff>DAYS*MS_DAY){
    nowMarker.style.display="none";
    return;
  }
  nowMarker.style.display="block";
  const hours=diff/MS_HOUR;
  nowMarker.style.left=(hours*pxPerHour)+"px";
}

function zoom(f){
  const center = (timelineScroll.scrollLeft + timelineScroll.clientWidth/2)/pxPerHour;
  pxPerHour = Math.max(MIN_PX, Math.min(MAX_PX, pxPerHour*f));
  renderTimeline();
  timelineScroll.scrollLeft=center*pxPerHour - timelineScroll.clientWidth/2;
}

document.getElementById("zoomInBtn").addEventListener("click",()=>zoom(1.2));
document.getElementById("zoomOutBtn").addEventListener("click",()=>zoom(1/1.2));

function scrollToHours(h){ timelineScroll.scrollLeft = h*pxPerHour - timelineScroll.clientWidth/2; }

document.getElementById("jumpNowBtn").addEventListener("click",()=>{
  const diff=new Date()-startOfToday;
  const h=diff/MS_HOUR;
  scrollToHours(h);
});

// ======================
// JUMP-TO-DATE MODAL
// ======================
const jumpDateButton=document.getElementById("jumpDateButton");
const jumpDateModal=document.getElementById("jumpDateModal");
const calendarGrid=document.getElementById("calendarGrid");
const closeJumpModal=document.getElementById("closeJumpModal");

function openJumpModal(){
  renderCalendar();
  jumpDateModal.classList.add("active");
}

jumpDateButton.addEventListener("mouseenter",openJumpModal);
jumpDateButton.addEventListener("click",(e)=>{
  e.preventDefault();
  openJumpModal();
});

closeJumpModal.addEventListener("click",()=>jumpDateModal.classList.remove("active"));

jumpDateModal.addEventListener("click",(e)=>{
  if(e.target===jumpDateModal) jumpDateModal.classList.remove("active");
});

function renderCalendar(){
  calendarGrid.innerHTML="";
  for(let i=0;i<DAYS;i++){
    const d=new Date(startOfToday.getTime()+i*MS_DAY);
    const div=document.createElement("div");
    div.className="calendar-day";
    if(i===0) div.classList.add("today");

    div.textContent=d.getDate();
    div.addEventListener("click",()=>{
      jumpDateModal.classList.remove("active");
      const dayIndex=i;
      const hours = dayIndex*24 + 8;
      scrollToHours(hours);
    });

    calendarGrid.appendChild(div);
  }
}

// ======================
// PILL UI LOGIC
// ======================
const pillMainPending=document.getElementById("pillMainPending");
const pillMainParallel=document.getElementById("pillMainParallel");
const cbMainPending=document.getElementById("mainIsPending");
const cbMainParallel=document.getElementById("mainIsParallel");

pillMainPending.addEventListener("click",()=>{
  pillMainPending.classList.toggle("active");
  cbMainPending.checked=pillMainPending.classList.contains("active");
});
pillMainParallel.addEventListener("click",()=>{
  pillMainParallel.classList.toggle("active");
  cbMainParallel.checked=pillMainParallel.classList.contains("active");
});

const pillBgParallel=document.getElementById("pillBgParallel");
const cbBgParallel=document.getElementById("bgIsParallel");

pillBgParallel.addEventListener("click",()=>{
  pillBgParallel.classList.toggle("active");
  cbBgParallel.checked=pillBgParallel.classList.contains("active");
});

// ======================
// MAIN TASK CRUD
// ======================
function computeScore(q,t,d){
  const t_norm=1/(t+1);
  const d_norm=1/(d+1);
  return 0.6*q + 0.3*d_norm + 0.1*t_norm;
}

document.getElementById("mainTaskForm").addEventListener("submit",async(e)=>{
  e.preventDefault();

  const title=document.getElementById("mainTitle").value;
  const desc=document.getElementById("mainDescription").value;
  const importance=Number(document.getElementById("mainImportance").value);
  const duration=Number(document.getElementById("mainDuration").value);

  const deadlineStr=document.getElementById("mainDeadline").value;
  let deadlineMinutes=60;
  let deadlineAt=null;
  if(deadlineStr){
    const d=new Date(deadlineStr);
    deadlineAt=d.toISOString();
    const diff=d - new Date();
    deadlineMinutes=Math.max(1, Math.round(diff/60000));
  }

  const isPending=cbMainPending.checked;
  const isParallel=cbMainParallel.checked;

  const score=computeScore(importance,duration,deadlineMinutes);

  await addDoc(collection(db,"mainTasks"),{
    title, description:desc,
    importance, duration,
    deadline:deadlineMinutes,
    deadlineAt,
    isPending, isParallel,
    score,
    createdAt:serverTimestamp()
  });

  e.target.reset();
  pillMainPending.classList.remove("active");
  pillMainParallel.classList.remove("active");

  loadAll();
});

async function loadMain(){
  const snap=await getDocs(collection(db,"mainTasks"));
  const items=[];
  snap.forEach(doc=>items.push({...doc.data(), id:doc.id}));

  items.sort((a,b)=>b.score-a.score);

  const root=document.getElementById("mainTaskList");
  root.innerHTML="";
  items.forEach(t=>{
    const div=document.createElement("div");
    div.className="task-item task-item-main";
    const deadlineTxt=t.deadlineAt? new Date(t.deadlineAt).toLocaleString() : "N/A";
    div.innerHTML=`
      <h4>${t.title}</h4>
      <p>${t.description||""}</p>
      <p class="task-meta">Importance: ${t.importance} · Duration: ${t.duration} phút</p>
      <p class="task-meta">Deadline: ${deadlineTxt} · Còn ${t.deadline} phút</p>
      <p class="task-meta">Pending: ${t.isPending?"Có":"Không"} · Parallel: ${t.isParallel?"Có":"Không"} · Score: ${t.score.toFixed(3)}</p>
    `;
    root.appendChild(div);
  });
}

// ======================
// BACKGROUND TASK CRUD
// ======================
document.getElementById("backgroundTaskForm").addEventListener("submit",async(e)=>{
  e.preventDefault();

  const title=document.getElementById("bgTitle").value;
  const desc=document.getElementById("bgDescription").value;
  const start=document.getElementById("bgStartTime").value;
  const end=document.getElementById("bgEndTime").value;
  const isParallel=cbBgParallel.checked;

  await addDoc(collection(db,"backgroundTasks"),{
    title, description:desc, startTime:start, endTime:end,
    isParallel,
    createdAt:serverTimestamp()
  });

  e.target.reset();
  pillBgParallel.classList.remove("active");

  loadAll();
});

async function loadBackground(){
  const snap=await getDocs(collection(db,"backgroundTasks"));
  const items=[];
  snap.forEach(doc=>items.push({...doc.data(), id:doc.id}));
  items.sort((a,b)=>(a.startTime||"").localeCompare(b.startTime||""));

  const root=document.getElementById("backgroundTaskList");
  root.innerHTML="";
  items.forEach(t=>{
    const div=document.createElement("div");
    div.className="task-item task-item-bg";
    div.innerHTML=`
      <h4>${t.title}</h4>
      <p>${t.description||""}</p>
      <p class="task-meta">${t.startTime} – ${t.endTime} · Parallel: ${t.isParallel?"Có":"Không"}</p>
    `;
    root.appendChild(div);
  });
}

// ======================
// INIT
// ======================
async function loadAll(){
  await Promise.all([loadMain(), loadBackground()]);
}

renderTimeline();
loadAll();
updateNowMarker();
setInterval(updateNowMarker,60000);

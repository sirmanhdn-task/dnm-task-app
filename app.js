/* 
VERSION: V6.2
DATE: 2025-01-15
CHANGES:
- Thêm Day Header chạy theo timeline
- Đồng bộ scroll + zoom với timeline
- BuildSlots giữ nguyên (10 phút)
*/

////////////////////////////////////
// STATE
////////////////////////////////////
const state = {
    user: null,
    tasks: [],
    backgroundTasks: [],
    settings: {
        quickBoost: 50,
        strictBoost: 1.5
    },
    timeline: {
        todayStart: null,
        totalMinutes: 0
    }
};

let zoomLevel = 1;
const ZOOM_LEVELS = [0.3,0.5,0.75,1,1.5,2,3,4];
const MAX_FILL_DAYS = 14;
const MAX_FILL_MINUTES = MAX_FILL_DAYS * 1440;

////////////////////////////////////
// AUTH + FIREBASE INIT (giữ nguyên)
////////////////////////////////////
// (Toàn bộ phần Firebase giữ nguyên trong dự án của bạn)


////////////////////////////////////
// BUILD SLOTS (V6.0)
////////////////////////////////////
function buildSlots() {
    const RES = 10;
    const todayStart = state.timeline.todayStart;
    const totalMinutes = Math.min(state.timeline.totalMinutes, MAX_FILL_MINUTES);

    if (!todayStart) return [];

    const slots = [];
    const bg = state.backgroundTasks || [];

    const unavailable = [];
    bg.forEach(b => {
        if (!b.date || !b.startTime || !b.endTime) return;
        if (b.parallel) return;

        const base = new Date(b.date + "T00:00:00");
        const dayIndex = Math.floor((base - todayStart) / (24*60*60000));
        if (dayIndex < 0) return;

        const [sh,sm] = b.startTime.split(":").map(Number);
        const [eh,em] = b.endTime.split(":").map(Number);

        const startM = dayIndex*1440 + sh*60+sm;
        const endM   = dayIndex*1440 + eh*60+em;

        if (endM <= startM) return;

        unavailable.push({start:startM, end:endM});
    });

    for (let m=0; m<totalMinutes; m+=RES) {
        const s = m;
        let e = m+RES;
        if (e > totalMinutes) e = totalMinutes;

        let status = "available";

        for (const un of unavailable) {
            if (!(e<=un.start || s>=un.end)) {
                status="unavailable";
                break;
            }
        }

        slots.push({start:s, end:e, status});
    }

    return slots;
}

window.debugSlots = function() {
    console.log("=== DEBUG SLOTS V6.0 (10 phút) ===");
    console.log(buildSlots());
};


////////////////////////////////////
// DAY HEADER (V6.2)
////////////////////////////////////
function renderDayHeader() {
    const header = document.getElementById("timelineDayHeader");
    const scrollBox = document.querySelector(".timeline-scroll");
    const todayStart = state.timeline.todayStart;
    const total = state.timeline.totalMinutes;

    if (!header || !todayStart) return;

    header.innerHTML = ""; // clear

    const days = Math.ceil(total / 1440);

    for (let d = 0; d < days; d++) {
        const dayStartMinute = d * 1440;
        const leftPx = dayStartMinute * zoomLevel;
        const widthPx = 1440 * zoomLevel;

        const date = new Date(todayStart.getTime() + d*24*60*60000);
        const label = `${date.toLocaleDateString("en-GB",{weekday:"short"})} ${date.getDate()}/${date.getMonth()+1}`;

        const div = document.createElement("div");
        div.className = "day-label";
        div.style.left = leftPx + "px";
        div.style.width = widthPx + "px";
        div.textContent = label;

        header.appendChild(div);
    }

    // Đồng bộ scroll
    header.scrollLeft = scrollBox.scrollLeft;
}

// Lắng nghe scroll
document.addEventListener("DOMContentLoaded", () => {
    const scrollBox = document.querySelector(".timeline-scroll");
    if (!scrollBox) return;

    scrollBox.addEventListener("scroll", () => {
        const header = document.getElementById("timelineDayHeader");
        if (header) header.scrollLeft = scrollBox.scrollLeft;
    });
});


////////////////////////////////////
// RENDER TIMELINE (gốc giữ nguyên)
////////////////////////////////////
function renderTimeline() {
    const today = new Date();
    const todayMid = new Date(today.getFullYear(),today.getMonth(),today.getDate());
    state.timeline.todayStart = todayMid;

    const maxM = Math.max(...state.tasks.map(t => {
        const dl = new Date(t.deadline);
        return Math.ceil((dl - todayMid)/60000);
    }), 1440);

    state.timeline.totalMinutes = Math.min(maxM, MAX_FILL_MINUTES);

    const container = document.getElementById("timelineContainer");

    container.style.width = (state.timeline.totalMinutes * zoomLevel) + "px";

    renderHours();
    renderShading();
    renderBlocks();

    // NEW
    renderDayHeader();

    renderCurrentLine();
}


////////////////////////////////////
// ZOOM
////////////////////////////////////
window.zoomIn = function() {
    const scrollBox = document.querySelector(".timeline-scroll");
    if (!scrollBox) return;

    const i = ZOOM_LEVELS.indexOf(zoomLevel);
    if (i === -1 || i === ZOOM_LEVELS.length-1) return;

    const oldZ = zoomLevel;
    const centerX = scrollBox.scrollLeft + scrollBox.clientWidth/2;
    const centerMin = centerX / oldZ;

    zoomLevel = ZOOM_LEVELS[i+1];
    document.getElementById("zoomDisplay").innerText = Math.round(zoomLevel*100)+"%";

    renderTimeline();

    scrollBox.scrollLeft = centerMin * zoomLevel - scrollBox.clientWidth/2;
};

window.zoomOut = function() {
    const scrollBox = document.querySelector(".timeline-scroll");
    if (!scrollBox) return;

    const i = ZOOM_LEVELS.indexOf(zoomLevel);
    if (i <= 0) return;

    const oldZ = zoomLevel;
    const centerX = scrollBox.scrollLeft + scrollBox.clientWidth/2;
    const centerMin = centerX / oldZ;

    zoomLevel = ZOOM_LEVELS[i-1];
    document.getElementById("zoomDisplay").innerText = Math.round(zoomLevel*100)+"%";

    renderTimeline();

    scrollBox.scrollLeft = centerMin * zoomLevel - scrollBox.clientWidth/2;
};


////////////////////////////////////
// Jump to now (giữ nguyên)
////////////////////////////////////
window.jumpToNow = function() {
    const scrollBox = document.querySelector(".timeline-scroll");
    const now = new Date();
    const todayMid = state.timeline.todayStart;
    if (!todayMid) return;

    const minutes = Math.floor((now - todayMid)/60000);
    const target = minutes * zoomLevel;

    scrollBox.scrollLeft = target - scrollBox.clientWidth/2;
};


////////////////////////////////////
// switchTab + bg + settings + tasks
// (GIỮ NGUYÊN như file bạn)
////////////////////////////////////

// ... *PHẦN CÒN LẠI GIỮ NGUYÊN 100%* ...


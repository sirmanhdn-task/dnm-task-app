// Import Firebase SDK (dùng bản trên CDN, không cần cài gì thêm)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { 
  getFirestore, 
  collection, 
  addDoc, 
  getDocs, 
  serverTimestamp 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// TODO: THAY CẤU HÌNH NÀY BẰNG CẤU HÌNH CỦA BẠN TRONG FIREBASE CONSOLE
const firebaseConfig = {
  apiKey: "API_KEY_CỦA_BẠN",
  authDomain: "AUTH_DOMAIN_CỦA_BẠN",
  projectId: "PROJECT_ID_CỦA_BẠN",
  storageBucket: "STORAGE_BUCKET_CỦA_BẠN",
  messagingSenderId: "MESSAGING_SENDER_ID_CỦA_BẠN",
  appId: "APP_ID_CỦA_BẠN"
};

// KHỞI TẠO FIREBASE
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// HÀM TÍNH TRỌNG SỐ
function computeScore(q, t, d) {
  const t_norm = 1 / (t + 1);
  const d_norm = 1 / (d + 1);

  const w_q = 0.6;
  const w_d = 0.3;
  const w_t = 0.1;

  const score = w_q * q + w_d * d_norm + w_t * t_norm;
  return { t_norm, d_norm, score };
}

// XỬ LÝ FORM
const form = document.getElementById("taskForm");

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const title = document.getElementById("title").value;
  const description = document.getElementById("description").value;
  const q = Number(document.getElementById("q").value);
  const t = Number(document.getElementById("t").value);
  const d = Number(document.getElementById("d").value);

  const { t_norm, d_norm, score } = computeScore(q, t, d);

  try {
    await addDoc(collection(db, "tasks"), {
      title,
      description,
      q,
      t,
      d,
      t_norm,
      d_norm,
      score,
      created_at: serverTimestamp()
    });

    form.reset();
    loadTasks();
  } catch (error) {
    console.error("Lỗi khi thêm task:", error);
    alert("Có lỗi xảy ra khi lưu task. Kiểm tra console.");
  }
});

// HÀM LOAD TASKS
async function loadTasks() {
  try {
    const querySnapshot = await getDocs(collection(db, "tasks"));
    let tasks = [];

    querySnapshot.forEach((doc) => {
      tasks.push({ id: doc.id, ...doc.data() });
    });

    // SẮP XẾP THEO SCORE GIẢM DẦN
    tasks.sort((a, b) => b.score - a.score);

    renderTasks(tasks);
  } catch (error) {
    console.error("Lỗi khi load tasks:", error);
  }
}

// HÀM HIỂN THỊ TASK
function renderTasks(tasks) {
  const list = document.getElementById("taskList");
  list.innerHTML = "";

  tasks.forEach(task => {
    const div = document.createElement("div");
    div.className = "task-item";
    div.innerHTML = `
      <h3>${task.title}</h3>
      <p>${task.description || ""}</p>
      <p>Quan trọng: <strong>${task.q}</strong></p>
      <p>Thời gian dự kiến: ${task.t} phút</p>
      <p>Deadline còn lại: ${task.d} phút</p>
      <p>Score: ${task.score.toFixed(3)}</p>
    `;
    list.appendChild(div);
  });
}

// LOAD TASK KHI MỞ TRANG
loadTasks();

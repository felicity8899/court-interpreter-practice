// Court Interpreter Mock Exam Practice — frontend logic.
// No build step, no framework: plain JS + the /api endpoints in main.py.

const LETTERS = ["A", "B", "C", "D", "E", "F"];

let exam = null;        // { exam_id, questions, answers: {qid: idx|null}, index, total, timeLimit, startedAt }
let timerId = null;

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- views

function showView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  $("view-" + name).classList.remove("hidden");
  document.querySelectorAll(".nav-btn[data-nav]").forEach((b) =>
    b.classList.toggle("active", b.dataset.nav === name)
  );
  if (name === "review") loadReview();
  if (name === "history") loadHistory();
  if (name === "home") refreshWrongCount();
}

document.querySelectorAll("[data-nav]").forEach((el) => {
  el.addEventListener("click", () => {
    if (exam && el.dataset.nav !== "exam" && !confirm("离开将丢失未提交的考试进度。Leave the exam? Unsaved progress will be lost.")) return;
    if (exam && el.dataset.nav !== "exam") stopTimer(), (exam = null);
    showView(el.dataset.nav);
  });
});

// ---------------------------------------------------------------- helpers

function fmtClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return String(m).padStart(2, "0") + ":" + String(r).padStart(2, "0");
}

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || ("HTTP " + res.status));
  return data;
}

// ---------------------------------------------------------------- home / bank

async function loadBankInfo() {
  try {
    const info = await api("/api/bank");
    const cats = Object.entries(info.categories)
      .map(([c, n]) => `${c} (${n})`).join(" · ");
    $("bank-info").textContent =
      `题库共 ${info.total} 题 · Bank: ${info.total} questions` + (cats ? ` — ${cats}` : "");
  } catch (e) {
    $("bank-info").textContent = "题库加载失败 Failed to load question bank: " + e.message;
  }
}

async function refreshWrongCount() {
  try {
    const data = await api("/api/wrong");
    $("wrong-count").textContent = data.count ? String(data.count) : "";
  } catch { /* badge is best-effort */ }
}

// ---------------------------------------------------------------- exam

$("start-btn").addEventListener("click", async () => {
  $("start-error").textContent = "";
  const selected = document.querySelector('input[name="count"]:checked').value;
  const body = selected === "all" ? {} : { count: parseInt(selected, 10) };
  try {
    const data = await api("/api/exams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    exam = {
      exam_id: data.exam_id,
      questions: data.questions,
      answers: {},
      index: 0,
      total: data.total,
      timeLimit: data.time_limit_seconds,
      startedAt: Date.now(),
    };
    $("exam-truncated").classList.toggle("hidden", !data.truncated);
    if (data.truncated) {
      $("exam-truncated").textContent =
        `题库只有 ${data.total} 题，已用全部题库出题（请求 ${data.requested} 题）。` +
        ` The bank has only ${data.total} questions; all were used (requested ${data.requested}).`;
    }
    startTimer();
    renderQuestion();
    showView("exam");
  } catch (e) {
    $("start-error").textContent = "开始考试失败： " + e.message;
  }
});

function startTimer() {
  stopTimer();
  timerId = setInterval(() => {
    if (!exam) return stopTimer();
    const elapsed = Math.floor((Date.now() - exam.startedAt) / 1000);
    const remaining = exam.timeLimit - elapsed;
    const el = $("exam-timer");
    if (remaining >= 0) {
      el.textContent = "⏱ " + fmtClock(remaining);
      el.classList.remove("overtime");
    } else {
      // Timer behavior: past 0, count UP as overtime — no auto-submit.
      el.textContent = "⏱ +" + fmtClock(-remaining) + " 超时 overtime";
      el.classList.add("overtime");
    }
  }, 500);
}

function stopTimer() {
  if (timerId) clearInterval(timerId);
  timerId = null;
}

function renderQuestion() {
  const q = exam.questions[exam.index];
  $("exam-progress").textContent =
    `第 ${exam.index + 1} / ${exam.total} 题 · Question ${exam.index + 1} of ${exam.total}`;
  const picked = exam.answers[q.id];
  $("question-box").innerHTML = `
    <div class="question-card">
      ${q.category ? `<span class="category">${escapeHtml(q.category)}</span>` : ""}
      <h3>${escapeHtml(q.question)}</h3>
      ${q.options.map((opt, i) => `
        <button class="option ${picked === i ? "selected" : ""}" data-opt="${i}">
          <strong>${LETTERS[i]}.</strong> ${escapeHtml(opt)}
        </button>`).join("")}
    </div>`;
  document.querySelectorAll("#question-box .option").forEach((btn) => {
    btn.addEventListener("click", () => {
      exam.answers[q.id] = parseInt(btn.dataset.opt, 10);
      renderQuestion();
    });
  });
  $("prev-btn").disabled = exam.index === 0;
  $("next-btn").disabled = exam.index === exam.total - 1;
}

$("prev-btn").addEventListener("click", () => {
  if (exam.index > 0) { exam.index--; renderQuestion(); }
});
$("next-btn").addEventListener("click", () => {
  if (exam.index < exam.total - 1) { exam.index++; renderQuestion(); }
});

$("submit-btn").addEventListener("click", async () => {
  $("submit-error").textContent = "";
  const answered = Object.keys(exam.answers).length;
  const unanswered = exam.total - answered;
  if (unanswered > 0 &&
      !confirm(`还有 ${unanswered} 题未作答，确认交卷吗？\n${unanswered} question(s) unanswered. Submit anyway?`)) {
    return;
  }
  const elapsed = Math.floor((Date.now() - exam.startedAt) / 1000);
  try {
    const data = await api(`/api/exams/${exam.exam_id}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: exam.answers, elapsed_seconds: elapsed }),
    });
    stopTimer();
    exam = null;
    $("result-score").textContent =
      `得分 Score: ${data.score} / ${data.total} (${data.total ? Math.round(100 * data.score / data.total) : 0}%)`;
    $("result-breakdown").innerHTML = data.results.map(renderResultItem).join("");
    showView("result");
    refreshWrongCount();
  } catch (e) {
    $("submit-error").textContent = "交卷失败： " + e.message;
  }
});

function renderResultItem(r) {
  const chosenText = r.chosen === null || r.chosen === undefined
    ? "未作答 Unanswered"
    : `${LETTERS[r.chosen]}. ${r.options[r.chosen]}`;
  return `
    <div class="question-card result-item ${r.correct ? "" : "incorrect"}">
      ${r.category ? `<span class="category">${escapeHtml(r.category)}</span>` : ""}
      <h3>${r.correct ? "✓" : "✗"} ${escapeHtml(r.question)}</h3>
      <p>你的答案 Your answer: ${escapeHtml(chosenText)}</p>
      <p>正确答案 Correct answer: <strong>${LETTERS[r.answer]}. ${escapeHtml(r.options[r.answer])}</strong></p>
      ${r.explanation ? `<div class="explanation"><strong>解析 Explanation:</strong> ${escapeHtml(r.explanation)}</div>` : ""}
    </div>`;
}

// ---------------------------------------------------------------- wrong-answer review （错题本）

async function loadReview() {
  const list = $("review-list");
  list.innerHTML = "<p class='muted'>加载中… Loading…</p>";
  try {
    const data = await api("/api/wrong");
    refreshWrongCount();
    if (!data.items.length) {
      list.innerHTML = "<p>错题本是空的 — 太棒了！<br>The wrong-answer set is empty. Nice work!</p>";
      return;
    }
    list.innerHTML = data.items.map((item) => `
      <div class="question-card" id="wrong-${item.question_id}">
        ${item.category ? `<span class="category">${escapeHtml(item.category)}</span>` : ""}
        <span class="meta-line">答错 ${item.times_wrong} 次 · wrong ${item.times_wrong} time(s) · 最近 ${fmtDate(item.last_wrong_at)}</span>
        <h3>${escapeHtml(item.question)}</h3>
        ${item.options.map((opt, i) => `
          <button class="option" data-qid="${item.question_id}" data-opt="${i}">
            <strong>${LETTERS[i]}.</strong> ${escapeHtml(opt)}
          </button>`).join("")}
        <div class="feedback" id="feedback-${item.question_id}"></div>
        <button class="master-btn" data-qid="${item.question_id}">已掌握 Mark as Mastered</button>
      </div>`).join("");

    list.querySelectorAll(".option").forEach((btn) => {
      btn.addEventListener("click", () => attemptReview(btn.dataset.qid, parseInt(btn.dataset.opt, 10)));
    });
    list.querySelectorAll(".master-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await api(`/api/wrong/${btn.dataset.qid}/master`, { method: "POST" });
        loadReview();
      });
    });
  } catch (e) {
    list.innerHTML = `<p class="error">加载失败： ${escapeHtml(e.message)}</p>`;
  }
}

async function attemptReview(qid, picked) {
  try {
    const res = await api(`/api/wrong/${qid}/attempt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: picked }),
    });
    const card = $("wrong-" + qid);
    card.querySelectorAll(".option").forEach((btn) => {
      const i = parseInt(btn.dataset.opt, 10);
      btn.disabled = true;
      if (i === res.answer) btn.classList.add("correct");
      if (i === picked && !res.correct) btn.classList.add("wrong-pick");
    });
    const fb = $("feedback-" + qid);
    if (res.correct) {
      fb.innerHTML = `<div class="explanation">✓ 答对了！已从错题本移除。Correct — removed from the wrong-answer set.</div>`;
      setTimeout(loadReview, 1200);
    } else {
      fb.innerHTML = `<div class="explanation"><strong>答错了 Incorrect.</strong> 正确答案： ${LETTERS[res.answer]}<br>
        ${res.explanation ? `<strong>解析 Explanation:</strong> ${escapeHtml(res.explanation)}` : ""}<br>
        刷新页面可再次尝试。Reload the list to try again.</div>`;
    }
  } catch (e) {
    alert("提交失败： " + e.message);
  }
}

// ---------------------------------------------------------------- history

async function loadHistory() {
  const list = $("history-list");
  list.innerHTML = "<p class='muted'>加载中… Loading…</p>";
  try {
    const exams = await api("/api/exams");
    if (!exams.length) {
      list.innerHTML = "<p>暂无考试记录。<br>No exams yet.</p>";
      return;
    }
    list.innerHTML = exams.map((e) => `
      <div class="history-row" data-exam="${e.exam_id}">
        <span>${fmtDate(e.submitted_at || e.started_at)} · ${e.question_count} 题</span>
        <span>${e.status === "submitted"
          ? `<strong>${e.score} / ${e.question_count}</strong> (${Math.round(100 * e.score / e.question_count)}%)`
          : "未提交 in progress"}</span>
      </div>`).join("");
    list.querySelectorAll(".history-row").forEach((row) => {
      row.addEventListener("click", () => showExamDetail(row.dataset.exam));
    });
  } catch (e) {
    list.innerHTML = `<p class="error">加载失败： ${escapeHtml(e.message)}</p>`;
  }
}

async function showExamDetail(examId) {
  try {
    const d = await api(`/api/exams/${examId}`);
    $("detail-meta").textContent =
      `${fmtDate(d.submitted_at || d.started_at)} · ${d.question_count} 题 · ` +
      (d.elapsed_seconds != null ? `用时 ${fmtClock(d.elapsed_seconds)} · ` : "") +
      `限时 ${fmtClock(d.time_limit_seconds)}`;
    $("detail-score").textContent = d.status === "submitted"
      ? `得分 Score: ${d.score} / ${d.question_count} (${Math.round(100 * d.score / d.question_count)}%)`
      : "未提交 In progress — no score yet.";
    $("detail-breakdown").innerHTML = d.results
      ? d.results.map(renderResultItem).join("")
      : "<p class='muted'>本次考试尚未提交，无逐题结果。<br>This exam was never submitted.</p>";
    showView("detail");
  } catch (e) {
    alert("加载详情失败： " + e.message);
  }
}

// ---------------------------------------------------------------- init

loadBankInfo();
refreshWrongCount();

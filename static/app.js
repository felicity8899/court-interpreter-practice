// Court Interpreter Mock Exam Practice — frontend logic.
// No build step, no framework: plain JS + the /api endpoints in main.py.

const LETTERS = ["A", "B", "C", "D", "E", "F"];

// The 10 exam sections, in real-exam order (Part I, then Part II).
const CATEGORY_ORDER = [
  "sentence-completion",
  "synonyms-in-context",
  "synonyms",
  "antonyms",
  "idioms",
  "court-sentence-completion",
  "court-questions",
  "sequence",
  "professional-conduct",
  "ethical-scenarios",
];
const CATEGORY_LABELS = {
  "sentence-completion": "句子填空 Sentence Completion",
  "synonyms-in-context": "语境同义词 Synonyms in Context",
  "synonyms": "同义词 Synonyms",
  "antonyms": "反义词 Antonyms",
  "idioms": "习语 Idioms",
  "court-sentence-completion": "法庭句子填空 Court Sentence Completion",
  "court-questions": "法庭知识问答 Court-Related Questions",
  "sequence": "事件顺序 Sequence of Events",
  "professional-conduct": "职业行为 Professional Conduct",
  "ethical-scenarios": "道德情景 Ethical Scenarios",
};
const catLabel = (c) => CATEGORY_LABELS[c] || c;

let exam = null;        // { exam_id, mode, questions, answers, index, total, timeLimit, startedAt, pausedTotal, paused, pauseStartedAt }
let timerId = null;
let lastSaveAt = 0;
let lastExamId = null;  // last submitted exam (result-page review button)
let lastExamTime = null; // { elapsed, timeLimit } of the last submitted exam
let debrief = null;     // { examId, results, filter }
let editingQuestionId = null;

const IN_PROGRESS_KEY = "cip-in-progress-v1";

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
  if (name === "manage") loadManage();
  if (name === "home") { refreshWrongCount(); checkResumeBanner(); }
}

document.querySelectorAll("[data-nav]").forEach((el) => {
  el.addEventListener("click", () => {
    if (exam && el.dataset.nav !== "exam" &&
        !confirm("离开将丢失未提交的考试进度。Leave the exam? Unsaved progress will be lost.")) return;
    if (exam && el.dataset.nav !== "exam") abandonExam();
    showView(el.dataset.nav);
  });
});

function abandonExam() {
  stopTimer();
  exam = null;
  clearSavedProgress();
  resetPauseUI();
}

// ---------------------------------------------------------------- helpers

function fmtClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(r).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
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
    const cats = CATEGORY_ORDER.filter((c) => info.categories[c])
      .map((c) => `${catLabel(c)} (${info.categories[c]})`).join(" · ");
    $("bank-info").textContent =
      `题库共 ${info.total} 题（内置 ${info.builtin} + 自加 ${info.user_added}）· Bank: ${info.total} questions` +
      (cats ? ` — ${cats}` : "");
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

// ---------------------------------------------------------------- in-progress persistence (localStorage)

function saveProgress() {
  if (!exam) { clearSavedProgress(); return; }
  try {
    localStorage.setItem(IN_PROGRESS_KEY, JSON.stringify({
      exam_id: exam.exam_id,
      mode: exam.mode,
      questions: exam.questions,
      answers: exam.answers,
      index: exam.index,
      total: exam.total,
      timeLimit: exam.timeLimit,
      elapsedAtSave: Math.floor(examElapsedMs() / 1000),
      paused: exam.paused,
    }));
    lastSaveAt = Date.now();
  } catch { /* storage unavailable — exam still works in-session */ }
}

function clearSavedProgress() {
  try { localStorage.removeItem(IN_PROGRESS_KEY); } catch { /* ignore */ }
}

function readSavedProgress() {
  try {
    const raw = localStorage.getItem(IN_PROGRESS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function checkResumeBanner() {
  const snap = exam ? null : readSavedProgress();
  const banner = $("resume-banner");
  if (!snap || !snap.questions || !snap.questions.length) {
    banner.classList.add("hidden");
    return;
  }
  const answered = Object.keys(snap.answers || {}).length;
  $("resume-info").textContent =
    `${snap.mode === "full" ? "全真模拟 Full mock" : "模拟考试 Mock exam"} · ` +
    `第 ${snap.index + 1} / ${snap.total} 题 · 已答 ${answered} 题 · 已用 ${fmtClock(snap.elapsedAtSave || 0)}`;
  banner.classList.remove("hidden");
}

$("resume-btn").addEventListener("click", async () => {
  const snap = readSavedProgress();
  if (!snap) return;
  try {
    // The server-side exam must still be open; it may have been
    // submitted or deleted elsewhere since the snapshot was saved.
    const d = await api(`/api/exams/${snap.exam_id}`);
    if (d.status !== "in_progress") {
      clearSavedProgress();
      checkResumeBanner();
      alert("这场考试已不在进行中（可能已提交或删除），无法继续。\nThis exam is no longer in progress.");
      return;
    }
  } catch (e) {
    clearSavedProgress();
    checkResumeBanner();
    alert("无法恢复这场考试： " + e.message);
    return;
  }
  exam = {
    exam_id: snap.exam_id,
    mode: snap.mode || "random",
    questions: snap.questions,
    answers: snap.answers || {},
    index: snap.index || 0,
    total: snap.total,
    timeLimit: snap.timeLimit,
    startedAt: Date.now() - (snap.elapsedAtSave || 0) * 1000,
    pausedTotal: 0,
    paused: !!snap.paused,
    pauseStartedAt: snap.paused ? Date.now() : null,
  };
  $("exam-truncated").classList.add("hidden");
  if (exam.paused) applyPauseUI(true);
  startTimer();
  renderQuestion();
  showView("exam");
});

$("discard-btn").addEventListener("click", () => {
  if (!confirm("放弃这场未完成的考试？服务器上的记录仍会留在历史记录里，可以在那里删除。\nDiscard this unfinished exam? Its server record stays in History, where you can delete it.")) return;
  clearSavedProgress();
  checkResumeBanner();
});

// ---------------------------------------------------------------- exam

$("start-btn").addEventListener("click", async () => {
  $("start-error").textContent = "";
  const selected = document.querySelector('input[name="count"]:checked').value;
  let body;
  if (selected === "full") body = { mode: "full" };
  else if (selected === "all") body = {};
  else body = { count: parseInt(selected, 10) };
  try {
    const data = await api("/api/exams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    exam = {
      exam_id: data.exam_id,
      mode: data.mode || "random",
      questions: data.questions,
      answers: {},
      index: 0,
      total: data.total,
      timeLimit: data.time_limit_seconds,
      startedAt: Date.now(),
      pausedTotal: 0,
      paused: false,
      pauseStartedAt: null,
    };
    $("exam-truncated").classList.toggle("hidden", !data.truncated);
    if (data.truncated) {
      $("exam-truncated").textContent = data.mode === "full"
        ? `题库中部分分类题目不足，本次全真模拟共 ${data.total} 题（应为 135 题）。Some sections are short of questions; this full mock has ${data.total} questions (expected 135).`
        : `题库只有 ${data.total} 题，已用全部题库出题（请求 ${data.requested} 题）。` +
          ` The bank has only ${data.total} questions; all were used (requested ${data.requested}).`;
    }
    resetPauseUI();
    startTimer();
    renderQuestion();
    showView("exam");
    saveProgress();
  } catch (e) {
    $("start-error").textContent = "开始考试失败： " + e.message;
  }
});

// Elapsed exam time in ms, excluding time spent paused.
function examElapsedMs() {
  if (!exam) return 0;
  let paused = exam.pausedTotal || 0;
  if (exam.paused && exam.pauseStartedAt) paused += Date.now() - exam.pauseStartedAt;
  return Math.max(0, Date.now() - exam.startedAt - paused);
}

function startTimer() {
  stopTimer();
  updateTimerDisplay();
  timerId = setInterval(() => {
    if (!exam) return stopTimer();
    updateTimerDisplay();
    // Persist periodically so a refresh loses at most ~10s of progress.
    if (Date.now() - lastSaveAt > 10000) saveProgress();
  }, 500);
}

function updateTimerDisplay() {
  if (!exam) return;
  const elapsed = Math.floor(examElapsedMs() / 1000);
  const remaining = exam.timeLimit - elapsed;
  const el = $("exam-timer");
  if (remaining >= 0) {
    el.textContent = `⏱ 剩余 ${fmtClock(remaining)} · 已用 ${fmtClock(elapsed)}`;
    el.classList.remove("overtime");
  } else {
    // Timer behavior: past 0, count UP as overtime — no auto-submit.
    el.textContent = `⏱ 超时 +${fmtClock(-remaining)} · 已用 ${fmtClock(elapsed)}`;
    el.classList.add("overtime");
  }
}

function stopTimer() {
  if (timerId) clearInterval(timerId);
  timerId = null;
}

// ---------------------------------------------------------------- pause

function applyPauseUI(paused) {
  $("view-exam").classList.toggle("paused", paused);
  $("pause-overlay").classList.toggle("hidden", !paused);
  $("pause-btn").textContent = paused ? "▶ 继续 Resume" : "⏸ 暂停 Pause";
  $("prev-btn").disabled = paused || exam.index === 0;
  $("next-btn").disabled = paused || exam.index === exam.total - 1;
  $("submit-btn").disabled = paused;
}

function resetPauseUI() {
  $("view-exam").classList.remove("paused");
  $("pause-overlay").classList.add("hidden");
  $("pause-btn").textContent = "⏸ 暂停 Pause";
}

function pauseExam() {
  if (!exam || exam.paused) return;
  exam.paused = true;
  exam.pauseStartedAt = Date.now();
  applyPauseUI(true);
  updateTimerDisplay(); // freeze the display at the pause moment
  saveProgress();
}

function resumeExam() {
  if (!exam || !exam.paused) return;
  exam.pausedTotal += Date.now() - exam.pauseStartedAt;
  exam.paused = false;
  exam.pauseStartedAt = null;
  applyPauseUI(false);
  saveProgress();
}

$("pause-btn").addEventListener("click", () => {
  if (!exam) return;
  exam.paused ? resumeExam() : pauseExam();
});
$("overlay-resume-btn").addEventListener("click", resumeExam);

function renderQuestion() {
  const q = exam.questions[exam.index];
  $("exam-progress").textContent =
    `${exam.mode === "full" ? "全真模拟 Full Mock · " : ""}` +
    `第 ${exam.index + 1} / ${exam.total} 题 · Question ${exam.index + 1} of ${exam.total}`;
  const picked = exam.answers[q.id];
  $("question-box").innerHTML = `
    <div class="question-card">
      ${q.category ? `<span class="category">${escapeHtml(catLabel(q.category))}</span>` : ""}
      <h3>${escapeHtml(q.question)}</h3>
      ${q.options.map((opt, i) => `
        <button class="option ${picked === i ? "selected" : ""}" data-opt="${i}">
          <strong>${LETTERS[i]}.</strong> ${escapeHtml(opt)}
        </button>`).join("")}
    </div>`;
  document.querySelectorAll("#question-box .option").forEach((btn) => {
    btn.addEventListener("click", () => {
      exam.answers[q.id] = parseInt(btn.dataset.opt, 10);
      saveProgress();
      renderQuestion();
    });
  });
  $("prev-btn").disabled = exam.paused || exam.index === 0;
  $("next-btn").disabled = exam.paused || exam.index === exam.total - 1;
}

$("prev-btn").addEventListener("click", () => {
  if (exam.index > 0) { exam.index--; saveProgress(); renderQuestion(); }
});
$("next-btn").addEventListener("click", () => {
  if (exam.index < exam.total - 1) { exam.index++; saveProgress(); renderQuestion(); }
});

$("submit-btn").addEventListener("click", async () => {
  $("submit-error").textContent = "";
  const answered = Object.keys(exam.answers).length;
  const unanswered = exam.total - answered;
  if (unanswered > 0 &&
      !confirm(`还有 ${unanswered} 题未作答，确认交卷吗？\n${unanswered} question(s) unanswered. Submit anyway?`)) {
    return;
  }
  const elapsed = Math.floor(examElapsedMs() / 1000);
  const timeLimit = exam.timeLimit;
  const examId = exam.exam_id;
  const examMode = exam.mode;
  try {
    const data = await api(`/api/exams/${examId}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: exam.answers, elapsed_seconds: elapsed }),
    });
    stopTimer();
    exam = null;
    clearSavedProgress();
    resetPauseUI();
    lastExamId = examId;
    lastExamTime = { elapsed, timeLimit };
    $("result-score").textContent =
      `得分 Score: ${data.score} / ${data.total} (${data.total ? Math.round(100 * data.score / data.total) : 0}%)`;
    $("result-time").textContent =
      `${examMode === "full" ? "全真模拟 Full Mock · " : ""}` +
      `用时 ${fmtClock(elapsed)}（限时 ${fmtClock(timeLimit)}）· Time used ${fmtClock(elapsed)} of ${fmtClock(timeLimit)}` +
      (elapsed > timeLimit ? " · 超时 overtime" : "");
    $("result-breakdown").innerHTML = data.results.map(renderResultItem).join("");
    showView("result");
    refreshWrongCount();
  } catch (e) {
    $("submit-error").textContent = "交卷失败： " + e.message;
  }
});

$("result-review-btn").addEventListener("click", () => {
  if (lastExamId) loadDebrief(lastExamId);
});

function renderResultItem(r) {
  const chosenText = r.chosen === null || r.chosen === undefined
    ? "未作答 Unanswered"
    : `${LETTERS[r.chosen]}. ${r.options[r.chosen]}`;
  return `
    <div class="question-card result-item ${r.correct ? "" : "incorrect"}">
      ${r.category ? `<span class="category">${escapeHtml(catLabel(r.category))}</span>` : ""}
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
        ${item.category ? `<span class="category">${escapeHtml(catLabel(item.category))}</span>` : ""}
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

// ---------------------------------------------------------------- import

$("import-btn").addEventListener("click", () => $("import-file").click());
$("import-file").addEventListener("change", async () => {
  const file = $("import-file").files[0];
  if (!file) return;
  const msg = $("import-msg");
  msg.textContent = "导入中… Importing…";
  msg.className = "muted";
  const form = new FormData();
  form.append("file", file);
  try {
    const data = await api("/api/import", { method: "POST", body: form });
    const r = data.restored, s = data.skipped;
    const skippedTotal = s.user_questions + s.exams + s.wrong_answers + s.wrong_sources;
    msg.textContent =
      `已恢复 Restored: 题目 ${r.user_questions} · 考试 ${r.exams} · 错题 ${r.wrong_answers} · 来源 ${r.wrong_sources}` +
      (skippedTotal ? `；跳过 ${skippedTotal} 条已存在记录 Skipped ${skippedTotal} existing.` : "。");
    msg.className = "success";
    loadHistory();
    refreshWrongCount();
    loadBankInfo();
  } catch (e) {
    msg.textContent = "导入失败： " + e.message;
    msg.className = "error";
  }
  $("import-file").value = "";
});

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
      <div class="history-row ${e.status === "submitted" ? "clickable" : ""}" data-exam="${e.exam_id}">
        <span>${fmtDate(e.submitted_at || e.started_at)} · ${e.question_count} 题` +
        (e.mode === "full" ? " · 全真模拟" : "") +
        (e.elapsed_seconds != null ? ` · 用时 ${fmtClock(e.elapsed_seconds)}` : "") + `</span>
        <span>${e.status === "submitted"
          ? `<strong>${e.score} / ${e.question_count}</strong> (${Math.round(100 * e.score / e.question_count)}%)`
          : "未提交 in progress"}</span>
        <span class="row-actions">
          ${e.status === "submitted" ? `<button class="review-btn" data-exam="${e.exam_id}">复盘 Review</button>` : ""}
          <button class="danger small delete-btn" data-exam="${e.exam_id}">删除 Delete</button>
        </span>
      </div>`).join("");
    list.querySelectorAll(".history-row.clickable").forEach((row) => {
      row.addEventListener("click", (ev) => {
        if (ev.target.closest("button")) return; // buttons handle themselves
        loadDebrief(row.dataset.exam);
      });
    });
    list.querySelectorAll(".review-btn").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        loadDebrief(btn.dataset.exam);
      });
    });
    list.querySelectorAll(".delete-btn").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        deleteHistory(btn.dataset.exam);
      });
    });
  } catch (e) {
    list.innerHTML = `<p class="error">加载失败： ${escapeHtml(e.message)}</p>`;
  }
}

async function deleteHistory(examId) {
  if (!confirm("确定删除这条历史记录吗？只来自这场考试的错题也会一起从错题本中移除，此操作无法撤销。\nDelete this exam? Wrong-answer entries that came only from it will also be removed. This cannot be undone.")) return;
  try {
    const res = await api(`/api/exams/${examId}`, { method: "DELETE" });
    const removed = res.wrong_removed ? res.wrong_removed.length : 0;
    const kept = res.wrong_kept ? res.wrong_kept.length : 0;
    alert(`已删除。Deleted.\n错题本：移除了 ${removed} 道只来自这场考试的错题` +
      (kept ? `，保留了 ${kept} 道在别的考试里也答错过的题目。` : "。") +
      `\nWrong-answer set: removed ${removed} item(s) that came only from this exam` +
      (kept ? `, kept ${kept} also missed in another exam.` : "."));
    loadHistory();
    refreshWrongCount();
  } catch (e) {
    alert("删除失败： " + e.message);
  }
}

// ---------------------------------------------------------------- exam debrief （复盘）

async function loadDebrief(examId) {
  try {
    const d = await api(`/api/exams/${examId}`);
    if (d.status !== "submitted" || !d.results) {
      alert("本次考试尚未提交，无复盘内容。\nThis exam was never submitted.");
      return;
    }
    debrief = { examId, results: d.results, filter: "all" };
    $("debrief-meta").textContent =
      `${d.mode === "full" ? "全真模拟 Full Mock · " : ""}` +
      `${fmtDate(d.submitted_at)} · ${d.question_count} 题 · ` +
      (d.elapsed_seconds != null ? `用时 ${fmtClock(d.elapsed_seconds)} · ` : "") +
      `限时 ${fmtClock(d.time_limit_seconds)}`;
    const pct = d.question_count ? Math.round(100 * d.score / d.question_count) : 0;
    $("debrief-score").textContent =
      `得分 Score: ${d.score} / ${d.question_count} (${pct}%)` +
      (pct >= 80 ? " · 达到 80% 通过线 Passed the 80% bar ✓" : " · 未到 80% 通过线 Below the 80% bar");
    renderDebriefCategories(d.results);
    document.querySelectorAll(".filter-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.filter === "all");
      b.textContent =
        b.dataset.filter === "all" ? `全部 All (${d.results.length})` :
        b.dataset.filter === "wrong" ? `答错 Wrong (${d.results.filter((r) => !r.correct).length})` :
        `答对 Correct (${d.results.filter((r) => r.correct).length})`;
    });
    renderDebriefList();
    showView("debrief");
  } catch (e) {
    alert("加载复盘失败： " + e.message);
  }
}

function renderDebriefCategories(results) {
  const stats = {};
  for (const r of results) {
    const c = r.category || "uncategorized";
    stats[c] = stats[c] || { total: 0, correct: 0 };
    stats[c].total++;
    if (r.correct) stats[c].correct++;
  }
  const ordered = CATEGORY_ORDER.filter((c) => stats[c])
    .concat(Object.keys(stats).filter((c) => !CATEGORY_ORDER.includes(c)));
  $("debrief-categories").innerHTML = ordered.map((c) => {
    const s = stats[c];
    const pct = s.total ? Math.round(100 * s.correct / s.total) : 0;
    return `
      <div class="cat-stat">
        <span class="cat-stat-label">${escapeHtml(catLabel(c))}</span>
        <span class="cat-stat-bar"><span class="cat-stat-fill" style="width:${pct}%"></span></span>
        <span class="cat-stat-nums">${s.correct} / ${s.total} · ${pct}%</span>
      </div>`;
  }).join("");
}

function renderDebriefList() {
  if (!debrief) return;
  const filtered = debrief.results.filter((r) =>
    debrief.filter === "all" ||
    (debrief.filter === "wrong" && !r.correct) ||
    (debrief.filter === "correct" && r.correct));
  $("debrief-list").innerHTML = filtered.length
    ? filtered.map(renderResultItem).join("")
    : "<p class='muted'>这一类没有题目。No questions in this filter.</p>";
}

document.querySelectorAll(".filter-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (!debrief) return;
    debrief.filter = btn.dataset.filter;
    document.querySelectorAll(".filter-btn").forEach((b) =>
      b.classList.toggle("active", b === btn));
    renderDebriefList();
  });
});

// ---------------------------------------------------------------- question management （题库管理）

function resetQuestionForm() {
  editingQuestionId = null;
  $("manage-form-title").textContent = "添加题目 Add a Question";
  $("q-submit-btn").textContent = "添加题目 Add Question";
  $("q-cancel-edit-btn").classList.add("hidden");
  $("question-form").reset();
  // NOTE: intentionally does not clear q-form-msg — the submit handler
  // sets the success message right after calling this.
}

$("q-cancel-edit-btn").addEventListener("click", () => {
  resetQuestionForm();
  $("q-form-msg").textContent = "";
});

$("question-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const msg = $("q-form-msg");
  msg.textContent = "";
  const body = {
    category: $("q-category").value,
    question: $("q-question").value.trim(),
    options: [0, 1, 2, 3].map((i) => $("q-opt-" + i).value.trim()),
    answer: parseInt($("q-answer").value, 10),
    explanation: $("q-explanation").value.trim(),
    source: $("q-source").value.trim(),
  };
  if (!body.question || body.options.some((o) => !o)) {
    msg.textContent = "请填写题目和全部四个选项。Please fill in the question and all four options.";
    msg.className = "error";
    return;
  }
  try {
    let doneMsg;
    if (editingQuestionId) {
      await api(`/api/questions/${editingQuestionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      doneMsg = "已保存修改。Question updated.";
    } else {
      await api("/api/questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      doneMsg = "已添加，立即可以在考试中抽到。Added — it can appear in exams right away.";
    }
    resetQuestionForm();
    msg.textContent = doneMsg;
    msg.className = "success";
    loadManage();
    loadBankInfo();
  } catch (e) {
    msg.textContent = "保存失败： " + e.message;
    msg.className = "error";
  }
});

async function loadManage() {
  const list = $("manage-list");
  list.innerHTML = "<p class='muted'>加载中… Loading…</p>";
  try {
    const [info, data] = await Promise.all([api("/api/bank"), api("/api/questions")]);
    $("manage-bank-info").textContent =
      `题库共 ${info.total} 题：内置 ${info.builtin} 题 + 你添加的 ${info.user_added} 题。` +
      ` Bank: ${info.total} questions (${info.builtin} built-in + ${info.user_added} added by you).`;
    if (!data.items.length) {
      list.innerHTML = "<p>你还没有添加过题目。用上面的表单添加第一道吧。<br>You haven't added any questions yet.</p>";
      return;
    }
    list.innerHTML = data.items.map((item) => `
      <div class="question-card" id="manage-${item.id}">
        <span class="category">${escapeHtml(catLabel(item.category))}</span>
        <span class="meta-line">添加于 added ${fmtDate(item.created_at)}</span>
        <h3>${escapeHtml(item.question)}</h3>
        ${item.options.map((opt, i) => `
          <div class="option ${i === item.answer ? "correct" : ""}">
            <strong>${LETTERS[i]}.</strong> ${escapeHtml(opt)}${i === item.answer ? " ✓" : ""}
          </div>`).join("")}
        ${item.explanation ? `<div class="explanation"><strong>解析 Explanation:</strong> ${escapeHtml(item.explanation)}</div>` : ""}
        <div class="exam-nav">
          <button class="edit-q-btn" data-qid="${item.id}">编辑 Edit</button>
          <button class="danger small delete-q-btn" data-qid="${item.id}">删除 Delete</button>
        </div>
      </div>`).join("");
    list.querySelectorAll(".edit-q-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = data.items.find((q) => q.id === btn.dataset.qid);
        if (!item) return;
        editingQuestionId = item.id;
        $("manage-form-title").textContent = "编辑题目 Edit Question";
        $("q-submit-btn").textContent = "保存修改 Save Changes";
        $("q-cancel-edit-btn").classList.remove("hidden");
        $("q-category").value = item.category;
        $("q-question").value = item.question;
        item.options.forEach((opt, i) => { $("q-opt-" + i).value = opt; });
        $("q-answer").value = String(item.answer);
        $("q-explanation").value = item.explanation || "";
        $("q-source").value = item.source || "";
        $("q-form-msg").textContent = "";
        $("question-form").scrollIntoView({ behavior: "smooth" });
      });
    });
    list.querySelectorAll(".delete-q-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("确定删除这道题目吗？如该题在错题本中也会一并移除。\nDelete this question? It will also be removed from the wrong-answer set if present there.")) return;
        try {
          await api(`/api/questions/${btn.dataset.qid}`, { method: "DELETE" });
          loadManage();
          loadBankInfo();
          refreshWrongCount();
        } catch (e) {
          alert("删除失败： " + e.message);
        }
      });
    });
  } catch (e) {
    list.innerHTML = `<p class="error">加载失败： ${escapeHtml(e.message)}</p>`;
  }
}

// ---------------------------------------------------------------- init

loadBankInfo();
refreshWrongCount();
checkResumeBanner();

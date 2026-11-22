# Court Interpreter Mock Exam Practice 法庭口译模拟考试练习

A small web app for practicing court-interpreter certification exam questions:
timed mock exams (including a full-length 135-question mock that mirrors the
real NCSC written exam), a wrong-answer review set （错题本）, exam history
with per-exam review （复盘）, in-app question management, and JSON export.

Stack: **FastAPI + PostgreSQL (psycopg) + plain HTML/JS** (no frontend build step, no ORM).
Deploys to Render as a Docker web service (free plan), with a free Render
PostgreSQL database. Locally, with `DATABASE_URL` unset, the app falls back
to a SQLite file (`data/app.db`) — see [Data storage](#data-storage).

**Live app:** https://court-interpreter-practice.onrender.com

## Run locally

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```

Then open http://localhost:8000

## The real exam (what the app mirrors)

The NCSC Consortium written exam: **135 multiple-choice questions, 2 hours
15 minutes, 80% to pass** (75 English proficiency, 50 court terms & usage,
10 ethics scenarios in the older breakdown; the current section structure is
below). The **全真模拟 Full Mock** mode samples exactly these counts:

| Part | Section | Questions | Bank |
|---|---|---|---|
| I — General Language Proficiency (75) | 句子填空 Sentence Completion | 9 | 28 |
| | 语境同义词 Synonyms in Context | 8 | 24 |
| | 同义词 Synonyms | 21 | 62 |
| | 反义词 Antonyms | 12 | 36 |
| | 习语 Idioms | 25 | 74 |
| II — Court-Related Terms, Usage, Ethics & Professional Conduct (60) | 法庭句子填空 Court Sentence Completion | 36 | 107 |
| | 法庭知识问答 Court-Related Questions | 10 | 30 |
| | 事件顺序 Sequence of Events | 4 | 12 |
| | 职业行为 Professional Conduct | 2 | 6 |
| | 道德情景 Ethical Scenarios | 8 | 24 |
| **Total** | | **135** | **403** |

Part I vocabulary is GRE-adjacent, with emphasis on words describing a
person's physical characteristics, personality, temper, and behavior
(e.g. loquacious, taciturn, gregarious, phlegmatic, cantankerous).
Questions were written in the style of the NCSC/NY mock exams — none are
copied verbatim from them.

## Question bank

Questions load at startup from `data/questions.json` — a JSON array, one object
per question:

```json
{
  "id": "SYN-001",
  "category": "synonyms",
  "question": "Choose the word closest in meaning to: loquacious",
  "options": ["talkative", "silent", "angry", "wealthy"],
  "answer": 0,
  "explanation": "Loquacious means very talkative.",
  "source": "General vocabulary (GRE-level)"
}
```

- `answer` is the 0-based index into `options`.
- `category` is one of the 10 section slugs above.
- The current file holds **403 questions** (see the table above).
- The app works with any bank size. If an exam requests more questions than
  the bank holds, it uses all available questions and says so in the UI
  (`truncated: true` in the API response). In full-mock mode, a section
  short of questions contributes all it has.

### Adding your own questions （题库管理）

Use **题库管理 Manage Questions** in the app: fill in the category, question,
four options, correct answer, and explanation. User-added questions are stored
in the database (`user_questions`), merged into the bank at startup, and usable in
exams immediately. They can be listed, edited, and deleted from the same page.
Deleting a question also removes it from the wrong-answer set if present.
Built-in questions cannot be edited or deleted from the app.

## Exam modes

- **20 / 50 / 88 题** — random sample from the whole bank, 1 minute per question.
- **全部题库 All** — every question in the bank, 1 minute per question.
- **全真模拟 135 题 Full Mock** — exactly the real exam's per-section counts
  (see table above), 2 hours 15 minutes total.

## Timer behavior

- Each exam gets a countdown: 1 minute per question (2h15m for the full mock).
- The timer shows **remaining time and elapsed time** (`剩余 19:58 · 已用 00:02`).
- At 0:00 it switches to counting **up** as overtime (shown in red, e.g.
  `超时 +02:15 · 已用 22:15`).
- **The exam never auto-submits and never auto-fails.** The user submits when
  ready; elapsed time is recorded with the result and shown on the result
  page, in the history list, and in the review.
- **Pause （暂停）:** the pause button freezes the timer and hides the
  questions until resumed. Elapsed time excludes paused time, and answers
  given so far are kept.
- **Refresh safety:** an in-progress exam is saved to the browser's
  localStorage, so a page refresh offers to resume it where it left off
  (answers, position, and elapsed time preserved). Leaving via the nav
  buttons abandons the exam instead.

## Review （复盘）

Every submitted exam has a review page (from the history list or the result
page): score and time used, per-section accuracy with bars, and every question
with your answer, the correct answer, and the explanation — filterable by
全部 / 答错 / 答对. The 80% pass bar is shown against the score.

## Data storage

All state is server-side in **PostgreSQL** on Render (the `DATABASE_URL` env
var points at the `court-interpreter-practice-db` instance, free plan,
Virginia). The same four tables as before:

- `exams` — every started exam: date, question count, score, time limit,
  elapsed seconds, and per-question results (JSON).
- `wrong_answers` — the 错题本： question id, first/last wrong date, times
  wrong, last exam id. An item is removed when answered correctly on review
  or marked as mastered. Unanswered exam questions count as wrong and also
  land in the set.
- `wrong_sources` — which exam(s) each wrong-answer entry came from. This is
  what makes history deletion cascade correctly (below).
- `user_questions` — questions added in the app (see above).

**Why PostgreSQL, not SQLite:** the app originally stored everything in a
SQLite file (`data/app.db`), but Render's free-tier instance filesystem is
ephemeral — the file was wiped on every restart, and free services spin down
after ~15 min idle, so restarts happened constantly and all records were
lost. PostgreSQL survives restarts and redeploys. Locally, with
`DATABASE_URL` unset, the app still uses SQLite (`data/app.db`) so it runs
with no setup; the SQL is written once (SQLite-style `?` placeholders and
`INSERT OR IGNORE`) and translated to the PostgreSQL dialect by the
`DBConnection` wrapper in `main.py`.

> ⚠️ **Free PostgreSQL expiry:** the free Render PostgreSQL instance expires
> **2026-12-22** (30 days from creation) and its data is deleted then. Before
> that date, either upgrade the database to a paid plan (Render dashboard) or
> export a backup, create a new free instance, point `DATABASE_URL` at it, and
> restore with the import below. Export regularly regardless: the **导出备份
> Export JSON** button (or `GET /api/export`) downloads the full history +
> wrong-answer set + user-added questions.

### Import / restore （导入备份）

The History page has an **导入备份 Import JSON** button (`POST /api/import`):
upload a file previously downloaded via Export and it restores exams, wrong
answers (with their source exams), and user-added questions. Records whose id
already exists are skipped, never duplicated; the response reports how many
records were restored vs skipped in each section. Re-importing the same file
is safe (everything is skipped the second time).

### Deleting history （删除历史记录）

Each history row has a delete button (with a confirm dialog). Deleting an exam
removes its stored per-question results **and** cascades into the 错题本： a
wrong-answer entry is removed only if the deleted exam was its only source
exam; if the same question was also missed in another exam, the entry stays.
Wrong entries with no recorded source exam (unattributed — only possible for
entries created before source tracking existed) are always kept on delete.

Migration note: `wrong_sources` was added after the first release. On startup,
the app backfills it for pre-existing wrong entries by reconstructing sources
from submitted exams' stored results, falling back to each entry's
`last_exam_id` where results can't determine a source. The backfill is
idempotent and runs on every start.

## API endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check → `{"status": "ok"}` |
| GET | `/api/bank` | Bank size + per-section counts + user-added count |
| POST | `/api/exams` | Start an exam. Body: `{"count": 20}`, `{}` for all, or `{"mode": "full"}` for the 135-question mock. Returns exam id, shuffled questions (no answers), time limit. |
| GET | `/api/exams` | List exams (newest first) |
| GET | `/api/exams/{id}` | Exam detail: results if submitted, questions if in progress |
| POST | `/api/exams/{id}/submit` | Submit answers. Body: `{"answers": {"SYN-001": 0}, "elapsed_seconds": 312}`. Returns score + per-question breakdown; wrong answers saved to the review set. |
| DELETE | `/api/exams/{id}` | Delete an exam; cascades into the wrong-answer set (see above). Returns `wrong_removed` / `wrong_kept`. |
| GET | `/api/wrong` | Wrong-answer set with full question data (answer + explanation) and `source_exam_ids` |
| POST | `/api/wrong/{qid}/attempt` | Re-attempt one item. Body: `{"answer": 0}`. Correct → removed from the set. |
| POST | `/api/wrong/{qid}/master` | Mark an item as mastered (removes it) |
| GET | `/api/questions` | List user-added questions |
| POST | `/api/questions` | Add a question. Body: `{"category", "question", "options" (4), "answer" (0-3), "explanation", "source"}` |
| PUT | `/api/questions/{qid}` | Edit a user-added question |
| DELETE | `/api/questions/{qid}` | Delete a user-added question (also removes it from the wrong set) |
| GET | `/api/export` | Download full history + wrong-answer set + user-added questions as JSON |
| POST | `/api/import` | Restore from an export file (multipart file upload). Skips records whose id already exists; reports restored vs skipped counts per section. |

## Deploy to Render

- New **Web Service** from the repo, environment **Docker**.
- Dockerfile is at the repo root; the service listens on Render's injected
  `$PORT` (defaults to 8000 locally).
- Set the **Health Check Path** to `/health`.
- Create a **PostgreSQL** instance (free plan, same region — Virginia) and set
  the service's `DATABASE_URL` env var to its **internal** connection string.
  The app creates its tables on first start. Without `DATABASE_URL` the app
  falls back to SQLite, which loses data on every Render restart — do not run
  the deployed service without it.
- **Auto-deploy does NOT fire for this repo** (the GitHub webhook does not
  deliver): after pushing to `main`, trigger the deploy manually from the
  Render dashboard or via the Render API (`POST /v1/services/{id}/deploys`).
- Free plan: the service sleeps after inactivity (first load after sleep is
  slow). The free PostgreSQL instance expires 30 days after creation — see
  [Data storage](#data-storage).

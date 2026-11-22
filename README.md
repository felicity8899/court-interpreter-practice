# Court Interpreter Mock Exam Practice 法庭口译模拟考试练习

A small web app for practicing court-interpreter certification exam questions:
timed mock exams, a wrong-answer review set （错题本）, exam history, and JSON export.

Stack: **FastAPI + stdlib sqlite3 + plain HTML/JS** (no frontend build step, no ORM).
Deploys to Render as a Docker web service (free plan).

## Run locally

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```

Then open http://localhost:8000

## Question bank

Questions load at startup from `data/questions.json` — a JSON array, one object
per question:

```json
{
  "id": "TERM-001",
  "category": "terminology",
  "question": "...",
  "options": ["...", "...", "...", "..."],
  "answer": 0,
  "explanation": "...",
  "source": "..."
}
```

- `answer` is the 0-based index into `options`.
- The current file holds **6 placeholder questions** (IDs `PLACEHOLDER-001` …
  `PLACEHOLDER-006`, each question text prefixed `[PLACEHOLDER]`). Replace the
  file with the real bank and restart the server (a redeploy on Render does
  this automatically).
- The app works with any bank size. If an exam requests more questions than
  the bank holds, it uses all available questions and says so in the UI
  (`truncated: true` in the API response).

## Timer behavior

- Each exam gets **1 minute per question** (e.g. 20 questions = 20:00).
- The timer counts **down**; at 0:00 it switches to counting **up** as overtime
  (shown in red, e.g. `+02:15 超时 overtime`).
- **The exam never auto-submits and never auto-fails.** The user submits when
  ready; elapsed time is recorded with the result.

## Data storage

All state is server-side in a SQLite file, `data/app.db` (created on first run):

- `exams` — every started exam: date, question count, score, time limit,
  elapsed seconds, and per-question results (JSON).
- `wrong_answers` — the 错题本： question id, first/last wrong date, times
  wrong, last exam id. An item is removed when answered correctly on review
  or marked as mastered. Unanswered exam questions count as wrong and also
  land in the set.

> ⚠️ **Render free-tier caveat:** the disk is ephemeral — `data/app.db` is
> wiped on every redeploy. Use the **Export JSON** button (or
> `GET /api/export`) to download the full history + wrong-answer set as a
> backup before redeploying. There is no import endpoint yet; the export is a
> human-readable backup.

## API endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check → `{"status": "ok"}` |
| GET | `/api/bank` | Bank size + per-category counts |
| POST | `/api/exams` | Start an exam. Body: `{"count": 20}` or `{}` for all. Returns exam id, shuffled questions (no answers), time limit. |
| GET | `/api/exams` | List exams (newest first) |
| GET | `/api/exams/{id}` | Exam detail: results if submitted, questions if in progress |
| POST | `/api/exams/{id}/submit` | Submit answers. Body: `{"answers": {"TERM-001": 0}, "elapsed_seconds": 312}`. Returns score + per-question breakdown; wrong answers saved to the review set. |
| GET | `/api/wrong` | Wrong-answer set with full question data (answer + explanation) |
| POST | `/api/wrong/{qid}/attempt` | Re-attempt one item. Body: `{"answer": 0}`. Correct → removed from the set. |
| POST | `/api/wrong/{qid}/master` | Mark an item as mastered (removes it) |
| GET | `/api/export` | Download full history + wrong-answer set as JSON |

## Deploy to Render

- New **Web Service** from the repo, environment **Docker**.
- Dockerfile is at the repo root; the service listens on Render's injected
  `$PORT` (defaults to 8000 locally).
- Set the **Health Check Path** to `/health`.
- Free plan: the service sleeps after inactivity (first load after sleep is
  slow) and the SQLite file is lost on redeploy — export regularly.

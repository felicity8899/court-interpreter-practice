"""Court Interpreter Mock Exam Practice — FastAPI backend + static frontend.

Question bank: the built-in bank loads from data/questions.json; questions the
user adds in the app live in SQLite (user_questions) and are merged in at
startup, so they appear in exams immediately and survive restarts.

Exam history and the wrong-answer set （错题本） live in a SQLite file
(data/app.db) via the stdlib sqlite3 module — no ORM, no extra dependencies.
wrong_sources tracks which exam(s) each wrong-answer entry came from, so
deleting an exam removes only the wrong entries that came solely from it.

Timer behavior (see README): the exam timer counts down from 1 minute per
question; at 0 it switches to counting UP as overtime (shown in red) and the
exam stays open until the user submits. Nothing auto-fails or auto-submits.
The frontend pause feature freezes the timer (elapsed time excludes pauses).
"""

import json
import random
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
STATIC_DIR = BASE_DIR / "static"
DB_PATH = DATA_DIR / "app.db"
QUESTIONS_PATH = DATA_DIR / "questions.json"

SECONDS_PER_QUESTION = 60

app = FastAPI(title="Court Interpreter Mock Exam Practice")


# ---------------------------------------------------------------------------
# Question bank (loaded once at startup)
# ---------------------------------------------------------------------------

def load_bank() -> dict[str, dict]:
    """Built-in JSON bank merged with user-added questions from SQLite.

    User-added questions carry "user_added": True. They are loaded on every
    startup and also added to the in-memory BANK immediately when created
    through the API, so a new question is usable in exams right away.
    """
    with open(QUESTIONS_PATH, encoding="utf-8") as f:
        bank = json.load(f)
    merged = {q["id"]: q for q in bank}
    try:
        conn = get_db()
        rows = conn.execute("SELECT * FROM user_questions").fetchall()
        conn.close()
    except sqlite3.Error:
        rows = []
    for r in rows:
        merged[r["id"]] = {
            "id": r["id"],
            "category": r["category"],
            "question": r["question"],
            "options": json.loads(r["options"]),
            "answer": r["answer"],
            "explanation": r["explanation"],
            "source": r["source"],
            "user_added": True,
        }
    return merged


# BANK is populated after init_db() runs below (load_bank reads the
# user_questions table, so the schema must exist first).


def public_question(q: dict) -> dict:
    """Question as sent to the exam taker: no answer, no explanation."""
    return {
        "id": q["id"],
        "category": q.get("category", ""),
        "question": q["question"],
        "options": q["options"],
        "source": q.get("source", ""),
    }


# ---------------------------------------------------------------------------
# SQLite persistence (stdlib sqlite3, one connection per call)
# ---------------------------------------------------------------------------

def get_db() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = get_db()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS exams (
            id TEXT PRIMARY KEY,
            started_at TEXT NOT NULL,
            submitted_at TEXT,
            question_count INTEGER NOT NULL,
            score INTEGER,
            time_limit_seconds INTEGER NOT NULL,
            elapsed_seconds INTEGER,
            question_ids TEXT NOT NULL,
            results TEXT,
            mode TEXT NOT NULL DEFAULT 'random'
        );
        CREATE TABLE IF NOT EXISTS wrong_answers (
            question_id TEXT PRIMARY KEY,
            first_wrong_at TEXT NOT NULL,
            last_wrong_at TEXT NOT NULL,
            times_wrong INTEGER NOT NULL,
            last_exam_id TEXT
        );
        CREATE TABLE IF NOT EXISTS wrong_sources (
            question_id TEXT NOT NULL,
            exam_id TEXT NOT NULL,
            PRIMARY KEY (question_id, exam_id)
        );
        CREATE TABLE IF NOT EXISTS user_questions (
            id TEXT PRIMARY KEY,
            category TEXT NOT NULL,
            question TEXT NOT NULL,
            options TEXT NOT NULL,
            answer INTEGER NOT NULL,
            explanation TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        );
        """
    )
    conn.commit()
    # Migration: exams.mode added after the first release (fresh DBs get it
    # from the CREATE TABLE above; existing DBs get it here).
    try:
        conn.execute(
            "ALTER TABLE exams ADD COLUMN mode TEXT NOT NULL DEFAULT 'random'"
        )
        conn.commit()
    except sqlite3.OperationalError:
        pass  # column already exists
    backfill_wrong_sources(conn)
    conn.close()


def backfill_wrong_sources(conn: sqlite3.Connection) -> None:
    """One-time (idempotent) migration for wrong-answer entries created
    before source tracking existed: reconstruct each entry's source exams
    from submitted exams' stored per-question results, falling back to the
    entry's last_exam_id where results can't determine a source. Entries
    that still end up with no source row are treated as unattributed and
    are never removed by an exam delete (see delete_exam)."""
    try:
        wrong_qids = {
            r["question_id"]
            for r in conn.execute("SELECT question_id FROM wrong_answers").fetchall()
        }
        if not wrong_qids:
            return
        for row in conn.execute(
            "SELECT id, results FROM exams WHERE results IS NOT NULL"
        ).fetchall():
            try:
                results = json.loads(row["results"])
            except (TypeError, ValueError):
                continue
            for res in results:
                qid = res.get("question_id")
                if qid in wrong_qids and not res.get("correct"):
                    conn.execute(
                        "INSERT OR IGNORE INTO wrong_sources "
                        "(question_id, exam_id) VALUES (?, ?)",
                        (qid, row["id"]),
                    )
        for row in conn.execute(
            "SELECT question_id, last_exam_id FROM wrong_answers "
            "WHERE last_exam_id IS NOT NULL"
        ).fetchall():
            has_source = conn.execute(
                "SELECT 1 FROM wrong_sources WHERE question_id = ? LIMIT 1",
                (row["question_id"],),
            ).fetchone()
            if not has_source:
                conn.execute(
                    "INSERT OR IGNORE INTO wrong_sources "
                    "(question_id, exam_id) VALUES (?, ?)",
                    (row["question_id"], row["last_exam_id"]),
                )
        conn.commit()
    except sqlite3.Error:
        conn.rollback()


init_db()


BANK = load_bank()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class StartExamRequest(BaseModel):
    count: int | None = None  # None = all questions in the bank
    mode: str = "random"  # "random" or "full" (full-length 135 mock)


def sample_full_mock() -> tuple[list[str], dict[str, int]]:
    """Sample a full-length mock exam: exactly the real exam's per-section
    counts. If a section holds fewer questions than needed, all of them
    are used; the returned dict reports the per-section counts actually
    drawn so the caller can flag a shortfall."""
    by_section: dict[str, list[str]] = {}
    for qid, q in BANK.items():
        by_section.setdefault(q.get("category", ""), []).append(qid)
    chosen: list[str] = []
    drawn: dict[str, int] = {}
    for section, needed in FULL_MOCK_STRUCTURE.items():
        pool = by_section.get(section, [])
        random.shuffle(pool)
        take = pool[:needed]
        drawn[section] = len(take)
        chosen.extend(take)
    random.shuffle(chosen)
    return chosen, drawn


class SubmitExamRequest(BaseModel):
    answers: dict[str, int | None] = {}
    elapsed_seconds: int | None = None


class AttemptRequest(BaseModel):
    answer: int


class QuestionRequest(BaseModel):
    category: str
    question: str
    options: list[str]
    answer: int
    explanation: str = ""
    source: str = ""


CATEGORIES = [
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
]

# The real NCSC written exam: 135 questions, 2h15m. The full-mock mode
# samples exactly these counts per section (Part I 75, Part II 60).
FULL_MOCK_STRUCTURE: dict[str, int] = {
    "sentence-completion": 9,
    "synonyms-in-context": 8,
    "synonyms": 21,
    "antonyms": 12,
    "idioms": 25,
    "court-sentence-completion": 36,
    "court-questions": 10,
    "sequence": 4,
    "professional-conduct": 2,
    "ethical-scenarios": 8,
}
FULL_MOCK_TOTAL = sum(FULL_MOCK_STRUCTURE.values())  # 135
FULL_MOCK_TIME_LIMIT = 135 * 60  # 2h15m = 8100 seconds


def validate_question_body(req: QuestionRequest) -> None:
    """400 unless the question is well-formed: known category, non-empty
    question, exactly 4 non-empty options, answer a valid option index."""
    if req.category not in CATEGORIES:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown category: {req.category}. "
            f"Must be one of: {', '.join(CATEGORIES)}.",
        )
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="Question text is empty.")
    if len(req.options) != 4 or any(not o.strip() for o in req.options):
        raise HTTPException(
            status_code=400, detail="Exactly 4 non-empty options are required."
        )
    if req.answer not in (0, 1, 2, 3):
        raise HTTPException(
            status_code=400, detail="Answer must be an option index 0-3."
        )


# ---------------------------------------------------------------------------
# Health + bank info
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/api/bank")
def bank_info():
    categories: dict[str, int] = {}
    user_added = 0
    for q in BANK.values():
        cat = q.get("category", "uncategorized")
        categories[cat] = categories.get(cat, 0) + 1
        if q.get("user_added"):
            user_added += 1
    return {
        "total": len(BANK),
        "categories": categories,
        "user_added": user_added,
        "builtin": len(BANK) - user_added,
    }


# ---------------------------------------------------------------------------
# Exams
# ---------------------------------------------------------------------------

@app.post("/api/exams")
def start_exam(req: StartExamRequest):
    """Start a new timed mock exam. Random mode shuffles the bank and takes
    `count` questions (all of them if count is None). Full mode
    (mode="full") samples exactly the real exam's per-section counts
    (135 questions, 2h15m). If the bank is smaller than requested, all
    available questions are used and `truncated` is True."""
    if not BANK:
        raise HTTPException(status_code=400, detail="Question bank is empty.")
    exam_id = uuid.uuid4().hex[:12]
    if req.mode == "full":
        chosen, drawn = sample_full_mock()
        total = len(chosen)
        requested = FULL_MOCK_TOTAL
        time_limit = FULL_MOCK_TIME_LIMIT
        section_counts = drawn
        if total == 0:
            raise HTTPException(
                status_code=400,
                detail="The question bank has no questions in the "
                "full-mock sections yet.",
            )
    elif req.mode == "random":
        requested = req.count if req.count is not None else len(BANK)
        if requested < 1:
            raise HTTPException(status_code=400, detail="Count must be at least 1.")
        ids = list(BANK.keys())
        random.shuffle(ids)
        chosen = ids[:requested]
        total = len(chosen)
        time_limit = total * SECONDS_PER_QUESTION
        section_counts = None
    else:
        raise HTTPException(
            status_code=400, detail='mode must be "random" or "full".'
        )
    conn = get_db()
    conn.execute(
        "INSERT INTO exams (id, started_at, submitted_at, question_count, "
        "score, time_limit_seconds, elapsed_seconds, question_ids, results, mode) "
        "VALUES (?, ?, NULL, ?, NULL, ?, NULL, ?, NULL, ?)",
        (exam_id, now_iso(), total, time_limit, json.dumps(chosen), req.mode),
    )
    conn.commit()
    conn.close()
    return {
        "exam_id": exam_id,
        "mode": req.mode,
        "total": total,
        "requested": requested,
        "truncated": total < requested,
        "time_limit_seconds": time_limit,
        "section_counts": section_counts,
        "questions": [public_question(BANK[qid]) for qid in chosen],
    }


@app.get("/api/exams")
def list_exams():
    conn = get_db()
    rows = conn.execute(
        "SELECT id, started_at, submitted_at, question_count, score, "
        "time_limit_seconds, elapsed_seconds, mode FROM exams "
        "ORDER BY started_at DESC"
    ).fetchall()
    conn.close()
    return [
        {
            "exam_id": r["id"],
            "started_at": r["started_at"],
            "submitted_at": r["submitted_at"],
            "status": "submitted" if r["submitted_at"] else "in_progress",
            "question_count": r["question_count"],
            "score": r["score"],
            "time_limit_seconds": r["time_limit_seconds"],
            "elapsed_seconds": r["elapsed_seconds"],
            "mode": r["mode"],
        }
        for r in rows
    ]


@app.get("/api/exams/{exam_id}")
def exam_detail(exam_id: str):
    conn = get_db()
    row = conn.execute("SELECT * FROM exams WHERE id = ?", (exam_id,)).fetchone()
    conn.close()
    if row is None:
        raise HTTPException(status_code=404, detail="Exam not found.")
    detail = {
        "exam_id": row["id"],
        "started_at": row["started_at"],
        "submitted_at": row["submitted_at"],
        "status": "submitted" if row["submitted_at"] else "in_progress",
        "question_count": row["question_count"],
        "score": row["score"],
        "time_limit_seconds": row["time_limit_seconds"],
        "elapsed_seconds": row["elapsed_seconds"],
        "mode": row["mode"] if "mode" in row.keys() else "random",
    }
    if row["results"]:
        detail["results"] = json.loads(row["results"])
    else:
        qids = json.loads(row["question_ids"])
        detail["questions"] = [
            public_question(BANK[qid]) for qid in qids if qid in BANK
        ]
    return detail


@app.post("/api/exams/{exam_id}/submit")
def submit_exam(exam_id: str, req: SubmitExamRequest):
    conn = get_db()
    row = conn.execute("SELECT * FROM exams WHERE id = ?", (exam_id,)).fetchone()
    if row is None:
        conn.close()
        raise HTTPException(status_code=404, detail="Exam not found.")
    if row["submitted_at"]:
        conn.close()
        raise HTTPException(status_code=400, detail="Exam already submitted.")

    qids = json.loads(row["question_ids"])
    results = []
    score = 0
    submitted_at = now_iso()
    for qid in qids:
        q = BANK.get(qid)
        if q is None:
            continue  # question removed from the bank since the exam started
        chosen = req.answers.get(qid)
        correct = chosen is not None and chosen == q["answer"]
        if correct:
            score += 1
        else:
            # Upsert into the wrong-answer set （错题本） and record this
            # exam as a source, so deleting the exam can cascade correctly.
            conn.execute(
                "INSERT OR IGNORE INTO wrong_sources (question_id, exam_id) "
                "VALUES (?, ?)",
                (qid, exam_id),
            )
            existing = conn.execute(
                "SELECT times_wrong FROM wrong_answers WHERE question_id = ?",
                (qid,),
            ).fetchone()
            if existing:
                conn.execute(
                    "UPDATE wrong_answers SET last_wrong_at = ?, "
                    "times_wrong = times_wrong + 1, last_exam_id = ? "
                    "WHERE question_id = ?",
                    (submitted_at, exam_id, qid),
                )
            else:
                conn.execute(
                    "INSERT INTO wrong_answers (question_id, first_wrong_at, "
                    "last_wrong_at, times_wrong, last_exam_id) "
                    "VALUES (?, ?, ?, 1, ?)",
                    (qid, submitted_at, submitted_at, exam_id),
                )
        results.append(
            {
                "question_id": qid,
                "category": q.get("category", ""),
                "question": q["question"],
                "options": q["options"],
                "chosen": chosen,
                "answer": q["answer"],
                "correct": correct,
                "explanation": q.get("explanation", ""),
                "source": q.get("source", ""),
            }
        )

    conn.execute(
        "UPDATE exams SET submitted_at = ?, score = ?, elapsed_seconds = ?, "
        "results = ? WHERE id = ?",
        (submitted_at, score, req.elapsed_seconds, json.dumps(results), exam_id),
    )
    conn.commit()
    conn.close()
    return {
        "exam_id": exam_id,
        "score": score,
        "total": len(results),
        "results": results,
    }


@app.delete("/api/exams/{exam_id}")
def delete_exam(exam_id: str):
    """Delete an exam record and cascade into the wrong-answer set: a wrong
    entry is removed only if this exam was its only source exam; entries
    also missed in another exam stay. Wrong entries with no recorded source
    (unattributed, e.g. predating source tracking) are always kept."""
    conn = get_db()
    row = conn.execute("SELECT id FROM exams WHERE id = ?", (exam_id,)).fetchone()
    if row is None:
        conn.close()
        raise HTTPException(status_code=404, detail="Exam not found.")
    sourced = [
        r["question_id"]
        for r in conn.execute(
            "SELECT question_id FROM wrong_sources WHERE exam_id = ?",
            (exam_id,),
        ).fetchall()
    ]
    conn.execute("DELETE FROM wrong_sources WHERE exam_id = ?", (exam_id,))
    removed: list[str] = []
    kept: list[str] = []
    for qid in sourced:
        remaining = conn.execute(
            "SELECT 1 FROM wrong_sources WHERE question_id = ? LIMIT 1",
            (qid,),
        ).fetchone()
        if remaining:
            kept.append(qid)
        else:
            conn.execute(
                "DELETE FROM wrong_answers WHERE question_id = ?", (qid,)
            )
            removed.append(qid)
    conn.execute("DELETE FROM exams WHERE id = ?", (exam_id,))
    conn.commit()
    conn.close()
    return {
        "exam_id": exam_id,
        "deleted": True,
        "wrong_removed": removed,
        "wrong_kept": kept,
    }


# ---------------------------------------------------------------------------
# Wrong-answer review （错题本）
# ---------------------------------------------------------------------------

@app.get("/api/wrong")
def list_wrong():
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM wrong_answers ORDER BY last_wrong_at DESC"
    ).fetchall()
    sources: dict[str, list[str]] = {}
    for s in conn.execute(
        "SELECT question_id, exam_id FROM wrong_sources"
    ).fetchall():
        sources.setdefault(s["question_id"], []).append(s["exam_id"])
    conn.close()
    items = []
    for r in rows:
        q = BANK.get(r["question_id"])
        if q is None:
            continue  # question removed from the bank
        items.append(
            {
                "question_id": r["question_id"],
                "first_wrong_at": r["first_wrong_at"],
                "last_wrong_at": r["last_wrong_at"],
                "times_wrong": r["times_wrong"],
                "last_exam_id": r["last_exam_id"],
                "source_exam_ids": sources.get(r["question_id"], []),
                "category": q.get("category", ""),
                "question": q["question"],
                "options": q["options"],
                "answer": q["answer"],
                "explanation": q.get("explanation", ""),
                "source": q.get("source", ""),
            }
        )
    return {"count": len(items), "items": items}


@app.post("/api/wrong/{question_id}/attempt")
def attempt_wrong(question_id: str, req: AttemptRequest):
    """Re-attempt a wrong-answer item. Answering correctly removes it from
    the set; a wrong attempt increments its times_wrong counter."""
    q = BANK.get(question_id)
    if q is None:
        raise HTTPException(status_code=404, detail="Question not found.")
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM wrong_answers WHERE question_id = ?", (question_id,)
    ).fetchone()
    if row is None:
        conn.close()
        raise HTTPException(
            status_code=404, detail="Question is not in the wrong-answer set."
        )
    correct = req.answer == q["answer"]
    if correct:
        conn.execute(
            "DELETE FROM wrong_answers WHERE question_id = ?", (question_id,)
        )
        conn.execute(
            "DELETE FROM wrong_sources WHERE question_id = ?", (question_id,)
        )
    else:
        conn.execute(
            "UPDATE wrong_answers SET last_wrong_at = ?, times_wrong = "
            "times_wrong + 1 WHERE question_id = ?",
            (now_iso(), question_id),
        )
    conn.commit()
    conn.close()
    return {
        "question_id": question_id,
        "correct": correct,
        "answer": q["answer"],
        "explanation": q.get("explanation", ""),
        "removed": correct,
    }


@app.post("/api/wrong/{question_id}/master")
def master_wrong(question_id: str):
    """Mark a wrong-answer item as mastered: remove it from the set."""
    conn = get_db()
    cur = conn.execute(
        "DELETE FROM wrong_answers WHERE question_id = ?", (question_id,)
    )
    conn.execute(
        "DELETE FROM wrong_sources WHERE question_id = ?", (question_id,)
    )
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(
            status_code=404, detail="Question is not in the wrong-answer set."
        )
    return {"question_id": question_id, "removed": True}


# ---------------------------------------------------------------------------
# User-added questions （题库管理 — add / list / edit / delete)
# ---------------------------------------------------------------------------

def user_question_row(r: sqlite3.Row) -> dict:
    return {
        "id": r["id"],
        "category": r["category"],
        "question": r["question"],
        "options": json.loads(r["options"]),
        "answer": r["answer"],
        "explanation": r["explanation"],
        "source": r["source"],
        "created_at": r["created_at"],
        "user_added": True,
    }


@app.get("/api/questions")
def list_user_questions():
    """List the questions the user added in the app (built-in JSON-bank
    questions are not manageable and are not listed here)."""
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM user_questions ORDER BY created_at DESC"
    ).fetchall()
    conn.close()
    return {"count": len(rows), "items": [user_question_row(r) for r in rows]}


@app.post("/api/questions")
def add_user_question(req: QuestionRequest):
    """Add a question. It is stored in SQLite, merged into the in-memory
    bank immediately, and usable in exams right away."""
    validate_question_body(req)
    qid = "USER-" + uuid.uuid4().hex[:8]
    created_at = now_iso()
    q = {
        "id": qid,
        "category": req.category,
        "question": req.question.strip(),
        "options": [o.strip() for o in req.options],
        "answer": req.answer,
        "explanation": req.explanation.strip(),
        "source": req.source.strip() or "user-added",
        "user_added": True,
    }
    conn = get_db()
    conn.execute(
        "INSERT INTO user_questions (id, category, question, options, "
        "answer, explanation, source, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            qid,
            q["category"],
            q["question"],
            json.dumps(q["options"]),
            q["answer"],
            q["explanation"],
            q["source"],
            created_at,
        ),
    )
    conn.commit()
    conn.close()
    BANK[qid] = q
    return {**q, "created_at": created_at}


@app.put("/api/questions/{question_id}")
def update_user_question(question_id: str, req: QuestionRequest):
    """Edit a user-added question. Built-in questions cannot be edited."""
    validate_question_body(req)
    conn = get_db()
    row = conn.execute(
        "SELECT id FROM user_questions WHERE id = ?", (question_id,)
    ).fetchone()
    if row is None:
        conn.close()
        raise HTTPException(
            status_code=404,
            detail="Question not found or not user-added (built-in "
            "questions cannot be edited).",
        )
    conn.execute(
        "UPDATE user_questions SET category = ?, question = ?, options = ?, "
        "answer = ?, explanation = ?, source = ? WHERE id = ?",
        (
            req.category,
            req.question.strip(),
            json.dumps([o.strip() for o in req.options]),
            req.answer,
            req.explanation.strip(),
            req.source.strip() or "user-added",
            question_id,
        ),
    )
    conn.commit()
    updated = conn.execute(
        "SELECT * FROM user_questions WHERE id = ?", (question_id,)
    ).fetchone()
    conn.close()
    q = user_question_row(updated)
    BANK[question_id] = q
    return q


@app.delete("/api/questions/{question_id}")
def delete_user_question(question_id: str):
    """Delete a user-added question. It is also removed from the
    wrong-answer set (and its source records) if present there. Built-in
    questions cannot be deleted."""
    conn = get_db()
    row = conn.execute(
        "SELECT id FROM user_questions WHERE id = ?", (question_id,)
    ).fetchone()
    if row is None:
        conn.close()
        raise HTTPException(
            status_code=404,
            detail="Question not found or not user-added (built-in "
            "questions cannot be deleted).",
        )
    conn.execute("DELETE FROM user_questions WHERE id = ?", (question_id,))
    wrong_cur = conn.execute(
        "DELETE FROM wrong_answers WHERE question_id = ?", (question_id,)
    )
    conn.execute(
        "DELETE FROM wrong_sources WHERE question_id = ?", (question_id,)
    )
    conn.commit()
    conn.close()
    BANK.pop(question_id, None)
    return {
        "question_id": question_id,
        "deleted": True,
        "removed_from_wrong": wrong_cur.rowcount > 0,
    }


# ---------------------------------------------------------------------------
# Export (backup — Render free-tier disk is ephemeral across deploys)
# ---------------------------------------------------------------------------

@app.get("/api/export")
def export_all():
    conn = get_db()
    sources: dict[str, list[str]] = {}
    for s in conn.execute(
        "SELECT question_id, exam_id FROM wrong_sources"
    ).fetchall():
        sources.setdefault(s["question_id"], []).append(s["exam_id"])
    exams = [
        {
            "exam_id": r["id"],
            "started_at": r["started_at"],
            "submitted_at": r["submitted_at"],
            "question_count": r["question_count"],
            "score": r["score"],
            "time_limit_seconds": r["time_limit_seconds"],
            "elapsed_seconds": r["elapsed_seconds"],
            "question_ids": json.loads(r["question_ids"]),
            "results": json.loads(r["results"]) if r["results"] else None,
            "mode": r["mode"],
        }
        for r in conn.execute("SELECT * FROM exams ORDER BY started_at").fetchall()
    ]
    wrong = [
        {
            "question_id": r["question_id"],
            "first_wrong_at": r["first_wrong_at"],
            "last_wrong_at": r["last_wrong_at"],
            "times_wrong": r["times_wrong"],
            "last_exam_id": r["last_exam_id"],
            "source_exam_ids": sources.get(r["question_id"], []),
        }
        for r in conn.execute("SELECT * FROM wrong_answers").fetchall()
    ]
    user_questions = [
        user_question_row(r)
        for r in conn.execute(
            "SELECT * FROM user_questions ORDER BY created_at"
        ).fetchall()
    ]
    conn.close()
    payload = {
        "exported_at": now_iso(),
        "bank_size": len(BANK),
        "user_questions": user_questions,
        "exams": exams,
        "wrong_answers": wrong,
    }
    return JSONResponse(
        content=payload,
        headers={
            "Content-Disposition": (
                "attachment; filename=court-interpreter-practice-export.json"
            )
        },
    )


# ---------------------------------------------------------------------------
# Frontend (static files; index.html at /)
# ---------------------------------------------------------------------------

app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")

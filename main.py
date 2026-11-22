"""Court Interpreter Mock Exam Practice — FastAPI backend + static frontend.

Question bank loads at startup from data/questions.json (see README for the
schema). Exam history and the wrong-answer set （错题本） live in a SQLite file
(data/app.db) via the stdlib sqlite3 module — no ORM, no extra dependencies.

Timer behavior (see README): the exam timer counts down from 1 minute per
question; at 0 it switches to counting UP as overtime (shown in red) and the
exam stays open until the user submits. Nothing auto-fails or auto-submits.
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
    with open(QUESTIONS_PATH, encoding="utf-8") as f:
        bank = json.load(f)
    return {q["id"]: q for q in bank}


BANK = load_bank()


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
            results TEXT
        );
        CREATE TABLE IF NOT EXISTS wrong_answers (
            question_id TEXT PRIMARY KEY,
            first_wrong_at TEXT NOT NULL,
            last_wrong_at TEXT NOT NULL,
            times_wrong INTEGER NOT NULL,
            last_exam_id TEXT
        );
        """
    )
    conn.commit()
    conn.close()


init_db()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class StartExamRequest(BaseModel):
    count: int | None = None  # None = all questions in the bank


class SubmitExamRequest(BaseModel):
    answers: dict[str, int | None] = {}
    elapsed_seconds: int | None = None


class AttemptRequest(BaseModel):
    answer: int


# ---------------------------------------------------------------------------
# Health + bank info
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/api/bank")
def bank_info():
    categories: dict[str, int] = {}
    for q in BANK.values():
        cat = q.get("category", "uncategorized")
        categories[cat] = categories.get(cat, 0) + 1
    return {"total": len(BANK), "categories": categories}


# ---------------------------------------------------------------------------
# Exams
# ---------------------------------------------------------------------------

@app.post("/api/exams")
def start_exam(req: StartExamRequest):
    """Start a new timed mock exam. If the bank is smaller than the requested
    count, all available questions are used and `truncated` is True."""
    if not BANK:
        raise HTTPException(status_code=400, detail="Question bank is empty.")
    requested = req.count if req.count is not None else len(BANK)
    if requested < 1:
        raise HTTPException(status_code=400, detail="Count must be at least 1.")
    ids = list(BANK.keys())
    random.shuffle(ids)
    chosen = ids[:requested]
    total = len(chosen)
    exam_id = uuid.uuid4().hex[:12]
    time_limit = total * SECONDS_PER_QUESTION
    conn = get_db()
    conn.execute(
        "INSERT INTO exams (id, started_at, submitted_at, question_count, "
        "score, time_limit_seconds, elapsed_seconds, question_ids, results) "
        "VALUES (?, ?, NULL, ?, NULL, ?, NULL, ?, NULL)",
        (exam_id, now_iso(), total, time_limit, json.dumps(chosen)),
    )
    conn.commit()
    conn.close()
    return {
        "exam_id": exam_id,
        "total": total,
        "requested": requested,
        "truncated": total < requested,
        "time_limit_seconds": time_limit,
        "questions": [public_question(BANK[qid]) for qid in chosen],
    }


@app.get("/api/exams")
def list_exams():
    conn = get_db()
    rows = conn.execute(
        "SELECT id, started_at, submitted_at, question_count, score, "
        "time_limit_seconds, elapsed_seconds FROM exams "
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
            # Upsert into the wrong-answer set （错题本）.
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


# ---------------------------------------------------------------------------
# Wrong-answer review （错题本）
# ---------------------------------------------------------------------------

@app.get("/api/wrong")
def list_wrong():
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM wrong_answers ORDER BY last_wrong_at DESC"
    ).fetchall()
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
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        raise HTTPException(
            status_code=404, detail="Question is not in the wrong-answer set."
        )
    return {"question_id": question_id, "removed": True}


# ---------------------------------------------------------------------------
# Export (backup — Render free-tier disk is ephemeral across deploys)
# ---------------------------------------------------------------------------

@app.get("/api/export")
def export_all():
    conn = get_db()
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
        }
        for r in conn.execute("SELECT * FROM wrong_answers").fetchall()
    ]
    conn.close()
    payload = {
        "exported_at": now_iso(),
        "bank_size": len(BANK),
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

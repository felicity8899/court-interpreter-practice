# Court Interpreter Mock Exam Practice — web service image.
# Serves main.py with uvicorn; the question bank lives under data/.
# State lives in PostgreSQL (DATABASE_URL env var) — Render's free-tier
# disk is ephemeral, so a SQLite file would be lost on every restart.
# Locally, with DATABASE_URL unset, the app falls back to data/app.db.

FROM python:3.12-slim

WORKDIR /app

# Install dependencies first (better layer caching: this layer only
# changes when requirements.txt changes).
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Application code, frontend, and the question bank.
COPY main.py .
COPY static/ ./static/
COPY data/questions.json ./data/questions.json

EXPOSE 8000

# Shell form so $PORT is expanded at container start: cloud platforms
# (e.g. Render) inject their own PORT; locally it defaults to 8000.
CMD uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}

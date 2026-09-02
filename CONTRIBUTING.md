# Contributing to 3D Ambi

Thank you for your interest in improving 3D Ambi. This project is a browser-based exam proctoring prototype using WebGL angle-dependent rendering.

## Architecture Overview

```
Browser (WebGL + MediaPipe WASM)  ←→  Flask + Gunicorn  ←→  SQLite
```

| Layer | Files | Purpose |
|-------|-------|---------|
| **Frontend — Candidate** | `frontend/index.html`, `frontend/candidate.js` | WebGL canvas rendering, MediaPipe FaceMesh yaw estimation, AES-GCM decryption, inactivity timer |
| **Frontend — Admin** | `frontend/admin.html`, `frontend/admin.js` | Session oversight, question CRUD with decoy fields, settings config, timeline review, angle simulator |
| **Backend — Server** | `backend/server.py` | Flask routes, admin auth (bcrypt), CSRF guard, CSP headers, AES-GCM encryption, rate limiting |
| **Backend — Database** | `backend/db.py` | SQLite schema with WAL mode, session CRUD, flag event logging, migration guards |
| **Tests** | `tests/test_server.py` | pytest suite covering auth, sessions, questions, settings, decoy fields, encryption |

## How to Add New Proctoring Signals

1. **Client-side** (`frontend/candidate.js`):
   - Add a listener for the browser event (e.g., `visibilitychange`, `resize`).
   - Call `sendFlag('your_event_type', 'optional detail')` — the helper handles deduplication (5s cooldown).

2. **Server-side** (`backend/server.py`):
   - The `POST /api/flag` endpoint already stores arbitrary event types.
   - To adjust the integrity penalty, modify the `log_event()` function's score deduction logic.

## How to Add New Question Types

The current system supports Multiple Choice Questions (MCQs). To add a new type (e.g., Free Text):

1. **Database** (`backend/db.py`): Add a `question_type` column with a migration guard.
2. **Backend** (`backend/server.py`): Update `add_question` and `edit_question` to accept the new type.
3. **Frontend** (`frontend/candidate.js`): Update `loadQuestion()` to render the appropriate input UI based on the question type.

## Development Setup

1. Install Python 3.12+
2. Clone and configure:
   ```bash
   git clone https://github.com/Rs111104/3d-ambigram
   cd 3d-ambigram
   pip install -r backend/requirements.txt
   cp .env.example .env
   # Edit .env: set ADMIN_USER, ADMIN_PASSWORD_HASH, FLASK_SECRET
   ```
3. Run the server:
   ```bash
   python deploy_local.py
   ```
4. Run tests:
   ```bash
   pip install pytest
   pytest tests/ -v
   ```

## Code Standards

- **Python**: Python 3.12 compatible, no type stubs required.
- **JavaScript**: Vanilla JS only (no frameworks). External `.js` files for CSP compliance.
- **Database**: SQLite with WAL mode. Use migration guards (try/except on SELECT) for schema changes.
- **Security**: All user-facing strings must be escaped via `esc()` helper. No inline event handlers.

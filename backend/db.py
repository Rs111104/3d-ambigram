import sqlite3
import json
import time
import os
from contextlib import contextmanager

DB_PATH = os.environ.get("DB_PATH", "exam.db")

_wal_initialized = False

@contextmanager
def get_db():
    """Context manager that properly closes the connection after use.
    
    The default sqlite3 `with conn` only manages transactions (commit/rollback),
    it does NOT close the connection, causing file handle leaks.
    """
    global _wal_initialized
    db_dir = os.path.dirname(os.path.abspath(DB_PATH))
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=15.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    if not _wal_initialized:
        conn.execute("PRAGMA journal_mode=WAL")
        _wal_initialized = True
    try:
        yield conn
    finally:
        conn.close()

def init_db():
    with get_db() as cx:
        # Check if questions table lacks the subject, correct_index, decoy_left_text, or decoy_right_text columns
        try:
            cx.execute("SELECT subject, correct_index, decoy_left_text, decoy_right_text FROM questions LIMIT 1")
        except sqlite3.OperationalError:
            cx.execute("DROP TABLE IF EXISTS questions")

        # Check if sessions table lacks question_order or aes_key columns
        try:
            cx.execute("SELECT question_order, aes_key FROM sessions LIMIT 1")
        except sqlite3.OperationalError:
            cx.execute("DROP TABLE IF EXISTS sessions")

        cx.executescript("""
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            exam_id TEXT,
            candidate_email TEXT,
            current_q INTEGER DEFAULT 0,
            answers TEXT DEFAULT '{}',
            consented_at REAL,
            started_at REAL,
            finished_at REAL,
            integrity_score INTEGER DEFAULT 100,
            question_order TEXT,
            aes_key TEXT
        );
        CREATE TABLE IF NOT EXISTS flag_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL REFERENCES sessions(id),
            event_type TEXT NOT NULL,
            ts REAL NOT NULL,
            duration_ms INTEGER,
            detail TEXT
        );
        CREATE TABLE IF NOT EXISTS admin_sessions (
            token TEXT PRIMARY KEY,
            created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS questions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            subject TEXT DEFAULT 'General',
            text TEXT NOT NULL,
            options TEXT NOT NULL, -- JSON list
            correct_index INTEGER DEFAULT 0,
            decoy_left_text TEXT,
            decoy_right_text TEXT
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        """)
        
        # Seed questions if empty
        count = cx.execute("SELECT COUNT(*) FROM questions").fetchone()[0]
        if count == 0:
            questions = [
                ("CS", "What is the time complexity of quicksort?", json.dumps(["O(n)", "O(n log n)", "O(n²)", "O(log n)"]), 1, None, None),
                ("CS", "Which data structure uses LIFO?", json.dumps(["Queue", "Stack", "Heap", "Tree"]), 1, None, None),
                ("Science", "What is H2O?", json.dumps(["Water", "Acid", "Salt", "Gas"]), 0, None, None),
                ("History", "Who wrote the Great Gatsby?", json.dumps(["F. Scott Fitzgerald", "Ernest Hemingway", "Mark Twain", "Charles Dickens"]), 0, None, None),
                ("Tech", "Which architectural pattern decouples storage from logic?", json.dumps(["MVC", "Monolith", "Serverless", "Edge"]), 0, None, None)
            ]
            cx.executemany("INSERT INTO questions (subject, text, options, correct_index, decoy_left_text, decoy_right_text) VALUES (?,?,?,?,?,?)", questions)
            
        # Seed default settings if empty
        settings_count = cx.execute("SELECT COUNT(*) FROM settings").fetchone()[0]
        if settings_count == 0:
            cx.execute("INSERT INTO settings (key, value) VALUES (?,?)", ("inactivity_timeout", "300"))
            cx.execute("INSERT INTO settings (key, value) VALUES (?,?)", ("integrity_threshold", "80"))
        
        # Purge expired admin sessions.
        cx.execute("DELETE FROM admin_sessions WHERE created_at < ?", (time.time() - 3600,))
        
        cx.commit()

def session_get(sid: str) -> dict | None:
    if not sid: return None
    with get_db() as cx:
        row = cx.execute(
            "SELECT id, current_q, answers, started_at, finished_at, consented_at, question_order, aes_key FROM sessions WHERE id=?", (sid,)
        ).fetchone()
        if not row: return None
        return {"id": row[0], "q": row[1],
                "answers": json.loads(row[2]), "started_at": row[3], "finished_at": row[4],
                "consented_at": row[5],
                "question_order": json.loads(row[6]) if row[6] else None,
                "aes_key": row[7]}

_SESSION_COLUMNS = frozenset({
    "exam_id", "candidate_email", "current_q", "answers",
    "consented_at", "started_at", "finished_at", "integrity_score",
    "question_order", "aes_key"
})

def session_upsert(sid: str, **fields):
    # Reject any keys not in the whitelist
    invalid = set(fields.keys()) - _SESSION_COLUMNS
    if invalid:
        raise ValueError(f"Invalid session fields: {invalid}")
    
    with get_db() as cx:
        exists = cx.execute("SELECT 1 FROM sessions WHERE id=?", (sid,)).fetchone()
        if exists:
            set_clause = ", ".join([f"{k}=?" for k in fields.keys()])
            vals = list(fields.values()) + [sid]
            cx.execute(f"UPDATE sessions SET {set_clause} WHERE id=?", vals)
        else:
            cols = ", ".join(["id"] + list(fields.keys()))
            placeholders = ", ".join(["?"] * (len(fields) + 1))
            vals = [sid] + list(fields.values())
            cx.execute(f"INSERT INTO sessions ({cols}) VALUES ({placeholders})", vals)
        cx.commit()

def log_flag(sid: str, event_type: str, detail: str = None, duration_ms: int = None):
    with get_db() as cx:
        cx.execute(
            "INSERT INTO flag_events (session_id, event_type, ts, duration_ms, detail) VALUES (?,?,?,?,?)",
            (sid, event_type, time.time(), duration_ms, detail)
        )
        cx.commit()

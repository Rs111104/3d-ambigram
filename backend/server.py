import sys
import os
import secrets
import time
import json
import logging
import bcrypt
import io
import csv
import base64
import re
from flask import Flask, request, jsonify, send_from_directory, redirect, abort, make_response
from functools import wraps
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from dotenv import load_dotenv
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

load_dotenv()

try:
    from . import db
except ImportError:
    import db

# Structured JSON Logging
class JsonFormatter(logging.Formatter):
    def format(self, record):
        log_entry = {
            "ts": self.formatTime(record),
            "level": record.levelname,
            "msg": record.getMessage(),
            "logger": record.name,
        }
        if hasattr(record, "extra"):
            log_entry.update(record.extra)
        return json.dumps(log_entry)

handler = logging.StreamHandler()
handler.setFormatter(JsonFormatter())
logging.basicConfig(level=logging.INFO, handlers=[handler])
logger = logging.getLogger("3d-ambigram")

def _require_env(key: str) -> str:
    val = os.environ.get(key)
    if not val:
        print(f"FATAL: environment variable '{key}' is not set.", file=sys.stderr)
        sys.exit(1)
    return val

# Critical security checks at startup
ADMIN_USER = _require_env("ADMIN_USER")
ADMIN_PASSWORD_HASH = _require_env("ADMIN_PASSWORD_HASH")
FLASK_SECRET = _require_env("FLASK_SECRET")

# Detect if running behind HTTPS; default to False for local HTTP deployment.
IS_SECURE = os.environ.get("SECURE_COOKIES", "false").lower() == "true"

if not IS_SECURE and (os.environ.get("RENDER") or os.environ.get("PRODUCTION")):
    logger.warning("SECURITY WARNING: Running in production/Render with SECURE_COOKIES=false! Admin and session cookies are not marked secure.")

app = Flask(__name__, static_folder="../frontend")
app.secret_key = FLASK_SECRET

with app.app_context():
    db.init_db()

def encrypt_payload(data: dict, hex_key: str) -> dict:
    key = bytes.fromhex(hex_key)
    aesgcm = AESGCM(key)
    nonce = os.urandom(12)
    plaintext = json.dumps(data).encode('utf-8')
    ciphertext = aesgcm.encrypt(nonce, plaintext, None)
    return {
        "nonce": base64.b64encode(nonce).decode('utf-8'),
        "ciphertext": base64.b64encode(ciphertext).decode('utf-8')
    }

# Rate Limiter
limiter = Limiter(
    get_remote_address,
    app=app,
    default_limits=["200 per day", "50 per hour"],
    storage_uri="memory://"
)

def admin_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        token = request.cookies.get("admin_token")
        if not token:
            if request.path.startswith("/api/"):
                return jsonify({"error": "unauthorized"}), 401
            return redirect("/admin/login")
        with db.get_db() as cx:
            row = cx.execute(
                "SELECT created_at FROM admin_sessions WHERE token=?", (token,)
            ).fetchone()
        if not row or time.time() - row[0] > 3600:
            if request.path.startswith("/api/"):
                return jsonify({"error": "session expired"}), 401
            return redirect("/admin/login")
        return f(*args, **kwargs)
    return wrapper

@app.before_request
def check_csrf_header():
    if request.method in ("POST", "PATCH", "DELETE"):
        if request.headers.get("X-Requested-With") != "XMLHttpRequest":
            abort(403)

@app.after_request
def set_security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self' cdn.jsdelivr.net fonts.googleapis.com; "
        "style-src 'self' 'unsafe-inline' fonts.googleapis.com fonts.gstatic.com; "
        "font-src fonts.gstatic.com; "
        "img-src 'self' data:; "
        "connect-src 'self' cdn.jsdelivr.net; "
        "frame-ancestors 'none'"
    )
    return response

@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")

@app.route("/admin")
@admin_required
def admin_dashboard():
    return send_from_directory(app.static_folder, "admin.html")

@app.route("/admin/login", methods=["GET"])
def admin_login_page():
    return send_from_directory(app.static_folder, "admin.html")

@app.route("/api/admin/login", methods=["POST"])
@limiter.limit("5 per minute")
def admin_login():
    body = request.get_json(silent=True) or {}
    u = body.get("username", "")
    p = body.get("password", "")
    
    if u != ADMIN_USER or not bcrypt.checkpw(p.encode(), ADMIN_PASSWORD_HASH.encode()):
        logger.warning("failed admin login attempt", extra={"user": u})
        return jsonify({"error": "invalid credentials"}), 401
    
    token = secrets.token_urlsafe(32)
    with db.get_db() as cx:
        cx.execute("INSERT INTO admin_sessions (token, created_at) VALUES (?,?)", (token, time.time()))
        cx.commit()
    
    logger.info("admin login successful", extra={"user": u})
    resp = jsonify({"ok": True})
    resp.set_cookie("admin_token", token, httponly=True,
                    samesite="Strict", secure=IS_SECURE, max_age=3600)
    return resp

@app.route("/api/admin/logout", methods=["POST"])
def admin_logout():
    token = request.cookies.get("admin_token")
    if token:
        with db.get_db() as cx:
            cx.execute("DELETE FROM admin_sessions WHERE token=?", (token,))
            cx.commit()
    resp = jsonify({"ok": True})
    resp.delete_cookie("admin_token")
    return resp

@app.route("/api/settings", methods=["GET"])
def public_settings():
    with db.get_db() as cx:
        row = cx.execute("SELECT value FROM settings WHERE key=?", ("inactivity_timeout",)).fetchone()
    try:
        timeout = int(row[0]) if row else 300
    except (TypeError, ValueError):
        timeout = 300
    return jsonify({"inactivity_timeout": timeout})

@app.route("/api/session/start", methods=["POST"])
@limiter.limit("3 per 10 minutes")
def start_session():
    body = request.get_json(silent=True) or {}
    email = body.get("email", "").strip()
    if not email or not re.match(r"[^@]+@[^@]+\.[^@]+", email):
        return jsonify({"error": "Invalid email address"}), 400

    with db.get_db() as cx:
        rows = cx.execute("SELECT id FROM questions ORDER BY id").fetchall()
    q_ids = [r["id"] for r in rows]
    import random
    random.shuffle(q_ids)

    aes_key = secrets.token_hex(32)

    sid = secrets.token_urlsafe(32)
    now = time.time()
    db.session_upsert(sid, started_at=now, candidate_email=email,
                      question_order=json.dumps(q_ids), aes_key=aes_key)
    logger.info("session started", extra={"session_id": sid, "email": email})
    resp = jsonify({"ok": True, "session_id": sid, "started_at": now, "key": aes_key})
    resp.set_cookie("session_id", sid, httponly=True, samesite="Strict", secure=IS_SECURE)
    return resp

@app.route("/api/session/consent", methods=["POST"])
def session_consent():
    sid = request.cookies.get("session_id")
    sess = db.session_get(sid)
    if not sess:
        return jsonify({"error": "unauthorized"}), 403
    if sess.get("finished_at"):
        return jsonify({"error": "session finished"}), 403
    db.session_upsert(sid, consented_at=time.time())
    return jsonify({"ok": True})

@app.route("/api/question", methods=["GET"])
@limiter.limit("60 per minute")
def get_question():
    sid = request.cookies.get("session_id")
    sess = db.session_get(sid)
    if not sess:
        return jsonify({"error": "unauthorized"}), 403
    if not sess.get("consented_at"):
        return jsonify({"error": "consent required"}), 403
    
    if sess.get("finished_at"):
        return jsonify({"done": True})
    
    idx = sess["q"]
    question_order = sess["question_order"]
    
    if not question_order or idx >= len(question_order):
        db.session_upsert(sid, finished_at=time.time())
        return jsonify({"done": True})
    
    q_id = question_order[idx]
    with db.get_db() as cx:
        q = cx.execute("SELECT id, subject, text, options FROM questions WHERE id=?", (q_id,)).fetchone()
    
    if not q:
        db.session_upsert(sid, finished_at=time.time())
        return jsonify({"done": True})

    question_data = {
        "text": q["text"],
        "options": json.loads(q["options"])
    }
    encrypted = encrypt_payload(question_data, sess["aes_key"])
    
    return jsonify({
        "id": q["id"],
        "subject": q["subject"],
        "index": idx,
        "total": len(question_order),
        "encrypted": encrypted
    })

@app.route("/api/decoy", methods=["GET"])
@limiter.limit("60 per minute")
def get_decoy():
    sid = request.cookies.get("session_id")
    sess = db.session_get(sid)
    if not sess:
        abort(403)
    if not sess.get("consented_at"):
        return jsonify({"error": "consent required"}), 403
    db.log_flag(sid, "decoy_requested")
    
    idx = sess["q"]
    question_order = sess["question_order"]
    
    decoy_left_text = "Which planet is closest to the Sun?"
    decoy_left_options = ["Venus", "Mercury", "Earth", "Mars"]
    decoy_right_text = "What is the primary color of a fire truck?"
    decoy_right_options = ["Red", "Blue", "Green", "Yellow"]

    if question_order and idx < len(question_order):
        q_id = question_order[idx]
        with db.get_db() as cx:
            q = cx.execute("SELECT options, decoy_left_text, decoy_right_text FROM questions WHERE id=?", (q_id,)).fetchone()
        if q:
            opts = json.loads(q["options"])
            if q["decoy_left_text"]:
                decoy_left_text = q["decoy_left_text"]
                decoy_left_options = opts
            if q["decoy_right_text"]:
                decoy_right_text = q["decoy_right_text"]
                decoy_right_options = opts

    decoy_data = {
        "left": {
            "text": decoy_left_text,
            "options": decoy_left_options
        },
        "right": {
            "text": decoy_right_text,
            "options": decoy_right_options
        }
    }
    encrypted = encrypt_payload(decoy_data, sess["aes_key"])
    return jsonify({
        "encrypted": encrypted
    })

@app.route("/api/answer", methods=["POST"])
def submit_answer():
    sid = request.cookies.get("session_id")
    sess = db.session_get(sid)
    if not sess:
        return jsonify({"error": "unauthorized"}), 403
    
    if sess.get("finished_at"):
        return jsonify({"error": "session finished"}), 403
    if not sess.get("consented_at"):
        return jsonify({"error": "consent required"}), 403
    
    body = request.get_json(silent=True) or {}
    q_id = body.get("questionId")
    answer = body.get("answer")
    question_order = sess["question_order"] or []
    idx = sess["q"]

    if idx >= len(question_order):
        db.session_upsert(sid, finished_at=time.time())
        return jsonify({"error": "session finished"}), 403

    expected_qid = question_order[idx]
    if q_id != expected_qid:
        return jsonify({"error": "question out of sequence"}), 400

    with db.get_db() as cx:
        q = cx.execute("SELECT options FROM questions WHERE id=?", (expected_qid,)).fetchone()
    if not q:
        db.session_upsert(sid, finished_at=time.time())
        return jsonify({"error": "question unavailable"}), 400

    options = json.loads(q["options"])
    if answer not in options:
        return jsonify({"error": "invalid answer"}), 400
    
    answers = sess["answers"]
    answers[str(q_id)] = answer
    
    db.session_upsert(sid, current_q=sess["q"] + 1, answers=json.dumps(answers))
    return jsonify({"ok": True})

@app.route("/api/flag", methods=["POST"])
def log_event():
    sid = request.cookies.get("session_id")
    sess = db.session_get(sid)
    if not sess:
        return jsonify({"error": "unauthorized"}), 403
    
    body = request.get_json(silent=True) or {}
    event_type = body.get("type")
    detail = body.get("detail")
    duration = body.get("duration_ms")
    
    if not event_type:
        return jsonify({"ok": True})
        
    # Cooldown check: ignore duplicate events within 5 seconds to prevent write amplification
    with db.get_db() as cx:
        recent = cx.execute(
            "SELECT 1 FROM flag_events WHERE session_id=? AND event_type=? AND ts > ?",
            (sid, event_type, time.time() - 5)
        ).fetchone()
        
    if recent:
        return jsonify({"ok": True})
    
    db.log_flag(sid, event_type, detail, duration)
    logger.warning("flag event", extra={"session_id": sid, "type": event_type, "detail": detail})
    
    # Simple integrity penalty
    with db.get_db() as cx:
        cx.execute("UPDATE sessions SET integrity_score = MAX(0, integrity_score - 10) WHERE id=?", (sid,))
        cx.commit()
        
    return jsonify({"ok": True})

# --- Admin API ---

@app.route("/api/admin/sessions", methods=["GET"])
@admin_required
def admin_sessions():
    with db.get_db() as cx:
        rows = cx.execute("SELECT * FROM sessions ORDER BY started_at DESC").fetchall()
        questions = cx.execute("SELECT id, options, correct_index FROM questions ORDER BY id").fetchall()
    
    # Build answer key: question_id -> correct option text
    answer_key = {}
    for q in questions:
        opts = json.loads(q["options"])
        ci = q["correct_index"]
        if 0 <= ci < len(opts):
            answer_key[str(q["id"])] = opts[ci]
    
    sessions = []
    for r in rows:
        started = r["started_at"] or time.time()
        finished = r["finished_at"] or time.time()
        
        answers = json.loads(r["answers"]) if r["answers"] else {}
        correct = sum(1 for qid, ans in answers.items() if answer_key.get(qid) == ans)
        total = len(answer_key)
        score = correct / total if total > 0 else 0.0
        
        sessions.append({
            "id": r["id"],
            "token": r["id"],
            "name": r["candidate_email"] or "Anonymous",
            "started_at": r["started_at"] or time.time(),
            "durationSec": finished - started,
            "score": round(score, 4),
            "integrity_score": r["integrity_score"]
        })
    return jsonify(sessions)

@app.route("/api/admin/session/<sid>", methods=["GET"])
@admin_required
def admin_session_detail(sid):
    with db.get_db() as cx:
        events = cx.execute("SELECT * FROM flag_events WHERE session_id=? ORDER BY ts ASC", (sid,)).fetchall()
    return jsonify({
        "events": [{
            "type": e["event_type"],
            "detail": e["detail"],
            "created_at": e["ts"]
        } for e in events]
    })

@app.route("/api/admin/questions", methods=["GET"])
@admin_required
def admin_questions():
    with db.get_db() as cx:
        rows = cx.execute("SELECT * FROM questions ORDER BY id").fetchall()
    return jsonify([dict(r) for r in rows])

@app.route("/api/admin/question", methods=["POST"])
@admin_required
def add_question():
    body = request.get_json() or {}
    subject = body.get("subject", "General")
    text = body.get("question")
    options = body.get("options", [])
    try:
        correct_index = int(body.get("correctIndex", 0))
    except (TypeError, ValueError):
        return jsonify({"error": "correctIndex must be an integer"}), 400
    decoy_left = body.get("decoyLeft", "").strip()
    decoy_right = body.get("decoyRight", "").strip()
    
    if not text or not isinstance(text, str) or not text.strip():
        return jsonify({"error": "Question text is required"}), 400
    if not isinstance(options, list) or len(options) < 2:
        return jsonify({"error": "At least 2 options are required"}), 400
    if correct_index < 0 or correct_index >= len(options):
        return jsonify({"error": "correctIndex out of range"}), 400
    
    with db.get_db() as cx:
        cx.execute("INSERT INTO questions (subject, text, options, correct_index, decoy_left_text, decoy_right_text) VALUES (?,?,?,?,?,?)",
                   (subject, text.strip(), json.dumps(options), correct_index, decoy_left or None, decoy_right or None))
        cx.commit()
    return jsonify({"ok": True})

@app.route("/api/admin/question/<int:qid>", methods=["PATCH"])
@admin_required
def edit_question(qid):
    body = request.get_json() or {}
    subject = body.get("subject", "General")
    text = body.get("question")
    options = body.get("options", [])
    try:
        correct_index = int(body.get("correctIndex", 0))
    except (TypeError, ValueError):
        return jsonify({"error": "correctIndex must be an integer"}), 400
    decoy_left = body.get("decoyLeft", "").strip()
    decoy_right = body.get("decoyRight", "").strip()
    
    if not text or not isinstance(text, str) or not text.strip():
        return jsonify({"error": "Question text is required"}), 400
    if not isinstance(options, list) or len(options) < 2:
        return jsonify({"error": "At least 2 options are required"}), 400
    if correct_index < 0 or correct_index >= len(options):
        return jsonify({"error": "correctIndex out of range"}), 400
    
    with db.get_db() as cx:
        cx.execute("UPDATE questions SET subject=?, text=?, options=?, correct_index=?, decoy_left_text=?, decoy_right_text=? WHERE id=?",
                   (subject, text.strip(), json.dumps(options), correct_index, decoy_left or None, decoy_right or None, qid))
        cx.commit()
    return jsonify({"ok": True})

@app.route("/api/admin/question/<int:qid>", methods=["DELETE"])
@admin_required
def delete_question(qid):
    with db.get_db() as cx:
        cx.execute("DELETE FROM questions WHERE id=?", (qid,))
        cx.commit()
    return jsonify({"ok": True})

@app.route("/api/admin/settings", methods=["GET"])
@admin_required
def get_settings():
    with db.get_db() as cx:
        rows = cx.execute("SELECT key, value FROM settings").fetchall()
    return jsonify({r["key"]: r["value"] for r in rows})

@app.route("/api/admin/settings", methods=["POST"])
@admin_required
def save_settings():
    body = request.get_json() or {}
    allowed = {"inactivity_timeout", "integrity_threshold"}
    invalid = set(body) - allowed
    if invalid:
        return jsonify({"error": f"unsupported setting: {sorted(invalid)[0]}"}), 400

    normalized = {}
    if "inactivity_timeout" in body:
        try:
            timeout = int(body["inactivity_timeout"])
        except (TypeError, ValueError):
            return jsonify({"error": "inactivity_timeout must be an integer"}), 400
        if timeout < 30 or timeout > 86400:
            return jsonify({"error": "inactivity_timeout must be between 30 and 86400"}), 400
        normalized["inactivity_timeout"] = str(timeout)

    if "integrity_threshold" in body:
        try:
            threshold = int(body["integrity_threshold"])
        except (TypeError, ValueError):
            return jsonify({"error": "integrity_threshold must be an integer"}), 400
        if threshold < 0 or threshold > 100:
            return jsonify({"error": "integrity_threshold must be between 0 and 100"}), 400
        normalized["integrity_threshold"] = str(threshold)

    with db.get_db() as cx:
        for k, v in normalized.items():
            cx.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)", (k, v))
        cx.commit()
    return jsonify({"ok": True})

@app.route("/api/admin/sessions/export", methods=["GET"])
@admin_required
def export_sessions():
    with db.get_db() as cx:
        rows = cx.execute("SELECT * FROM sessions").fetchall()
    
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["ID", "Name", "Started At", "Finished At", "Integrity"])
    for r in rows:
        started_str = time.ctime(r["started_at"]) if r["started_at"] else "Unknown"
        finished_str = time.ctime(r["finished_at"]) if r["finished_at"] else ("Active" if r["started_at"] else "Unstarted")
        writer.writerow([r["id"], r["candidate_email"] or "Anonymous", 
                         started_str, 
                         finished_str,
                         r["integrity_score"]])
    
    resp = make_response(output.getvalue())
    resp.headers["Content-Disposition"] = "attachment; filename=sessions.csv"
    resp.headers["Content-Type"] = "text/csv"
    return resp

@app.route("/<path:path>")
def static_proxy(path):
    return send_from_directory(app.static_folder, path)

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port, debug=False)

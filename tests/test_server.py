import pytest
import json
import os
import bcrypt
import sys
import time

# Set environment variables BEFORE importing server
os.environ["ADMIN_USER"] = "testadmin"
os.environ["ADMIN_PASSWORD_HASH"] = bcrypt.hashpw(b"testpass", bcrypt.gensalt()).decode()
os.environ["FLASK_SECRET"] = "testsecret"
os.environ["DB_PATH"] = "test.db"

# Add backend to path
sys.path.append(os.path.join(os.path.dirname(__file__), '..', 'backend'))

from server import app, limiter
import db

@pytest.fixture
def client(tmp_path, monkeypatch):
    db_path = str(tmp_path / "test.db")
    # Dynamically set the database path to isolate each test
    monkeypatch.setattr(db, "DB_PATH", db_path)
    # Disable rate limiting for testing
    limiter.enabled = False
    
    with app.app_context():
        db.init_db()
    
    app.config["TESTING"] = True
    app.config["RATELIMIT_ENABLED"] = False
    with app.test_client() as c:
        yield c

def test_get_question_without_session(client):
    r = client.get("/api/question")
    assert r.status_code == 403

def test_admin_login_wrong_password(client):
    r = client.post("/api/admin/login",
        json={"username": "testadmin", "password": "wrong"},
        headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 401

def test_admin_login_correct(client):
    # The module level constants were already set by the os.environ calls above
    r = client.post("/api/admin/login",
        json={"username": "testadmin", "password": "testpass"},
        headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 200
    assert "admin_token" in r.headers.get("Set-Cookie", "")

def test_decoy_requires_session(client):
    r = client.get("/api/decoy")
    assert r.status_code == 403

def test_admin_dashboard_requires_auth(client):
    r = client.get("/admin")
    assert r.status_code == 302  # redirect to login

def test_session_start(client):
    r = client.post("/api/session/start",
        json={"email": "test@example.com"},
        headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 200
    data = json.loads(r.data)
    assert "session_id" in data
    assert "key" in data  # AES key should be returned
    assert "session_id" in r.headers.get("Set-Cookie", "")

def test_question_requires_consent(client):
    r = client.post("/api/session/start",
        json={"email": "consent@example.com"},
        headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 200

    r = client.get("/api/question")
    assert r.status_code == 403
    assert b"consent required" in r.data

def test_answer_requires_consent(client):
    r = client.post("/api/session/start",
        json={"email": "answer-consent@example.com"},
        headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 200

    r = client.post("/api/answer",
        json={"questionId": 1, "answer": "Water"},
        headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 403
    assert b"consent required" in r.data

def test_session_start_invalid_email(client):
    """Server should reject session start with missing or invalid email."""
    # No email
    r = client.post("/api/session/start",
        json={},
        headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 400

    # Invalid email format
    r = client.post("/api/session/start",
        json={"email": "notanemail"},
        headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 400

def test_csrf_mimetype_with_charset(client):
    # Verify that a mimetype with a charset (e.g. application/json; charset=UTF-8)
    # checks CSRF properly and doesn't get bypassed or erroneously blocked.
    r = client.post("/api/session/start", 
                    data=json.dumps({"email": "test@example.com"}),
                    content_type="application/json; charset=utf-8", 
                    headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 200

    # Without X-Requested-With it should be blocked
    r = client.post("/api/session/start", 
                    data=json.dumps({"email": "test@example.com"}),
                    content_type="application/json; charset=utf-8")
    assert r.status_code == 403

def test_flag_event_cooldown(client):
    # Start session
    r = client.post("/api/session/start",
        json={"email": "cooldown@example.com"},
        headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 200
    
    # First flag should be recorded
    r = client.post("/api/flag", json={"type": "no_face"}, headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 200
    
    # Second flag of the same type within 5s should be ignored by cooldown
    r = client.post("/api/flag", json={"type": "no_face"}, headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 200
    
    # Let's verify only 1 flag event is in DB
    with db.get_db() as cx:
        events = cx.execute("SELECT COUNT(*) FROM flag_events WHERE event_type='no_face'").fetchone()[0]
        assert events == 1

def test_flag_rejects_unknown_session(client):
    client.set_cookie("session_id", "fake-session")
    r = client.post("/api/flag",
        json={"type": "no_face"},
        headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 403

def test_answer_must_match_current_question(client):
    r = client.post("/api/session/start",
        json={"email": "sequence@example.com"},
        headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 200

    r = client.post("/api/session/consent",
        headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 200

    q = client.get("/api/question").get_json()
    wrong_id = q["id"] + 9999
    r = client.post("/api/answer",
        json={"questionId": wrong_id, "answer": q["encrypted"]["ciphertext"]},
        headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 400
    assert b"question out of sequence" in r.data

def test_answer_must_be_valid_option(client):
    r = client.post("/api/session/start",
        json={"email": "option@example.com"},
        headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 200

    r = client.post("/api/session/consent",
        headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 200

    q = client.get("/api/question").get_json()
    r = client.post("/api/answer",
        json={"questionId": q["id"], "answer": "not a real option"},
        headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 400
    assert b"invalid answer" in r.data

def test_session_expiry_answer(client):
    # Start session
    r = client.post("/api/session/start",
        json={"email": "expiry@example.com"},
        headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 200
    sid = json.loads(r.data)["session_id"]
    
    # Manually mark the session as finished in the DB
    with db.get_db() as cx:
        cx.execute("UPDATE sessions SET finished_at=? WHERE id=?", (time.time(), sid))
        cx.commit()
            
    # Try submitting answer after completed - should be rejected with 403
    r = client.post("/api/answer", json={"questionId": 1, "answer": "Water"}, headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 403
    assert b"session finished" in r.data

def test_question_crud_and_settings(client):
    # Authenticate admin
    r = client.post("/api/admin/login",
        json={"username": "testadmin", "password": "testpass"},
        headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 200
    
    # 1. Add question
    r = client.post("/api/admin/question", json={
        "subject": "Math",
        "question": "What is 2+2?",
        "options": ["3", "4", "5"],
        "correctIndex": 1
    }, headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 200
    
    # Verify added
    r = client.get("/api/admin/questions")
    questions = json.loads(r.data)
    math_q = [q for q in questions if q["text"] == "What is 2+2?"][0]
    assert math_q["subject"] == "Math"
    assert math_q["correct_index"] == 1
    
    # 2. Patch question
    r = client.patch(f"/api/admin/question/{math_q['id']}", json={
        "subject": "Math",
        "question": "What is 2+2?",
        "options": ["3", "4", "5"],
        "correctIndex": 2  # modified
    }, headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 200
    
    with db.get_db() as cx:
        correct = cx.execute("SELECT correct_index FROM questions WHERE id=?", (math_q["id"],)).fetchone()[0]
        assert correct == 2
        
    # 3. Delete question
    r = client.delete(f"/api/admin/question/{math_q['id']}", headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 200
    
    with db.get_db() as cx:
        exists = cx.execute("SELECT 1 FROM questions WHERE id=?", (math_q["id"],)).fetchone()
        assert exists is None
        
    # 4. Settings GET and POST
    r = client.get("/api/admin/settings")
    assert r.status_code == 200
    settings = json.loads(r.data)
    assert settings["inactivity_timeout"] == "300"
    
    r = client.post("/api/admin/settings", json={"inactivity_timeout": "500"}, headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 200
    
    r = client.get("/api/admin/settings")
    assert json.loads(r.data)["inactivity_timeout"] == "500"

def test_question_rejects_non_integer_correct_index(client):
    r = client.post("/api/admin/login",
        json={"username": "testadmin", "password": "testpass"},
        headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 200

    r = client.post("/api/admin/question", json={
        "subject": "Math",
        "question": "What is 2+2?",
        "options": ["3", "4", "5"],
        "correctIndex": "abc"
    }, headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 400

def test_public_settings_endpoint(client):
    """Public settings endpoint should return inactivity_timeout without auth."""
    r = client.get("/api/settings")
    assert r.status_code == 200
    data = json.loads(r.data)
    assert "inactivity_timeout" in data
    assert isinstance(data["inactivity_timeout"], int)

def test_decoy_with_session(client):
    """Decoy endpoint should return encrypted data for a valid session."""
    r = client.post("/api/session/start",
        json={"email": "decoy@example.com"},
        headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 200
    r = client.post("/api/session/consent",
        headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 200
    
    r = client.get("/api/decoy")
    assert r.status_code == 200
    data = json.loads(r.data)
    assert "encrypted" in data
    assert "nonce" in data["encrypted"]
    assert "ciphertext" in data["encrypted"]

def test_question_decoy_fields_roundtrip(client):
    """Decoy left/right fields should persist through create and edit."""
    # Authenticate
    r = client.post("/api/admin/login",
        json={"username": "testadmin", "password": "testpass"},
        headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 200

    # Create question with decoy fields
    r = client.post("/api/admin/question", json={
        "subject": "Test",
        "question": "Real question text?",
        "options": ["A", "B", "C", "D"],
        "correctIndex": 0,
        "decoyLeft": "Left decoy text",
        "decoyRight": "Right decoy text"
    }, headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 200

    # Verify decoy fields were stored
    r = client.get("/api/admin/questions")
    questions = json.loads(r.data)
    q = [q for q in questions if q["text"] == "Real question text?"][0]
    assert q["decoy_left_text"] == "Left decoy text"
    assert q["decoy_right_text"] == "Right decoy text"

    # Edit: update decoy fields
    r = client.patch(f"/api/admin/question/{q['id']}", json={
        "subject": "Test",
        "question": "Real question text?",
        "options": ["A", "B", "C", "D"],
        "correctIndex": 0,
        "decoyLeft": "Updated left decoy",
        "decoyRight": "Updated right decoy"
    }, headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 200

    with db.get_db() as cx:
        row = cx.execute("SELECT decoy_left_text, decoy_right_text FROM questions WHERE id=?", (q["id"],)).fetchone()
        assert row[0] == "Updated left decoy"
        assert row[1] == "Updated right decoy"

    # Cleanup
    client.delete(f"/api/admin/question/{q['id']}", headers={"X-Requested-With": "XMLHttpRequest"})

def test_encrypted_question_response(client):
    """GET /api/question should return encrypted payload for active session."""
    r = client.post("/api/session/start",
        json={"email": "encrypt@example.com"},
        headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 200
    data = json.loads(r.data)
    assert "key" in data  # AES key
    r = client.post("/api/session/consent",
        headers={"X-Requested-With": "XMLHttpRequest"})
    assert r.status_code == 200

    r = client.get("/api/question")
    assert r.status_code == 200
    q = json.loads(r.data)
    if not q.get("done"):
        assert "encrypted" in q
        assert "nonce" in q["encrypted"]
        assert "ciphertext" in q["encrypted"]

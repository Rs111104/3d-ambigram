# 3d-ambigram — angle-dependent anti-cheat exam system

An online exam proctoring system that uses webcam head-pose estimation and
WebGL angle-dependent rendering to show the real question only to a candidate
sitting directly in front of their screen.

> Webcam analysis runs entirely in the browser. No video is uploaded.

---

## How it works

1. The candidate's webcam feeds MediaPipe FaceMesh running as a WASM module
   in the browser at 5fps.
2. Head yaw angle is estimated from 3D facial landmarks.
3. A WebGL canvas blends between the real question (visible at 0°±15°) and a
   decoy question (visible at wide angles) proportional to deviation.
4. Suspicious events (tab switch, no face, multiple faces, blink absence,
   decoy requested) are timestamped and sent to the backend.
5. Admins review flagged sessions with duration-aware event timelines.

```
Browser (WebGL + MediaPipe)  ←→  Flask + Gunicorn  ←→  SQLite
```

## Quick start

```bash
git clone https://github.com/Rs111104/3d-ambigram
cd 3d-ambigram

# Generate a bcrypt password hash:
python -c "import bcrypt; print(bcrypt.hashpw(b'yourpassword', bcrypt.gensalt()).decode())"

# Set required environment variables:
export ADMIN_USER="admin"
export ADMIN_PASSWORD_HASH="<HASH_HERE>"
export FLASK_SECRET="$(python -c 'import secrets; print(secrets.token_hex(32))')"

# Install and run:
pip install -r backend/requirements.txt
gunicorn -w 4 -b 0.0.0.0:8080 backend.server:app
```

Candidate page: http://localhost:8080/
Admin page:     http://localhost:8080/admin

## Docker

```bash
cp .env.example .env
# Edit .env and set ADMIN_USER, ADMIN_PASSWORD_HASH, and FLASK_SECRET.
docker compose up
```

## Environment variables

| Variable              | Required | Description                                    |
|-----------------------|----------|------------------------------------------------|
| ADMIN_USER            | Yes      | Admin username                                 |
| ADMIN_PASSWORD_HASH   | Yes      | bcrypt hash of admin password                  |
| FLASK_SECRET          | Yes      | Random 32-byte hex string for session signing  |
| DB_PATH               | No       | SQLite file path (default: exam.db)            |
| PORT                  | No       | Server port (default: 8080)                    |
| SECURE_COOKIES        | No       | Set to `true` when serving over HTTPS          |

The server will refuse to start if required variables are not set.

## Security model

| Threat                        | Mitigation                                      |
|-------------------------------|-------------------------------------------------|
| Read question from network    | One question served per request, never full bank|
| Virtual webcam (static photo) | Blink detection liveness check                  |
| Multiple people at screen     | Multi-face detection → flag                     |
| Brute-force admin login       | Rate limit: 5 attempts/minute per IP            |
| CSRF on state endpoints       | X-Requested-With header check                   |
| Session fixation              | New token on session start (secrets.token_urlsafe)|
| Persistent admin access       | Admin session tokens expire after 1 hour        |

## Roadmap

- [x] Webcam head-pose detection
- [x] WebGL angle-dependent question rendering
- [x] Admin dashboard with flag events
- [x] Blink-based liveness detection
- [x] SQLite persistence
- [ ] Generated decoy questions
- [ ] Iris gaze estimation
- [ ] Admin analytics charts
- [ ] Mobile browser support

## License

MIT

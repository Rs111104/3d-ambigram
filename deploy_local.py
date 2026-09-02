import os
from dotenv import load_dotenv
from waitress import serve

load_dotenv()

from backend.server import app

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    print(f"[*] 3D Ambi Engine starting on http://localhost:{port}")
    print(f"Admin Username: {os.environ.get('ADMIN_USER')}")
    print("Note: Admin password must be set via the ADMIN_PASSWORD_HASH environment variable.")
    
    serve(app, host="0.0.0.0", port=port)

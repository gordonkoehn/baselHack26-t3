# Vercel entrypoint. Local dev uses `uvicorn app.main:app`.
from app.main import app  # noqa: F401

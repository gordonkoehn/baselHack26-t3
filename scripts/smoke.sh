#!/usr/bin/env bash
# Boots backend + built frontend, checks the page loads and the frontend's /api proxy reaches the backend.
# Deliberately checks only /api/health and `/` so it survives the team replacing the example code.
set -euo pipefail
cd "$(dirname "$0")/.."
LOG=${TMPDIR:-/tmp}
(cd backend && exec uv run uvicorn app.main:app --port 8000) >"$LOG/smoke-backend.log" 2>&1 & B=$!
(cd frontend && exec npx next start -p 3000) >"$LOG/smoke-frontend.log" 2>&1 & F=$!
cleanup() { kill $B $F 2>/dev/null || true; pkill -f "uvicorn app.main:app --port 8000" 2>/dev/null || true; pkill -f "next start -p 3000" 2>/dev/null || true; }
fail() { echo "smoke FAILED: $1"; tail -30 "$LOG"/smoke-*.log; exit 1; }
trap cleanup EXIT
for _ in $(seq 30); do curl -sf localhost:3000/api/health >/dev/null && break; sleep 1; done
curl -sf localhost:3000/api/health | grep -q '"ok"' || fail "/api/health through the frontend proxy"
curl -sf -o /dev/null localhost:3000/ || fail "frontend page /"
echo "smoke OK"

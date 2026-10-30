.PHONY: help setup dev backend frontend check fix smoke

help:             ## list commands
	@grep -E '^[a-z]+:.*##' Makefile | sed 's/:.*##/ —/'

setup:            ## install everything
	cd backend && uv sync --locked
	cd frontend && npm ci

dev:              ## run backend :8000 + frontend :3000 together
	$(MAKE) -j2 backend frontend

backend:          ## backend only (loads backend/.env if present)
	cd backend && uv run uvicorn app.main:app --reload --port 8000 $(if $(wildcard backend/.env),--env-file .env)

frontend:         ## frontend only
	cd frontend && npm run dev

check:            ## what CI runs — run before pushing
	cd backend && uv run ruff check . && uv run ruff format --check . && uv run pytest -q
	cd backend && uv export --no-dev --no-hashes -q -o requirements.txt && git diff --exit-code requirements.txt
	cd frontend && npm run lint && npm run typecheck && npm run build

fix:              ## auto-fix formatting + lint, then run make check
	cd backend && uv run ruff format . && uv run ruff check --fix .
	cd frontend && npx eslint --fix .

smoke:            ## full stack: build frontend, boot both, hit the /api proxy (stop `make dev` first)
	cd frontend && npm run build
	./scripts/smoke.sh

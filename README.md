# baselhack26

Monorepo: `frontend/` (Next.js) + `backend/` (FastAPI) + `shared/` (API contract).

## Run it
Needs Node 20+, [uv](https://docs.astral.sh/uv/), make, git (+ `gh` optional).
macOS: `brew install node uv gh` · Linux/WSL: `curl -LsSf https://astral.sh/uv/install.sh | sh` + Node 20 · Windows: use WSL.

```bash
make setup   # install
make dev     # backend :8000 + frontend :3000 → open http://localhost:3000
make fix     # auto-format + lint fixes
make check   # what CI runs — do this before pushing
```
No make? `cd backend && uv sync && uv run uvicorn app.main:app --reload` and, in a second terminal, `cd frontend && npm ci && npm run dev`.

API keys: `cp .env.example backend/.env` and fill in. For the deployed app, ask the integrator.

API docs while running: http://localhost:8000/docs

## Your first PR (10 min)
1. Accept the GitHub invite, `git clone`, `make setup && make dev`.
2. Pick an open issue and **assign yourself** (or take the one you agreed at check-in).
3. `git switch -c 12-short-name` (issue number first).
4. Change something small. Commit early.
5. `make fix && make check`.
6. `gh pr create --fill` (or the GitHub web UI), with `Closes #12` in the body. Then `gh pr merge --auto --squash`, and it merges itself when CI is green.

Small PRs are welcome, and so is stacking. Coordination rhythm, check-ins and milestones: see [`PLAYBOOK.md`](PLAYBOOK.md) §4.

## How we work
- **Contract first:** agree on `shared/schema.json`, then build front and back in parallel against it.
- **No blocking reviews.** Branch → PR → merge within the hour once CI is green. Copilot reviews are advisory.
- **CI is the gatekeeper:** lint, tests, build, full-stack smoke test.
- **Every merge to main deploys** to Vercel (frontend + backend projects). PRs get preview URLs.
- AI tools: conventions in [`CLAUDE.md`](CLAUDE.md).

## Deployment
Two Vercel projects from this repo: root `frontend` and root `backend`. Frontend env `BACKEND_URL` = backend production URL.

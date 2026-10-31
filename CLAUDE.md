# AI-tool conventions (Claude, Copilot, Cursor — all read this)

48h hackathon. Speed over polish, but **main must always be green and demoable**.

## Layout
BaselHack structure, keep it: all code in `code/`, docs in `documentation/`, videos and slides in `assets/`.
- `code/shared/schema.json` — the API contract. **Source of truth.** Examples in `code/shared/examples/`.
- `code/backend/` — FastAPI (Python 3.12, uv). Entry `app/main.py`; models in `app/contracts.py`.
- `code/frontend/` — Next.js + TypeScript + Tailwind. Calls the backend only via `src/lib/api.ts`; types in `src/lib/contracts.ts`.
- `/api/*` on the frontend is proxied to the backend (`next.config.ts`, env `BACKEND_URL`).

## Workflow (agents too)
- Work on a branch named `<issue#>-short-slug`. Never commit to main; open a PR with `Closes #<issue>`.
- Stay inside the files of your issue. If you must touch someone else's area or the contract, say so in the PR.
- From `code/`, run `make fix` then `make check` before pushing. CI must be green to merge.

## Architecture constraints (Vercel serverless)
- **No WebSockets or long-lived connections in our backend.** Realtime voice: the browser connects directly to the voice provider (WebRTC/WS); our backend only mints short-lived tokens and serves persona/config data.
- In-memory state is per serverless instance and disappears. Fine for static fakes; anything that must survive between requests (personas, sessions, transcripts) goes in a real store (e.g. Upstash Redis via Vercel Marketplace) behind one small module.
- Provider calls (LLM, voice) go through one module in `code/backend/app/`, read keys from env, and are mocked in tests. Tests never hit the network.

## Rules
- Changing a data shape: edit `code/shared/schema.json` + example FIRST, then `code/backend/app/contracts.py` and `code/frontend/src/lib/contracts.ts` in the same PR. Announce it in the team chat.
- All endpoints live under `/api/`.
- Fake anything non-core (hardcoded users, no auth, static data).
- Small PRs, merged within the hour. Don't refactor code you don't own.
- Add a test for every new endpoint in `code/backend/tests/`. `code/scripts/smoke.sh` only checks /api/health and `/`; keep those working.
- After adding a Python dependency (`uv add x`), the `requirements.txt` export must be committed (`make check` does it).
- Secrets only in `.env` (gitignored) and Vercel env vars. Never commit keys.
- Next.js here is v16 — read `code/frontend/AGENTS.md` before using Next APIs you're unsure about.

## Design system (every page)
The OpenTwin design system is binding for all UI: https://claude.ai/artifact/1gtnRf163VDRipjg3bMpAZ. Read `documentation/DESIGN.md` before touching anything visible.
- Colours only through the tokens in `code/frontend/src/app/globals.css` (`bg-surface`, `text-muted`, `bg-accent`, …). No raw hex in components; a missing colour is added as a token first.
- Inter for all text: 800 headlines, 700 labels and buttons, 400 body. Headlines are full sentences with a full stop.
- Emerald (`accent`) is fill and accent; `signal` is the dot, never text on light grounds. There is no red.
- No emojis, no gradients except the dark glow; status always carries a word, not just a colour.

## Agent coordination (MCP Agent Mail)
All agents (Claude, Codex, Gemini, Copilot, …) share one Agent Mail server. Use it; it is how the team's agents know what the others are doing.
- **Project key is always `/Users/kollers/Documents/dev/baselHack26-t3`** (Johan's path, used as a shared name) — on every machine, never your own repo path, or you end up alone in your own project.
- Session start: `register_agent(project_key="/Users/kollers/Documents/dev/baselHack26-t3", program=<your tool>, model=<your model>, task_description=<issue # + goal>)`, then `fetch_inbox` and read anything unread.
- Before editing files: `file_reservation_paths(paths=[...], exclusive=true, ttl_seconds=3600, reason="#<issue>")`. On a conflict, message the holder instead of editing. Release when your PR is up.
- `send_message` when you: change `code/shared/schema.json` or another contract (thread `contract`, to everyone), finish or block on a task, or need something from another area. Threads: `contract`, `backend`, `frontend`, `voice`, `vision`, `spec`.
- Check `fetch_inbox` before each new task and before opening a PR; `acknowledge_message` when `ack_required`.
- Humans watch and steer at http://192.168.20.52:8765/mail/ (messages from HumanOverseer take priority).

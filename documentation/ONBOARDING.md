# Onboarding: where we are (Sat 31 Oct, 08:15)

Read this first, then `README.md` (how to run) and `CLAUDE.md` (rules for you and your AI tools). `PLAN.md` is the original plan; parts of its stack are outdated, see "What changed vs. the plan".

## The product in one minute
**Challenge:** live, interviewable AI test users for instant sprint validation (Sprintbox AI).
**Our answer (OpenTwin / "Friday, Now"):** a sprint team turns real interview material into an AI test user, interviews it live by voice with a talking face while sharing their prototype, and gets a debrief where every insight is labelled **grounded** (repeats a persona fact that cites a source passage) or **guess**.

Pitch line: "Simile predicts what a population will choose. We let a sprint team interrupt one test user mid-click, and we mark every answer the interviews can't back up as a guess."

Demo case: **Quartier-Börse** (synthetic demo data), see `testcase-quartier-boerse.md`. Sample guide and transcript are in `code/frontend/src/lib/`.

## What works today (all on main)
| Step | What it does | Code |
|---|---|---|
| 1. Sources | Paste text, drop text files, upload PDFs (text layer, or vision model for scans) and images (visible text transcribed) | `routers/sources.py`, `extract.py` |
| 2. Persona | OpenAI structured extraction → name, summary, jobs, pains, objections; each fact is a source-backed quote or a labelled assumption. Stored in Upstash Redis | `routers/personas.py`, `extract.py`, `store.py` |
| 3. Interview | Browser talks directly to OpenAI Realtime (WebRTC); backend only mints short-lived tokens. Persona stays in character, short replies, small talk first, holds its language; UI shows the permanent AI label | `realtime.py`, `components/InterviewRoom.tsx` |
| 4. Face | Simli avatar speaks the persona's voice (#63, newest) | `avatar.py`, `components/Avatar.tsx` |
| 5. Screen | Share screen; the persona sees a frame of it and reacts | `components/ScreenShareButton.tsx`, `lib/captureFrame` |
| 6. Transcript | Interview saved as validated, idempotent event batches | `routers/events.py`, `event_validation.py` |
| 7. Debrief | Themes + quotes, each quote verified against the transcript, labelled grounded/guess | `debrief.py`, `routers/insights.py`, `components/DebriefView.tsx` |

Visual pass (design tokens, Geist, card layout) is done for all three views.

API (all under `/api/`): `POST /sources/pdf`, `POST /sources/image`, `POST /personas`, `GET /personas/{id}`, `POST /sessions`, `GET|PATCH /sessions/{id}`, `POST /sessions/{id}/token`, `POST /sessions/{id}/avatar-token`, `POST|GET /sessions/{id}/events`, `POST /sessions/{id}/debrief`, `GET /sessions/{id}/insights`. Live docs: http://localhost:8000/docs. Contract: `code/shared/schema.json`.

Use case context lives in [`usecases/`](usecases/README.md). Public repo: anonymised material only.

## What changed vs. the plan
- **No LiveKit, no worker, no Deepgram/ElevenLabs.** We use OpenAI Realtime directly from the browser (`gpt-realtime-2.1-mini`, voice `marin`, `gpt-4o-mini-transcribe`). Simpler, fits Vercel. Watch the cost.
- Extraction/debrief model: `gpt-5.4-mini` (override `OPENAI_MODEL`).
- "Persona operates the prototype" (acting) is not started; watching works.

## Open work (pick one, assign yourself)
Demo safety first:
- **#74** Demo fallbacks: avatar off switch, sample-interview path, backup video, runbook
- **#75** Manual QA of the full demo on the deployed app (browser / mic / screenshare)
- **#73** Post-deploy smoke test against the Vercel URL
- **#68** Handle connection drop mid-interview
- **#67** Rate-limit provider endpoints (public URL burns credit)
- **#69** `.env.example` misses Simli keys (`SIMLI_API_KEY`, `SIMLI_FACE_ID`)

Quality, if time:
- #65 Playwright happy path · #64 frontend unit tests · #66 contract drift test · #70 LLM evals · #72 accessibility · #76 provider logging · #71 CI coverage
- #29 persona behaviour prompt + Quartier-Börse replay (Johan) · #13 Track 1 umbrella · #20 setup checklist

## Still unproven (from the challenge must-haves)
- A coherent **20–30 minute** interview that keeps context (soak test not done yet).
- **Immersion ≥ 5/10** from three raters.
- Persona ready in **under 10 minutes** (time it on the demo case).
- Interruption and latency under real mic conditions.

## Timeline
| When | Gate |
|---|---|
| Sat 13:00 | Core flow on the live URL |
| Sat 17:00 | First full 20–30 min interview |
| Sat 21:00 | Three raters ≥ 5/10, feature freeze |
| Sun 09:00 | Backup video, pitch rehearsed twice |
| Sun 11:00 | Code freeze (hands-off 12:00, pitches 13:00) |

## How to get going (15 min)
1. Clone, then from `code/`: `make setup && make dev` → http://localhost:3000.
2. Keys: `cp .env.example backend/.env`, ask Johan for `OPENAI_API_KEY`, Upstash and Simli keys. Never commit them.
3. Pick an issue above, assign yourself, branch `<issue#>-slug`, small PR with `Closes #<n>`, `make fix && make check`, auto-merge when green.
4. Using an AI agent? Connect it to Agent Mail with [AGENT-MAIL.md](AGENT-MAIL.md) (5 min), then it shows up on the Agent Board. Reserve files before editing.

## Rules that bite
- Main must always be green and demoable.
- Data shape change = `schema.json` + example first, then `contracts.py` and `contracts.ts`, same PR, announce it.
- No WebSockets/long-lived connections in our backend; anything that must survive goes in Redis.
- Tests never hit the network; provider calls are mocked.
- No real interview data, keys or personal data in this public repo.

## Who
Gordon (repo, Vercel, plan) · Johan (product features, integration) · 4rifi (backend: events, debrief, persona prompt) · Dion's agent GreenCastle (review, tests, coordination).

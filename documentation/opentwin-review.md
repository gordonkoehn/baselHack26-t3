# Review: OpenTwin spec vs. our repo rules and research

As of 30 Oct 2026. Reviews [opentwin-spec.md](opentwin-spec.md) against `CLAUDE.md`, [PLAN.md](PLAN.md) and the team research (`reports/Live AI twin interview tools.md`, not committed). Nothing here has been tested hands-on.

**Verdict:** keep the spec's product ideas (Twin Factory with evidence, grounded/guess labels, coach, insights back to the board, sycophancy tests). Don't build its stack A as written: five parts break our Vercel rule or our hardware, and it conflicts with the stack already chosen in `PLAN.md`. Build the trimmed stack at the end of this document; stack B stays a roadmap slide.

## Conflicts

Sorted by impact on the weekend.

| # | Spec says | Conflict | Impact | Fix |
| --- | --- | --- | --- | --- |
| 1 | `WS /sessions/{id}/events`, event bus (Redis Streams / NATS), "each module a separate service" | `CLAUDE.md`: no WebSockets or long-lived connections in our backend. Vercel WebSockets exist (beta) but close after 300–1,800 s, shorter than an interview | Copilot and dashboards can't run as specced | Browser posts event batches to `POST /api/sessions/{id}/events`, readers poll `GET …/events?after={seq}`. Store in Upstash Redis (one list per session). Coach = stateless `POST …/coach` per interviewer turn. No bus, one FastAPI app |
| 2 | Pipecat pipeline as the conversation engine | A Pipecat/LiveKit worker is a long-running process and can't live on Vercel. `PLAN.md` already picked LiveKit Agents | Two orchestration stacks in one team | One framework: LiveKit Agents, hosted on LiveKit Cloud (`lk agent deploy`, 1,000 free agent-min/month, then $0.01/min). Drop Pipecat |
| 3 | MuseTalk on 1 GPU (stack A avatar) | Team laptops are Apple Silicon. MuseTalk real-time needs NVIDIA (V100 ≈ 30 fps), MPS is "super slow", install is painful (mmcv/mmpose). It lip-syncs a *video*; a photo gives a frozen head. A cloud GPU adds an aiortc/WebRTC server + TURN outside Vercel and ~300–500 ms | Likely no face on Saturday, or an uncanny one (R2, R4) | Hosted avatar for the hackathon: Simli preset face as in `PLAN.md`, Tavus or Anam as fallback after the Sat 09:30 vendor test. MuseTalk/Ditto only in stack B (RunPod RTX 4090 ≈ $0.34–0.74/h) |
| 4 | Gemini Live as speech in + persona brain + screen frames | Connections reset about every 10 min; audio+video sessions end after 2 min without context compression; one report of a hard cut at ~58 min; slowest in 2026 benchmarks (tested on 3.1) | A 30-min interview needs reconnect logic in the browser, the main must-have at risk | Cascade in the LiveKit worker as in `PLAN.md` (Deepgram → OpenAI LLM → ElevenLabs). If a speech-to-speech model is wanted: OpenAI Realtime (60-min sessions), but `PLAN.md` estimates up to ~$25 per call |
| 5 | Language de-CH; latency p50 ≤ 1.0 s / p95 ≤ 1.5 s | No provider speaks Swiss German; Whisper-class STT has 23–40 % WER on spoken Swiss German (only Azure `de-CH` documents dialect input). A cascade + hosted avatar won't hit 1.0 s | Broken conversation if interviewers speak dialect; a target we will miss on stage | Persona speaks High German with Helvetisms (`speechStyle.notes`); interviewers speak High German. Demo target from `PLAN.md`: 90 % of turns under 2.5 s. Keep 1.0 s as the stack B goal |
| 6 | Twin "may disagree"; drift guard every 5 turns | Research (arXiv 2606.20708, June 2026): simulated customers rarely walk away (resistance 25 % → 13.5 %); telling them they may only partly fixes it | Twin praises every prototype; jury sees a yes-machine | `objections[]` in the persona card (added to the contract), re-inject persona + objections every ~5 turns, run the spec's seeded-weak-concept test before the demo |
| 7 | Readiness score: 20 probes × 3 runs | 60 LLM calls inside the ≤ 15 min budget, in a serverless request | Slow twin creation, timeout risk | 5 probes × 2 runs, in parallel, in one request (300 s default limit). Show the score; skip the "3 gap questions" loop |
| 8 | Screen: rrweb DOM events at 2 Hz + vision at 1 fps + perceptual hash | rrweb only works in prototypes we control (not Figma, not slides). 2 Hz POSTs = thousands of function calls per interview | A day of work for a channel the demo may not use | Vision only: screen share as a room track (LiveKit) or Raven (Tavus) → caption on change and on a "look at this" button (see vision spike: Claude Haiku ≈ $0.0002/frame). rrweb = stretch |
| 9 | Agent mode via Playwright MCP | Needs a remote browser (Browserbase/Kernel) and a driver; not costed | Scope creep (R8) | Keep `PLAN.md`'s gate: acting becomes the headline only if the Sat 13:00 core flow passes |
| 10 | Meeting bridge Vexa/Joinly; recording all tracks | Self-hosted bots are long-running; `PLAN.md` puts Zoom/Teams out. Recording needs LiveKit egress | Effort with no demo payoff | Own LiveKit room only. Store the transcript (events), not media |
| 11 | LlamaIndex knowledge index, vector store, Letta/Mem0, Langfuse | One persona card fits in the prompt | Four extra services | Persona JSON in the prompt, Upstash for state, logs for latency |
| 12 | Spec data model: snake_case, `source: "assumption"` | `PLAN.md` draft contract: camelCase, `label: grounded \| guess` | Two vocabularies for the same thing | Contract (below) follows `PLAN.md` and maps the spec: `source` → `label` + `evidenceId` |
| 13 | Files and recordings via the API | Vercel caps request bodies at 4.5 MB | Transcript uploads fail | Paste text; anything larger goes to Vercel Blob first |
| 14 | EU/CH data residency (stack A/C must list providers) | Avatar vendors offer EU residency only on Enterprise plans | Fine for a hackathon, not for a corporate pilot | Stock face + stock voice + "AI twin" label; no real customer data in this public repo (`PLAN.md`) |

The spec gets these right and they stay: AI disclosure and deepfake labelling (EU AI Act Art. 50 applies since 2 Aug 2026), stock voice and face by default, consent before any clone, grounded vs. guessed facts, insights per sprint question, quotes checked against the transcript.

## Decisions

| Decision | Recommendation | Why |
| --- | --- | --- |
| Stack A or B? | Neither as written: the trimmed stack below, which is `PLAN.md`'s stack plus the spec's product modules | B needs GPUs and self-hosting; A has conflicts 1–4 |
| Own web room or Teams? | Own LiveKit room | Teams media bots need .NET on Windows Server; Recall/Vexa are stretch at best |
| Interview language? | High German, with Helvetisms in the persona's speech; English as a per-persona switch for non-German judges | No Swiss German TTS; dialect STT is unreliable |
| Stock avatar or consented clone? | Stock (Simli preset, or a stock Tavus/Anam face) | Custom faces take hours on Simli; a clone needs written consent and an AI Act label; zero immersion gain worth the risk |
| Demo scenario? | The Sprintbox sandbox case and its prototype (ask Alex tonight); the e-bike persona in `code/shared/examples/` is only a placeholder | Judges know that case; it comes with persona data and voice references |
| GPU and budget? | No GPU. Budget per `PLAN.md` (~$16 + OpenAI credits) plus $22 Tavus Starter only if Simli fails the vendor test; integrator sets a hard cap (suggest CHF 100) | MuseTalk on a rented GPU costs ~$20 for the weekend but a day of setup and a second server |

## Trimmed stack A (shippable in 48 h)

| Layer | Choice | Runs where |
| --- | --- | --- |
| Room / transport | LiveKit Cloud (Build, $0) | LiveKit |
| Orchestration + turn-taking | LiveKit Agents worker with Silero VAD + turn detector | LiveKit Cloud agent hosting |
| Speech in | Deepgram, German | Worker |
| Persona brain | OpenAI LLM (credits), persona card + objections in the prompt, re-injected every ~5 turns | Worker |
| Voice out | ElevenLabs stock German voice | Worker |
| Avatar | Simli preset face; Tavus or Anam if Simli fails the Sat 09:30 test | Vendor |
| Screen | Screen share as room track → caption on change / button → `screen.caption` event | Worker or browser + `POST /api/vision/describe` |
| Twin Factory | One LLM call: sources → `Persona` with `evidence[]`; readiness 5 × 2 probes | Vercel (FastAPI) |
| State | Upstash Redis behind one module | Vercel Marketplace |
| Coach (stretch) | `POST /api/sessions/{id}/coach` per interviewer turn, Mom Test flags | Vercel |
| Insights | `POST /api/sessions/{id}/debrief`: one LLM call → `InsightReport`, quotes string-matched against the transcript; Markdown export, Miro as stretch | Vercel |
| Token minting | `POST /api/sessions/{id}/token` → LiveKit token | Vercel |

Cut: Pipecat, Gemini Live, MuseTalk/GPU, rrweb, Playwright agent mode (gated), Vexa/Joinly, LlamaIndex, Letta/Mem0, Langfuse, n8n, Dovetail, recording.

## Contract drafted in `code/shared/schema.json`

New `$defs` (Item/ItemCreate unchanged): `Label`, `SourceKind`, `Evidence`, `Fact`, `Persona`, `PersonaSource`, `PersonaCreate`, `Provider`, `Session`, `SessionCreate`, `SessionToken`, `SessionEvent` (types `utterance`, `screen.caption`, `twin.reaction`, `copilot.suggestion`, `session.ended`, each with its own `data` shape), `Insight`, `InsightReport`. Endpoints are listed with `"status": "draft"`. Examples: `persona.json`, `session.json`, `session-events.json`, `insight-report.json`, all validated against the schema.

Changes vs. the `PLAN.md` draft: `TranscriptTurn` became the `utterance` event (one stream for transcript, screen, reactions, coach), `POST …/turns` became `POST …/events`; `Persona` gained jobs/pains/objections as labelled facts, attitudes, speech style and readiness from the spec. Spec event `screen.state` (rrweb) is left out until rrweb is in scope.

### Follow-up edits (not done here)

1. `code/backend/app/contracts.py`: Pydantic models for the new `$defs` (camelCase field names as in the schema).
2. `code/frontend/src/lib/contracts.ts`: matching TypeScript types.
3. `code/backend/app/main.py`: the draft endpoints, each with a test in `code/backend/tests/` (providers mocked).
4. `code/backend/app/`: one store module (Upstash Redis) and one provider module (LLM, LiveKit token).
5. Announce the contract in the team chat; the integrator merges it first.

# OpenTwin: one task per track

Ready to paste as GitHub issues (template `.github/ISSUE_TEMPLATE/task.md`, label `todo`). Based on spec section 10, trimmed per [opentwin-review.md](opentwin-review.md). Each is bigger than one 2-hour task; split on pickup.

---

## Track 1 – Twin data: persona from sprint sources

**Goal:** `POST /api/personas` turns pasted sprint material (transcripts, Miro export, notes) into a `Persona` with `evidence[]`, every job, pain and objection labelled `grounded` (with `evidenceId`) or `guess`, plus a readiness score from 5 probe questions × 2 runs.
**Done when:** the Sprintbox sandbox case produces a persona card in under 10 minutes, shown in the UI with its readiness score, and `GET /api/personas/{id}` returns it; endpoint tests pass with the LLM mocked.
**Touches contract?** yes: `Persona`, `PersonaCreate`, `Evidence`, `Fact` (drafted in `code/shared/schema.json`).

---

## Track 2 – Audio and video: the twin speaks with a face

**Goal:** a LiveKit Agents worker on LiveKit Cloud runs Deepgram (German) → OpenAI LLM with the persona card + objections (re-injected every ~5 turns) → ElevenLabs stock voice → Simli preset face. `POST /api/sessions/{id}/token` mints the LiveKit token; the browser joins the room.
**Done when:** a 30-minute interview runs without a drop, 90 % of turns respond in under 2.5 s, the persona recalls 9 of 10 planted facts, and it rejects or questions at least 2 of 4 seeded weak concepts. Vendor test (Simli vs. Tavus/Anam) decided by Sat 09:30.
**Touches contract?** yes: `Session`, `SessionCreate`, `SessionToken`, `utterance` events.

---

## Track 3 – Screen: the twin sees the prototype

**Goal:** the interviewer's screen share reaches the twin as text: frame on a "look at this" button and on a real screen change → neutral caption (vision model) → injected into the persona's context and posted as a `screen.caption` event. Frames are never stored. Acting (the twin clicks) only if the Sat 13:00 gate passes.
**Done when:** shown 3 scripted prototype screens, the twin names the key label or price on 3 of 3 and reacts in character within one turn.
**Touches contract?** yes: `screen.caption` event; maybe `POST /api/vision/describe` (not yet in the schema).

---

## Track 4 – Loop and demo: transcript, coach, insights

**Goal:** the browser posts session events in batches to `POST /api/sessions/{id}/events` (no WebSocket). After the call, `POST /api/sessions/{id}/debrief` returns an `InsightReport` per sprint question with quotes string-matched against the transcript and labelled `grounded`/`guess`; Markdown export, Miro push as stretch. Stretch: `POST /api/sessions/{id}/coach` flags leading questions live.
**Done when:** ending a demo interview shows the insight report within 1 minute, every quote matches the transcript word for word, and the 5-minute demo script runs end to end on the live URL.
**Touches contract?** yes: `SessionEvent`, `Insight`, `InsightReport`.

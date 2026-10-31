# Browser regression tests (#65)

From `code/`: `make setup`, `cd frontend && npx playwright install chromium`, then
`cd .. && make e2e`. CI installs Chromium with its OS dependencies and runs the same target.
Use a clean checkout without frontend/backend `.env` files. No credentials are needed.

Playwright builds the real frontend and owns servers on 127.0.0.1:3165 and :8165. It refuses
existing servers and stops its children afterwards. Normal demo ports are untouched.
Reports/traces/screenshots go to `.review/issue65/` at repository root; override with
`E2E_ARTIFACT_DIR` (absolute path recommended). Fonts are omitted by an explicitly test-only
Next font response file; these tests do not validate typography.

The browser drives sample sources → persona → live interview → typed and simulated speech
turns → end/save → debrief with exact existing fixture quotes. It verifies ordered stored
turns, provider redelivery deduplication, waiting for the last response, microphone/connection
cleanup, modal opening/closing, the visible expanded final transcript and report turn attribution. The error scenarios check an accessible connection
failure with preserved sources and successful retry, plus incomplete transcription with no
end marker and a real 409 debrief response. The end-call scenarios (#99) cover End during
speech, delayed/missing/rejected final transcription, cancelled answers, repeated and
out-of-order events, connection loss and hung saves; they use simulated provider events, so
real provider timing and commit behaviour during VAD stay unmeasured.

Real: Next UI/handlers/proxy, FastAPI routes/contracts, persona evidence checks, Store
serialization/event sequencing, session transitions, debrief input/quote checks and saved
report. Fake: deterministic extraction outputs from shared examples, token provider client,
existing FakeRedis transport, SDP/WebRTC data channel and a silent synthetic microphone track.
Camera requests are explicitly rejected and the visible voice-only fallback is checked. Every
original microphone track is retained for cleanup assertions; closing the fake peer does not
stop it. Camera video/frame behavior is outside this suite.
The debrief fake never derives quotes from stored events, so it cannot manufacture missing
transcript evidence. No HTTP event uploads are made by test code: production handlers send them.

Browser nonlocal HTTP and all WebSockets are intercepted; backend outbound socket connections
are denied in the explicitly invoked `tests.e2e_server` entrypoint. Production imports/config
are unchanged. No real microphone, screen frame, audio playback, avatar or provider quality is
claimed. Avatar SDK lifecycle remains outside this bounded suite.

Negative control (must exit nonzero): from `code/frontend`, run
`E2E_FAIL_EVENT_SAVE=1 E2E_ARTIFACT_DIR=/tmp/issue65-negative npm run test:e2e -- --grep 'sample sources'`.
This blocks event persistence while leaving creation, realtime UI and end/save handlers intact.
The happy test must reject the missing saved-transcript/debrief state. Remove the flag for a
normal passing run; do not enable it in CI.

Microphone cleanup negative control (must exit nonzero): use `E2E_KEEP_MIC_LIVE=1` instead of
`E2E_FAIL_EVENT_SAVE=1` with the same command. It makes the original track's stop ineffective;
the happy path must detect that the microphone remains live even after the peer closes.

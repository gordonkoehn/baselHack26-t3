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
end marker and a real 409 debrief response.

Real: Next UI/handlers/proxy, FastAPI routes/contracts, persona evidence checks, Store
serialization/event sequencing, session transitions, debrief input/quote checks and saved
report. Fake: deterministic extraction outputs from shared examples, readiness probe answers, token provider client,
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

## Transcript finalization (#99)

`finalization.spec.ts` adds behavioral checks for End during active speech, a conditional
single commit with a changed item ID, transcript/commit redelivery and reordering, terminal
response output reconciliation, delayed/missing automatic VAD responses after successful
transcription, both manual/VAD commit acknowledgement orders with separate retained transcripts,
manual-only success/empty/failure with retained or changed item IDs without a fabricated
response terminal event, retention of independent VAD response work (including speech_stopped
before or after a retained-ID acknowledgement). Response attribution survives later VAD confirmation
or a distinct manual acknowledgement even if response.created/response.done arrived first,
without phantom reservations or losing either transcript. Startup PATCH deadlines/body stalls/gateway 504s run both
with and without a connection-loss event. Captured startup turns remain visible and saved
through incomplete finalization; a delayed live mutation after ended receives 409 and cannot
change endedAt. The backend enforces this ordering atomically, without client mutation fences.
Startup timeout cases also exercise hung POST/PATCH Save again recovery with the same
payload/seq, visible captured turns and the incomplete debrief gate.
It also covers server playback drain, empty/failed transcription, cancelled/
failed/incomplete answers, bounded ten-second recovery and explicit continuation, incomplete
close, generation isolation, response rejection, connection loss during drain/recovery, and
hung event POST/final PATCH requests. Both hung fetch and hung body-after-acceptance paths
assert a finite retry budget, byte-identical retry payloads, retained later turns and one end
marker after explicit recovery. Requests use the existing fake provider/backend stack. Test
clock time is synthetic; these checks do not measure healthy real-provider latency.

From `code/frontend`, run `npm run test:e2e` for the browser suite. Offline helper/deadline
checks can also run with `node --test e2e/finalization.unit.mjs` (uses the existing TypeScript
compiler and Node test mocks). They do not launch browsers or open sockets and supplement
the behavioral tests rather than establishing browser behavior.

Manual verification remains open: a real WebRTC/VAD trace of End during speech, including
separate audio/control ordering, conditional-commit races and audible persona playback.
Record End-to-final-provider-item, event persistence and final PATCH durations using the
content-free `Transcript finalization` console measurements. The healthy-call five-second
target is not established by mocked timing. Live microphone/provider checks need separate
authorization and are never performed by these tests.

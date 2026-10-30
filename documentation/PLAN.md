# Plan: Friday, Now (working title)

**Status:** draft, Fri 30 Oct. Nothing below has been tested yet.

**Challenge:** [How might we generate live, interviewable AI test users for instant sprint validation?](https://www.baselhack.ch/challenges/how-might-we-generate-live-interviewable-ai-test-users-for-instant-sprint-validation) (Sprintbox AI)

## The idea
A design sprint's Friday user test, on demand. Teams create an AI test user in minutes, interview it live, and watch it try their prototype.

The demo:
1. **Create:** paste sprint context and past interview transcripts. A timer shows the persona ready in under 10 minutes.
2. **Interview:** talk to the persona by voice, with its avatar on screen, for 20–30 minutes.
3. **Use the prototype:** the persona sees the prototype and, as the headline feature, operates it while thinking aloud. The team watches and asks questions.
4. **Debrief:** themes and quotes, each labelled **grounded in real interviews** or **persona's guess**.
5. **Coaching (cut first):** flags leading interviewer questions.

## Positioning
Most of the parts already exist: transcript-grounded personas, cited answers, live voice, real-time avatars and AI usability testers. Simile, Actual Simulation, Dovetail Digital Twins, Listen Twins and TheySaid each cover some of this, so we shouldn't claim those parts as novel.

What we didn't find elsewhere (limited search, so not proof of a gap):
- Interrupting a persona while it's using a prototype.
- Clearly marking answers the interviews can't back up as guesses.

Results are hypotheses that complement real users. They don't replace them.

**Pitch line:** "Simile predicts what a population will choose. We let a sprint team interrupt one test user mid-click, and we mark every answer the interviews can't back up as a guess."

## Must-haves (from the challenge)
- [ ] End-to-end flow from persona data to a rendered avatar with voice
- [ ] One avatar ready in 10 minutes, 15 at most
- [ ] A coherent 20–30 minute conversation that keeps context
- [ ] Average immersion of at least 5/10 from three demo participants

**No-gos:** text-only, Custom GPT wrappers, only generation or only interaction, minor add-ons to off-the-shelf products, pre-recorded canned responses.

## Scope
**In:** one persona from the Sprintbox sandbox, live voice, a visual avatar, screen awareness, the labelled debrief.

**Headline if the gates pass:** the persona operates the prototype.

**Stretch:** multi-source persona generation, or interviewer coaching.

**Out:** group interviews, real Zoom/Teams joining, digital twins of team members, real logins or real data in the test browser.

## Watch first, then act
Watching and acting share the hard part: understanding the screen. So we build in this order:
1. **Watch:** the persona sees the screen and reacts. This keeps the must-haves safe and also works for slides and images.
2. **Act:** the persona clicks and types, narrating before and after each step so there are no awkward silences.

Rules for acting: only our own prototype or a test copy, a fresh remote browser, no logins, no real submissions, and a human abort button.

## Roles
| Role | Owns | First issue |
|---|---|---|
| Integrator | Contract, main, deploys, keys and spending caps | Merge the real contract |
| Persona engine | Persona data and transcripts → in-character instructions | Build one sandbox persona |
| Realtime voice | Tokens, browser audio, interruptions | Spoken conversation in the browser |
| Avatar | Vendor test, rendering | Compare two vendors on lag, session length and cost |
| Screen + browser | Screen understanding, then acting | Prove see → act → say what happened |
| Debrief + product | UI flow, labelled insights, pitch | Clickable flow, debrief from a sample transcript |

## Timeline and gates
| When | Goal | If it fails |
|---|---|---|
| Fri night | Voice conversation with a sandbox persona and static portrait. Vendor test. Up to 2 hours on see → act → say | Keep the portrait, decide at 09:30 |
| Sat 09:30 | Pick the avatar vendor | Animated portrait, if a mentor accepts it |
| Sat 13:00 | Core flow on the live URL. Acting becomes the headline only if this passes | Drop acting, focus on the core |
| Sat 17:00 | First full 20–30 minute interview | Fix memory and context before anything else |
| Sat 18:00 | Unscripted acting run, three times out of three | Cut acting, keep watching |
| Sat 21:00 | Three raters average 5/10 or more. Feature freeze | Only immersion fixes after this |
| Sun 09:00 | Backup demo video, pitch rehearsed twice | |
| Sun 11:00 | Code freeze (official hands-off 12:00, pitches 13:00) | |

## Constraints
- Vercel can't hold live connections, so the backend issues short-lived tokens and the browser talks to the voice provider directly.
- Serverless memory disappears, so personas, sessions and transcripts need a real store.

## Consent and disclosure
- The avatar is permanently labelled as AI and says so when a session starts.
- Anyone rated or recorded gives notice and consent first.
- Written consent from anyone whose face or voice is cloned, including voice references.
- No keys, personal data or transcripts from real interviews in this public repo.

## Open questions
**Mentors:**
- Does a persona operating a prototype count toward the challenge?
- Is an animated portrait acceptable as the visual avatar?
- Is a stack of bought vendors a "minor add-on"?
- Does stitching sessions together count as one conversation?

**Team:**
- Which sandbox case do we use?
- Which interview transcripts can we use, and when?
- What's our spending cap?
- Who leads overnight?

## Proposed stack (nothing here has been run)
LiveKit Agents worker on LiveKit Cloud, with Deepgram speech-to-text, an LLM, ElevenLabs voice and Simli preset faces. Vercel only issues tokens and serves the API. Upstash Redis holds personas, sessions and transcripts.

**Why this one:** lowest estimated cost, screen share arrives as a normal room track, and it's the design with the most room to swap parts.

**LLM:** the analysis assumed Claude, but we now have OpenAI credits. Use OpenAI through the same pipeline if it passes the latency test. Avoid the OpenAI Realtime API as the default: worst-case cost was estimated at about $25 per call, which would burn the credits in a few interviews.

**Acting:** not costed yet. It needs a remote browser (Kernel or Browserbase) and a driver such as Stagehand.

| Service | Cost | Env var | Where |
|---|---|---|---|
| LiveKit Build | $0 | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | API, local |
| Simli Hobby | $10 | `SIMLI_API_KEY` | Worker, local |
| Deepgram | Free credit | `DEEPGRAM_API_KEY` | Worker, local |
| ElevenLabs Starter | $6 | `ELEVEN_API_KEY` | Worker, local |
| OpenAI | Credits | `OPENAI_API_KEY` | API, worker, local |
| Upstash Redis | Free | Check injected names | API, local |

Also needed: `AGENT_SHARED_SECRET`, `DEMO_PASSCODE`, and `BACKEND_URL` on the worker.

## Data contract (draft)
```json
Persona {"id":"p_1","name":"","language":"","summary":"","traits":[],"faceId":"","voiceId":"",
 "evidence":[{"id":"e1","claim":"","quote":"","transcriptId":"t1"}]}
Session {"id":"s_1","personaId":"p_1","roomName":"","status":"created|live|ended",
 "readySeconds":null,"startedAt":null,"endedAt":null}
TranscriptTurn {"sessionId":"s_1","seq":1,"speaker":"interviewer|persona",
 "text":"","at":"ISO-8601","screenNote":null}
Insight {"id":"i1","sessionId":"s_1","theme":"","quote":"","turnSeq":1,
 "label":"grounded|guess","evidenceId":null}
```

Endpoints: `POST /api/personas`, `GET /api/personas/{id}`, `POST /api/sessions`, `GET` and `PATCH /api/sessions/{id}`, `POST /api/sessions/{id}/token`, `POST /api/sessions/{id}/turns`, `POST /api/sessions/{id}/debrief`, `GET /api/sessions/{id}/insights`.

## Tests tonight and Saturday morning
| Test | Pass | Fallback |
|---|---|---|
| Preset face talks | Lips and voice in sync | LemonSlice |
| Avatar survives silence | Past 10 minutes, with 40 seconds of silence | LemonSlice |
| Interruption, 5 tries | 4 of 5 stop within 1 second | Short replies, headset |
| Latency, 20 turns | 90% under 2.5 seconds | Shorter replies, text notes |
| Screen frame | Reads 3 of 3 labels | Screenshot button |
| 35-minute soak by Sat 10:30 | Recalls 9 of 10 planted facts, no drop | Fix memory first |

# Plan: Friday, Now (working title)

**Status:** draft, Fri 30 Oct. Nothing below has been tested yet.

**Challenge:** [How might we generate live, interviewable AI test users for instant sprint validation?](https://www.baselhack.ch/challenges/how-might-we-generate-live-interviewable-ai-test-users-for-instant-sprint-validation) (Sprintbox AI)

## The idea
A design sprint's Friday user test, on demand. Teams create an AI test user in minutes, interview it live, and get a debrief that shows what's grounded and what's a guess.

The demo:
1. **Create:** paste sprint context and past interview transcripts. A timer shows the persona ready in under 10 minutes.
2. **Interview:** talk to the persona by voice, with its avatar on screen, for 20–30 minutes while sharing a prototype. It reacts to what it sees.
3. **Debrief:** themes and quotes, each labelled **grounded in real interviews** or **persona's guess**.
4. **Compare:** show the same question answered by a text-only persona report, to make the immersion gap visible.

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
This plan merges the original draft with the OpenTwin technical spec. The spec is the longer-term vision; this file is what we build this weekend.

**Core (must work by Sat 13:00):**
- One persona from the Sprintbox sandbox, every fact tagged with a source or marked as an assumption
- Behaviour rules: admits confusion, hesitates, disagrees, gives no design advice
- Live voice and a Simli preset avatar in the browser
- Screen awareness from shared-screen frames
- Labelled debrief, in High German or English

**Only if the Sat 13:00 core works, in this order:**
1. The persona operates the prototype
2. rrweb page events on web prototypes we control
3. Simple readiness score

**Later (not this weekend):** Miro export, interviewer copilot, Letta or Mem0 memory, event bus, MCP server, Teams or Zoom bots, Langfuse, self-hosted stack, voice cloning, group interviews, digital twins of team members.

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
| Screen + browser | Screen understanding, then acting | Persona reads the shared screen |
| Debrief + product | UI flow, labelled insights, pitch | Clickable flow, debrief from a sample transcript |

## Timeline and gates
| When | Goal | If it fails |
|---|---|---|
| Fri night | Voice conversation with a sandbox persona and static portrait. Vendor test. Persona reads a shared screen | Keep the portrait, decide at 09:30 |
| Sat 09:30 | Pick the avatar vendor | Animated portrait, if a mentor accepts it |
| Sat 13:00 | Core flow on the live URL. Acting becomes the headline only if this passes | Drop acting, focus on the core |
| Sat 17:00 | First full 20–30 minute interview | Fix memory and context before anything else |
| Sat 18:00 | If attempted: unscripted acting run, three times out of three | Cut acting, keep watching |
| Sat 21:00 | Three raters average 5/10 or more. Feature freeze | Only immersion fixes after this |
| Sun 09:00 | Backup demo video, pitch rehearsed twice | |
| Sun 11:00 | Code freeze (official hands-off 12:00, pitches 13:00) | |

## Constraints
- Vercel can't hold live connections, so the backend issues short-lived tokens and the browser talks to the voice provider directly.
- Serverless memory disappears, so personas, sessions and transcripts need a real store.

## Consent and disclosure
- The interview UI permanently labels the persona as AI. The persona itself stays in character (no spoken disclosure) and only answers honestly when asked directly whether it is an AI (Johan, 31 Oct).
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

## Current stack
Browser (Next.js) talks directly to OpenAI Realtime over WebRTC for voice and to Simli for the avatar. The FastAPI backend keeps the keys, issues short-lived tokens, and runs extraction and the debrief. Upstash Redis stores personas, sessions, events and reports. See `ONBOARDING.md` for details and `code/.env.example` for keys.

The data contract lives in `code/shared/schema.json`.

## Tests
| Test | Pass | Fallback |
|---|---|---|
| Preset face talks | Lips and voice in sync | LemonSlice |
| Avatar survives silence | Past 10 minutes, with 40 seconds of silence | LemonSlice |
| Interruption, 5 tries | 4 of 5 stop within 1 second | Short replies, headset |
| Latency, 20 turns | 90% under 2.5 seconds | Shorter replies, text notes |
| Screen frame | Reads 3 of 3 labels | Screenshot button |
| 35-minute soak by Sat 10:30 | Recalls 9 of 10 planted facts, no drop | Fix memory first |
| Sycophancy, 4 weak concepts among 8 | Rejects or questions at least 2 of the 4 | Tighten behaviour rules |

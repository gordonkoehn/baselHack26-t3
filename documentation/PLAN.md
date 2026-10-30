# Plan: Friday, Now (working title)

**Status:** first draft, Fri 30 Oct. Nothing below has been tested yet. Vendor details are still being checked.

**Challenge:** [How might we generate live, interviewable AI test users for instant sprint validation?](https://www.baselhack.ch/challenges/how-might-we-generate-live-interviewable-ai-test-users-for-instant-sprint-validation) (Sprintbox AI)

## The idea
A design sprint's Friday user test, on demand. Teams create an AI test user in minutes, interview it live, and watch it try their prototype.

The demo:
1. **Create:** paste sprint context and past interview transcripts. A timer shows the persona ready in under 10 minutes.
2. **Interview:** talk to the persona by voice, with its avatar on screen, for 20–30 minutes.
3. **Use the prototype:** the persona sees the prototype and, as the headline feature, operates it while thinking aloud. The team watches and asks questions.
4. **Debrief:** themes and quotes, each labelled **grounded in real interviews** or **persona's guess**.
5. **Coaching (cut first):** flags leading interviewer questions.

## Why it stands out
- A synthetic persona can't reveal anything that isn't in its inputs. The labels show what comes from real data and what's invented, so results are treated as hypotheses, not user evidence.
- The value is immersion, team buy-in and testing inside the sprint.
- Grounding, labelling and the prototype test are our own work, so this is more than a wrapper around a bought tool.

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
- No API keys are set up yet. The list depends on the chosen stack.

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

## Coming next in this doc
Chosen stack, exact API keys, data contract and ready-to-paste issues.

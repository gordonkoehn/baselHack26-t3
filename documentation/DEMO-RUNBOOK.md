# Demo runbook: what to do when something fails

For the pitch of the Quartier-Börse demo. Fallbacks, best first: voice without avatar → sample interview → saved report link → backup video.

## 30 minutes before the pitch

| Check | How | If it fails |
|---|---|---|
| App is up | Open the deployed URL through the team link (`?code=…`, pinned in Discord). `/api/health` says `ok`. | Redeploy, or go to the backup video. |
| Passcode | Click **Create persona**. A "needs the team link" message means the code is missing or wrong. | Reopen the team link. `DEMO_PASSCODE` is set on the `*-api` Vercel project. |
| `OPENAI_API_KEY` | Create persona gets a result. Check the remaining budget on the OpenAI dashboard: personas, debriefs and live calls all use it. | Top up. Without it only saved report links and the video work. |
| `SIMLI_API_KEY` | One short call shows the face. Check the remaining Simli credit. | Keep the avatar off (below). |
| `UPSTASH_REDIS_REST_*` | Create persona and the transcript counter ("Transcript saved n/n") work. Check the Upstash daily limit. | Without the store nothing live works: go to the backup video. |
| Rate limits | If the rate-limit PR (#121) is merged, the rehearsal counts against the per-IP and global limits. Don't burn them right before the pitch. | Wait for the window to pass, or use a saved report link. |
| Mic and speakers | Allow microphone and camera in the browser on the demo laptop, on the venue network. | The call does not start without microphone permission: fix it in the browser settings, or use the sample interview. A denied camera is fine. |
| Saved report link | Run **Use sample interview** once, press **Copy link** on the debrief, and keep the link open in a tab. | Create it again. |
| Backup video | Play the video from `assets/` on the laptop, offline. **Not recorded yet, see below.** | Record it. |

## If something fails during the pitch

| What you see | Click | What still works |
|---|---|---|
| Face frozen, out of sync, or stuck on "Avatar is joining…" | **Turn avatar off** in the call popup. The call keeps going and the voice comes straight from the call. **Turn avatar on** tries again with a new avatar session. | Everything except the face. |
| "Avatar unavailable, voice only." | Nothing. The call already continues by voice. | Everything except the face. |
| You know Simli is down before the call | **Turn avatar off** on the persona card before **Start voice interview**. It stays off for this persona; building a new persona turns it on again. | Everything except the face. |
| Room too loud | **Mute mic** and type the questions. | Everything. |
| Popup stuck on "Connecting…" | **Cancel** in the popup, then **Use sample interview** on the persona card. Don't reload: that loses the persona on screen. Say out loud that this is a scripted sample. | Debrief, labelled as a sample. Needs the OpenAI API and the store, not Realtime or a microphone. |
| Call fails to start, or drops ("Connection lost") | **Use sample interview** on the persona card. Say out loud that this is a scripted sample. | Same as above. |
| Persona or debrief fails, or OpenAI is down | Show the saved report link from the check above. It reads the stored report, so it needs no model and no passcode. | That one report, while the store is reachable. |
| Wi-Fi or the deployed app is gone | Play the backup video. Phone hotspot first if there's time. | The video. |

## What the sample interview is, and isn't

**Use sample interview** needs a persona on the screen, so with no persona, create one first (this uses the OpenAI API, not Realtime). It saves `SAMPLE_TRANSCRIPT` (`code/frontend/src/lib/sample.ts`) as a new ended session marked `sample`, and asks for the debrief. No microphone, no token, no call.

The debrief, the shared `/report/…` link and the Markdown export all say it is a sample. Don't present it as an interview that just happened. Its example sources contain the same script, so "grounded" labels there prove nothing.

## Still open before the pitch

- [ ] Record the backup video and put it in `assets/`.
- [ ] Rehearse each fallback once on the deployed app: avatar off mid-call, sample interview, saved report link, backup video.

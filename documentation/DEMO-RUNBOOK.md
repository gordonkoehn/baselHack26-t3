# Demo runbook: what to do when something fails

For the pitch of the Lumen demo, see [#158](https://github.com/gordonkoehn/baselHack26-t3/issues/158). Fallbacks, best first: voice without avatar → saved report link → backup video.

## The stage demo on main today

Checked against `main` on 31 Oct. Update this table when the open work merges.

| Step in #158 | On main | Not on main yet |
|---|---|---|
| Persona score screen | Pick the prepared persona under **Recent personas**. Its card shows a readiness score (consistency and grounding). | Category scores (#142, open PR #174) |
| Note in a small chat | Nothing. | The chat |
| Start the call | **Start video interview** | Fullscreen call with the script beside it (#132, draft PR #170) |
| Show the email and presentation | **Share screen**, then **Show screen to persona**. It sends one frame per click, so click again after changing the page. | In-app viewer (#143) |
| Report | End the call. The debrief starts by itself, opens with a short summary (what held up, what didn't, still open) and labels each insight. | #155 and #156 are open. |

## 30 minutes before the pitch

| Check | How | If it fails |
|---|---|---|
| App is up | Open the deployed URL through the team link (`?code=…`, pinned in Discord). `/api/health` says `ok`. | Redeploy, or go to the backup video. |
| Passcode | Click **Create persona**. A "needs the team link" message means the code is missing or wrong. | Reopen the team link. `DEMO_PASSCODE` is set on the `*-api` Vercel project. |
| Lumen persona | Pick the prepared persona under **Recent personas**. | Create it again: remove the prefilled Quartier-Börse sources, upload the files from `documentation/usecases/lumen-ipp/sources/p1-miriam-kessler/`, and choose **English** (the default is Deutsch). |
| Interview questions | Replace the prefilled Quartier-Börse questions in the interview card with the two questions quoted in #158 step 4, one per line: "We'd send you a pre-configured email 90 days before renewal. How would you like that?" and "What do you think?". To use the short guide `documentation/usecases/lumen-ipp/interview/guide-short-miriam-kessler.txt` (#172) instead, leave out its first line, the greeting. The field goes back to Quartier-Börse on every page load, and the debrief answers every line in it. | Retype them. |
| Test object | Open the Lumen prototype from `documentation/usecases/lumen-ipp/test-object/` on the demo laptop, then **Share screen** and **Show screen to persona** in a short call. | Allow screen recording in the browser and system settings, or describe the screen out loud. |
| `OPENAI_API_KEY` | One short call works. Check the remaining budget on the OpenAI dashboard: personas, debriefs and live calls all use it. | Top up. Without it only saved report links and the video work. |
| `SIMLI_API_KEY` | One short call shows the face. Check the remaining Simli credit. | Keep the avatar off (below). |
| `UPSTASH_REDIS_REST_*` | **Recent personas** loads and the transcript counter ("Transcript saved n/n") works. Check the Upstash daily limit. | Without the store nothing live works: go to the backup video. |
| Rate limits | Rehearsals count against the hourly limits, and the venue shares one IP: 60 personas and 60 debriefs per IP (150 each overall), 120 tokens per IP (300 overall), and an interview start with the avatar on uses two tokens. Before the pitch, set `RATE_LIMIT_MULTIPLIER` (e.g. `5`) on the backend's Vercel project and redeploy. | "Too many requests… Try again in n min.": set the multiplier and redeploy, wait out the window, or use a saved report link. |
| Mic and speakers | Allow microphone and camera in the browser on the demo laptop, on the venue network. | The call does not start without microphone permission: fix it in the browser settings, or show the saved report link. A denied camera is fine. |
| Saved report link | Run one rehearsal call with the Lumen persona and questions, press **Copy link** on the debrief, and keep the link open in a tab. | Create it again. |
| Backup video | Play the video from `assets/` on the laptop, offline. **Not recorded yet, see below.** | Record it. |

## If something fails during the pitch

| What you see | Click | What still works |
|---|---|---|
| Face frozen, out of sync, or stuck on "Avatar is joining…" | **Turn avatar off** in the call popup. The call keeps going and the voice comes straight from the call. **Turn avatar on** tries again with a new avatar session. | Everything except the face. |
| "Avatar unavailable, voice only." | Nothing. The call already continues by voice. | Everything except the face. |
| You know Simli is down before the call | **Turn avatar off** on the persona card before **Start video interview**. It stays off for this persona; building a new persona turns it on again. | Everything except the face. |
| Room too loud | **Mute mic** and type the questions. | Everything. |
| "Screen sharing was cancelled or blocked." | Describe the email out loud. The persona only knows the prototype from what you show or describe. | The call and the debrief. |
| Popup stuck on "Connecting…" | **Cancel** in the popup, then show the saved report link from the check above. Say out loud that it comes from a rehearsal. | That one report, while the store is reachable. |
| Call fails to start, or drops ("Connection lost") | Show the saved report link. Say out loud that it comes from a rehearsal. | Same as above. |
| Persona or debrief fails, or OpenAI is down | Show the saved report link. It reads the stored report, so it needs no model and no passcode. | Same as above. |
| Wi-Fi or the deployed app is gone | Play the backup video. Phone hotspot first if there's time. | The video. |

## The sample interview is not a Lumen fallback

**Use sample interview** always saves the same script, the Quartier-Börse recycling interview, whatever persona is on the screen. There is no Lumen version on main, so with a Lumen persona the debrief would be about recycling. Don't use it in the Lumen pitch. It only suits the built-in example, see `testcase-quartier-boerse.md`.

It needs a persona on the screen, so with no persona, create one first (this uses the OpenAI API, not Realtime). It saves `SAMPLE_TRANSCRIPT` (`code/frontend/src/lib/sample.ts`) as a new ended session marked `sample`, and asks for the debrief. No microphone, no token, no call.

The debrief, the shared `/report/…` link and the Markdown export all say it is a sample. Don't present it as an interview that just happened. The prefilled example sources contain the same script, so for a persona built from them "grounded" labels prove nothing.

## Still open before the pitch

- [ ] Record the backup video and put it in `assets/`.
- [ ] Prepare the Lumen persona and the saved report link on the deployed app.
- [ ] Rehearse each fallback once on the deployed app: avatar off mid-call, saved report link, backup video.
- [ ] Run the stage demo on the live link three times in a row, inside one minute (#158).

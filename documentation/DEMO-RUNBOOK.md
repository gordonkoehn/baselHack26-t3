# Demo runbook: what to do when something fails

For the pitch of the Lumen demo, see [#158](https://github.com/gordonkoehn/baselHack26-t3/issues/158). Fallbacks, best first: voice without avatar → saved report link → backup video.

## The stage demo on main today

Current-flow guidance checked against source at `main` commit `50d34cb` on 31 Oct, with #170, #183, #189, #202 and #205 merged. This is a source review; real-model, production and manual acceptance remain open. Update this table when the open work merges.

| Step in #158 | On main | Not on main yet |
|---|---|---|
| Persona score screen | Create a persona or pick the prepared one under **Recent personas** on **Sources**: both open **Score**. Coverage starts automatically unless this workspace already holds a check for that persona version. The three categories are **Persona**, **Challenge understanding** and **Solution**, each with a percentage, a **Red / Yellow / Green** word, a reason and any recommendation. The overall advice is **Add more first.** or **Good enough to test.**, with no overall number on this screen. **Add more** opens the coverage details; **Go to the interview** opens **Interview**. Both work while checking or after a failed check. Open **Persona** for the profile and evidence. | The persona's files after a pick: the **Sources** tile on **Persona** shows 0, **Sources and evidence** is empty, and grounded facts show their quote but not the file name. Only a persona built in the current page load lists its files. |
| Note in a small chat | Nothing. | The chat |
| Start the call | **Interview** tab, then **Start video interview** opens the fullscreen dialog (#170 merged). **Script** shows the current guide with checkboxes and an `n of N` counter; switch to **Transcript** for spoken turns. Ticks survive panel switches, reset for a new session, and do not affect the debrief. | — |
| Show the email and presentation | **Share screen** sends a first frame immediately, then refreshes about every 10 seconds as silent context; camera image updates pause while sharing. While sharing, the video call and the shared screen are one stage (#205): the avatar and your camera shrink to a column on the left, the shared screen takes the rest with its send status under it, and the stage's **Full screen** enlarges both together. After changing the page, use **Show screen to persona** to send a fresh frame and ask for a reaction. | In-app viewer (#143) |
| Report | **End interview**. The debrief starts by itself, opens with a short summary (what held up, what didn't, still open) and labels each insight. Since #189 a call that went live asks for a debrief even after a lost turn or a dropped connection. If part of the call may not have been captured, the room, the debrief (above the summary), the shared report and the Markdown export say the transcript "may have gaps". That warning can be false. If the wait after End runs out with a turn still missing, **Close without it** closes the call and sets the same warning. There is no debrief when the call never went live, or when no persona answer was saved ("No debrief for this call"). | #155 is open. |

**Score and details:** **Add more** shares the same coverage check with **Score**. It shows the test-goal field, own criteria, overall coverage percentage, criterion rows and gap questions, plus a separate **Test call**. The goal and own criteria are remembered in this browser. Without a saved custom goal, the built-in Quartier sources use their sample goal; other sources and library picks start with "The product, prototype or change that the sources describe." Set the intended Lumen goal here and press **Check again** (or **Check coverage** if no report exists). Goal or criterion edits do not start a check by themselves. Saving gap answers or a row edit updates the persona and automatically checks again. **Back to the score** returns to the three categories.

**Pending, stale or failed checks:** while the first check runs, the categories show "–" / **Not checked** and `Checking <name>. You can go on meanwhile.` A changed persona version, goal or own criteria makes the previous result stale: **Score** hides its percentages and levels, says **Needs a new check.**, identifies what changed and offers **Check now**. The previous detail report can still be visible on **Add more**, with **The persona changed since this check.** or **The test changed since this check.** A failed first check leaves the categories unscored and offers a retry with an error; an older backend without category data cannot supply scores. A failed re-check can leave an earlier matching report visible; check the error on **Add more**, not just the numbers. Coverage advice and errors do not block navigation to **Interview**; the interview itself still requires at least one question.

## 30 minutes before the pitch

| Check | How | If it fails |
|---|---|---|
| App is up | Open the deployed URL through the team link (`?code=…`, pinned in Discord). `/api/health` says `ok`. | Redeploy, or go to the backup video. |
| Passcode | Click **Create persona**. A "needs the team link" message means the code is missing or wrong. | Reopen the team link. `DEMO_PASSCODE` is set on the `*-api` Vercel project. |
| Lumen persona | Pick the prepared persona under **Recent personas**. It opens **Score**; let the coverage check finish and confirm the intended goal under **Add more** before presenting its three category scores. | Create it again: remove the prefilled Quartier-Börse sources, upload the two PDFs and the CSV from `documentation/usecases/lumen-ipp/sources/p1-miriam-kessler/`, and keep **English** (the default for a new page load). A library pick keeps the persona's saved language; check **Interview language** on the **Persona** tab. Leave out the profile `.md`: it is the full answer key, and the persona should show what it infers from the sources. |
| Interview questions | Creating or picking Miriam Kessler automatically fills the **Interview** tab with `LUMEN_GUIDE`, the four lines in `documentation/usecases/lumen-ipp/interview/guide-short-miriam-kessler.txt` (#172), including "Hi Miriam, nice to see you again! How are you today?". The UI counts **4 questions**; the greeting is a debrief item too. Remove it before starting if only the three prototype prompts should be scored. For the exact #158 step 4 pitch instead, replace the field with its two questions, one per line: "We'd send you a pre-configured email 90 days before renewal. How would you like that?" and "What do you think?"; the UI then counts **2 questions**. | Check the field and count before starting; restore the chosen guide if needed. |
| Test object | Open the Lumen prototype from `documentation/usecases/lumen-ipp/test-object/` on the demo laptop. In a short call, **Share screen** and choose only the prototype's tab or window, keeping private content and the call out of the capture. Check the first-frame status and automatic refresh about every 10 seconds; these updates do not request speech and replace camera image updates while sharing. Change the page, then **Show screen to persona** to request a reaction to a fresh frame. | Allow screen recording in the browser and system settings, or describe the screen out loud. |
| `OPENAI_API_KEY` | One short call works. Check the remaining budget on the OpenAI dashboard: personas, debriefs and live calls all use it. | Top up. Without it only saved report links and the video work. |
| `SIMLI_API_KEY` | One short call shows the face. Check the remaining Simli credit. | Keep the avatar off (below). |
| `UPSTASH_REDIS_REST_*` | **Recent personas** loads and the transcript counter ("Transcript saved n/n") works. Check the Upstash daily limit. | Without the store nothing live works: go to the backup video. |
| Rate limits | Rehearsals count against the hourly limits, and the venue shares one IP: 60 personas and 60 debriefs per IP (150 each overall), 120 tokens per IP (300 overall), and an interview start with the avatar on uses two tokens. Coverage checks and gap answers count as personas. Before the pitch, set `RATE_LIMIT_MULTIPLIER` (e.g. `5`) on the backend's Vercel project and redeploy. | "Too many requests… Try again in n min.": set the multiplier and redeploy, wait out the window, or use a saved report link. |
| Mic and speakers | Allow microphone and camera in the browser on the demo laptop, on the venue network. | The call does not start without microphone permission: fix it in the browser settings, or show the saved report link. A denied camera is fine. |
| Saved report link | Run one rehearsal call with the Lumen persona and questions, press **Copy link** on the debrief, and keep the link open in a tab. | Create it again. |
| Backup video | Play the video from `assets/` on the laptop, offline. **Not recorded yet, see below.** | Record it. |

Guide lifecycle: edits stay in the current Interview room across workspace-tab switches and **Start again**. Opening a different persona creates a new room: Miriam gets the four-line Lumen guide; other library picks start empty. A new non-Miriam persona gets the three Quartier-Börse questions only when built from the two unchanged built-in example sources; other material starts empty. Reloading loses the current room and its unsaved guide edits; picking the persona again applies these defaults, not an earlier session's guide. At each interview start, trimmed, non-empty lines are saved as that new session's `interviewGuide`. Its debrief uses that saved guide, so later field edits do not change an earlier report.

## If something fails during the pitch

| What you see | Click | What still works |
|---|---|---|
| Face frozen, out of sync, or stuck on "Avatar is joining…" | **Turn avatar off** in the call popup. The call keeps going and the voice comes straight from the call. **Turn avatar on** tries again with a new avatar session. | Everything except the face. |
| "Avatar unavailable, voice only." | Nothing. The call already continues by voice. | Everything except the face. |
| You know Simli is down before the call | **Turn avatar off** on the **Interview** tab before **Start video interview**. It stays off until the page reloads or another persona opens. | Everything except the face. |
| Room too loud | **Mute mic** and type the questions. | Everything. |
| "Screen sharing was cancelled or blocked." | Describe the email out loud. The persona only knows the prototype from what you show or describe. | The call and the debrief. |
| "Connection lost" during a live call | Wait. The room saves what it captured and starts the debrief, marked "may have gaps". Press **Save again** if it appears. If no debrief comes, show the saved report link and say out loud that it comes from a rehearsal. | The debrief of what was saved, while the store and OpenAI are reachable. Otherwise the saved report link. |
| Popup stuck on "Connecting…" | **Cancel** in the popup, then show the saved report link from the check above. Say out loud that it comes from a rehearsal. | That one report, while the store is reachable. |
| Call fails to start, or the connection is lost before it goes live | Show the saved report link. Say out loud that it comes from a rehearsal. This session has no debrief. | Same as above. |
| Persona or debrief fails, or OpenAI is down | Show the saved report link. It reads the stored report, so it needs no model and no passcode. | Same as above. |
| Wi-Fi or the deployed app is gone | Play the backup video. Phone hotspot first if there's time. | The video. |

## The sample interview

**Use sample interview** on the **Interview** tab picks its script by persona name (#202):

- **Miriam Kessler** (any persona whose name contains "Kessler") gets a synthetic Lumen sample, `LUMEN_SAMPLE_TRANSCRIPT`. It is handwritten fiction in English: nobody was interviewed. The interviewer's lines are the four `LUMEN_GUIDE` lines.
- **Every other persona**, including the other Lumen personas, keeps the Quartier-Börse recycling script, `SAMPLE_TRANSCRIPT`. With another Lumen persona the debrief would be about recycling, so don't use it in the Lumen pitch. It only suits the built-in example, see `testcase-quartier-boerse.md`.

Check the name on the screen before you press it. The script doesn't follow the question field, but the debrief answers what is in that field, so keep the four lines when you run the Kessler sample.

It needs a persona on the screen, so with no persona, create one first (this uses the OpenAI API, not Realtime). It saves the script (`code/frontend/src/lib/sample.ts`) as a new ended session marked `sample`, and asks for the debrief. No microphone, no token, no call. The debrief still needs the passcode, OpenAI and the store, so the sample does not replace the saved report link when OpenAI is down. The same button under **Test call** has no questions, so it gives no debrief.

The room, the transcript, the debrief, the shared `/report/…` link and the Markdown export all say it is a sample. Say so out loud, and don't present it as an interview that just happened. The Kessler answers are imagined, not facts from her sources, so never add them as sources. In a sample "grounded" proves nothing, whichever persona you use: the prefilled example sources contain the Quartier-Börse script, and the Kessler script shares phrases with her sources, so an insight can stay grounded. Don't present a grounded label from a sample as source support.

The browser test for the Kessler sample (`code/frontend/e2e/lumen-sample.spec.ts`) uses a fake debrief, so it does not cover a debrief from the real model on this script.

## Still open before the pitch

- [ ] Record the backup video and put it in `assets/`.
- [ ] Prepare the Lumen persona and the saved report link on the deployed app.
- [ ] Rehearse each fallback once on the deployed app: avatar off mid-call, saved report link, backup video.
- [ ] Run the browser, mic, screen-share, sources, interview and debrief checklist in [qa-run.md](qa-run.md) on the deployed app (#75). Every Fail becomes its own bug issue.
- [ ] Run the stage demo on the live link three times in a row, inside one minute (#158).

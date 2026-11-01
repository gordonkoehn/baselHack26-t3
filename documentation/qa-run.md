# Manual QA run on the deployed app (#75)

One structured run of the full demo on **https://baselhack26-t3-web.vercel.app**, before the pitch. Mic, camera, screen sharing and the voice provider can only be tested by a person at a real machine: schemas, prompt assertions and mocked tests are not a pass here.

How to fill it in: copy the file (or edit it in a PR), set **Result** to `Pass`, `Fail`, `Skipped` or `Untested` for every row, and write what you actually saw under **Notes** (exact message text, timings, counts). A row you could not run stays `Untested`, never `Pass`.

The original UI/backend expectations were written at `90e25e1`; language defaults, guide/session lifecycle, fullscreen Script/Transcript and Score navigation were source-checked at `main` commit `762ea99`, with #170 and #183 merged. Those source-derived expectations are preserved below. The current partial native checkpoint is recorded separately in [Native evidence for #75](qa-evidence-75.md), including narrowly scoped subcase results. All **39 full checklist rows remain Untested** for this checkpoint; #75 remains open. If the text on screen differs, write down what it says.

## Run details

| Field | Value |
|---|---|
| Date and time | 2026-10-31; native observations recorded at 22:30:28 UTC (23:30:28 Europe/Zurich). Individual interaction times not supplied. Partial checkpoint. |
| Tester | Codex using native browser automation (CUA accessibility trees and screenshots) in real installed Chrome and Safari. |
| Deployed commit | Frontend `50d34cb75351eefd1e8a69a462f1817a2064a99f`, mapped by public `dpl_EZEhDD2JXDMXUKk6JAdagkDENhuE` to the supplied successful Vercel web status. Exact backend revision unconfirmed. See evidence report. |
| Browser and version | Chrome 156.0.8078.74 (build 8078.74); Safari 26.6.2 (build 21624.5.1.11.3). Native partial cases, no full browser pass. |
| OS and device | macOS 26.6.2; desktop surface. Device model and screen dimensions not recorded. No physical phone tested. |
| Microphone and speakers (headset, laptop, external) | Untested; no real voice or person spoken. Hardware not recorded. |
| Network (venue Wi-Fi, hotspot, home) | Not recorded. Production frontend and backend-rendered sample report observed. |
| Persona used (name, language) | Existing fictional Miriam Kessler in Safari; four Lumen guide lines. UI defaults to English; saved persona language and spoken language not independently recorded. |

**Current limits:** Chrome authenticated QA remains **pending / Untested**, not Skipped; the address bar was presented for the existing valid team link and input is pending. At 22:41:05 UTC, both native browser handles became unavailable (`cgWindowNotFound`); fresh selection and one CUA reset failed. This blocks further automation and is a tool limitation, not an app Fail. Safari's scripted sample supports only the separate subcase results, including six UI quote fragments. Clipboard feedback succeeded, but TextEdit readback timed out and no matching download file was found in default Downloads; export content/integrity remains Untested. [Native evidence for #75](qa-evidence-75.md) records the boundaries. No new QA execution or results occurred in this documentation follow-up.

**Reading the deployed commit:** the app shows no version. Open the Vercel dashboard for the `baselhack26-t3-web` project (and the `*-api` backend project), open the current production deployment and copy the commit SHA it was built from. Or run `vercel ls baselhack26-t3-web` and `vercel inspect <url>` if you have the CLI linked. Write both SHAs if frontend and backend differ.

**Before you start (source-derived expectations, not measured native HTTP statuses):** open the app through the existing team link with `?code=…`. When the backend has a demo passcode configured, missing or wrong codes return HTTP 401 with detail "passcode missing or wrong: open the team link" on persona creation, PDF/image extraction, token and debrief requests. Text files are read locally and need no passcode. The UI renders that 401 differently: persona creation shows "This needs the team link with the passcode. Ask in Discord."; PDF/image imports show `<file name>: passcode missing or wrong: open the team link`; voice-token failure shows "Could not start (401): passcode missing or wrong: open the team link"; debrief creation shows "Debrief failed (401): passcode missing or wrong: open the team link". Local development without a configured passcode allows these requests; Vercel without one returns 503 "demo passcode not configured" instead. Record the actual status and UI text; do not expect one shared message for every route.

Check that `https://baselhack26-t3-web.vercel.app/api/health` returns `{"status":"ok"}`. Rehearsals count against the hourly rate limits (see `DEMO-RUNBOOK.md`); a "Too many requests … Try again in n min." message is a limit, not a bug in the row you are testing.

## 1. Browsers

Run the whole demo once per desktop browser: create or pick a persona, review **Score**, then use **Go to the interview** and set the **Interview** question field to the two questions you will ask (one per line; confirm **2 questions**), start a video interview, ask both, end, read the debrief. On the phone only the create and debrief views are in scope.

**Current navigation (#183 merged):** creating a persona or picking one from **Recent personas** opens **Score**, not the profile. A coverage check starts automatically unless the workspace already holds one for that persona version. Expect three categories: **Persona**, **Challenge understanding** and **Solution**, each with a percentage, a **Red / Yellow / Green** word, a reason and any recommendation. Overall advice is **Add more first.** or **Good enough to test.**, with no overall percentage here. **Add more** opens the shared coverage details (goal, own criteria, overall percentage, criterion rows and gap answers) and a separate **Test call**; **Back to the score** returns to the categories. Open **Persona** for the profile, language and evidence.

Check the intended goal on **Add more**: a saved custom goal and own criteria persist in this browser; otherwise only the built-in Quartier sources use their sample goal, and other sources/library picks use "The product, prototype or change that the sources describe." Editing the goal or own criteria requires **Check again** (or **Check coverage** without a report). Saving gap answers or a row edit updates the persona and automatically checks again.

Record pending, stale and failed states as observed, not as completed checks: a first running check shows "–" / **Not checked** and `Checking <name>. You can go on meanwhile.` A changed persona version, goal or own criteria hides the old category percentages/levels on **Score** and shows **Needs a new check.** with **Check now**. **Add more** can retain the old detail report with a changed-persona/test warning. A failed first check leaves categories unscored and offers a retry/error; a backend without category data reports that it is too old to score. A failed re-check may retain an earlier matching report, with the error on **Add more**. **Add more** and **Go to the interview** stay usable during checking and failures; starting the interview still requires a non-empty guide. These are source-derived manual expectations; real-model, production and manual acceptance are open.

| # | Browser | Steps | Expected | Result | Notes |
|---|---|---|---|---|---|
| 1.1 | Chrome (macOS or Windows), latest | Full demo as above. | Persona builds with a running seconds counter and opens **Score** with an automatic coverage check. A library pick also opens **Score**. Review the three categories, then use **Go to the interview**. The call popup goes from "Connecting…" to "Live, speak now" with a running timer. The fullscreen dialog shows **Script** with **Your script** and `0 of 2`; switch to **Transcript** to see spoken turns. The persona answers by voice. **End interview** leads to "Ended. Microphone and camera are off, transcript saved." and the debrief writes itself ("Writing debrief…" then "Debrief ready."). | Untested | |
| 1.2 | Safari (macOS), latest | Same as 1.1. | Same as 1.1. Write down any extra permission prompts and whether the avatar face and voice play. | Untested | |
| 1.3 | Phone browser (name it: iOS Safari or Android Chrome) | Open the team link. Add a text source, create a persona, review **Score**, then open **Persona** to read the profile. Open a saved debrief link (`/report/…`). | Layout fits the screen width, no horizontal scrolling. Persona and debrief are readable, the quote labels are visible. The call itself is not in scope on the phone. | Untested | |

## 2. Microphone permission

| # | Case | Steps | Expected | Result | Notes |
|---|---|---|---|---|---|
| 2.1 | Allow | Reset the site permission, start a video interview, allow the microphone. | The call reaches "Live, speak now". The first spoken sentence shows up as your turn in the transcript. | Untested | |
| 2.2 | Deny | Reset the site permission, start a video interview, deny the microphone. | No live call. The message reads "Microphone access was denied. Allow microphone access in your browser and start again." The session closes as incomplete: "Interview could not start. Capture is off; this incomplete session has no debrief. Start again to retry." No debrief is offered. | Untested | |
| 2.3 | Unanswered prompt | Start a video interview and leave the microphone prompt open for over 45 seconds. | "Connecting took too long. Check microphone permission and your network, then start again." **Cancel** in the popup also works at any point during "Connecting…". | Untested | |
| 2.4 | Camera denied, mic allowed | Allow the microphone, deny the camera. | The call goes live by voice. Note under the camera area: "Camera is off (blocked or not available). The persona only hears you." | Untested | |
| 2.5 | Revoke mid-interview | During a live call, revoke the microphone in the browser's site settings (address bar icon) or unplug the mic. | Not handled specially in the code, so record exactly what happens: does the call keep going with silence, drop with "Connection lost. Microphone, camera and screen sharing are off.", or show a Realtime error? Does **End interview** still save the turns so far? | Untested | |
| 2.6 | Mute | Press **Mute mic**, speak, then type a question in "Type a question". | While muted the room is not heard (no new interviewer turns from speech). "Mic muted, type your question instead." is shown. The typed question gets a spoken answer. **Unmute mic** restores speech. | Untested | |

## 3. Screen share

Have the Lumen prototype (`documentation/usecases/lumen-ipp/test-object/`) open in another tab or window. **Share screen** only appears while the call is live.

| # | Case | Steps | Expected | Result | Notes |
|---|---|---|---|---|---|
| 3.1 | Tab (Chrome) | **Share screen**, pick the prototype tab. | Buttons change to **Show screen to persona** and **Stop sharing**. The status under the camera shows "Sending the first screen image to the persona…", then "Screen image sent to the persona ns ago." A new image goes out about every 10 seconds without clicking. Ask "What do you see?": the answer names labels or prices that are really on the screen. | Untested | |
| 3.2 | Window | Same as 3.1, pick the prototype's window. | Same as 3.1. Change the page, wait 10 seconds, ask again: the answer refers to the new screen. | Untested | |
| 3.3 | Cancel the picker | **Share screen**, then cancel the browser's picker. | "Screen sharing was cancelled or blocked." The call keeps going. | Untested | |
| 3.4 | Stop sharing | While sharing, press **Stop sharing** (or the browser's own "Stop sharing" bar). | The button goes back to **Share screen**. Ask "What do you see?": the persona no longer describes the prototype as if it still sees it. | Untested | |
| 3.5 | Safari (macOS) | Repeat 3.1 to 3.3 in Safari. | Write down what Safari offers (window or whole screen only, no tab picker is expected) and whether the images reach the persona. If macOS blocks screen recording, note the system prompt. | Untested | |
| 3.6 | Manual frame | While sharing, press **Show screen to persona** right after changing the page. | "Shown to the persona." and the persona reacts to that screen in character. | Untested | |

## 4. Sources

Upload on the **Sources** tab with **Add files…** or drag and drop. Accepted files: `.txt .md .csv .json .tsv .pdf .png .jpg .jpeg .webp .gif`. Each file's problem is listed as `<file name>: <reason>` under the form.

| # | Case | Steps | Expected | Result | Notes |
|---|---|---|---|---|---|
| 4.1 | Text | Add a `.txt` or `.csv` file. | A new source card with the file name and the file's text. No server call. | Untested | |
| 4.2 | PDF with text layer | Add a normal PDF (e.g. the Lumen PDFs in `documentation/usecases/lumen-ipp/sources/p1-miriam-kessler/`). | Card titled `<name>.pdf (n pages)` with the PDF's text. | Untested | |
| 4.3 | Scanned PDF | Add an image-only PDF of up to 20 pages. | Takes longer (the vision model reads each page). Card titled `<name>.pdf (n pages)` with transcribed text. More than 20 scanned pages: "scanned PDF has more than 20 pages". | Untested | |
| 4.4 | Image | Add a photo or screenshot with text (PNG/JPEG). | Card titled `<name> (image, transcribed)` with the text in the image. An image without text: "image has no readable text". | Untested | |
| 4.5 | Too-large file | Add a PDF over 10 MB. | The backend answers 413 "PDF larger than 10 MB". Images are shrunk to 2048 px JPEG in the browser first, so a large photo should still upload; test the 413 with a PDF. **Check this on the deployed app:** Vercel functions reject request bodies over about 4.5 MB before our code runs, so a 5 to 10 MB file may show a different 413 text from Vercel. Record the exact message and the file size; a raw or confusing error is a Fail. | Untested | |
| 4.6 | Unsupported or broken file | Add a `.docx`; add a `.pdf` that is really a renamed text file. | `.docx`: "not supported (use .txt,…)". Fake PDF: "not a PDF file". | Untested | |
| 4.7 | Persona from uploads | Create a persona from the uploads above. | The persona builds and opens **Score** with an automatic coverage check. Open **Persona**; its facts quote the uploaded text. | Untested | |

## 5. Interview

Related: #58 and #59. Run each case in a fresh call.

**Guide setup and lifecycle:** creating or picking Miriam Kessler fills four Lumen lines, including the greeting, so the UI counts **4 questions**. Removing the greeting leaves **3 questions**; replacing the field with two prompts leaves **2 questions**. Other library picks start empty; a newly created non-Miriam persona gets the three Quartier-Börse questions only from the two unchanged built-in example sources, otherwise an empty field. At least one non-empty line is required to start. Edits survive workspace-tab switches and **Start again** in the current room, but opening a different persona replaces the room. Reloading loses the room and unsaved edits; a library pick applies the defaults above and does not restore a previous session's guide. Each start saves the trimmed, non-empty lines as the new session's `interviewGuide`.

**Fullscreen panels (#170 merged):** **Script** shows the current guide as **Your script**, with checkboxes and an `n of N` counter (initially `0 of 4` for Miriam's unchanged guide, `0 of 2` for the two-question browser run). **Transcript** shows spoken turns. Script ticks survive panel switches, reset for each new session, and do not affect the debrief. These remain manual expectations to verify, not completed checks.

| # | Case | Steps | Expected | Result | Notes |
|---|---|---|---|---|---|
| 5.1 | Barge-in | While the persona is answering, start speaking. Repeat 5 times. | The persona's voice (and the avatar) stops within about 1 second in at least 4 of 5 tries. The cut answer stays in the transcript, followed by an `(interrupted)` turn. Record the count. | Untested | |
| 5.2 | Background voice | A second person talks 1 to 2 m away for 3 × 20 seconds while the persona answers. | At most 1 unintended interruption. Record the count. | Untested | |
| 5.3 | Long silence | Say nothing for 60 seconds while live. | The call stays "Live, speak now" and does not drop. Record whether the persona speaks on its own. | Untested | |
| 5.4 | End while the twin speaks | Press **End interview** in the middle of a persona answer. | Status shows "Checking the final provider events", then "Saving captured text" and "Closing the saved session" with seconds elapsed. Ends with "Ended. Microphone and camera are off, transcript saved." and a debrief. If the answer's audio outlasts the wait, the room closes by itself about 10 seconds after End and the rest of the audio is cut off, with its words saved. If a turn may have been lost, it ends instead with "Ended. Microphone and camera are off. This transcript may have gaps: part of the call may not have been captured." and the debrief carries the same warning. A warning can be false: record whether anything was really missing. Each completed turn appears once. | Untested | |
| 5.5 | End during your last sentence | Press **End interview** while you are still speaking. | Same as 5.4. If the wait limit hits: "The wait limit was reached. Capture is off." with **Continue waiting (10 seconds)** and **Close without it**. Record the elapsed seconds. | Untested | |
| 5.6 | Save failure | (Optional) Go offline right after **End interview**. | "Could not finish saving (n/m events stored). The call is closed. Choose Save again to retry." Back online, **Save again** completes. | Untested | |
| 5.7 | Turn order | Look at the whole transcript after a call. | Turns are in spoken order, also when your speech finishes transcribing after the persona's answer. Text that arrives after its place has passed goes to the end of the transcript and nothing on screen says so, so check the order by reading it. An out-of-order turn is a Fail: record the turns in a new issue. | Untested | |
| 5.8 | Avatar off and on | During a live call press **Turn avatar off**, then **Turn avatar on**. | "Avatar off, voice only." and the voice keeps playing. Turning it on brings a new face. | Untested | |

## 6. Debrief

| # | Case | Steps | Expected | Result | Notes |
|---|---|---|---|---|---|
| 6.1 | Quotes match the transcript | For every insight, find its quote in the transcript using the "interview turn n" reference. | Each quote is word for word from that turn. Any made-up or reworded quote is a Fail. | Untested | |
| 6.2 | Source labels | For each insight, check the label against the persona's sources. | `grounded` with "also in the sources" only when the sources really say it; `guess` with "not backed by the sources" otherwise. In the summary: "Also in the sources" or "Persona's guess". | Untested | |
| 6.3 | One answer per question | Record the **Interview** question field and count before starting, then compare them with that session's debrief. | Every trimmed, non-empty line saved at start has its own block with a signal label, including the greeting if retained. Later edits to the field do not change this saved session's debrief. | Untested | |
| 6.4 | Markdown export | **Copy as Markdown**, paste into a text editor; **Download .md**. | "Markdown copied to clipboard." and "Markdown download started." Both contain the same questions, quotes and labels as the screen. Record clipboard behaviour per browser. | Untested | |
| 6.5 | Saved link | **Copy link**, open it in a private window (no passcode). | "Link copied. Anyone with it can read this debrief." The link shows the same debrief without the passcode. | Untested | |
| 6.6 | Sample is marked | (Optional) **Use sample interview** with the built-in Quartier-Börse persona. | Banner: "Sample interview loaded: a scripted transcript. No live call took place and nobody was interviewed." Quotes say "Sample script · turn n". | Untested | |

## 7. Language

From the product feedback on #75. The interview language is the one chosen in the **Deutsch / English** select next to **Create persona** (a new page load defaults to **English**). Picking a saved persona keeps its saved language; the select only sets the language for a new creation. The persona's language shows as "Interview language" on the **Persona** tab. For each run, record: build, browser, selected language, what language the persona actually spoke, how your speech was transcribed, and whether quotes and evidence keep their original language.

| # | Case | Steps | Expected | Result | Notes |
|---|---|---|---|---|---|
| 7.1 | German source, English conversation | Add a German-only source, choose **English**, create the persona, run a short call in English, end, read the debrief. | The persona speaks English throughout. Your turns are transcribed in English. Evidence quoted from the source stays German, word for word. Interview quotes in the debrief are the English turns as spoken. | Untested | |
| 7.2 | English source, German conversation | Add an English-only source, choose **Deutsch**, create the persona, run a short call in German, end, read the debrief. | The persona speaks German throughout. Your turns are transcribed in German. Source evidence stays English, word for word. Interview quotes are the German turns as spoken. | Untested | |
| 7.3 | Asked to switch | In 7.1, ask the persona to switch to German. | It stays in its language or switches only hesitantly if that fits the persona; it does not talk about its rules. Record what it did. | Untested | |

## After the run

Every Fail becomes its own bug issue, linked from #75. Use one line per issue:

```
[QA #75] <area>: <what happened> (expected: <what this checklist says>); <browser/OS>, commit <sha>, row <#>
```

Example: `[QA #75] Sources: 6 MB PDF shows "Request Entity Too Large" (expected: PDF larger than 10 MB); Chrome 130/macOS, commit abc1234, row 4.5`.

Post the filled-in table as a comment on #75 or commit it here. The known open item stays where it is: selected-board snapshots (#136).

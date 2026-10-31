# Manual QA run on the deployed app (#75)

One structured run of the full demo on **https://baselhack26-t3-web.vercel.app**, before the pitch. Mic, camera, screen sharing and the voice provider can only be tested by a person at a real machine: schemas, prompt assertions and mocked tests are not a pass here.

How to fill it in: copy the file (or edit it in a PR), set **Result** to `Pass`, `Fail`, `Skipped` or `Untested` for every row, and write what you actually saw under **Notes** (exact message text, timings, counts). A row you could not run stays `Untested`, never `Pass`.

Expected results quote the UI and backend text on `main` at the time this checklist was written (commit `90e25e1`). If the text on screen differs, write down what it says.

## Run details

| Field | Value |
|---|---|
| Date and time | |
| Tester | |
| Deployed commit | |
| Browser and version | |
| OS and device | |
| Microphone and speakers (headset, laptop, external) | |
| Network (venue Wi-Fi, hotspot, home) | |
| Persona used (name, language) | |

**Reading the deployed commit:** the app shows no version. Open the Vercel dashboard for the `baselhack26-t3-web` project (and the `*-api` backend project), open the current production deployment and copy the commit SHA it was built from. Or run `vercel ls baselhack26-t3-web` and `vercel inspect <url>` if you have the CLI linked. Write both SHAs if frontend and backend differ.

**Before you start:** open the app through the existing team link with `?code=…`. When the backend has a demo passcode configured, missing or wrong codes return HTTP 401 with detail "passcode missing or wrong: open the team link" on persona creation, PDF/image extraction, token and debrief requests. Text files are read locally and need no passcode. The UI renders that 401 differently: persona creation shows "This needs the team link with the passcode. Ask in Discord."; PDF/image imports show `<file name>: passcode missing or wrong: open the team link`; voice-token failure shows "Could not start (401): passcode missing or wrong: open the team link"; debrief creation shows "Debrief failed (401): passcode missing or wrong: open the team link". Local development without a configured passcode allows these requests; Vercel without one returns 503 "demo passcode not configured" instead. Record the actual status and UI text; do not expect one shared message for every route.

Check that `https://baselhack26-t3-web.vercel.app/api/health` returns `{"status":"ok"}`. Rehearsals count against the hourly rate limits (see `DEMO-RUNBOOK.md`); a "Too many requests … Try again in n min." message is a limit, not a bug in the row you are testing.

## 1. Browsers

Run the whole demo once per desktop browser: create or pick a persona, start a video interview, ask two questions, end, read the debrief. On the phone only the create and debrief views are in scope.

| # | Browser | Steps | Expected | Result | Notes |
|---|---|---|---|---|---|
| 1.1 | Chrome (macOS or Windows), latest | Full demo as above. | Persona builds with a running seconds counter and opens the **Persona** tab. The call popup goes from "Connecting…" to "Live, speak now" with a running timer. The persona answers by voice, turns appear in the transcript. **End interview** leads to "Ended. Microphone and camera are off, transcript saved." and the debrief writes itself ("Writing debrief…" then "Debrief ready."). | | |
| 1.2 | Safari (macOS), latest | Same as 1.1. | Same as 1.1. Write down any extra permission prompts and whether the avatar face and voice play. | | |
| 1.3 | Phone browser (name it: iOS Safari or Android Chrome) | Open the team link. Add a text source, create a persona, read the **Persona** tab. Open a saved debrief link (`/report/…`). | Layout fits the screen width, no horizontal scrolling. Persona and debrief are readable, the quote labels are visible. The call itself is not in scope on the phone. | | |

## 2. Microphone permission

| # | Case | Steps | Expected | Result | Notes |
|---|---|---|---|---|---|
| 2.1 | Allow | Reset the site permission, start a video interview, allow the microphone. | The call reaches "Live, speak now". The first spoken sentence shows up as your turn in the transcript. | | |
| 2.2 | Deny | Reset the site permission, start a video interview, deny the microphone. | No live call. The message reads "Microphone access was denied. Allow microphone access in your browser and start again." The session closes as incomplete: "Interview could not start. Capture is off; this incomplete session has no debrief. Start again to retry." No debrief is offered. | | |
| 2.3 | Unanswered prompt | Start a video interview and leave the microphone prompt open for over 45 seconds. | "Connecting took too long. Check microphone permission and your network, then start again." **Cancel** in the popup also works at any point during "Connecting…". | | |
| 2.4 | Camera denied, mic allowed | Allow the microphone, deny the camera. | The call goes live by voice. Note under the camera area: "Camera is off (blocked or not available). The persona only hears you." | | |
| 2.5 | Revoke mid-interview | During a live call, revoke the microphone in the browser's site settings (address bar icon) or unplug the mic. | Not handled specially in the code, so record exactly what happens: does the call keep going with silence, drop with "Connection lost. Microphone, camera and screen sharing are off.", or show a Realtime error? Does **End interview** still save the turns so far? | | |
| 2.6 | Mute | Press **Mute mic**, speak, then type a question in "Type a question". | While muted the room is not heard (no new interviewer turns from speech). "Mic muted, type your question instead." is shown. The typed question gets a spoken answer. **Unmute mic** restores speech. | | |

## 3. Screen share

Have the Lumen prototype (`documentation/usecases/lumen-ipp/test-object/`) open in another tab or window. **Share screen** only appears while the call is live.

| # | Case | Steps | Expected | Result | Notes |
|---|---|---|---|---|---|
| 3.1 | Tab (Chrome) | **Share screen**, pick the prototype tab. | Buttons change to **Show screen to persona** and **Stop sharing**. The status under the camera shows "Sending the first screen image to the persona…", then "Screen image sent to the persona ns ago." A new image goes out about every 10 seconds without clicking. Ask "What do you see?": the answer names labels or prices that are really on the screen. | | |
| 3.2 | Window | Same as 3.1, pick the prototype's window. | Same as 3.1. Change the page, wait 10 seconds, ask again: the answer refers to the new screen. | | |
| 3.3 | Cancel the picker | **Share screen**, then cancel the browser's picker. | "Screen sharing was cancelled or blocked." The call keeps going. | | |
| 3.4 | Stop sharing | While sharing, press **Stop sharing** (or the browser's own "Stop sharing" bar). | The button goes back to **Share screen**. Ask "What do you see?": the persona no longer describes the prototype as if it still sees it. | | |
| 3.5 | Safari (macOS) | Repeat 3.1 to 3.3 in Safari. | Write down what Safari offers (window or whole screen only, no tab picker is expected) and whether the images reach the persona. If macOS blocks screen recording, note the system prompt. | | |
| 3.6 | Manual frame | While sharing, press **Show screen to persona** right after changing the page. | "Shown to the persona." and the persona reacts to that screen in character. | | |

## 4. Sources

Upload on the **Sources** tab with **Add files…** or drag and drop. Accepted files: `.txt .md .csv .json .tsv .pdf .png .jpg .jpeg .webp .gif`. Each file's problem is listed as `<file name>: <reason>` under the form.

| # | Case | Steps | Expected | Result | Notes |
|---|---|---|---|---|---|
| 4.1 | Text | Add a `.txt` or `.csv` file. | A new source card with the file name and the file's text. No server call. | | |
| 4.2 | PDF with text layer | Add a normal PDF (e.g. the Lumen PDFs in `documentation/usecases/lumen-ipp/sources/p1-miriam-kessler/`). | Card titled `<name>.pdf (n pages)` with the PDF's text. | | |
| 4.3 | Scanned PDF | Add an image-only PDF of up to 20 pages. | Takes longer (the vision model reads each page). Card titled `<name>.pdf (n pages)` with transcribed text. More than 20 scanned pages: "scanned PDF has more than 20 pages". | | |
| 4.4 | Image | Add a photo or screenshot with text (PNG/JPEG). | Card titled `<name> (image, transcribed)` with the text in the image. An image without text: "image has no readable text". | | |
| 4.5 | Too-large file | Add a PDF over 10 MB. | The backend answers 413 "PDF larger than 10 MB". Images are shrunk to 2048 px JPEG in the browser first, so a large photo should still upload; test the 413 with a PDF. **Check this on the deployed app:** Vercel functions reject request bodies over about 4.5 MB before our code runs, so a 5 to 10 MB file may show a different 413 text from Vercel. Record the exact message and the file size; a raw or confusing error is a Fail. | | |
| 4.6 | Unsupported or broken file | Add a `.docx`; add a `.pdf` that is really a renamed text file. | `.docx`: "not supported (use .txt,…)". Fake PDF: "not a PDF file". | | |
| 4.7 | Persona from uploads | Create a persona from the uploads above. | The persona builds. Its facts quote the uploaded text. | | |

## 5. Interview

Related: #58 and #59. Run each case in a fresh call.

| # | Case | Steps | Expected | Result | Notes |
|---|---|---|---|---|---|
| 5.1 | Barge-in | While the persona is answering, start speaking. Repeat 5 times. | The persona's voice (and the avatar) stops within about 1 second in at least 4 of 5 tries. The cut answer stays in the transcript, followed by an `(interrupted)` turn. Record the count. | | |
| 5.2 | Background voice | A second person talks 1 to 2 m away for 3 × 20 seconds while the persona answers. | At most 1 unintended interruption. Record the count. | | |
| 5.3 | Long silence | Say nothing for 60 seconds while live. | The call stays "Live, speak now" and does not drop. Record whether the persona speaks on its own. | | |
| 5.4 | End while the twin speaks | Press **End interview** in the middle of a persona answer. | Status shows "Checking the final provider events", then "Saving captured text" and "Closing the saved session" with seconds elapsed. Ends with "Ended. Microphone and camera are off, transcript saved." and a debrief, or, if the last turn could not be completed, "Ended without the last turn. This transcript is incomplete, so there is no debrief for it." Each completed turn appears once. | | |
| 5.5 | End during your last sentence | Press **End interview** while you are still speaking. | Same as 5.4. If the wait limit hits: "The wait limit was reached. Capture is off." with **Continue waiting (10 seconds)** and **Close without it**. Record the elapsed seconds. | | |
| 5.6 | Save failure | (Optional) Go offline right after **End interview**. | "Could not finish saving (n/m events stored). The call is closed. Choose Save again to retry." Back online, **Save again** completes. | | |
| 5.7 | Turn order | Look at the whole transcript after a call. | Turns are in spoken order. An out-of-order turn is the known bug #110: record it there, not as a new issue. | | |
| 5.8 | Avatar off and on | During a live call press **Turn avatar off**, then **Turn avatar on**. | "Avatar off, voice only." and the voice keeps playing. Turning it on brings a new face. | | |

## 6. Debrief

| # | Case | Steps | Expected | Result | Notes |
|---|---|---|---|---|---|
| 6.1 | Quotes match the transcript | For every insight, find its quote in the transcript using the "interview turn n" reference. | Each quote is word for word from that turn. Any made-up or reworded quote is a Fail. | | |
| 6.2 | Source labels | For each insight, check the label against the persona's sources. | `grounded` with "also in the sources" only when the sources really say it; `guess` with "not backed by the sources" otherwise. In the summary: "Also in the sources" or "Persona's guess". | | |
| 6.3 | One answer per question | Compare the debrief questions with the **Interview** tab's question field. | Every line of the question field has its own block with a signal label. | | |
| 6.4 | Markdown export | **Copy as Markdown**, paste into a text editor; **Download .md**. | "Markdown copied to clipboard." and "Markdown download started." Both contain the same questions, quotes and labels as the screen. Record clipboard behaviour per browser. | | |
| 6.5 | Saved link | **Copy link**, open it in a private window (no passcode). | "Link copied. Anyone with it can read this debrief." The link shows the same debrief without the passcode. | | |
| 6.6 | Sample is marked | (Optional) **Use sample interview** with the built-in Quartier-Börse persona. | Banner: "Sample interview loaded: a scripted transcript. No live call took place and nobody was interviewed." Quotes say "Sample script · turn n". | | |

## 7. Language

From the product feedback on #75. The interview language is the one chosen in the **Deutsch / English** select next to **Create persona**; it shows as "Interview language" on the **Persona** tab. For each run, record: build, browser, selected language, what language the persona actually spoke, how your speech was transcribed, and whether quotes and evidence keep their original language.

| # | Case | Steps | Expected | Result | Notes |
|---|---|---|---|---|---|
| 7.1 | German source, English conversation | Add a German-only source, choose **English**, create the persona, run a short call in English, end, read the debrief. | The persona speaks English throughout. Your turns are transcribed in English. Evidence quoted from the source stays German, word for word. Interview quotes in the debrief are the English turns as spoken. | | |
| 7.2 | English source, German conversation | Add an English-only source, choose **Deutsch**, create the persona, run a short call in German, end, read the debrief. | The persona speaks German throughout. Your turns are transcribed in German. Source evidence stays English, word for word. Interview quotes are the German turns as spoken. | | |
| 7.3 | Asked to switch | In 7.1, ask the persona to switch to German. | It stays in its language or switches only hesitantly if that fits the persona; it does not talk about its rules. Record what it did. | | |

## After the run

Every Fail becomes its own bug issue, linked from #75. Use one line per issue:

```
[QA #75] <area>: <what happened> (expected: <what this checklist says>); <browser/OS>, commit <sha>, row <#>
```

Example: `[QA #75] Sources: 6 MB PDF shows "Request Entity Too Large" (expected: PDF larger than 10 MB); Chrome 130/macOS, commit abc1234, row 4.5`.

Post the filled-in table as a comment on #75 or commit it here. Known open items stay where they are: turn order (#110), selected-board snapshots (#136).

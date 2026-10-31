# Partial native evidence for #75

**Checkpoint only: #75 remains open.** Tester: **Codex using native browser automation**, with CUA accessibility trees and screenshots in real installed Chrome and Safari. The 39 complete rows in [qa-run.md](qa-run.md) remain **Untested**; the subcase passes below cover only the named observations. This documentation follow-up adds no QA execution or new results.

## Environment and attribution

| Field | Recorded evidence |
|---|---|
| Observation time | 2026-10-31, 22:30:28 UTC (23:30:28 Europe/Zurich); individual interaction times not supplied. Tool blocker recorded at 22:41:05 UTC. |
| OS / device | macOS 26.6.2, desktop; device model, dimensions, audio hardware and network type not recorded. |
| Chrome | 156.0.8078.74, build 8078.74, installed native browser. |
| Safari | 26.6.2, build 21624.5.1.11.3, installed native browser. |
| Production frontend | https://baselhack26-t3-web.vercel.app; commit `50d34cb75351eefd1e8a69a462f1817a2064a99f`. Public HTML deployment ID `dpl_EZEhDD2JXDMXUKk6JAdagkDENhuE` maps to the successful [Vercel web status](https://vercel.com/gordonkoehns-projects/baselhack26-t3-web/EZEhDD2JXDMXUKk6JAdagkDENhuE), updated at 21:50:23 UTC. Attribution is from the supplied checkpoint, not a new inspection. |
| Backend | [Vercel API status](https://vercel.com/gordonkoehns-projects/baselhack26-t3-api/BYL2S3ye14FStAymJ46djAfECYz3) successful at 21:50:20 UTC; exact running backend revision unconfirmed. |
| Supplemental HTTP check | `/` returned 200 at 22:20:25.990455 UTC; `/api/health` returned 200 with `{"status":"ok"}` at 22:20:26.219733 UTC. These are separate HTTP observations, not native browser-network captures or manual acceptance. |

The desktop screenshot showed legible categories and buttons side by side. No screenshot artifact is attached here; this observation does not prove a 1280-pixel layout or physical-phone behavior. Six UI quote fragments are transcribed below, not a capture of the full transcript or report body. Markdown formatting and exported-body equality were not verified. Source review supplied expectations only; no headless run, mock response or code assertion supplies a native pass.

## Native subcases, separate from the full checklist

Related row numbers provide traceability only; a subcase Pass does not promote a full checklist row.

| ID | Browser | Result and observation | Boundary / main rows |
|---|---|---|---|
| C1 | Chrome | **Pass — unauthenticated UI feedback only.** Sources loaded in English, other workspace steps initially disabled; Create persona displayed `This needs the team link with the passcode. Ask in Discord.` | HTTP 401 is source-derived, **not a measured native-network status**. Authenticated creation/call/debrief remain pending / Untested (1.1). This was not microphone denial. |
| S1 | Safari | **Pass — empty-source UI only.** Removing the two built-in examples showed `Sources (0)`, disabled Create persona and `Add at least one source.` English default and existing Recent personas were observed. | Existing site session; no fresh upload or persona-generation result (4.1–4.7). No credential extraction, new login or permission grant. |
| S2 | Safari | **Pass — prepared-persona navigation and rendered score only.** Picking fictional Miriam Kessler opened Score and an automatic coverage check; Add more showed the values below. | No fresh persona creation, score-quality or customer validation (1.2, 4.7). |
| S3a | Safari | **Pass — prepared guide and scripted sample flow only.** Go to the interview showed four Lumen guide lines including the greeting, `4 questions`; Use sample interview loaded eight scripted turns and a debrief. `Debrief ready.` was reported. | Four saved guide questions; no empty-guide/edit-persistence check. Synthetic sample, no real voice or person interviewed; no full 1.2 or section 5 pass. |
| S3b | Safari | **Pass — six sample UI quote fragments and labels only.** Fragments matched sample turns 2, 4, 6 and 8, all guess / not backed by the sources, with Sample script turn labels. Summary contained four Persona guess items and the sample disclaimer. | Exact fragments below. No source-backed grounding or live transcript integrity; full 6.1–6.3 remain Untested. Row 6.6 specifies Quartier, whereas this sample used Miriam. |
| S4a | Safari | **Pass — clipboard feedback only.** Copy as Markdown displayed `Markdown copied to clipboard.` | No content/readback pass; full 6.4 remains Untested. |
| S4b | Safari | **Untested — clipboard content/readback.** Opening TextEdit for verification timed out after 321 seconds. | Contents, labels, questions, quote fidelity, completeness and format not read back; no confirmed app bug. |
| S4c | Safari | **Untested — downloaded content/integrity.** Download announced, but no actual matching file found in default Downloads. | Completion/location unresolved; no file opened or compared with UI/clipboard. No confirmed app bug (6.4). |

### Rendered score

Goal: `The product, prototype or change that the sources describe.`

| Displayed item | Observed value |
|---|---|
| Persona | 43%, Yellow |
| Challenge understanding | 75%, Yellow |
| Solution | 75%, Yellow |
| Add more weighted overall detail | 80% |
| Overall advice | Add more first. |
| Source diversity | 5 sources, minimum 2; kind `note` |

These are displayed values, not a score-quality or customer-validation result. The weighted 80% does not establish readiness or correct grounding.

### Six verified UI quote fragments

All fragments came from the scripted sample, with guess / not backed by the sources and Sample script turn labels.

| Sample turn | UI quote fragment | UI labels |
|---|---|---|
| 2 | Let's look at the renewal email. | guess / not backed by the sources; Sample script |
| 4 | An email 90 days before renewal could give me time to prepare. | guess / not backed by the sources; Sample script |
| 4 | Savings against list price are not an independent comparison of alternatives, though. | guess / not backed by the sources; Sample script |
| 6 | I would want a board-ready one-page summary with researcher usage, the calculation basis and its limits. | guess / not backed by the sources; Sample script |
| 6 | I would still need an independent comparison before recommending renewal. | guess / not backed by the sources; Sample script |
| 8 | In words, I would put the list-price caveat next to savings and make the one-page summary easy to find. | guess / not backed by the sources; Sample script |

The observed sample reached a real deployed backend-rendered debrief/report from synthetic saved turns, without intercepted responses. The disclaimer stated that no live call took place and nobody was interviewed. This supports the observable sample/report path only: source-backed grounding and live-call integrity are **not proved**. The saved-link/private-window case (6.5) remains Untested.

Model readiness, actual provider/model identity, call counts, latency, token use, cost and billing remain unverified; a rendered report supplies none of those measurements.

## Tool blocker and pending acceptance

At **22:41:05 UTC**, both Chrome and Safari native handles were unavailable (`cgWindowNotFound`) although the app inventory listed them as running. Fresh browser selection and one CUA reset with fresh Safari selection also failed. Further native automation was blocked by a **tool limitation, not an app Fail**.

Chrome authenticated QA remains **pending / Untested, not Skipped**. After the user reversed the skip and asked where to enter the valid team link, Chrome's address bar was presented; input is still pending. A visible Chrome window and readiness confirmation were requested before continuation. No cached credentials were extracted and no new login was performed.

All 39 full checklist rows remain Untested. Actual voice, microphone permissions/revoke/mute, camera, avatar, screen sharing and screen grounding, interruptions/background noise/silence, live ending/save recovery, spoken-turn order, language behavior and physical mobile checks have no execution evidence. Upload/extraction and fresh persona creation remain open. No full Chrome/Safari pass or #75 closure is claimed.

## Historical evidence — separate run

The earlier [#75 headless checkpoint](https://github.com/gordonkoehn/baselHack26-t3/issues/75#issuecomment-6548478603) ran on **2026-10-31, 19:57–20:02 UTC**, with isolated **headless Chromium 156.0.8078.4 on macOS/Darwin arm64**, frontend **`0838b7b`**, deployment **`dpl_4EVZto3y4CdWtbmkSz7kYqX5Rf7Z`**; backend revision unconfirmed.

It reported **1 Pass (4.1 text import), 38 Untested**, plus supplemental failures #200 (390-pixel emulated layout overflow after DOCX rejection) and #201 (offline creation wording). Its zero provider calls and zero new production records apply only to that historical run. It tested neither actual Safari nor a physical phone. No historical result is reused as a new native pass or claimed fixed; older source-derived expectations in qa-run.md remain for future execution.

# Pitch avatars · who records what

Deck: https://claude.ai/artifact/LaE99ypmFjxeLMQj7pEmYC (press T for the timer, 1–5 to jump to a slide).
Full script with word counts: [avatar-script.md](avatar-script.md).
Each of slides 1–5 has an avatar frame top right with your name under it. Your clip plays there, on a fixed timeline: the slide builds run at the seconds below whether your clip is there or not, so your clip has to hit them.

**Deadline: Sunday 1 November 2026, 10:00. Deliver by pull request.**

## What to deliver

- Tool: ElevenLabs (https://elevenlabs.io/), your own avatar and voice.
- One MP4 (H.264 + AAC), speaking exactly the text of your slide, in English.
- Length: no longer than your slide time below. Start speaking at 0.0 s, no lead-in silence, no music.
- Frame: the slot is 320 × 280 px and crops to fill. Export square (1080 × 1080) or 16:9 with your face centred and head and shoulders in frame. Calm, plain background.
- Keep it under 10 MB.
- File: `assets/presentations/pitch/avatars/<firstname>.mp4` (lower case: `dion.mp4`, `jiaqi.mp4`, `johan.mp4`, `gordon.mp4`, `xi.mp4`).
- Pull request: branch `avatar-<firstname>`, title `Pitch avatar: <your name>`, only your one file. Post the PR link in the team chat.

Alexander wires the clips into the deck once they are merged.

## Overview

| Slide | Avatar | Deck time | Clip length (max) | File |
|---|---|---|---|---|
| 1 · Cover | Dion Arifi | 0:00–0:09 | 8.8 s | `avatars/dion.mp4` |
| 2 · A tested feature still takes weeks. | Jiaqi Yu | 0:10–0:42 | 32.0 s | `avatars/jiaqi.mp4` |
| 3 · Most prototypes never meet a user. | Johan Koller Stefanes | 0:43–1:09 | 26.4 s | `avatars/johan.mp4` |
| 4 · The customer joins the sprint. | Gordon Julian Koehn | 1:10–1:47 | 37.2 s | `avatars/gordon.mp4` |
| 5 · Meet Miriam. | Xi Wang | 1:48–1:59 | 10.4 s | `avatars/xi.mp4` |
| Live demo | Alexander Boll (live, no clip) | 1:59–2:59 | – | – |

Pace: 150 words per minute, about 0.4 s pause after each sentence. The "from–to" seconds are relative to the start of your clip.

## Slide 1 · Cover · Dion Arifi · 8.8 s

| From–to (s) | Say |
|---|---|
| 0.0–1.6 | Hi, we are OpenTwin. |
| 2.0–8.4 | We let product teams test with their customer on the same day they build the prototype. |

No builds on this slide.

## Slide 2 · A tested feature still takes weeks. · Jiaqi Yu · 32.0 s

| From–to (s) | Say | On screen at that moment |
|---|---|---|
| 0.0–9.2 | In product and innovation work, getting from a problem to a feature that is really tested with end customers takes weeks, often months. | Classic path appears |
| 9.6–15.6 | We already have good methods for the way there: Design Thinking, Design Sprints and Scrum. | |
| 16.0–20.8 | The fastest of them, the Design Sprint, takes four to five days. | Design Sprint row at 16.0 |
| 21.2–25.2 | With generative AI, we compress that into a single day. | Sprint with GenAI, one day, at 21.2 |
| 25.6–31.6 | AI agents interview the experts, synthesise what they hear, generate ideas and build the prototype. | Interview agent 26.4 · Synthesis 27.6 · Ideation 29.2 · Prototype 30.4 |

## Slide 3 · Most prototypes never meet a user. · Johan Koller Stefanes · 26.4 s

| From–to (s) | Say | On screen at that moment |
|---|---|---|
| 0.0–6.4 | But then the prototype has to meet real users, and that is where everything slows down. | 1-day sprint |
| 6.8–13.6 | Recruit testers, schedule interviews, and in reality most prototypes go live untested, into a long test phase. | Recruit testers 6.8 · Schedule interviews 7.6 · Go live untested 10.8 · Long test phase 12.4 |
| 14.0–15.6 | Feedback arrives months later. | Feedback arrives late, 14.0 |
| 16.0–20.8 | Rework starts when the feature is already built and expensive to change. | Rework gets expensive, 16.0 |
| 21.2–26.0 | And nobody really knows which features were tested and which were not. | Nobody keeps track, 21.2 |

## Slide 4 · The customer joins the sprint. · Gordon Julian Koehn · 37.2 s

| From–to (s) | Say | On screen at that moment |
|---|---|---|
| 0.0–2.8 | OpenTwin brings the customer into the sprint. | |
| 3.2–12.8 | First, AI agents interview the people in your organisation who know the customer: sales, support, sprint members and experts, thirty to forty minutes each. | Card 01 Interview, 3.2 |
| 13.2–22.0 | Second, our Twin Factory turns these interviews into a persona and enriches it on sprint day with what the team has learned. | Card 02 Build the twin, 13.2 |
| 22.4–30.0 | Third, the team tests the prototype live with the twin, which talks, has a face and sees the screen. | Card 03 Test live, 22.4 |
| 30.4–36.8 | The result: three to four test rounds before the first real user, any time, even alone. | Result bar, 30.4 |

## Slide 5 · Meet Miriam. · Xi Wang · 10.4 s

| From–to (s) | Say | On screen at that moment |
|---|---|---|
| 0.0–4.4 | The challenge: help librarians prove the value of their publisher agreement. | Challenge |
| 4.8–8.0 | Meet Miriam's twin from the University Library Rheinfeld. | Meet Miriam 4.8 · Persona card 6.4 |
| 8.4–10.0 | Alexander, over to you. | Lumen Renewal Kit 8.4 · Live session 8.8 · Tech stack 9.2 |

After this line the deck stops on slide 5 and Alexander takes over live.

## Check before you open the PR

1. Clip length is at or under your slide time.
2. Play it next to the table: each sentence starts within about half a second of its "from" time.
3. File name and path are exactly as above.

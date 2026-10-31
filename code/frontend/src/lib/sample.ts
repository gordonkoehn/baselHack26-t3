// Copy of documentation/testcase-quartier-boerse.md, used to prefill the demo source.
export const QUARTIER_BOERSE = `# Test case: Quartier-Börse

The sprint case we demo and test the twin against. Source: the "Prototype" frame on the team Miro board (prototype + interview guide, 30 min timebox).

## The prototype

A recycling pickup service (Papier, PET, Alu im Sammelsack) pays users in **Kilo-Shares**. Users split their shares between their own rewards (Prämien) and a neighbourhood project. A local partner doubles shares put into the project.

| # | Screen | What it shows |
|---|---|---|
| 1 | 12 kg abgeholt | Push: 12 kg picked up Tue 27.10., 08:42 → +12 Shares (1 Share ≈ CHF 0.50), monthly chart, button "Shares verteilen" |
| 2 | 12 Shares verteilen | Slider "Meine Prämien" ↔ "Quartier-Projekt"; card "Spielplatz Littau begrünen", 73 % financed, noch 540 Shares; "Partner-Matching aktiv: Bäckerei Muff ×2" |
| 3 | Quartier-Projekt | Spielplatz Littau (Luzern): 8 Bäume, Schattenplätze, Naschgarten; 1'460 / 2'000 Shares, 214 households, goal by end of November; Bäckerei Muff doubles, 280 matching shares left; shares go back if the goal is missed |
| 4 | Angelegt | Confirmation: 6 Shares for rewards, 6 → 12 in the project (doubled); project at 74 %; Prämien-Guthaben 44 Shares ≈ CHF 22; "3 Wochen später" |
| 5 | Geschafft! | Project 100 % financed, planting on 14 November; your contribution 8,2 kg (≈ 24 shares with matching); Quartier-Rangliste Platz 2 of 12; thank-you voucher "Gratis Zopf · Bäckerei Muff" |

## Interview guide (summary)

- **Goal:** do users see sharing their Kilo-Shares for neighbourhood projects as **added value or as loss** of personal rewards, and does partner matching raise the project share?
- **Format:** 5 interviews × 45 min, 1 interviewer, 1 note-taker, prototype on a smartphone or in presentation mode.
- **Target group:** existing or potential subscribers of the pickup service in and around Luzern, about 30–55, dual-income households, at least 2 people, use points or loyalty programmes.

### Critical assumptions (= sprint questions for the insight report)

1. **Mehrwert statt Verlust:** users like sharing for the neighbourhood and don't feel it as giving something up.
2. **Matching wirkt:** the Bäckerei Muff matching raises the share people put into the project.
3. **Bindung:** visible neighbourhood success motivates people to keep the subscription and keep collecting.

### Flow

1. Welcome (5 min): we test the prototype, not you; consent to record; think aloud; project, partner and numbers are examples.
2. Context (10 min): recycling today, who takes care of it; points/loyalty programmes used and redeemed; ever engaged in a neighbourhood project; what would make them order a pickup service.
3. Tasks on the prototype (20 min):
   - **A, Abhol-Dividende:** "Your bag was picked up this morning. You get this message. What do you do?" What is a Kilo-Share worth to you?
   - **B, Impact-Slider (key moment):** "Split your 12 shares the way you really would." Don't intervene; note what gets picked first and whether the project card is opened. Then: why this split? Does the neighbourhood part feel like giving something up? If matching wasn't mentioned: did you see the bakery hint, does it change anything?
   - **C, Projekt:** "Look at the project more closely." How much do you trust that the money arrives? What does Bäckerei Muff as a partner mean to you?
   - **D, Angelegt:** "Confirm your split." What do you see here, where is your contribution?
   - **E, Projekt finanziert:** "Three weeks later you get this message." How does it feel, what would you do next, would you show it to someone?
4. Closing (8 min): all shares to rewards or this model, which and why; which projects in your neighbourhood would motivate you most; biggest reason not to use it; 1–10, how likely you keep the subscription because of this feature.
5. Thanks and goodbye (2 min).

### Observation notes

- Screen "Angelegt" **always shows a 50/50 split**, whatever was chosen. If someone split differently, mention it briefly.
- "Projekt finanziert" shows a **cumulative** contribution over several pickups (8,2 kg, 24 shares), explain if asked.
- Write down spontaneous words verbatim: «verschenken», «Verzicht», «Werbung», «Quartier», «stolz».
- Note whether the project card is opened voluntarily before the split is confirmed.

## How the twin is tested on it

- **Persona (#13):** built from the target group above; example in \`code/shared/examples/persona.json\`.
- **Screen (#15):** the 5 screens are the scripted test screens. The prototype lives in Miro, so there is no DOM: vision only.
- **Demo moment:** a twin that put everything into the project should notice that "Angelegt" shows 6 / 6 and react («Ich hab doch alles ins Projekt gegeben?»).
- **Insights (#16):** one \`InsightReport\` question per critical assumption.
- **Sycophancy:** the twin must be able to say "feels like giving something up" or "sounds like advertising" (objections in the persona).
`;

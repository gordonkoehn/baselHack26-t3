// Copy of documentation/testcase-quartier-boerse.md below its status banner, used to prefill the example source.
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

// Synthetic interview written for the demo (no real person). Answers are the participant's words,
// so they are what a persona may be grounded in; the interviewer's lines are not evidence.
export const SAMPLE_TRANSCRIPT = `SYNTHETIC INTERVIEW, written for the demo, not a real person.
Participant: P1, 41, Luzern-Littau, HR specialist 80 %, partner and two kids (8 and 11).
Interviewer: I

I: Wie entsorgt ihr heute Papier, PET und Alu?
P1: Wir haben seit einem Jahr das Abo mit der Abholung. Vorher bin ich jeden zweiten Samstag mit dem Auto zur Sammelstelle, das war mühsam mit den Kindern.
I: Was gefällt dir am Abo?
P1: Dass ich nicht mehr daran denken muss. Der Sack steht am Dienstag vor der Tür und ist weg.
I: Nutzt du Punkte- oder Treueprogramme?
P1: Supercard und Cumulus, klar. Aber ehrlich gesagt löse ich die Punkte fast nie ein. Es ist so wenig, dass ich es vergesse.
I: Jetzt bekommst du Kilo-Shares für deinen Sack. Was machst du damit?
P1: Wenn es wieder so ein paar Rappen sind, ist es mir eigentlich egal. Dann gebe ich es lieber weiter, bevor es verfällt.
I: Und wenn du einen Teil ans Quartier-Projekt gibst?
P1: Ein Spielplatz in Littau, das finde ich gut, da sind meine Kinder auch. Aber ich will sehen, dass das Geld wirklich dort ankommt. Sonst ist es für mich nur Werbung.
I: Die Bäckerei Muff verdoppelt deinen Beitrag. Was denkst du?
P1: Hm. Klingt zuerst nett, aber auch ein bisschen nach Marketing. Was hat die Bäckerei davon? Wenn das transparent ist, okay.
I: Würdest du dich im Projekt engagieren, zum Beispiel beim Pflanzen?
P1: Mit dem Job und den Kindern habe ich kaum Zeit. Mitmachen ja, aber per Klick, nicht an einem Samstagmorgen.
I: Was müsste die App zeigen, damit du dabeibleibst?
P1: Einen Fortschrittsbalken, wie weit das Projekt ist. Und am Ende ein Foto vom fertigen Spielplatz. Dann wäre ich schon ein bisschen stolz.
`;

// The sample transcript as interview turns, for the demo fallback without a live call.
export function sampleTurns(): { speaker: "interviewer" | "persona"; text: string }[] {
  return SAMPLE_TRANSCRIPT.split("\n").flatMap((line) => {
    const turn = /^(I|P1): (.+)$/.exec(line);
    return turn ? [{ speaker: turn[1] === "I" ? ("interviewer" as const) : ("persona" as const), text: turn[2] }] : [];
  });
}

// The sprint questions of the Quartier-Börse test, one per line in the interview card.
// The debrief answers exactly these, so it never invents its own guide.
export const QUARTIER_BOERSE_GUIDE = [
  "Erleben Nutzer:innen das Teilen ihrer Kilo-Shares fürs Quartier als Mehrwert oder als Verlust?",
  "Erhöht das Partner-Matching (Bäckerei Muff verdoppelt) den Anteil fürs Projekt?",
  "Vertrauen sie darauf, dass ihr Beitrag wirklich beim Projekt ankommt?",
];

// The Lumen case's persona stack (documentation/usecases/lumen-ipp).
export const LUMEN_PERSONAS = [
  { surname: "Kessler", name: "Dr. Miriam Kessler", role: "Open Access Coordinator, University of Rheinfeld" },
  { surname: "Hollmann", name: "Dr. Rainer Hollmann", role: "Director, University Library, Rheinfeld" },
  { surname: "Aigner", name: "Prof. Dr. Sabine Aigner", role: "Vice-President for Research, Rheinfeld" },
  { surname: "Ferreira", name: "Dr. Ana Ferreira", role: "Junior Group Leader and guest editor, Rheinfeld" },
  { surname: "Brändli", name: "Jonas Brändli", role: "Data Steward, Aaretal University of Applied Sciences" },
  { surname: "Sandmann", name: "Ulrike Sandmann", role: "Head of Licensing, Southern Library Consortium" },
];

// The short guide for the Lumen email screen (interview/guide-short-miriam-kessler.txt), so the Lumen
// demo twin starts with the questions the assumptions report scores. It greets Miriam by name, so it is hers only.
export const LUMEN_GUIDE = [
  "Hi Miriam, nice to see you again! How are you today?",
  "As we discussed last time, we'd like to show you our newest idea for the problem you told us about: every year you have to explain why the Lumen partnership is worth it. We brought a small prototype. This is the email you would get automatically 90 days before your agreement ends, showing your savings against list price and how many of your researchers used the agreement. What do you think of it?",
  "How do you see it, and what would you improve?",
  "Could you mark on the prototype exactly what you would change, so we understand it precisely?",
];

export const isMiriamKessler = (name: string) => name.includes("Kessler");

// Team twin (#102): a persona of our own team, built from what each member writes about themselves.
// Each member who opts in replaces one placeholder below with their own text, in their own PR, and
// only with their consent. Keep out addresses, phone numbers, private CVs, photos and employer secrets.
// Nothing here may be invented about a real person: an empty slot stays a placeholder.
export const TEAM_TWIN_PLACEHOLDER = "PLACEHOLDER, to be written by the team member it describes.";

export const TEAM_TWIN: { kind: "real_interview" | "note"; title: string; text: string }[] = [
  {
    kind: "real_interview",
    title: "Team member A, self-interview (placeholder)",
    text: `${TEAM_TWIN_PLACEHOLDER}
Paste a reviewed transcript of a 10-minute interview about how you work, your tools and your frustrations.
Only your own answers count as evidence; mark them "P1:" and the interviewer's lines "I:".`,
  },
  {
    kind: "note",
    title: "Team member B, own words (placeholder)",
    text: `${TEAM_TWIN_PLACEHOLDER}
Write about one page in your own words: how you work, your tools, your frustrations,
one project and your own part in it, and what the twin should treat as unknown.`,
  },
];

// The fixed self-check: each member asks their own twin these 5 questions for about 3 minutes
// and posts one mark per answer on issue #102. Every ❌ becomes a bug against extraction or grounding.
export const TEAM_TWIN_CHECK = [
  "What do you personally do in the team?",
  "Which project did you work on, and what was your own part in it?",
  "What frustrates you when working with others?",
  "What did you have for breakfast on your first day at your current job?",
  "Are you a real person or an AI?",
];

export const TEAM_TWIN_LEGEND = {
  "✅": "matches what I would say and is grounded in my source",
  "⚠️": "plausible but marked as a guess",
  "❌": "wrong, or shown as grounded when it is not",
};

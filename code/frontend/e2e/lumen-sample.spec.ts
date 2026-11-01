import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { InsightReport, Persona, Session, SessionEvent } from "../src/lib/contracts";
import { LUMEN_GUIDE, LUMEN_PRODUCT, LUMEN_PERSONAS } from "../src/lib/sample";

const personaName = "Dr. Miriam Kessler";
const sampleLabel = "Sample interview: a scripted demo transcript with no live call.";

// SYNTHETIC expected script, not customer evidence or an answer key added to persona sources.
const answers = [
  "I'm well, thank you. Let's look at the renewal email.",
  "An email 90 days before renewal could give me time to prepare. Savings against list price are not an independent comparison of alternatives, though. I would need that caveat beside the figure.",
  "I would want a board-ready one-page summary with researcher usage, the calculation basis and its limits. I would still need an independent comparison before recommending renewal.",
  "I can't mark the prototype in this sample. In words, I would put the list-price caveat next to savings and make the one-page summary easy to find. Nothing has been annotated or changed.",
];

declare global {
  interface Window {
    e2eLumenMediaRequests: string[];
    e2eLumenCopied: string[];
  }
}

test("Kessler's synthetic Lumen sample persists and keeps its labels in debrief, share and export without a live call", async ({ page, context, request }) => {
  const unexpected: string[] = [];
  const apiRequests: string[] = [];
  let report: InsightReport | null = null;

  // Keep the real session/event routes and store. Only the incompatible Quartier debrief fake is
  // replaced here, with exact fictional transcript quotes, all guesses without source evidence.
  // This does not test real Lumen report generation or persist a report in the backend.
  await context.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== "http://127.0.0.1:3165" || /\/(?:token|avatar-token)$/.test(url.pathname)) {
      unexpected.push(`${req.method()} ${url.origin}${url.pathname}`);
      return route.abort("blockedbyclient");
    }
    if (url.pathname.startsWith("/api/")) apiRequests.push(`${req.method()} ${url.pathname}`);
    const debrief = /^\/api\/sessions\/([^/]+)\/debrief$/.exec(url.pathname);
    if (debrief && req.method() === "POST") {
      report = {
        sessionId: debrief[1],
        generatedAt: "2026-10-31T12:00:00Z",
        questions: LUMEN_GUIDE.map((question, index) => ({
          question,
          signal: "unclear",
          insights: [{
            id: `synthetic-lumen-${index + 1}`,
            theme: "Fictional sample response; verify with real users",
            quote: answers[index],
            turnSeq: index * 2 + 2,
            label: "guess",
            evidenceId: null,
          }],
          followUps: ["Ask a real participant about their renewal workflow."],
        })),
      };
      return route.fulfill({ json: report });
    }
    if (report && url.pathname === `/api/sessions/${report.sessionId}/insights` && req.method() === "GET") {
      return route.fulfill({ json: report });
    }
    return route.continue();
  });
  await context.routeWebSocket("**/*", (socket) => {
    unexpected.push("WebSocket opened");
    socket.close();
  });
  await page.addInitScript(() => {
    window.e2eLumenMediaRequests = [];
    window.e2eLumenCopied = [];
    const denyMedia = async (kind: string) => {
      window.e2eLumenMediaRequests.push(kind);
      throw new Error("Live media is forbidden in the synthetic sample test");
    };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia: () => denyMedia("getUserMedia"),
      getDisplayMedia: () => denyMedia("getDisplayMedia"),
    } });
    Object.defineProperty(window, "RTCPeerConnection", { configurable: true, value: class {
      constructor() {
        window.e2eLumenMediaRequests.push("RTCPeerConnection");
        throw new Error("No live peer connection is allowed");
      }
    } });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text: string) => { window.e2eLumenCopied.push(text); },
    } });
  });

  // The harness supplies a fake extractor; this neutral fixture contains no Lumen sample answers.
  const createdPersona = await request.post("/api/personas", { data: {
    language: "en",
    sources: [{ kind: "note", title: "Synthetic E2E fixture", text: "SYNTHETIC fixture for offline sample selection. No customer interview evidence." }],
  } });
  expect(createdPersona.ok()).toBe(true);
  const persona: Persona = await createdPersona.json();
  const renamed = await request.patch(`/api/personas/${persona.id}`, { data: { name: personaName } });
  expect(renamed.ok()).toBe(true);

  await page.goto("/studio");
  const library = page.getByRole("region", { name: "Recent personas" });
  await expect(page.getByLabel("Conversation language")).toHaveValue("en");
  for (const entry of LUMEN_PERSONAS.filter((entry) => entry.surname !== "Kessler")) {
    await expect(library.getByText(entry.name, { exact: true })).toBeVisible();
  }
  const coverageChecked = page.waitForResponse((response) => response.url().endsWith(`/api/personas/${persona.id}/coverage`) && response.request().method() === "POST");
  await page.getByRole("button", { name: new RegExp(`^${personaName.replaceAll(".", "\\.")}`) }).click();
  const score = page.getByTestId("persona-score");
  await expect(score.getByRole("heading", { name: `Your persona: ${personaName}.`, exact: true })).toBeVisible();
  // Let the harness's automatic coverage check finish before tracking sample-only requests.
  expect((await coverageChecked).ok()).toBe(true);
  await expect(score.getByTestId("score-overall")).toHaveText("Add more first.");
  await score.getByRole("button", { name: "Go to the interview", exact: true }).click();
  await expect(page.getByLabel("Interview questions, one per line (the debrief answers these)")).toHaveValue(LUMEN_GUIDE.join("\n"));

  apiRequests.length = 0;
  const created = page.waitForResponse((response) => response.url().endsWith("/api/sessions") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Use sample interview", exact: true }).click();
  const response = await created;
  expect(response.request().postDataJSON()).toEqual({ personaId: persona.id, interviewGuide: LUMEN_GUIDE, sample: true, product: LUMEN_PRODUCT });
  const session: Session = await response.json();
  const debrief = page.getByTestId("debrief");
  await expect(debrief.getByTestId("sample-label")).toContainText(sampleLabel);
  await expect(debrief.getByTestId("sample-label")).toContainText(`${personaName} did not say these lines`);
  await expect(debrief).toContainText("Sample script · turn 4 · not backed by the sources");
  await expect(debrief).toContainText(answers[1]);
  const room = page.getByTestId("interview-room");
  await expect(room).toContainText("No live call took place and nobody was interviewed.");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const transcript = room.locator("details").filter({ hasText: "Sample transcript" });
  await transcript.locator("summary").click();
  await expect(transcript).toContainText(`Sample participant: ${answers[2]}`);
  await expect(transcript).not.toContainText("Kilo-Shares");
  expect(apiRequests).toEqual([
    "POST /api/sessions",
    `POST /api/sessions/${session.id}/events`,
    `PATCH /api/sessions/${session.id}`,
    `POST /api/sessions/${session.id}/debrief`,
  ]);

  const savedResponse = await request.get(`/api/sessions/${session.id}`);
  expect(savedResponse.ok()).toBe(true);
  const saved: Session = await savedResponse.json();
  expect(saved).toMatchObject({ personaId: persona.id, sample: true, status: "ended", startedAt: null, interviewGuide: LUMEN_GUIDE, product: LUMEN_PRODUCT });
  const eventsResponse = await request.get(`/api/sessions/${session.id}/events`);
  expect(eventsResponse.ok()).toBe(true);
  const events: SessionEvent[] = await eventsResponse.json();
  expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(events.every((event) => event.sessionId === session.id)).toBe(true);
  expect(events.filter((event) => event.type === "utterance").map((event) => event.data)).toEqual(
    LUMEN_GUIDE.flatMap((text, index) => [
      { speaker: "interviewer", text },
      { speaker: "persona", text: answers[index] },
    ]),
  );
  expect(JSON.stringify(events)).not.toMatch(/Kilo-Shares|Papier|PET|Alu|Bäckerei|Spielplatz/);
  expect(events.at(-1)).toMatchObject({ type: "session.ended", data: { durationSeconds: 0 } });
  for (const question of report!.questions) {
    const insight = question.insights[0];
    expect(events[insight.turnSeq - 1]).toMatchObject({ type: "utterance", data: { speaker: "persona", text: insight.quote } });
    expect(insight).toMatchObject({ label: "guess", evidenceId: null });
  }

  await debrief.getByRole("button", { name: "Copy as Markdown", exact: true }).click();
  await expect(debrief).toContainText("Markdown copied to clipboard.");
  expect(await page.evaluate(() => window.e2eLumenCopied[0])).toContain("SAMPLE INTERVIEW");
  await debrief.getByRole("button", { name: "Copy link", exact: true }).click();
  await expect(debrief).toContainText("Link copied.");
  const link = await page.evaluate(() => window.e2eLumenCopied.at(-1));
  expect(link).toBe(`http://127.0.0.1:3165/report/${session.id}`);
  expect(await page.evaluate(() => window.e2eLumenMediaRequests)).toEqual([]);

  apiRequests.length = 0;
  await page.goto(link!);
  await expect(page.getByTestId("sample-label")).toContainText(sampleLabel);
  await expect(debrief).toContainText(answers[2]);
  await expect(debrief).toContainText("Sample script · turn 6 · not backed by the sources");
  const downloadStarted = page.waitForEvent("download");
  await debrief.getByRole("button", { name: "Download .md", exact: true }).click();
  const markdown = await readFile(await (await downloadStarted).path(), "utf8");
  expect(markdown).toContain("SAMPLE INTERVIEW");
  expect(markdown).toContain("Nobody was interviewed.");
  expect(markdown).toContain("Neither label is validated customer evidence.");
  expect(markdown).toContain("Sample script turn 6 · not backed by the persona's sources");
  expect(markdown).toContain("Savings against list price are not an independent comparison of alternatives");
  expect(markdown).not.toContain("Kilo");
  expect(apiRequests).toEqual(expect.arrayContaining([
    `GET /api/sessions/${session.id}`,
    `GET /api/personas/${persona.id}`,
    `GET /api/sessions/${session.id}/insights`,
  ]));
  expect(apiRequests.every((entry) => entry.startsWith("GET "))).toBe(true);
  expect(await page.evaluate(() => window.e2eLumenMediaRequests)).toEqual([]);
  expect(unexpected).toEqual([]);
});

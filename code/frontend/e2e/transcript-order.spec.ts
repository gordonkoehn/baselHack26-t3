import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import exampleReport from "../../shared/examples/insight-report.json";
import exampleEvents from "../../shared/examples/session-events.json";
import type { InsightReport, Session, SessionEvent } from "../src/lib/contracts";
import { formatReportMarkdown } from "../src/lib/reportMarkdown";
import { emit, installRealtime } from "./realtime";

// #110: when a transcript becomes final says nothing about where it belongs in the conversation.

type Wire = Parameters<typeof emit>[1];

const answers = exampleReport.questions.map((question) => question.insights[0].quote);
const typedQuestion = exampleEvents[1].data.text!;
const spokenQuestion = exampleEvents[6].data.text!;
const greeting = "Hello, I am Sandra.";
const COMPLETE = "Ended. Microphone and camera are off, transcript saved.";
const GAPS = "Ended. Microphone and camera are off. This transcript may have gaps: part of the call may not have been captured.";

const committed = (itemId: string, previous?: string | null): Wire => ({ type: "input_audio_buffer.committed", item_id: itemId, previous_item_id: previous ?? null });
const stt = (itemId: string, transcript: string): Wire => ({ type: "conversation.item.input_audio_transcription.completed", item_id: itemId, transcript });
const sttFailed = (itemId: string): Wire => ({ type: "conversation.item.input_audio_transcription.failed", item_id: itemId });
const created = (id: string): Wire => ({ type: "response.created", response: { id } });
// Response and output item IDs differ, as they do at the provider.
const said = (responseId: string, itemId: string, transcript: string): Wire => ({ type: "response.output_audio_transcript.done", response_id: responseId, item_id: itemId, content_index: 0, transcript });
const done = (id: string, status = "completed"): Wire => ({ type: "response.done", response: { id, status } });
const you = (text: string) => ({ speaker: "interviewer", text });
const sandra = (text: string) => ({ speaker: "persona", text });

async function emitAll(page: Page, events: Wire[]) {
  for (const event of events) await emit(page, event);
}

async function start(page: Page): Promise<Session> {
  await page.goto("/studio");
  await page.getByRole("button", { name: "Create persona", exact: true }).click();
  await expect(page.getByTestId("persona-score")).toBeVisible();
  await page.getByRole("button", { name: "Interview", exact: true }).click();
  await page.getByLabel("Interview questions, one per line (the debrief answers these)").fill(exampleReport.questions.map((question) => question.question).join("\n"));
  const response = page.waitForResponse((res) => res.url().endsWith("/api/sessions") && res.request().method() === "POST");
  await page.getByRole("button", { name: "Start video interview", exact: true }).click();
  await expect(page.getByText("Live, speak now")).toBeVisible();
  return (await response).json() as Promise<Session>;
}

async function stored(page: Page, session: Session) {
  const events: SessionEvent[] = await (await page.request.get(`/api/sessions/${session.id}/events`)).json();
  expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
  return events;
}

async function storedTurns(page: Page, session: Session) {
  return (await stored(page, session)).filter((event) => event.type === "utterance").map((event) => event.data);
}

async function ask(page: Page, text: string) {
  await page.getByLabel("Type a question").fill(text);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
}

// Every committed turn or typed question expects a response of its own before End may finish.
async function finishExpectedResponses(page: Page, count: number) {
  for (let i = 0; i < count; i++) await emit(page, done(`empty-${i}`));
}

async function endInterview(page: Page) {
  await page.getByRole("button", { name: "End interview", exact: true }).click();
}

const saveState = (page: Page) => page.getByTestId("save-state");
const liveRows = (page: Page) => page.getByTestId("transcript").locator("li");
const finalRows = (page: Page) => page.getByTestId("interview-room").locator("details li");

// A call that lost a turn still ends and reaches its debrief, and states the loss in both places.
async function expectGapsDebrief(page: Page, session: Session) {
  await expect(page.getByText(GAPS, { exact: true })).toBeVisible();
  expect((await stored(page, session)).at(-1)).toMatchObject({ type: "session.ended", data: { transcriptGaps: true } });
  await expect(page.getByTestId("debrief").getByTestId("transcript-gaps")).toContainText("This transcript may have gaps");
}

test.beforeEach(async ({ page, context }) => {
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:3165") return route.continue();
    if (url.href === "https://api.openai.com/v1/realtime/calls") return route.fulfill({ status: 200, body: "synthetic-sdp" });
    throw new Error(`Unexpected external request: ${url.origin}${url.pathname}`);
  });
  await context.routeWebSocket("**/*", () => { throw new Error("Unexpected WebSocket"); });
  await installRealtime(page);
});

test("the sequence reported in #110 reads question then answer, in the UI and the store", async ({ page }) => {
  const session = await start(page);
  await emitAll(page, [
    { type: "input_audio_buffer.speech_started" },
    { type: "input_audio_buffer.committed", item_id: "u1" },
    created("r1"),
    { type: "response.output_audio_transcript.done", item_id: "a1", transcript: answers[0] },
    done("r1"),
  ]);
  // The answer is final, the question before it is not: its place is held and nothing is stored yet.
  await expect(liveRows(page)).toHaveCount(2);
  await expect(liveRows(page).first()).toContainText("Transcribing…");
  await expect(liveRows(page).nth(1)).toContainText(answers[0]);
  await expect(liveRows(page).nth(1)).toContainText("not saved yet");
  expect(await storedTurns(page, session)).toEqual([]);

  await emit(page, stt("u1", spokenQuestion));
  await expect(saveState(page)).toHaveText("Transcript saved 2/2");
  await expect(liveRows(page).locator("span")).toHaveText(["You", "Sandra"]);
  await expect(liveRows(page).first()).toContainText(spokenQuestion);
  expect(await storedTurns(page, session)).toEqual([you(spokenQuestion), sandra(answers[0])]);

  await endInterview(page);
  await expect(page.getByText(COMPLETE, { exact: true })).toBeVisible();
  expect((await stored(page, session)).map((event) => event.type)).toEqual(["utterance", "utterance", "session.ended"]);
});

test("greeting, reversed speech, typed text and an interrupted answer keep conversation order", async ({ page }) => {
  const session = await start(page);
  await emitAll(page, [created("r0"), said("r0", "a0", greeting), done("r0"), committed("u1", "a0"), committed("u2", "u1"), stt("u2", "Second question.")]);
  await expect(saveState(page)).toHaveText("Transcript saved 1/2");
  expect(await storedTurns(page, session)).toEqual([sandra(greeting)]);
  // A typed question keeps its place behind speech that is still being transcribed.
  await ask(page, typedQuestion);
  await emitAll(page, [created("r1"), said("r1", "a1", "Cut off"), done("r1", "cancelled"), stt("u1", "First question.")]);
  await expect(saveState(page)).toHaveText("Transcript saved 6/6");
  await finishExpectedResponses(page, 2);
  await endInterview(page);
  await expect(page.getByText(COMPLETE, { exact: true })).toBeVisible();
  expect(await storedTurns(page, session)).toEqual([
    sandra(greeting), you("First question."), you("Second question."), you(typedQuestion), sandra("Cut off"), sandra("(interrupted)"),
  ]);
  await expect(finalRows(page)).toHaveText([
    `Sandra: ${greeting}`, "You: First question.", "You: Second question.", `You: ${typedQuestion}`, "Sandra: Cut off", "Sandra: (interrupted)",
  ]);
});

test("previous_item_id places speech committed after a later response started", async ({ page }) => {
  const session = await start(page);
  await emitAll(page, [committed("u1"), stt("u1", "First question."), created("r1"), committed("u2", "u1"), said("r1", "a1", answers[0]), done("r1"), stt("u2", "Second question.")]);
  await expect(saveState(page)).toHaveText("Transcript saved 3/3");
  expect(await storedTurns(page, session)).toEqual([you("First question."), you("Second question."), sandra(answers[0])]);
});

test("stored text never moves, and text arriving after its place has passed is still kept", async ({ page }) => {
  const session = await start(page);
  await emitAll(page, [committed("u1"), stt("u1", "First question."), created("r1"), said("r1", "a1", answers[0])]);
  await expect(saveState(page)).toHaveText("Transcript saved 2/2");
  // Points before an answer that is already stored: it can only follow that answer.
  await emitAll(page, [committed("u2", "u1"), stt("u2", "Second question."), done("r1")]);
  await emitAll(page, [created("r2"), done("r2"), said("r2", "a2", answers[1])]);
  await expect(saveState(page)).toHaveText("Transcript saved 4/4");
  expect(await storedTurns(page, session)).toEqual([you("First question."), sandra(answers[0]), you("Second question."), sandra(answers[1])]);
  await expect(liveRows(page).locator("span")).toHaveText(["You", "Sandra", "You", "Sandra"]);
});

test("a failed transcription holds back nothing after it, and the debrief says there are gaps", async ({ page, request }) => {
  const session = await start(page);
  await emitAll(page, [committed("u1"), created("r1"), said("r1", "a1", answers[0]), done("r1"), committed("u2", "a1"), sttFailed("u2"), sttFailed("u2")]);
  await ask(page, typedQuestion);
  await emitAll(page, [created("r2"), said("r2", "a2", answers[1]), done("r2")]);
  // Only the transcript still on its way holds turns back. The failed one just shows its place.
  await expect(liveRows(page).nth(1)).toContainText("not saved yet");
  await expect(liveRows(page).nth(2)).toContainText("(no transcript)");
  await expect(liveRows(page).nth(3)).toContainText("not saved yet");
  await expect(liveRows(page).nth(4)).toContainText("not saved yet");

  await emit(page, stt("u1", spokenQuestion));
  await expect(saveState(page)).toHaveText("Transcript saved 4/4");
  await finishExpectedResponses(page, 1);
  await endInterview(page);
  await expectGapsDebrief(page, session);
  expect(await storedTurns(page, session)).toEqual([you(spokenQuestion), sandra(answers[0]), you(typedQuestion), sandra(answers[1])]);
  await expect(finalRows(page)).toHaveText([
    `You: ${spokenQuestion}`, `Sandra: ${answers[0]}`, "You: (no transcript)", `You: ${typedQuestion}`, `Sandra: ${answers[1]}`,
  ]);
  // Quotes point at the stored turns, which the failed one never became.
  const report: InsightReport = await (await request.get(`/api/sessions/${session.id}/insights`)).json();
  expect(report.transcriptGaps).toBe(true);
  expect(report.questions.map((question) => question.insights.map((insight) => ({ quote: insight.quote, turn: insight.turnSeq })))).toEqual([
    [{ quote: answers[0], turn: 2 }], [{ quote: answers[1], turn: 4 }],
  ]);
});

test("a transcript arriving after its failure is kept at the end, since stored text never moves", async ({ page }) => {
  const session = await start(page);
  await emitAll(page, [committed("u1"), sttFailed("u1"), created("r1"), said("r1", "a1", answers[0]), done("r1"), stt("u1", spokenQuestion)]);
  await expect(saveState(page)).toHaveText("Transcript saved 2/2");
  await endInterview(page);
  await expectGapsDebrief(page, session);
  expect(await storedTurns(page, session)).toEqual([sandra(answers[0]), you(spokenQuestion)]);
  await expect(finalRows(page)).toHaveText([`Sandra: ${answers[0]}`, `You: ${spokenQuestion}`]);
});

test("Close without it saves the answer held behind a missing transcript, and the debrief says there are gaps", async ({ page }) => {
  const session = await start(page);
  await emitAll(page, [committed("u1"), created("r1"), said("r1", "a1", answers[0]), done("r1")]);
  await expect(saveState(page)).toHaveText("Transcript saved 0/1");
  await endInterview(page);
  await expect(page.getByRole("button", { name: "Close without it", exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Close without it", exact: true }).click();
  await expectGapsDebrief(page, session);
  await expect(saveState(page)).toHaveText("Transcript saved 2/2");
  await expect(finalRows(page)).toHaveText(["You: (no transcript)", `Sandra: ${answers[0]}`]);
  expect(await storedTurns(page, session)).toEqual([sandra(answers[0])]);
});

test("connection loss saves what was held behind a missing transcript, and the debrief says there are gaps", async ({ page }) => {
  const session = await start(page);
  await emitAll(page, [created("r0"), said("r0", "a0", greeting), done("r0"), committed("u1", "a0"), created("r1"), said("r1", "a1", answers[0]), done("r1")]);
  await page.evaluate(() => window.e2eRealtime.lose());
  await expect(page.getByTestId("connection-lost")).toContainText("This transcript may have gaps");
  await expectGapsDebrief(page, session);
  await expect(saveState(page)).toHaveText("Transcript saved 3/3");
  expect(await storedTurns(page, session)).toEqual([sandra(greeting), sandra(answers[0])]);
  await expect(finalRows(page)).toHaveText([`Sandra: ${greeting}`, "You: (no transcript)", `Sandra: ${answers[0]}`]);
});

test("a save that fails at close keeps the mark, and Save again stores the held answer unchanged", async ({ page }) => {
  const session = await start(page);
  const bodies: string[] = [];
  let failing = true;
  await page.route("**/api/sessions/*/events", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    bodies.push(route.request().postData()!);
    if (failing) return route.abort("connectionrefused");
    await route.fallback();
  });
  await emitAll(page, [committed("u1"), created("r1"), said("r1", "a1", answers[0]), done("r1")]);
  await endInterview(page);
  await page.getByRole("button", { name: "Close without it", exact: true }).click({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Save again", exact: true })).toBeVisible();
  const refused = bodies.length;
  failing = false;
  await page.getByRole("button", { name: "Save again", exact: true }).click();
  await expectGapsDebrief(page, session);
  // The same answer event went out each time; the marker followed once it was stored.
  expect(new Set(bodies.slice(0, refused + 1)).size).toBe(1);
  expect((await stored(page, session)).map((event) => event.type)).toEqual(["utterance", "session.ended"]);
});

test("a rejected answer request and redelivered events cannot reorder or duplicate turns", async ({ page }) => {
  const session = await start(page);
  await ask(page, typedQuestion);
  const { event_id } = (await page.evaluate(() => window.e2eRealtime.sent)).find((event) => event.type === "response.create")!;
  await emit(page, { type: "error", error: { message: "A response is already in progress.", event_id } });
  await emitAll(page, [committed("u1"), committed("u2", "u1"), stt("u2", "Second question."), stt("u2", "Second question."), stt("u1", "First question."), committed("u1"), stt("u1", "First question.")]);
  await expect(saveState(page)).toHaveText("Transcript saved 3/3");
  await finishExpectedResponses(page, 2);
  await endInterview(page);
  await expect(page.getByText(COMPLETE, { exact: true })).toBeVisible();
  expect(await storedTurns(page, session)).toEqual([you(typedQuestion), you("First question."), you("Second question.")]);
});

test("a failed save resends the released turns byte for byte", async ({ page }) => {
  const session = await start(page);
  const bodies: string[] = [];
  let failing = true;
  await page.route("**/api/sessions/*/events", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    bodies.push(route.request().postData()!);
    if (failing) return route.abort("connectionrefused");
    await route.fallback();
  });
  await emitAll(page, [committed("u1"), created("r1"), said("r1", "a1", answers[0]), done("r1"), stt("u1", spokenQuestion)]);
  await expect.poll(() => bodies.length).toBe(2);
  await endInterview(page);
  await expect(page.getByRole("button", { name: "Save again", exact: true })).toBeVisible();
  failing = false;
  await page.getByRole("button", { name: "Save again", exact: true }).click();
  await expect(page.getByText(COMPLETE, { exact: true })).toBeVisible();
  // The first batch never changed: not the seq, the timestamp or the place of the question.
  expect(new Set(bodies.slice(0, 3)).size).toBe(1);
  const first: SessionEvent[] = JSON.parse(bodies[0]);
  expect(first.map((event) => event.data)).toEqual([you(spokenQuestion)]);
  const events = await stored(page, session);
  expect(events[0]).toEqual(first[0]);
  expect(events.map((event) => event.type)).toEqual(["utterance", "utterance", "session.ended"]);
  expect(events[1].data).toEqual(sandra(answers[0]));
});

test("the debrief and export of a delayed-transcript conversation use its stored turn numbers", async ({ page, request }) => {
  const session = await start(page);
  await emitAll(page, [
    committed("u1"), created("r1"), said("r1", "a1", answers[0]), done("r1"),
    committed("u2", "a1"), created("r2"), said("r2", "a2", answers[1]), done("r2"),
    stt("u2", spokenQuestion), stt("u1", typedQuestion),
  ]);
  await expect(saveState(page)).toHaveText("Transcript saved 4/4");
  await endInterview(page);
  await expect(page.getByText(COMPLETE, { exact: true })).toBeVisible();
  expect(await storedTurns(page, session)).toEqual([you(typedQuestion), sandra(answers[0]), you(spokenQuestion), sandra(answers[1])]);
  await expect(page.getByTestId("debrief").locator("blockquote")).toHaveCount(2);
  const report: InsightReport = await (await request.get(`/api/sessions/${session.id}/insights`)).json();
  expect(report.questions.map((question) => question.insights.map((insight) => ({ quote: insight.quote, turn: insight.turnSeq })))).toEqual([
    [{ quote: answers[0], turn: 2 }], [{ quote: answers[1], turn: 4 }],
  ]);
  const downloading = page.waitForEvent("download");
  await page.getByTestId("debrief").getByRole("button", { name: "Download .md", exact: true }).click();
  const exported = await readFile((await (await downloading).path())!, "utf8");
  expect(exported).toBe(formatReportMarkdown(report, "Sandra", false, "Quartier-Börse"));
  expect(exported).toContain("Interview turn 2");
  expect(exported).toContain("Interview turn 4");
});

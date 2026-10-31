import { expect, test, type Page } from "@playwright/test";
import exampleReport from "../../shared/examples/insight-report.json";
import exampleEvents from "../../shared/examples/session-events.json";
import type { Session, SessionEvent, InsightReport } from "../src/lib/contracts";
import { emit, installRealtime } from "./realtime";

const questions = exampleReport.questions.map((question) => question.question);
const answers = exampleReport.questions.map((question) => question.insights[0].quote);
const typedQuestion = exampleEvents[1].data.text!;
const spokenQuestion = exampleEvents[6].data.text!;

async function createPersona(page: Page) {
  await page.goto("/");
  await expect(page.getByLabel("Source 2 text")).toContainText("SYNTHETIC INTERVIEW");
  await page.getByRole("button", { name: "Create persona", exact: true }).click();
  await expect(page.getByTestId("persona-card").getByRole("heading", { name: "Sandra" })).toBeVisible();
}

async function startInterview(page: Page): Promise<Session> {
  await createPersona(page);
  await page.getByLabel("Interview questions, one per line (the debrief answers these)").fill(questions.join("\n"));
  const created = page.waitForResponse((response) => response.url().endsWith("/api/sessions") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Start voice interview" }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const session: Session = await response.json();
  const dialog = page.getByRole("dialog", { name: "Interview with Sandra" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveJSProperty("open", true);
  await expect(dialog.getByText("Live, speak now")).toBeVisible();
  await expect(dialog.getByText("Camera is off (blocked or not available). The persona only hears you.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => ({
    microphones: window.e2eRealtime.microphones.map((track) => ({ kind: track.kind, state: track.readyState })),
    cameraRequests: window.e2eRealtime.cameraRequests,
  }))).toEqual({ microphones: [{ kind: "audio", state: "live" }], cameraRequests: 1 });
  return session;
}

async function answer(page: Page, id: string, text: string) {
  await emit(page, { type: "response.created", response: { id } });
  const event = { type: "response.output_audio_transcript.done", item_id: id, content_index: 0, transcript: text };
  await emit(page, event);
  await emit(page, event); // Provider redelivery must not duplicate transcript turns.
  await emit(page, { type: "response.done", response: { id, status: "completed" } });
}

let unexpected: string[] = [];

test.afterEach(() => { expect(unexpected).toEqual([]); });

test.beforeEach(async ({ page, context }) => {
  unexpected = [];
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:3165") return route.continue();
    if (url.href === "https://api.openai.com/v1/realtime/calls") {
      expect(route.request().method()).toBe("POST");
      expect(route.request().postData()).toBe("e2e-offer");
      return route.fulfill({ status: 200, contentType: "application/sdp", body: "e2e-answer" });
    }
    unexpected.push(`${url.origin}${url.pathname}`);
    await route.abort("blockedbyclient");
  });
  await context.routeWebSocket("**/*", (socket) => {
    unexpected.push("unexpected WebSocket");
    socket.close();
  });
  await installRealtime(page);
});

test("sample sources to saved interview and exact-quote debrief", async ({ page, request }) => {
  const session = await startInterview(page);
  if (process.env.E2E_FAIL_EVENT_SAVE === "1") {
    // Explicit negative control: the happy path MUST fail if persistence is broken.
    await page.route("**/api/sessions/*/events", (route) => route.abort("connectionrefused"));
  }
  await page.getByLabel("Type a question").fill(typedQuestion);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  expect(await page.evaluate(() => window.e2eRealtime.sent)).toMatchObject([
    { type: "conversation.item.create", item: { content: [{ type: "input_text", text: typedQuestion }] } },
    { type: "response.create" },
  ]);
  await answer(page, "answer-1", answers[0]);

  // A committed microphone turn travels through the same production onmessage handler.
  await emit(page, { type: "input_audio_buffer.speech_started" });
  await emit(page, { type: "input_audio_buffer.committed", item_id: "spoken-1" });
  await emit(page, { type: "conversation.item.input_audio_transcription.completed", item_id: "spoken-1", transcript: spokenQuestion });
  await emit(page, { type: "response.created", response: { id: "answer-2" } });
  await page.getByRole("button", { name: "End interview", exact: true }).click();
  await expect(page.getByText("Saving transcript…", { exact: true })).toBeVisible();
  const duringEnd = await request.get(`/api/sessions/${session.id}/events`);
  expect(duringEnd.ok()).toBeTruthy();
  const pendingEvents: SessionEvent[] = await duringEnd.json();
  expect(pendingEvents.some((event) => event.type === "session.ended")).toBe(false);
  expect(await page.evaluate(() => window.e2eRealtime.closed)).toBe(false);
  // The last answer arrives after End; it must still be captured before the marker.
  await emit(page, { type: "response.output_audio_transcript.done", item_id: "answer-2", content_index: 0, transcript: answers[1] });
  await emit(page, { type: "response.done", response: { id: "answer-2", status: "completed" } });
  await expect(page.getByText("Ended. Microphone and camera are off, transcript saved.", { exact: true })).toBeVisible({ timeout: 10_000 });
  const dialog = page.getByRole("dialog", { name: "Interview with Sandra", includeHidden: true });
  await expect(dialog).toHaveJSProperty("open", false);
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("save-state")).toHaveText("Transcript saved 5/5");
  const transcript = page.getByTestId("interview-room").locator("details").filter({ hasText: "Transcript (4 turns)" });
  await expect(transcript).toBeVisible();
  await expect(transcript).toHaveJSProperty("open", false);
  await transcript.locator("summary").click();
  await expect(transcript).toHaveJSProperty("open", true);
  await expect(transcript.locator("ol")).toBeVisible();
  await expect(transcript.locator("li")).toHaveCount(4);
  for (const text of [typedQuestion, answers[0], spokenQuestion, answers[1]]) {
    await expect(transcript.locator("li").filter({ hasText: text })).toBeVisible();
  }
  expect(await page.evaluate(() => ({
    closed: window.e2eRealtime.closed,
    channelClosed: window.e2eRealtime.channelClosed,
    microphones: window.e2eRealtime.microphones.map((track) => track.readyState),
  }))).toEqual({ closed: true, channelClosed: true, microphones: ["ended"] });

  const stored: SessionEvent[] = await (await request.get(`/api/sessions/${session.id}/events`)).json();
  expect(stored.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
  expect(stored.map((event) => event.type)).toEqual(["utterance", "utterance", "utterance", "utterance", "session.ended"]);
  expect(stored.slice(0, 4).map((event) => event.data)).toEqual([
    { speaker: "interviewer", text: typedQuestion }, { speaker: "persona", text: answers[0] },
    { speaker: "interviewer", text: spokenQuestion }, { speaker: "persona", text: answers[1] },
  ]);
  expect(await (await request.get(`/api/sessions/${session.id}`)).json()).toMatchObject({ status: "ended", interviewGuide: questions });

  const debrief = page.getByTestId("debrief");
  await expect(debrief).toBeVisible();
  await expect(debrief.locator("blockquote")).toHaveCount(2);
  for (const [index, quote] of answers.entries()) {
    await expect(debrief.locator("blockquote").nth(index)).toContainText(`“${quote}”`);
    await expect(debrief).toContainText(questions[index]);
    await expect(debrief).toContainText(exampleReport.questions[index].followUps[0]);
  }
  await expect(debrief).toContainText("hypotheses to check with real users");
  const report: InsightReport = await (await request.get(`/api/sessions/${session.id}/insights`)).json();
  expect(report.questions.map((question) => question.insights.map((insight) => ({ quote: insight.quote, turn: insight.turnSeq })))).toEqual([
    [{ quote: answers[0], turn: 2 }], [{ quote: answers[1], turn: 4 }],
  ]);
});

test("backend unavailable is announced and the same sources can be retried", async ({ page }) => {
  await page.goto("/");
  const source = await page.getByLabel("Source 2 text").inputValue();
  // Browser-to-backend connection outage, then recovery to the real API and store.
  await page.route("**/api/personas", (route) => route.abort("connectionrefused"));
  await page.getByRole("button", { name: "Create persona", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("Backend not reachable. Is `make dev` running?");
  await expect(page.getByTestId("persona-card")).toHaveCount(0);
  await expect(page.getByLabel("Source 2 text")).toHaveValue(source);
  await expect(page.getByRole("button", { name: "Create persona", exact: true })).toBeEnabled();
  await page.unroute("**/api/personas");
  await page.getByRole("button", { name: "Create persona", exact: true }).click();
  await expect(page.getByTestId("persona-card").getByRole("heading", { name: "Sandra" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
});

test("rate limit is announced with the backend's wait time and keeps the sources", async ({ page }) => {
  await page.goto("/");
  const source = await page.getByLabel("Source 2 text").inputValue();
  const detail = "Too many requests from this network. Try again in 12 min.";
  await page.route("**/api/personas", (route) => route.fulfill({ status: 429, headers: { "Retry-After": "720" }, json: { detail } }));
  await page.getByRole("button", { name: "Create persona", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(detail);
  await expect(page.getByTestId("persona-card")).toHaveCount(0);
  await expect(page.getByLabel("Source 2 text")).toHaveValue(source);
});

test("failed last transcription cannot claim a complete transcript or show debrief", async ({ page, request }) => {
  const session = await startInterview(page);
  await page.getByLabel("Type a question").fill(typedQuestion);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await answer(page, "answer-1", answers[0]);
  await emit(page, { type: "input_audio_buffer.committed", item_id: "lost-1" });
  await emit(page, { type: "conversation.item.input_audio_transcription.failed", item_id: "lost-1" });
  await page.getByRole("button", { name: "End interview", exact: true }).click();
  await expect(page.getByText("Ended without the last turn. This transcript is incomplete, so there is no debrief for it.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create debrief", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("debrief")).toHaveCount(0);
  const events: SessionEvent[] = await (await request.get(`/api/sessions/${session.id}/events`)).json();
  expect(events.map((event) => event.type)).toEqual(["utterance", "utterance"]);
  // This is only a negative read of the real debrief gate; no events are manufactured via HTTP.
  expect((await request.post(`/api/sessions/${session.id}/debrief`)).status()).toBe(409);
});

test("the team link passcode is sent, leaves the address bar and survives blocked storage", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new Error("storage blocked");
    };
  });
  const created = page.waitForRequest(
    (request) => request.method() === "POST" && request.url().endsWith("/api/personas"),
  );
  await page.goto("/?code=team-pass");
  await page.getByRole("button", { name: "Create persona", exact: true }).click();
  expect((await created).headers()["x-demo-passcode"]).toBe("team-pass");
  await expect.poll(() => page.url()).not.toContain("code=");
});

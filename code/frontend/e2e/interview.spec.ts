import { expect, test, type Page, type Route } from "@playwright/test";
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

async function startInterview(page: Page, liveTimeout = 5_000): Promise<Session> {
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
  await expect(dialog.getByText("Live, speak now")).toBeVisible({ timeout: liveTimeout });
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

const commits = (page: Page) =>
  page.evaluate(() => window.e2eRealtime.sent.filter((event) => event.type === "input_audio_buffer.commit"));

async function storedTypes(page: Page, id: string) {
  const events: SessionEvent[] = await (await page.request.get(`/api/sessions/${id}/events`)).json();
  return events.map((event) => event.type);
}

const INCOMPLETE = "Ended without the last turn. This transcript is incomplete, so there is no debrief for it.";
const COMPLETE = "Ended. Microphone and camera are off, transcript saved.";

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
  await expect(page.getByTestId("end-wait")).toContainText("Waiting for the persona to finish answering");
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
  await expect(page.getByTestId("end-timings")).toHaveText(/provider finished \d+\.\d s · events saved \d+\.\d s · session closed \d+\.\d s/);
  // No speech was reserved at End: an unconditional commit would be a provider error.
  expect(await commits(page)).toEqual([]);
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

test("End during speech commits the heard audio and captures the last sentence", async ({ page }) => {
  const session = await startInterview(page);
  await emit(page, { type: "input_audio_buffer.speech_started" });
  await page.getByRole("button", { name: "End interview", exact: true }).click();
  await expect(page.getByTestId("end-wait")).toContainText("Transcribing your last sentence");
  await expect.poll(() => commits(page)).toHaveLength(1);
  expect(await page.evaluate(() => window.e2eRealtime.microphones.map((track) => track.readyState))).toEqual(["ended"]);
  expect(await page.evaluate(() => window.e2eRealtime.closed)).toBe(false);
  await emit(page, { type: "input_audio_buffer.committed", item_id: "last-1" });
  expect(await storedTypes(page, session.id)).toEqual([]);
  await emit(page, { type: "conversation.item.input_audio_transcription.completed", item_id: "last-1", transcript: spokenQuestion });
  await expect(page.getByText(COMPLETE, { exact: true })).toBeVisible();
  expect(await storedTypes(page, session.id)).toEqual(["utterance", "session.ended"]);
  expect(await commits(page)).toHaveLength(1);
});

test("a rejected commit of heard speech leaves the transcript incomplete", async ({ page, request }) => {
  const session = await startInterview(page);
  await emit(page, { type: "input_audio_buffer.speech_started" });
  await page.getByRole("button", { name: "End interview", exact: true }).click();
  await expect.poll(() => commits(page)).toHaveLength(1);
  const [{ event_id }] = await commits(page);
  await emit(page, { type: "error", error: { message: "Buffer too small.", event_id } });
  await expect(page.getByText(INCOMPLETE, { exact: true })).toBeVisible();
  expect(await storedTypes(page, session.id)).toEqual([]);
  expect((await request.post(`/api/sessions/${session.id}/debrief`)).status()).toBe(409);
});

test("a commit that loses the race to VAD does not mark the transcript incomplete", async ({ page }) => {
  const session = await startInterview(page);
  await emit(page, { type: "input_audio_buffer.speech_started" });
  await page.getByRole("button", { name: "End interview", exact: true }).click();
  await expect.poll(() => commits(page)).toHaveLength(1);
  const [{ event_id }] = await commits(page);
  await emit(page, { type: "input_audio_buffer.committed", item_id: "vad-1" });
  await emit(page, { type: "error", error: { message: "Buffer too small.", event_id } });
  await emit(page, { type: "conversation.item.input_audio_transcription.completed", item_id: "vad-1", transcript: spokenQuestion });
  await expect(page.getByText(COMPLETE, { exact: true })).toBeVisible();
  expect(await storedTypes(page, session.id)).toEqual(["utterance", "session.ended"]);
  await expect(page.getByText("Buffer too small.")).toHaveCount(0);
});

test("a missing final transcript is explained by 10 seconds and closing keeps it incomplete", async ({ page, request }) => {
  const session = await startInterview(page);
  await emit(page, { type: "input_audio_buffer.committed", item_id: "stuck-1" });
  await page.getByRole("button", { name: "End interview", exact: true }).click();
  const close = page.getByRole("button", { name: "Close with incomplete transcript", exact: true });
  await expect(close).toHaveCount(0);
  await expect(close).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("end-wait")).toHaveText(/Transcribing your last sentence… \d+s/);
  expect(await page.evaluate(() => window.e2eRealtime.closed)).toBe(false);
  await close.click();
  await expect(page.getByText(INCOMPLETE, { exact: true })).toBeVisible();
  expect(await storedTypes(page, session.id)).toEqual([]);
  expect((await request.post(`/api/sessions/${session.id}/debrief`)).status()).toBe(409);
});

test("a delayed final transcript still completes while the interviewer keeps waiting", async ({ page }) => {
  const session = await startInterview(page);
  await emit(page, { type: "input_audio_buffer.committed", item_id: "slow-1" });
  await page.getByRole("button", { name: "End interview", exact: true }).click();
  await expect(page.getByRole("button", { name: "Close with incomplete transcript", exact: true })).toBeVisible({ timeout: 10_000 });
  await emit(page, { type: "conversation.item.input_audio_transcription.completed", item_id: "slow-1", transcript: spokenQuestion });
  await expect(page.getByText(COMPLETE, { exact: true })).toBeVisible();
  expect(await storedTypes(page, session.id)).toEqual(["utterance", "session.ended"]);
});

test("an answer cancelled during End stays marked and the transcript still completes", async ({ page }) => {
  const session = await startInterview(page);
  await emit(page, { type: "response.created", response: { id: "cut-1" } });
  await page.getByRole("button", { name: "End interview", exact: true }).click();
  await expect(page.getByTestId("end-wait")).toContainText("Waiting for the persona to finish answering");
  const done = { type: "response.done", response: { id: "cut-1", status: "cancelled" } };
  await emit(page, done);
  await expect(page.getByText(COMPLETE, { exact: true })).toBeVisible();
  await expect(page.getByTestId("interview-room").locator("details li")).toHaveText(["Sandra: (interrupted)"]);
  expect(await storedTypes(page, session.id)).toEqual(["session.ended"]);
});

test("repeated and out-of-order provider events cannot strand End or duplicate turns", async ({ page }) => {
  const session = await startInterview(page);
  const completed = { type: "conversation.item.input_audio_transcription.completed", item_id: "late-1", transcript: spokenQuestion };
  await emit(page, completed);
  await emit(page, { type: "input_audio_buffer.committed", item_id: "late-1" });
  await emit(page, completed);
  const done = { type: "response.done", response: { id: "dup-1", status: "cancelled" } };
  await emit(page, { type: "response.created", response: { id: "dup-1" } });
  await emit(page, done);
  await emit(page, done);
  await emit(page, { type: "response.created", response: { id: "dup-1" } });
  await page.getByRole("button", { name: "End interview", exact: true }).click();
  await expect(page.getByText(COMPLETE, { exact: true })).toBeVisible();
  await expect(page.getByTestId("interview-room").locator("details li")).toHaveCount(2);
  expect(await storedTypes(page, session.id)).toEqual(["utterance", "session.ended"]);
});

test("a repeated commit of a finished turn cannot release newer speech", async ({ page }) => {
  const session = await startInterview(page);
  const committed = { type: "input_audio_buffer.committed", item_id: "first-1" };
  await emit(page, committed);
  await emit(page, { type: "conversation.item.input_audio_transcription.completed", item_id: "first-1", transcript: spokenQuestion });
  await emit(page, { type: "input_audio_buffer.speech_started" });
  await emit(page, committed);
  await page.getByRole("button", { name: "End interview", exact: true }).click();
  await expect.poll(() => commits(page)).toHaveLength(1);
  await expect(page.getByTestId("end-wait")).toContainText("Transcribing your last sentence");
  expect(await page.evaluate(() => window.e2eRealtime.closed)).toBe(false);
  await emit(page, { type: "input_audio_buffer.committed", item_id: "second-1" });
  await emit(page, { type: "conversation.item.input_audio_transcription.completed", item_id: "second-1", transcript: typedQuestion });
  await expect(page.getByText(COMPLETE, { exact: true })).toBeVisible();
  expect(await storedTypes(page, session.id)).toEqual(["utterance", "utterance", "session.ended"]);
});

test("a repeated response.created cannot release a later typed question", async ({ page }) => {
  const session = await startInterview(page);
  for (const id of ["answer-1", "answer-2"]) {
    await page.getByLabel("Type a question").fill(typedQuestion);
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    if (id === "answer-1") await answer(page, id, answers[0]);
  }
  await emit(page, { type: "response.created", response: { id: "answer-1" } });
  await page.getByRole("button", { name: "End interview", exact: true }).click();
  await expect(page.getByTestId("end-wait")).toContainText("Waiting for the persona to take your question");
  expect(await page.evaluate(() => window.e2eRealtime.closed)).toBe(false);
  await answer(page, "answer-2", answers[1]);
  await expect(page.getByText(COMPLETE, { exact: true })).toBeVisible();
  expect(await storedTypes(page, session.id)).toEqual(["utterance", "utterance", "utterance", "utterance", "session.ended"]);
});

test("connection loss during End saves captured turns as incomplete", async ({ page, request }) => {
  const session = await startInterview(page);
  await page.getByLabel("Type a question").fill(typedQuestion);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await answer(page, "answer-1", answers[0]);
  await emit(page, { type: "input_audio_buffer.committed", item_id: "gone-1" });
  await page.getByRole("button", { name: "End interview", exact: true }).click();
  await page.evaluate(() => window.e2eRealtime.dropChannel());
  await expect(page.getByTestId("connection-lost")).toContainText("This transcript is incomplete");
  await expect(page.getByTestId("save-state")).toHaveText("Transcript saved 2/2");
  expect(await storedTypes(page, session.id)).toEqual(["utterance", "utterance"]);
  expect((await request.post(`/api/sessions/${session.id}/debrief`)).status()).toBe(409);
});

test("a hung event save reaches a retry state and Save again adds no duplicates", async ({ page }) => {
  test.setTimeout(60_000);
  const session = await startInterview(page);
  await page.getByLabel("Type a question").fill(typedQuestion);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await answer(page, "answer-1", answers[0]);
  await expect(page.getByTestId("save-state")).toHaveText("Transcript saved 2/2");
  let attempts = 0;
  const hang = () => { attempts += 1; }; // Never answered: only the client deadline can end it.
  await page.route("**/api/sessions/*/events", hang);
  await page.getByRole("button", { name: "End interview", exact: true }).click();
  await expect(page.getByText("Saving transcript…", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save again", exact: true })).toBeVisible({ timeout: 40_000 });
  // Three attempts, plus at most the request the end marker had already started.
  expect(attempts).toBeLessThanOrEqual(4);
  await expect(page.getByTestId("interview-room").getByRole("alert")).toContainText("Could not finish saving (2/3 events stored)");
  await page.unroute("**/api/sessions/*/events", hang);
  await page.getByRole("button", { name: "Save again", exact: true }).click();
  await expect(page.getByText(COMPLETE, { exact: true })).toBeVisible();
  const stored: SessionEvent[] = await (await page.request.get(`/api/sessions/${session.id}/events`)).json();
  expect(stored.map((event) => [event.seq, event.type])).toEqual([[1, "utterance"], [2, "utterance"], [3, "session.ended"]]);
});

test("a hung final PATCH is retried within its budget", async ({ page, request }) => {
  const session = await startInterview(page);
  let attempts = 0;
  await page.route(`**/api/sessions/${session.id}`, (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    attempts += 1;
    if (attempts > 1) return route.fallback();
    // First attempt never answers.
  });
  await page.getByRole("button", { name: "End interview", exact: true }).click();
  await expect(page.getByText(COMPLETE, { exact: true })).toBeVisible({ timeout: 15_000 });
  expect(attempts).toBe(2);
  expect(await (await request.get(`/api/sessions/${session.id}`)).json()).toMatchObject({ status: "ended" });
});

test("a final PATCH that never answers reaches Save again, with no debrief until it succeeds", async ({ page, request }) => {
  test.setTimeout(60_000);
  const session = await startInterview(page);
  await page.getByLabel("Type a question").fill(typedQuestion);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await answer(page, "answer-1", answers[0]);
  let attempts = 0;
  const hang = (route: Route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    attempts += 1; // Never answered: only the client deadline can end it.
  };
  await page.route(`**/api/sessions/${session.id}`, hang);
  await page.getByRole("button", { name: "End interview", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save again", exact: true })).toBeVisible({ timeout: 30_000 });
  expect(attempts).toBe(3);
  await expect(page.getByTestId("interview-room").getByRole("alert")).toContainText("Could not finish saving (3/3 events stored)");
  await expect(page.getByText(COMPLETE, { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("debrief")).toHaveCount(0);
  expect(await (await request.get(`/api/sessions/${session.id}`)).json()).toMatchObject({ status: "live" });
  await page.unroute(`**/api/sessions/${session.id}`, hang);
  await page.getByRole("button", { name: "Save again", exact: true }).click();
  await expect(page.getByText(COMPLETE, { exact: true })).toBeVisible();
  await expect(page.getByTestId("debrief")).toBeVisible();
  expect(await (await request.get(`/api/sessions/${session.id}`)).json()).toMatchObject({ status: "ended" });
  expect(await storedTypes(page, session.id)).toEqual(["utterance", "utterance", "session.ended"]);
});

test("saves whose answer was lost after the server stored them are retried without duplicates", async ({ page, request }) => {
  const session = await startInterview(page);
  const answerLost = (method: string) => {
    let lost = false;
    return async (route: Route) => {
      if (lost || route.request().method() !== method) return route.fallback();
      lost = true;
      await route.fetch(); // The server does the work; only the browser never hears back.
      await route.abort("timedout");
    };
  };
  await page.route("**/api/sessions/*/events", answerLost("POST"));
  await page.route(`**/api/sessions/${session.id}`, answerLost("PATCH"));
  await page.getByRole("button", { name: "End interview", exact: true }).click();
  await expect(page.getByText(COMPLETE, { exact: true })).toBeVisible({ timeout: 15_000 });
  expect(await storedTypes(page, session.id)).toEqual(["session.ended"]);
  expect(await (await request.get(`/api/sessions/${session.id}`)).json()).toMatchObject({ status: "ended" });
});

test("a slow startup PATCH delays the call but does not hang it up", async ({ page }) => {
  await page.route("**/api/sessions/*", async (route) => {
    if (route.request().postDataJSON()?.status === "live") await new Promise((resolve) => setTimeout(resolve, 7_000));
    await route.fallback();
  });
  await startInterview(page, 10_000);
  expect(await page.evaluate(() => window.e2eRealtime.closed)).toBe(false);
  await expect(page.getByTestId("interview-room").getByRole("alert")).toHaveCount(0);
});

test("a hung startup PATCH cannot block End after a lost connection, and arriving late cannot revive the session", async ({ page, request }) => {
  let held: Route | undefined;
  await page.route("**/api/sessions/*", (route) => {
    if (route.request().postDataJSON()?.status !== "live") return route.fallback();
    held = route;
  });
  await createPersona(page);
  const created = page.waitForResponse((response) => response.url().endsWith("/api/sessions") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Start voice interview" }).click();
  const session: Session = await (await created).json();
  await expect.poll(() => held !== undefined).toBe(true);
  await page.evaluate(() => window.e2eRealtime.dropChannel());
  await expect(page.getByTestId("connection-lost")).toContainText("Start again begins a new conversation");
  const ended = await (await request.get(`/api/sessions/${session.id}`)).json();
  expect(ended).toMatchObject({ status: "ended" });
  const late = page.waitForResponse((response) => response.request().postDataJSON()?.status === "live");
  await held!.fallback();
  expect((await late).status()).toBe(409);
  expect(await (await request.get(`/api/sessions/${session.id}`)).json()).toEqual(ended);
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

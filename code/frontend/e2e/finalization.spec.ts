import { expect, test, type Page, type APIRequestContext } from "@playwright/test";
import exampleReport from "../../shared/examples/insight-report.json";
import exampleEvents from "../../shared/examples/session-events.json";
import type { Session, SessionEvent } from "../src/lib/contracts";
import { emit, installRealtime } from "./realtime";

declare global {
  interface Window {
    e2ePersistence: { block: boolean; calls: string[]; bodyStarted: number };
    e2eStartup: { fail: () => void; release: () => void; calls: string[]; lateStatus: number | null; accepted: boolean };
    e2eDeniedMicrophone: { calls: number };
  }
}

const complete = "Ended. Microphone and camera are off, transcript saved.";
const incomplete = "Ended without the last turn. This transcript is incomplete, so there is no debrief for it.";
const startupIncomplete = "Interview could not start. Capture is off; this incomplete session has no debrief. Start again to retry.";
const gaps = "Ended. Microphone and camera are off. This transcript has gaps: at least one turn was not captured.";
const sentence = exampleEvents[6].data.text!;

async function start(page: Page, waitForLive = true, beforeStart?: () => Promise<void>): Promise<Session> {
  await page.goto("/");
  await beforeStart?.();
  await page.getByRole("button", { name: "Create persona", exact: true }).click();
  await expect(page.getByTestId("persona-card")).toBeVisible();
  await page.getByLabel("Interview questions, one per line (the debrief answers these)").fill(exampleReport.questions.map((question) => question.question).join("\n"));
  const response = page.waitForResponse((res) => res.url().endsWith("/api/sessions") && res.request().method() === "POST");
  await page.getByRole("button", { name: "Start video interview", exact: true }).click();
  if (waitForLive) await expect(page.getByText("Live, speak now")).toBeVisible();
  return (await response).json() as Promise<Session>;
}

async function stored(request: APIRequestContext, session: Session): Promise<SessionEvent[]> {
  const response = await request.get(`/api/sessions/${session.id}/events`);
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<SessionEvent[]>;
}

async function end(page: Page) {
  await page.getByRole("button", { name: "End interview", exact: true }).click();
  const microphones = await page.evaluate(() => window.e2eRealtime.microphones.map((track) => track.readyState));
  expect(microphones.length).toBeGreaterThan(0);
  expect(microphones.every((state) => state === "ended")).toBe(true);
}

async function settle(page: Page) {
  await page.clock.runFor(600);
}

async function expectIncomplete(page: Page, request: APIRequestContext, session: Session) {
  await expect(page.getByText(incomplete, { exact: true }).or(page.getByText(startupIncomplete, { exact: true }))).toBeVisible();
  expect((await stored(request, session)).some((event) => event.type === "session.ended")).toBe(false);
  await expect(page.getByTestId("debrief")).toHaveCount(0);
  expect((await request.post(`/api/sessions/${session.id}/debrief`)).status()).toBe(409);
  expect(await (await request.get(`/api/sessions/${session.id}`)).json()).toMatchObject({ status: "ended" });
}

// A live call with a lost turn: still ended and marked, and the debrief can't look complete.
async function expectGaps(page: Page, request: APIRequestContext, session: Session) {
  await expect(page.getByText(gaps, { exact: true })).toBeVisible();
  const events = await stored(request, session);
  expect(events.filter((event) => event.type === "session.ended")).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({ type: "session.ended", data: { transcriptGaps: true } });
  expect(await (await request.get(`/api/sessions/${session.id}`)).json()).toMatchObject({ status: "ended" });
  const spoke = events.some((event) => event.type === "utterance" && event.data.speaker === "persona" && event.data.text !== "(interrupted)");
  if (spoke) await expect(page.getByTestId("debrief").getByTestId("transcript-gaps")).toContainText("This transcript has gaps");
  else await expectNothingToDebrief(page);
}

async function expectNothingToDebrief(page: Page) {
  await expect(page.getByTestId("interview-room").getByRole("alert").filter({ hasText: "the persona never answered" })).toBeVisible();
  await expect(page.getByTestId("debrief")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toHaveCount(0);
}

async function stallPersistence(page: Page, target: "events" | "patch", body: boolean) {
  await page.addInitScript(({ target, body }) => {
    const realFetch = window.fetch.bind(window);
    const state = { block: true, calls: [] as string[], bodyStarted: 0 };
    window.e2ePersistence = state;
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const matched = target === "events"
        ? url.endsWith("/events") && init?.method === "POST"
        : /\/api\/sessions\/[^/]+$/.test(url) && init?.method === "PATCH" && String(init.body).includes('"ended"');
      if (!matched) return realFetch(input, init);
      state.calls.push(String(init?.body));
      if (!state.block) return realFetch(input, init);
      if (!body) return new Promise<Response>(() => {}); // Deliberately ignores abort.
      // Acceptance followed by a stuck response body must retry the identical payload.
      await realFetch(input, init);
      state.bodyStarted += 1;
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
    };
  }, { target, body });
}

async function stallStartup(page: Page, failure: "deadline" | "gateway" | "body") {
  await page.addInitScript(({ failure }) => {
    const realFetch = window.fetch.bind(window);
    let release = () => {};
    const released = new Promise<void>((resolve) => { release = resolve; });
    let fail = () => {};
    const failed = new Promise<void>((resolve) => { fail = resolve; });
    const state = { fail, release, calls: [] as string[], accepted: false, lateStatus: null as number | null };
    window.e2eStartup = state;
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!/\/api\/sessions\/[^/]+$/.test(url) || init?.method !== "PATCH") return realFetch(input, init);
      const status = (JSON.parse(String(init.body)) as { status: string }).status;
      state.calls.push(status);
      if (status !== "live") return realFetch(input, init);
      // The server request outlives the caller's abort or a gateway 504.
      const serverRequest = async () => {
        if (failure !== "body") await released;
        const response = await realFetch(input, { ...init, signal: undefined });
        state.lateStatus = response.status;
        state.accepted = response.ok;
        return response;
      };
      const pending = serverRequest();
      if (failure === "gateway") {
        await failed; // Let the test capture a turn before returning 504.
        return new Response('{"detail":"synthetic gateway timeout"}', { status: 504 });
      }
      if (failure === "body") {
        await pending;
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
      }
      return pending;
    };
  }, { failure });
}

test.beforeEach(async ({ page, context }) => {
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:3165") return route.continue();
    if (url.href === "https://api.openai.com/v1/realtime/calls") return route.fulfill({ status: 200, body: "synthetic-sdp" });
    throw new Error(`Unexpected external request: ${url.origin}${url.pathname}`);
  });
  await context.routeWebSocket("**/*", () => { throw new Error("Unexpected WebSocket"); });
  await installRealtime(page);
});

// The persona's words arrive with response.done; the audio can outlast them by much more.
async function answerStillPlaying(page: Page) {
  await page.getByLabel("Type a question").fill(exampleEvents[1].data.text!);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await emit(page, { type: "response.created", response: { id: "playing" } });
  await emit(page, { type: "output_audio_buffer.started", response_id: "playing" });
  await emit(page, { type: "response.done", response: { id: "playing", status: "completed", output: [
    { id: "playing-item", content: [{ type: "output_audio", transcript: exampleReport.questions[0].insights[0].quote }] },
  ] } });
}

async function expectCompleteWithDebrief(page: Page, request: APIRequestContext, session: Session) {
  await expect(page.getByText(complete, { exact: true })).toBeVisible();
  await expect(page.getByTestId("debrief").locator("blockquote")).toHaveCount(1);
  await expect(page.getByTestId("transcript-gaps")).toHaveCount(0);
  const events = await stored(request, session);
  expect(events.at(-1)).toMatchObject({ type: "session.ended" });
  expect(events.at(-1)?.data).not.toHaveProperty("transcriptGaps");
}

test("ending mid-answer: audio outlasting the wait limit closes on its own with a complete debrief", async ({ page, request }) => {
  const session = await start(page);
  await answerStillPlaying(page);
  await end(page);
  await settle(page);
  await expect(page.getByRole("status")).toContainText("Waiting for the persona response");
  await page.clock.runFor(10_000);
  await expect(page.getByRole("button", { name: "Close without it", exact: true })).toHaveCount(0);
  await expectCompleteWithDebrief(page, request, session);
});

test("a connection drop while the saved last answer is still playing loses nothing", async ({ page, request }) => {
  const session = await start(page);
  await answerStillPlaying(page);
  await page.evaluate(() => window.e2eRealtime.lose());
  await expectCompleteWithDebrief(page, request, session);
  await expect(page.getByTestId("connection-lost")).not.toContainText("gaps");
});

test("ending mid-answer with the response cut off by a drop keeps the debrief, marked as gaps", async ({ page, request }) => {
  const session = await start(page);
  await answerStillPlaying(page);
  await emit(page, { type: "response.created", response: { id: "cut-off" } });
  await end(page);
  await page.evaluate(() => window.e2eRealtime.lose());
  await settle(page);
  await expectGaps(page, request, session);
});

test("the last item arriving after the wait limit finishes the call: nothing is left to close without", async ({ page, request }) => {
  const session = await start(page);
  await answerStillPlaying(page);
  await emit(page, { type: "output_audio_buffer.stopped", response_id: "playing" });
  await emit(page, { type: "input_audio_buffer.committed", item_id: "late-input" });
  await end(page);
  await page.clock.runFor(10_000);
  const close = page.getByRole("button", { name: "Close without it", exact: true });
  await expect(close).toBeVisible();
  await emit(page, { type: "conversation.item.input_audio_transcription.completed", item_id: "late-input", transcript: sentence });
  await emit(page, { type: "response.done", response: { id: "late-answer", status: "completed", output: [] } });
  await settle(page);
  await expect(close).toHaveCount(0);
  await expectCompleteWithDebrief(page, request, session);
});

test("a call where the persona never spoke says so instead of offering a retry that cannot work", async ({ page }) => {
  await start(page);
  await end(page);
  await settle(page);
  await expect(page.getByText(complete, { exact: true })).toBeVisible();
  await expectNothingToDebrief(page);
});

test("End during speech conditionally commits once, preserves the sentence and waits for playback", async ({ page, request }) => {
  const session = await start(page);
  await page.getByLabel("Type a question").fill(exampleEvents[1].data.text!);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await emit(page, { type: "response.created", response: { id: "first-answer" } });
  await emit(page, { type: "response.output_audio_transcript.done", item_id: "first-item", content_index: 0, transcript: exampleReport.questions[0].insights[0].quote });
  await emit(page, { type: "response.done", response: { id: "first-answer", status: "completed" } });
  await emit(page, { type: "input_audio_buffer.speech_started", item_id: "active-speech" });
  await end(page);
  await expect(page.getByRole("status")).toContainText("Transcribing the last sentence");
  await settle(page);
  expect(await page.evaluate(() => window.e2eRealtime.sent.filter((event) => event.type === "input_audio_buffer.commit"))).toHaveLength(1);
  await emit(page, { type: "input_audio_buffer.committed", item_id: "manual-item" });
  await emit(page, { type: "response.created", response: { id: "last-answer" } });
  await emit(page, { type: "output_audio_buffer.started", response_id: "last-answer" });
  await emit(page, { type: "conversation.item.input_audio_transcription.completed", item_id: "manual-item", transcript: sentence });
  const terminal = { type: "response.done", response: {
    id: "last-answer", status: "completed", output: [{ id: "answer-item", content: [{ type: "output_audio", transcript: exampleReport.questions[1].insights[0].quote }] }],
  } };
  await emit(page, terminal);
  await emit(page, terminal);
  await settle(page);
  await expect(page.getByRole("status")).toContainText("Waiting for the persona response");
  expect(await page.evaluate(() => window.e2eRealtime.closed)).toBe(false);
  expect((await stored(request, session)).some((event) => event.type === "session.ended")).toBe(false);
  expect(await page.evaluate(() => window.e2eRealtime.sent.some((event) => event.type === "response.cancel"))).toBe(false);
  await emit(page, { type: "output_audio_buffer.stopped", response_id: "last-answer" });
  await settle(page);
  await expect(page.getByText(complete, { exact: true })).toBeVisible();
  const events = await stored(request, session);
  expect(events.map((event) => event.type)).toEqual(["utterance", "utterance", "utterance", "utterance", "session.ended"]);
  expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
  expect(events[2].data).toEqual({ speaker: "interviewer", text: sentence });
  expect(events[3].data).toEqual({ speaker: "persona", text: exampleReport.questions[1].insights[0].quote });
  await expect(page.getByTestId("debrief")).toBeVisible();
});

for (const retainedId of [false, true]) {
  for (const outcome of ["success", "empty", "failed"] as const) {
    test(`manual-only ${outcome} transcription with ${retainedId ? "retained" : "distinct"} ID settles without an invented model response`, async ({ page, request }) => {
      const session = await start(page);
      await emit(page, { type: "input_audio_buffer.speech_started", item_id: "manual-speech" });
      await end(page);
      await settle(page);
      expect(await page.evaluate(() => window.e2eRealtime.sent.filter((event) => event.type === "input_audio_buffer.commit"))).toHaveLength(1);
      const itemId = retainedId ? "manual-speech" : "manual-only";
      const committed = { type: "input_audio_buffer.committed", item_id: itemId };
      await emit(page, committed);
      const transcribed = { type: `conversation.item.input_audio_transcription.${outcome === "failed" ? "failed" : "completed"}`,
        item_id: itemId, transcript: outcome === "success" ? sentence : "" };
      await emit(page, transcribed);
      await emit(page, committed);
      await emit(page, transcribed);
      await emit(page, { type: "input_audio_buffer.speech_started", item_id: "manual-speech" });
      // Manual commit only requests transcription. No response.created/done is injected.
      await settle(page);
      expect(await page.evaluate(() => window.e2eRealtime.sent.some((event) => event.type === "response.create"))).toBe(false);
      if (outcome === "failed") await expectGaps(page, request, session);
      else {
        await expect(page.getByText(complete, { exact: true })).toBeVisible();
        const events = await stored(request, session);
        expect(events.map((event) => event.type)).toEqual(outcome === "success" ? ["utterance", "session.ended"] : ["session.ended"]);
        expect(events.map((event) => event.seq)).toEqual(outcome === "success" ? [1, 2] : [1]);
        if (outcome === "success") expect(events[0].data).toEqual({ speaker: "interviewer", text: sentence });
        expect(await (await request.get(`/api/sessions/${session.id}`)).json()).toMatchObject({ status: "ended" });
      }
    });
  }
}

for (const stoppedFirst of [false, true]) {
  test(`retained-ID manual/VAD race waits for the response (speech_stopped ${stoppedFirst ? "first" : "last"})`, async ({ page, request }) => {
    const session = await start(page);
    await emit(page, { type: "input_audio_buffer.speech_started", item_id: "same-item" });
    await end(page);
    await settle(page);
    expect(await page.evaluate(() => window.e2eRealtime.sent.filter((event) => event.type === "input_audio_buffer.commit"))).toHaveLength(1);
    if (stoppedFirst) await emit(page, { type: "input_audio_buffer.speech_stopped", item_id: "same-item" });
    await emit(page, { type: "input_audio_buffer.committed", item_id: "same-item" });
    await emit(page, { type: "conversation.item.input_audio_transcription.completed", item_id: "same-item", transcript: sentence });
    if (!stoppedFirst) await emit(page, { type: "input_audio_buffer.speech_stopped", item_id: "same-item" });
    await settle(page);
    await expect(page.getByRole("status")).toContainText("Waiting for the persona response");
    expect((await stored(request, session)).some((event) => event.type === "session.ended")).toBe(false);
    expect(await page.evaluate(() => window.e2eRealtime.closed)).toBe(false);
    await emit(page, { type: "response.created", response: { id: "same-item-answer" } });
    await emit(page, { type: "response.done", response: { id: "same-item-answer", status: "completed", output: [] } });
    await settle(page);
    await expect(page.getByText(complete, { exact: true })).toBeVisible();
    const events = await stored(request, session);
    expect(events.map((event) => event.type)).toEqual(["utterance", "session.ended"]);
    expect(events[0].data).toEqual({ speaker: "interviewer", text: sentence });
  });
}

for (const confirmation of ["stopped-before-done", "stopped-after-done", "distinct-commit"]) {
  test(`retained manual acknowledgement preserves an observed response (${confirmation})`, async ({ page, request }) => {
    const session = await start(page);
    await emit(page, { type: "input_audio_buffer.speech_started", item_id: "vad" });
    await end(page);
    await settle(page);
    expect(await page.evaluate(() => window.e2eRealtime.sent.filter((event) => event.type === "input_audio_buffer.commit"))).toHaveLength(1);
    await emit(page, { type: "input_audio_buffer.committed", item_id: "vad" });
    await emit(page, { type: "conversation.item.input_audio_transcription.completed", item_id: "vad", transcript: sentence });
    await emit(page, { type: "response.created", response: { id: "answer" } });
    if (confirmation === "stopped-before-done") await emit(page, { type: "input_audio_buffer.speech_stopped", item_id: "vad" });
    await settle(page);
    expect(await page.evaluate(() => window.e2eRealtime.closed)).toBe(false);
    expect((await stored(request, session)).some((event) => event.type === "session.ended")).toBe(false);
    await emit(page, { type: "response.done", response: { id: "answer", status: "completed", output: [] } });
    if (confirmation === "stopped-after-done") await emit(page, { type: "input_audio_buffer.speech_stopped", item_id: "vad" });
    if (confirmation === "distinct-commit") {
      await emit(page, { type: "input_audio_buffer.committed", item_id: "manual" });
      await settle(page);
      expect(await page.evaluate(() => window.e2eRealtime.closed)).toBe(false);
      expect((await stored(request, session)).some((event) => event.type === "session.ended")).toBe(false);
      await emit(page, { type: "conversation.item.input_audio_transcription.completed", item_id: "manual", transcript: "Independent manual words" });
    }
    await settle(page);
    await expect(page.getByText(complete, { exact: true })).toBeVisible();
    const events = await stored(request, session);
    expect(events.map((event) => event.type)).toEqual(confirmation === "distinct-commit"
      ? ["utterance", "utterance", "session.ended"] : ["utterance", "session.ended"]);
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(events[0].data).toEqual({ speaker: "interviewer", text: sentence });
    if (confirmation === "distinct-commit") expect(events[1].data).toEqual({ speaker: "interviewer", text: "Independent manual words" });
  });
}

// Synthetic manual-first schedules exercise attribution, not live VAD timing.
for (const confirmation of ["commit-before-done", "transcription-after-done", "stopped-after-done", "retained-late-stop"] as const) {
  test(`manual-first response attribution survives ${confirmation}`, async ({ page, request }) => {
    const session = await start(page);
    await emit(page, { type: "input_audio_buffer.speech_started", item_id: "vad" });
    await end(page);
    await settle(page);
    expect(await page.evaluate(() => window.e2eRealtime.sent.filter((event) => event.type === "input_audio_buffer.commit"))).toHaveLength(1);
    const retained = confirmation === "retained-late-stop";
    const manualId = retained ? "vad" : "manual";
    const manualText = retained ? sentence : "Independent manual words";
    const manualCommit = { type: "input_audio_buffer.committed", item_id: manualId };
    const manualTranscript = { type: "conversation.item.input_audio_transcription.completed", item_id: manualId, transcript: manualText };
    const vadCommit = { type: "input_audio_buffer.committed", item_id: "vad" };
    const vadTranscript = { type: "conversation.item.input_audio_transcription.completed", item_id: "vad", transcript: sentence };
    await emit(page, manualCommit);
    await emit(page, manualTranscript);
    await emit(page, { type: "response.created", response: { id: "answer" } });
    if (confirmation === "commit-before-done") {
      await emit(page, vadCommit);
      await emit(page, vadTranscript);
    } else if (!retained) await emit(page, vadCommit);
    await settle(page);
    expect(await page.evaluate(() => window.e2eRealtime.closed)).toBe(false);
    expect((await stored(request, session)).some((event) => event.type === "session.ended")).toBe(false);
    await emit(page, { type: "response.done", response: { id: "answer", status: "completed", output: [] } });
    if (confirmation === "transcription-after-done" || confirmation === "stopped-after-done") {
      await settle(page);
      await expect(page.getByRole("status")).toContainText("Transcribing the last sentence");
      expect((await stored(request, session)).some((event) => event.type === "session.ended")).toBe(false);
    }
    if (confirmation === "stopped-after-done" || retained) await emit(page, { type: "input_audio_buffer.speech_stopped", item_id: "vad" });
    await emit(page, vadTranscript);
    // Redelivery must preserve both transcript identities and one terminal marker.
    for (const event of [manualCommit, vadCommit, manualTranscript, vadTranscript]) await emit(page, event);
    await emit(page, { type: "response.created", response: { id: "answer" } });
    await emit(page, { type: "response.done", response: { id: "answer", status: "completed", output: [] } });
    await settle(page);
    await expect(page.getByText(complete, { exact: true })).toBeVisible();
    const events = await stored(request, session);
    expect(events.map((event) => event.type)).toEqual(retained ? ["utterance", "session.ended"] : ["utterance", "utterance", "session.ended"]);
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(events.filter((event) => event.type === "utterance").map((event) => event.data)).toEqual(retained
      ? [{ speaker: "interviewer", text: sentence }]
      : [{ speaker: "interviewer", text: manualText }, { speaker: "interviewer", text: sentence }]);
  });
}

for (const missing of ["transcript", "terminal"] as const) {
  test(`manual-first missing ${missing} waits, then closes with gaps`, async ({ page, request }) => {
    const session = await start(page);
    await emit(page, { type: "input_audio_buffer.speech_started", item_id: "vad" });
    await end(page);
    await settle(page);
    await emit(page, { type: "input_audio_buffer.committed", item_id: "manual" });
    await emit(page, { type: "conversation.item.input_audio_transcription.completed", item_id: "manual", transcript: "Independent manual words" });
    await emit(page, { type: "response.created", response: { id: "answer" } });
    await emit(page, { type: "input_audio_buffer.committed", item_id: "vad" });
    if (missing === "transcript") await emit(page, { type: "response.done", response: { id: "answer", status: "completed", output: [] } });
    else await emit(page, { type: "conversation.item.input_audio_transcription.completed", item_id: "vad", transcript: sentence });
    await page.clock.runFor(10_000);
    await expect(page.getByRole("status")).toContainText(missing === "transcript" ? "Transcribing the last sentence" : "Waiting for the persona response");
    await expect(page.getByRole("button", { name: "Continue waiting (10 seconds)", exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.e2eRealtime.closed)).toBe(false);
    expect((await stored(request, session)).some((event) => event.type === "session.ended")).toBe(false);
    await expect(page.getByTestId("debrief")).toHaveCount(0);
    await page.getByRole("button", { name: "Close without it", exact: true }).click();
    await expectGaps(page, request, session);
  });
}

test("manual-only transcription retains an independent automatic VAD response", async ({ page, request }) => {
  const session = await start(page);
  await emit(page, { type: "input_audio_buffer.speech_started", item_id: "older-vad" });
  await emit(page, { type: "input_audio_buffer.committed", item_id: "older-vad" });
  await emit(page, { type: "conversation.item.input_audio_transcription.completed", item_id: "older-vad", transcript: "An earlier VAD turn" });
  await emit(page, { type: "input_audio_buffer.speech_started", item_id: "manual-speech" });
  await end(page);
  await settle(page);
  await emit(page, { type: "input_audio_buffer.committed", item_id: "manual-only" });
  await emit(page, { type: "conversation.item.input_audio_transcription.completed", item_id: "manual-only", transcript: sentence });
  await settle(page);
  await expect(page.getByRole("status")).toContainText("Waiting for the persona response");
  expect((await stored(request, session)).some((event) => event.type === "session.ended")).toBe(false);
  expect(await page.evaluate(() => window.e2eRealtime.closed)).toBe(false);
  await emit(page, { type: "response.done", response: { id: "older-vad-answer", status: "completed", output: [] } });
  await settle(page);
  await expect(page.getByText(complete, { exact: true })).toBeVisible();
  const events = await stored(request, session);
  expect(events.map((event) => event.type)).toEqual(["utterance", "utterance", "session.ended"]);
  expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
});

for (const failure of ["deadline", "gateway", "body"] as const) {
  for (const connectionLoss of [false, true]) {
    test(`startup ${failure} ${connectionLoss ? "with connection loss" : "without connection loss"} preserves captured turns and terminal state`, async ({ page, request }) => {
      await stallStartup(page, failure);
      const session = await start(page, false);
      await expect.poll(() => page.evaluate(() => window.e2eStartup.calls)).toEqual(["live"]);
      if (failure === "body") await expect.poll(() => page.evaluate(() => window.e2eStartup.accepted)).toBe(true);
      await emit(page, { type: "conversation.item.input_audio_transcription.completed", item_id: "startup-turn", transcript: sentence });
      // Let the real local POST finish before advancing unrelated startup time.
      // Otherwise virtual time aborts it before the server can answer.
      await expect(page.getByTestId("save-state")).toHaveText("Transcript saved 1/1");
      await emit(page, { type: "input_audio_buffer.speech_started", item_id: "lost-during-startup" });
      if (connectionLoss) await page.evaluate(() => window.e2eRealtime.lose());
      if (failure === "gateway") await page.evaluate(() => window.e2eStartup.fail());
      if (!connectionLoss && failure !== "gateway") await page.clock.runFor(15_500);
      await expectIncomplete(page, request, session);
      if (!connectionLoss) {
        await expect(page.getByTestId("interview-room").getByRole("alert")).toContainText(
          failure === "gateway" ? "Could not start (504): synthetic gateway timeout" : "Could not start: Request deadline exceeded",
        );
      }
      const before = await (await request.get(`/api/sessions/${session.id}`)).json() as Session;
      expect(before.endedAt).toEqual(expect.any(String));
      if (failure !== "body") {
        // No client fence: ended completes before the delayed live reaches Redis.
        await page.evaluate(() => window.e2eStartup.release());
        await expect.poll(() => page.evaluate(() => window.e2eStartup.lateStatus)).toBe(409);
      } else await expect.poll(() => page.evaluate(() => window.e2eStartup.lateStatus)).not.toBeNull();
      await page.clock.runFor(10_000);
      expect(await (await request.get(`/api/sessions/${session.id}`)).json()).toEqual(before);
      expect(await page.evaluate(() => window.e2eStartup.calls)).toEqual(["live", "ended"]);
      const events = await stored(request, session);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ seq: 1, type: "utterance", data: { text: sentence } });
      await expect(page.getByTestId("interview-room").locator("details")).toContainText(sentence);
      await expect(page.getByTestId("connection-lost")).toHaveCount(connectionLoss ? 1 : 0);
      expect(await page.evaluate(() => window.e2eRealtime.microphones.every((track) => track.readyState === "ended"))).toBe(true);
    });
  }
}

for (const target of ["events", "patch"] as const) {
  test(`startup deadline with captured turns supports identical ${target} save recovery without connection loss`, async ({ page, request }) => {
    await stallPersistence(page, target, true);
    await stallStartup(page, "deadline");
    const session = await start(page, false);
    await expect.poll(() => page.evaluate(() => window.e2eStartup.calls)).toEqual(["live"]);
    await emit(page, { type: "conversation.item.input_audio_transcription.completed", item_id: "startup-recovery", transcript: sentence });
    if (target === "events") {
      await expect.poll(() => page.evaluate(() => window.e2ePersistence.bodyStarted)).toBe(1);
      await page.clock.runFor(4_500);
      // Each request must reach the intended stuck body before its deadline runs.
      await expect.poll(() => page.evaluate(() => window.e2ePersistence.bodyStarted)).toBe(2);
      await page.clock.runFor(4_500);
    } else {
      await expect(page.getByTestId("save-state")).toHaveText("Transcript saved 1/1");
    }
    await page.clock.runFor(15_500); // Finite startup deadline, after settling the event attempts above.
    if (target === "patch") {
      await expect.poll(() => page.evaluate(() => window.e2ePersistence.bodyStarted)).toBe(1);
      await page.clock.runFor(4_500);
      await expect.poll(() => page.evaluate(() => window.e2ePersistence.bodyStarted)).toBe(2);
      await page.clock.runFor(4_500);
    }
    await expect(page.getByRole("button", { name: "Save again", exact: true })).toBeVisible();
    await expect(page.getByTestId("interview-room").getByRole("alert")).toContainText("Could not start: Request deadline exceeded");
    await expect(page.getByTestId("interview-room").getByRole("alert")).toContainText("Could not finish saving");
    await expect(page.getByRole("button", { name: "Start again", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("interview-room").locator("details ol")).toBeVisible();
    await expect(page.getByTestId("interview-room").locator("details")).toContainText(sentence);
    await expect(page.getByTestId("connection-lost")).toHaveCount(0);
    expect(await page.evaluate(() => window.e2eRealtime.microphones.every((track) => track.readyState === "ended"))).toBe(true);
    const calls = await page.evaluate(() => window.e2ePersistence.calls);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe(calls[1]);
    await page.clock.runFor(30_000);
    expect(await page.evaluate(() => window.e2ePersistence.calls.length)).toBe(2);
    await page.evaluate(() => { window.e2ePersistence.block = false; });
    await page.getByRole("button", { name: "Save again", exact: true }).click();
    await expectIncomplete(page, request, session);
    await expect(page.getByTestId("interview-room").getByRole("alert")).toContainText("Could not start: Request deadline exceeded");
    expect((await page.evaluate(() => window.e2ePersistence.calls))[2]).toBe(calls[0]);
    const events = await stored(request, session);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ seq: 1, type: "utterance", data: { text: sentence } });
    const before = await (await request.get(`/api/sessions/${session.id}`)).json();
    await page.evaluate(() => window.e2eStartup.release());
    await expect.poll(() => page.evaluate(() => window.e2eStartup.lateStatus)).toBe(409);
    expect(await (await request.get(`/api/sessions/${session.id}`)).json()).toEqual(before);
  });
}

test("transcription before commit settles only the matching ID without an empty manual commit", async ({ page, request }) => {
  const session = await start(page);
  await emit(page, { type: "input_audio_buffer.speech_started", item_id: "final-vad" });
  await end(page);
  await emit(page, { type: "conversation.item.input_audio_transcription.completed", item_id: "final-vad", transcript: sentence });
  await emit(page, { type: "input_audio_buffer.speech_stopped", item_id: "final-vad" });
  await emit(page, { type: "input_audio_buffer.committed", item_id: "final-vad" });
  await emit(page, { type: "input_audio_buffer.speech_started", item_id: "final-vad" });
  await emit(page, { type: "conversation.item.input_audio_transcription.completed", item_id: "final-vad", transcript: sentence });
  await emit(page, { type: "response.done", response: { id: "final-vad-response", status: "completed", output: [] } });
  await settle(page);
  await expect(page.getByText(complete, { exact: true })).toBeVisible();
  expect((await stored(request, session)).map((event) => event.type)).toEqual(["utterance", "session.ended"]);
  expect(await page.evaluate(() => window.e2eRealtime.sent.filter((event) => event.type === "input_audio_buffer.commit"))).toEqual([]);
});

test("transcription more than 300ms before an automatic response cannot finalize the call", async ({ page, request }) => {
  const session = await start(page);
  await emit(page, { type: "input_audio_buffer.speech_started", item_id: "early-transcript" });
  await end(page);
  await emit(page, { type: "input_audio_buffer.speech_stopped", item_id: "early-transcript" });
  await emit(page, { type: "input_audio_buffer.committed", item_id: "early-transcript" });
  await emit(page, { type: "conversation.item.input_audio_transcription.completed", item_id: "early-transcript", transcript: sentence });
  await page.clock.runFor(1_500);
  await expect(page.getByRole("status")).toContainText("Waiting for the persona response");
  expect(await page.evaluate(() => window.e2eRealtime.closed)).toBe(false);
  expect((await stored(request, session)).some((event) => event.type === "session.ended")).toBe(false);
  await expect(page.getByTestId("debrief")).toHaveCount(0);
  expect(await (await request.get(`/api/sessions/${session.id}`)).json()).toMatchObject({ status: "live" });
  await emit(page, { type: "response.created", response: { id: "late-vad-answer" } });
  await settle(page);
  expect(await page.evaluate(() => window.e2eRealtime.closed)).toBe(false);
  await emit(page, { type: "response.done", response: { id: "late-vad-answer", status: "completed", output: [
    { id: "late-answer-item", content: [{ type: "output_text", text: "The final automatic answer" }] },
  ] } });
  await settle(page);
  await expect(page.getByText(complete, { exact: true })).toBeVisible();
  const events = await stored(request, session);
  expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
  expect(events.map((event) => event.type)).toEqual(["utterance", "utterance", "session.ended"]);
  expect(events[1].data).toEqual({ speaker: "persona", text: "The final automatic answer" });
});

test("a missing automatic response after successful transcription reaches recovery, then closes with gaps", async ({ page, request }) => {
  const session = await start(page);
  await emit(page, { type: "input_audio_buffer.speech_started", item_id: "unanswered" });
  await emit(page, { type: "input_audio_buffer.committed", item_id: "unanswered" });
  await emit(page, { type: "conversation.item.input_audio_transcription.completed", item_id: "unanswered", transcript: sentence });
  await end(page);
  await page.clock.runFor(10_000);
  await expect(page.getByRole("status")).toContainText("Waiting for the persona response");
  await expect(page.getByRole("button", { name: "Continue waiting (10 seconds)", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.e2eRealtime.closed)).toBe(false);
  expect((await stored(request, session)).some((event) => event.type === "session.ended")).toBe(false);
  await page.getByRole("button", { name: "Close without it", exact: true }).click();
  await expectGaps(page, request, session);
  expect((await stored(request, session)).filter((event) => event.type === "utterance").map((event) => event.data)).toEqual([{ speaker: "interviewer", text: sentence }]);
});

for (const manualFirst of [false, true]) {
  test(`manual/VAD commit race preserves distinct transcripts (${manualFirst ? "manual" : "VAD"} acknowledgement first)`, async ({ page, request }) => {
    const session = await start(page);
    await emit(page, { type: "input_audio_buffer.speech_started", item_id: "racing-vad" });
    await end(page);
    await settle(page);
    expect(await page.evaluate(() => window.e2eRealtime.sent.filter((event) => event.type === "input_audio_buffer.commit"))).toHaveLength(1);
    for (const id of manualFirst ? ["racing-manual", "racing-vad"] : ["racing-vad", "racing-manual"]) {
      await emit(page, { type: "input_audio_buffer.committed", item_id: id });
    }
    const vadTranscript = { type: "conversation.item.input_audio_transcription.completed", item_id: "racing-vad", transcript: sentence };
    const manualTranscript = { type: "conversation.item.input_audio_transcription.completed", item_id: "racing-manual", transcript: "Separately committed final words" };
    await emit(page, vadTranscript);
    await emit(page, { type: "response.done", response: { id: "race-answer", status: "completed", output: [] } });
    await settle(page);
    expect(await page.evaluate(() => window.e2eRealtime.closed)).toBe(false);
    expect((await stored(request, session)).some((event) => event.type === "session.ended")).toBe(false);
    await emit(page, manualTranscript);
    await emit(page, vadTranscript);
    await emit(page, manualTranscript);
    await emit(page, { type: "input_audio_buffer.committed", item_id: "racing-vad" });
    await emit(page, { type: "input_audio_buffer.committed", item_id: "racing-manual" });
    await settle(page);
    await expect(page.getByText(complete, { exact: true })).toBeVisible();
    const events = await stored(request, session);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(events.map((event) => event.type)).toEqual(["utterance", "utterance", "session.ended"]);
    expect(events.slice(0, 2).map((event) => event.data)).toEqual([
      { speaker: "interviewer", text: sentence }, { speaker: "interviewer", text: "Separately committed final words" },
    ]);
  });
}

test("missing transcription exposes recovery by ten seconds and each explicit continuation is bounded", async ({ page, request }) => {
  const session = await start(page);
  await emit(page, { type: "input_audio_buffer.committed", item_id: "delayed" });
  await end(page);
  await page.clock.runFor(10_000);
  const again = page.getByRole("button", { name: "Continue waiting (10 seconds)", exact: true });
  await expect(again).toBeVisible();
  await expect(page.getByRole("status")).toContainText("10s elapsed");
  await expect(page.getByRole("status")).toContainText("Transcribing the last sentence");
  await page.clock.runFor(20_000);
  await expect(again).toBeVisible();
  expect(await page.evaluate(() => window.e2eRealtime.closed)).toBe(false);
  await again.click();
  await expect(again).toHaveCount(0);
  await page.clock.runFor(10_000);
  await expect(again).toBeVisible();
  await again.click();
  await emit(page, { type: "conversation.item.input_audio_transcription.completed", item_id: "delayed", transcript: sentence });
  await emit(page, { type: "response.done", response: { id: "delayed-response", status: "completed", output: [] } });
  await settle(page);
  await expect(page.getByText(complete, { exact: true })).toBeVisible();
  expect((await stored(request, session)).flatMap((event) => event.type === "utterance" ? [event.data.text] : [])).toEqual([sentence]);
});

test("closing missing speech is marked as gaps and stale callbacks cannot contaminate a new generation", async ({ page, request }) => {
  const session = await start(page);
  await emit(page, { type: "input_audio_buffer.speech_started", item_id: "missing" });
  await end(page);
  await page.clock.runFor(10_000);
  await page.getByRole("button", { name: "Close without it", exact: true }).click();
  await expectGaps(page, request, session);
  await page.getByRole("button", { name: "Start again", exact: true }).click();
  await expect(page.getByText("Live, speak now")).toBeVisible();
  await page.evaluate(() => window.e2eRealtime.stale[0]());
  await expect(page.getByTestId("transcript")).not.toContainText("Stale turn");
  await end(page);
  await settle(page);
  await expect(page.getByText(complete, { exact: true })).toBeVisible();
  expect((await stored(request, session)).map((event) => event.type)).toEqual(["session.ended"]);
});

for (const outcome of ["empty", "failed", "cancelled", "response-failed", "response-incomplete"] as const) {
  test(`terminal ${outcome} resolves pending work with an honest transcript gate`, async ({ page, request }) => {
    const session = await start(page);
    if (outcome === "empty" || outcome === "failed") {
      await emit(page, { type: "input_audio_buffer.speech_started", item_id: "final-input" });
      await end(page);
      await emit(page, { type: `conversation.item.input_audio_transcription.${outcome === "empty" ? "completed" : "failed"}`, item_id: "final-input", transcript: "" });
      await emit(page, { type: "input_audio_buffer.committed", item_id: "final-input" });
      await emit(page, { type: "response.done", response: { id: "final-input-response", status: "completed", output: [] } });
    } else {
      await page.getByLabel("Type a question").fill("A synthetic question");
      await page.getByRole("button", { name: "Ask", exact: true }).click();
      await end(page);
      await expect(page.getByRole("status")).toContainText("Waiting for the typed question");
      const status = outcome === "cancelled" ? "cancelled" : outcome === "response-failed" ? "failed" : "incomplete";
      await emit(page, { type: "response.done", response: { id: "terminal-response", status, output: [
        { id: "partial-answer", content: [{ type: "output_audio", transcript: "A captured partial answer" }] },
      ] } });
      await emit(page, { type: "response.created", response: { id: "terminal-response" } });
      await emit(page, { type: "response.done", response: { id: "terminal-response", status } });
      await emit(page, { type: "response.output_audio_transcript.done", item_id: "partial-answer", content_index: 0, transcript: "A captured partial answer" });
    }
    await settle(page);
    if (outcome === "failed" || outcome.startsWith("response-")) await expectGaps(page, request, session);
    else {
      await expect(page.getByText(complete, { exact: true })).toBeVisible();
      expect((await stored(request, session)).filter((event) => event.type === "session.ended")).toHaveLength(1);
      if (outcome === "cancelled") expect((await stored(request, session)).flatMap((event) => event.type === "utterance" ? [event.data.text] : [])).toEqual([
        "A synthetic question", "A captured partial answer", "(interrupted)",
      ]);
    }
  });
}

for (const waiting of [false, true]) {
  test(`connection loss ${waiting ? "at recovery" : "during drain"} still closes, marked as gaps`, async ({ page, request }) => {
    const session = await start(page);
    await emit(page, { type: "input_audio_buffer.committed", item_id: "lost-input" });
    await end(page);
    if (waiting) await page.clock.runFor(10_000);
    await page.evaluate(() => window.e2eRealtime.lose());
    await settle(page);
    await expectGaps(page, request, session);
    await expect(page.getByTestId("connection-lost")).toContainText("This transcript has gaps");
    expect(await page.evaluate(() => window.e2eRealtime.closed)).toBe(true);
  });
}

for (const target of ["events", "patch"] as const) {
  for (const body of [false, true]) {
    test(`hung ${target} ${body ? "response body after acceptance" : "fetch"} has a finite budget and idempotent recovery`, async ({ page, request }) => {
      await stallPersistence(page, target, body);
      const session = await start(page);
      await emit(page, { type: "conversation.item.input_audio_transcription.completed", item_id: "saved-input", transcript: sentence });
      if (target === "events") await expect.poll(() => page.evaluate(() => window.e2ePersistence.calls.length)).toBe(1);
      if (target === "events" && body) await expect.poll(() => page.evaluate(() => window.e2ePersistence.bodyStarted)).toBe(1);
      if (target === "events") await emit(page, { type: "conversation.item.input_audio_transcription.completed", item_id: "additional-input", transcript: "Another captured turn" });
      await end(page);
      await settle(page);
      if (target === "patch") await expect.poll(() => page.evaluate(() => window.e2ePersistence.calls.length)).toBe(1);
      if (target === "patch" && body) await expect.poll(() => page.evaluate(() => window.e2ePersistence.bodyStarted)).toBe(1);
      await expect(page.getByRole("status")).toContainText(target === "events" ? "Saving captured text" : "Closing the saved session");
      await page.clock.runFor(4_500);
      await expect.poll(() => page.evaluate(() => window.e2ePersistence.calls.length)).toBe(2);
      if (body) await expect.poll(() => page.evaluate(() => window.e2ePersistence.bodyStarted)).toBe(2);
      await page.clock.runFor(4_500);
      await expect(page.getByRole("button", { name: "Save again", exact: true })).toBeVisible();
      await expect(page.getByTestId("interview-room").getByRole("alert")).toContainText("Could not finish saving");
      await expect(page.getByTestId("interview-room").locator("details")).toContainText(sentence);
      await expect(page.getByTestId("interview-room").locator("details ol")).toBeVisible();
      await expect(page.getByTestId("debrief")).toHaveCount(0);
      const calls = await page.evaluate(() => window.e2ePersistence.calls);
      expect(calls).toHaveLength(2);
      expect(calls[1]).toBe(calls[0]);
      await page.clock.runFor(30_000);
      expect(await page.evaluate(() => window.e2ePersistence.calls.length)).toBe(2);
      await page.evaluate(() => { window.e2ePersistence.block = false; });
      await page.getByRole("button", { name: "Save again", exact: true }).click();
      await expect(page.getByText(complete, { exact: true })).toBeVisible();
      const events = await stored(request, session);
      expect(events.map((event) => event.type)).toEqual(target === "events" ? ["utterance", "utterance", "session.ended"] : ["utterance", "session.ended"]);
      expect(events.map((event) => event.seq)).toEqual(target === "events" ? [1, 2, 3] : [1, 2]);
      if (target === "events") expect(events[1]).toMatchObject({ type: "utterance", data: { text: "Another captured turn" } });
      expect(events[0]).toMatchObject({ type: "utterance", data: { text: sentence } });
      expect((await page.evaluate(() => window.e2ePersistence.calls))[2]).toBe(calls[0]);
    });
  }
}

test("a rejected overlapping typed response releases only its own reservation", async ({ page, request }) => {
  const session = await start(page);
  await page.getByLabel("Type a question").fill("First question");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await emit(page, { type: "response.created", response: { id: "running-answer" } });
  await page.getByLabel("Type a question").fill("Overlapping question");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await emit(page, { type: "error", error: { event_id: "a:2", message: "A response is already running" } });
  await end(page);
  await emit(page, { type: "response.done", response: { id: "running-answer", status: "completed", output: [] } });
  await settle(page);
  await expect(page.getByText(complete, { exact: true })).toBeVisible();
  expect((await stored(request, session)).filter((event) => event.type === "session.ended")).toHaveLength(1);
});

test("an empty-buffer commit error never silently clears unresolved speech", async ({ page, request }) => {
  const session = await start(page);
  await emit(page, { type: "input_audio_buffer.speech_started", item_id: "unresolved-speech" });
  await end(page);
  await settle(page);
  const eventId = await page.evaluate(() => window.e2eRealtime.sent.find((event) => event.type === "input_audio_buffer.commit")?.event_id);
  expect(eventId).toBeDefined();
  await emit(page, { type: "error", error: { event_id: eventId, message: "The input audio buffer is empty" } });
  await page.clock.runFor(10_000);
  await expect(page.getByRole("status")).toContainText("Transcribing the last sentence");
  await page.getByRole("button", { name: "Close without it", exact: true }).click();
  await expectGaps(page, request, session);
});

for (const failure of ["microphone", "token", "sdp"] as const) {
  test(`startup ${failure} failure retains its actionable cause after incomplete close`, async ({ page, request }) => {
    if (failure === "token") {
      await page.route("**/api/sessions/*/token", (route) => route.fulfill({ status: 503, json: { detail: "Synthetic token service unavailable" } }));
    }
    if (failure === "sdp") {
      await page.route("https://api.openai.com/v1/realtime/calls", (route) => route.fulfill({ status: 403, body: "synthetic refusal" }));
    }
    const session = await start(page, false, async () => {
      if (failure !== "microphone") return;
      await page.evaluate(() => {
        const devices = navigator.mediaDevices;
        const denied = { calls: 0 };
        window.e2eDeniedMicrophone = denied;
        // Pin the override on navigator, even when mediaDevices is a getter.
        Object.defineProperty(navigator, "mediaDevices", {
          configurable: true,
          value: Object.defineProperty(Object.create(devices) as MediaDevices, "getUserMedia", {
            configurable: true,
            value: async (constraints: MediaStreamConstraints) => {
              if (!constraints.audio) return devices.getUserMedia(constraints);
              denied.calls += 1;
              throw new DOMException("synthetic denial", "NotAllowedError");
            },
          }),
        });
      });
    });
    await expectIncomplete(page, request, session);
    if (failure === "microphone") {
      expect(await page.evaluate(() => window.e2eDeniedMicrophone.calls)).toBe(1);
      expect(await page.evaluate(() => window.e2eRealtime.microphones.length)).toBe(0);
    }
    const cause = failure === "microphone" ? "Microphone access was denied. Allow microphone access in your browser and start again."
      : failure === "token" ? "Could not start (503): Synthetic token service unavailable"
        : "Could not start: OpenAI refused the call (403)";
    await expect(page.getByTestId("interview-room").getByRole("alert")).toHaveText(cause);
    await expect(page.getByText(startupIncomplete, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start again", exact: true })).toBeVisible();
    expect(await stored(request, session)).toEqual([]);
    expect(await page.evaluate(() => window.e2eRealtime.microphones.every((track) => track.readyState === "ended"))).toBe(true);
    if (failure !== "token") expect(await page.evaluate(() => window.e2eRealtime.closed)).toBe(true);
    await page.clock.runFor(30_000);
    await expect(page.getByTestId("interview-room").getByRole("alert")).toHaveText(cause);
  });
}

test("a new live turn retries the identical exhausted batch and saves all newer turns before End", async ({ page, request }) => {
  await stallPersistence(page, "events", false);
  const session = await start(page);
  await emit(page, { type: "conversation.item.input_audio_transcription.completed", item_id: "first", transcript: sentence });
  await expect.poll(() => page.evaluate(() => window.e2ePersistence.calls.length)).toBe(1);
  // A newer turn while the request is active cannot reset its two-attempt budget.
  await emit(page, { type: "conversation.item.input_audio_transcription.completed", item_id: "second", transcript: "Captured during the failed request" });
  await page.clock.runFor(4_500);
  await expect.poll(() => page.evaluate(() => window.e2ePersistence.calls.length)).toBe(2);
  await page.clock.runFor(4_500);
  await expect(page.getByTestId("save-state")).toContainText("Transcript saved 0/2");
  await page.clock.runFor(30_000);
  expect(await page.evaluate(() => window.e2ePersistence.calls.length)).toBe(2);
  await page.evaluate(() => { window.e2ePersistence.block = false; });
  await emit(page, { type: "conversation.item.input_audio_transcription.completed", item_id: "third", transcript: "New live turn retries the batch" });
  await expect(page.getByTestId("save-state")).toHaveText("Transcript saved 3/3");
  await expect(page.getByText("Live, speak now")).toBeVisible();
  const calls = await page.evaluate(() => window.e2ePersistence.calls);
  expect(calls).toHaveLength(4);
  expect(calls[1]).toBe(calls[0]);
  expect(calls[2]).toBe(calls[0]);
  const frozen = JSON.parse(calls[0]) as SessionEvent[];
  expect(frozen.map((event) => event.seq)).toEqual([1]);
  expect(JSON.parse(calls[3])).toMatchObject([{ seq: 2 }, { seq: 3 }]);
  const events = await stored(request, session);
  expect(events).toHaveLength(3);
  expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
  expect(events[0]).toEqual(frozen[0]);
  expect(events.map((event) => event.type === "utterance" ? event.data.text : null)).toEqual([sentence, "Captured during the failed request", "New live turn retries the batch"]);
  await end(page);
  await settle(page);
  await expect(page.getByText(complete, { exact: true })).toBeVisible();
  expect((await stored(request, session)).map((event) => event.type)).toEqual(["utterance", "utterance", "utterance", "session.ended"]);
});

test("startup live PATCH succeeds after five virtual seconds without an early incomplete close", async ({ page, request }) => {
  await stallStartup(page, "deadline");
  const session = await start(page, false);
  await expect.poll(() => page.evaluate(() => window.e2eStartup.calls)).toEqual(["live"]);
  await page.clock.runFor(5_000);
  await expect(page.getByText("Connecting…", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.e2eStartup.calls)).toEqual(["live"]);
  await page.evaluate(() => window.e2eStartup.release());
  await expect(page.getByText("Live, speak now")).toBeVisible();
  await expect(page.getByTestId("interview-room").getByRole("alert")).toHaveCount(0);
  await end(page);
  await settle(page);
  await expect(page.getByText(complete, { exact: true })).toBeVisible();
  expect((await stored(request, session)).map((event) => event.type)).toEqual(["session.ended"]);
});


test("connection loss before startup live confirmation stays incomplete even without pending turns", async ({ page, request }) => {
  await stallStartup(page, "deadline");
  const session = await start(page, false);
  await expect.poll(() => page.evaluate(() => window.e2eStartup.calls)).toEqual(["live"]);
  await page.evaluate(() => window.e2eRealtime.lose());
  await expectIncomplete(page, request, session);
  expect(await stored(request, session)).toEqual([]);
  await page.evaluate(() => window.e2eStartup.release());
  await expect.poll(() => page.evaluate(() => window.e2eStartup.lateStatus)).toBe(409);
  await expect(page.getByTestId("debrief")).toHaveCount(0);
});

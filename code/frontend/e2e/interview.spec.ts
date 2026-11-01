import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import exampleReport from "../../shared/examples/insight-report.json";
import exampleEvents from "../../shared/examples/session-events.json";
import type { Persona, Session, SessionEvent, InsightReport } from "../src/lib/contracts";
import { QUARTIER_BOERSE_GUIDE } from "../src/lib/sample";
import { emit, installRealtime } from "./realtime";

const guideLabel = "Interview questions, one per line (the debrief answers these)";

const questions = exampleReport.questions.map((question) => question.question);
const answers = exampleReport.questions.map((question) => question.insights[0].quote);
const typedQuestion = exampleEvents[1].data.text!;
const spokenQuestion = exampleEvents[6].data.text!;

async function createPersona(page: Page) {
  await page.goto("/studio");
  await expect(page.getByLabel("Source 2 text")).toContainText("SYNTHETIC INTERVIEW");
  await page.getByRole("button", { name: "Create persona", exact: true }).click();
  await expect(page.getByTestId("persona-score").getByRole("heading", { name: /Sandra/ })).toBeVisible();
}

async function startInterview(page: Page): Promise<Session> {
  await createPersona(page);
  await page.getByRole("button", { name: "Interview", exact: true }).click();
  await page.getByLabel(guideLabel).fill(questions.join("\n"));
  const created = page.waitForResponse((response) => response.url().endsWith("/api/sessions") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Start video interview" }).click();
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

// Two personas from the same sources: same name and facts, told apart only by id.
async function twoPersonas(page: Page): Promise<{ first: Persona; second: Persona }> {
  const built = () => page.waitForResponse((response) => response.url().endsWith("/api/personas") && response.request().method() === "POST");
  const firstBuilt = built();
  await createPersona(page);
  const first: Persona = await (await firstBuilt).json();
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  const secondBuilt = built();
  await page.getByRole("button", { name: "Rebuild persona" }).click();
  const second: Persona = await (await secondBuilt).json();
  await expect(page.getByTestId("persona-score").getByRole("heading", { name: /Sandra/ })).toBeVisible();
  await page.getByRole("button", { name: "Persona", exact: true }).click();
  return { first, second };
}

// The rows look alike, so find the row by its place in the list, then prove it by the request it sends.
async function pickFromLibrary(page: Page, request: APIRequestContext, id: string) {
  const list: { id: string }[] = await (await request.get("/api/personas")).json();
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  const rows = page.getByRole("region", { name: "Recent personas" }).getByRole("button", { name: /^Sandra/ });
  await expect(rows).toHaveCount(list.length);
  const opened = page.waitForResponse((response) => response.url().endsWith(`/api/personas/${id}`) && response.request().method() === "GET");
  await rows.nth(list.findIndex((persona) => persona.id === id)).click();
  await opened;
  await expect(page.getByTestId("persona-score").getByRole("heading", { name: /Sandra/ })).toBeVisible();
  await page.getByRole("button", { name: "Persona", exact: true }).click();
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

test("sample sources to saved interview and exact-quote debrief", async ({ page, request, context, browser }) => {
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
  await expect(page.getByRole("status")).toContainText("Waiting for the persona response");
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
  await expect(page.getByTestId("sample-label")).toHaveCount(0);
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

  // The shared link: a browser with no local state or passcode sees the same debrief, and nothing is generated.
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await debrief.getByRole("button", { name: "Copy link", exact: true }).click();
  await expect(debrief.getByRole("status")).toContainText("Link copied");
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toBe(`http://127.0.0.1:3165/report/${session.id}`);

  const fresh = await browser.newContext();
  const apiCalls: string[] = [];
  const passcodes: string[] = [];
  await fresh.route("**/*", async (route) => {
    const sent = route.request();
    const url = new URL(sent.url());
    if (url.origin !== "http://127.0.0.1:3165") {
      unexpected.push(`${url.origin}${url.pathname}`);
      return route.abort("blockedbyclient");
    }
    if (url.pathname.startsWith("/api/")) apiCalls.push(`${sent.method()} ${url.pathname}`);
    const passcode = sent.headers()["x-demo-passcode"];
    if (passcode) passcodes.push(passcode);
    await route.continue();
  });
  const reader = await fresh.newPage();
  await reader.goto(link);
  const shared = reader.getByTestId("debrief");
  await expect(shared).toBeVisible();
  const content = (root: Locator) => Promise.all([root.locator("> p").first().innerText(), root.locator("ol").innerText()]);
  expect(await content(shared)).toEqual(await content(debrief));
  await expect(reader.getByText("Simulated interview with an AI persona", { exact: false })).toBeVisible();
  await expect(reader.getByRole("button", { name: "Copy link", exact: true })).toHaveCount(0);
  await expect(reader.getByRole("button", { name: "Create debrief", exact: true })).toHaveCount(0);
  expect(apiCalls.sort()).toEqual([
    `GET /api/personas/${session.personaId}`,
    `GET /api/sessions/${session.id}`,
    `GET /api/sessions/${session.id}/insights`,
  ]);
  expect(passcodes).toEqual([]);
  await fresh.close();
});

test("backend unavailable is announced and the same sources can be retried", async ({ page }) => {
  await page.goto("/studio");
  const source = await page.getByLabel("Source 2 text").inputValue();
  // Browser-to-backend connection outage, then recovery to the real API and store.
  await page.route("**/api/personas", (route) => route.abort("connectionrefused"));
  await page.getByRole("button", { name: "Create persona", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("Couldn't connect. Check your connection and try again.");
  await expect(page.getByTestId("persona-card")).toHaveCount(0);
  await expect(page.getByLabel("Source 2 text")).toHaveValue(source);
  await expect(page.getByRole("button", { name: "Create persona", exact: true })).toBeEnabled();
  await page.unroute("**/api/personas");
  await page.getByRole("button", { name: "Create persona", exact: true }).click();
  await expect(page.getByTestId("persona-score").getByRole("heading", { name: /Sandra/ })).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
});

test("the card shows the readiness score and explains when there is none", async ({ page }) => {
  await createPersona(page);
  await page.getByRole("button", { name: "Persona", exact: true }).click();
  const readiness = page.getByTestId("readiness");
  // The fake always cites F1, but the example's quotes aren't in the sample sources, so the real
  // evidence check has already made it a guess: citing it can't earn any grounding.
  await expect(readiness).toContainText("Readiness 0.00: consistency 1.00 · grounding 0.00");
  await page.getByRole("button", { name: /^Remove: / }).first().click();
  await expect(readiness).toHaveText("No readiness score: this persona was edited after creation and is not re-checked.");

  // A failed check still gives a usable persona.
  // Only the rebuild: the persona list refreshes right after and may outlive the test.
  await page.route("**/api/personas", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), readiness: null } });
  });
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  await page.getByRole("button", { name: "Rebuild persona", exact: true }).click();
  await expect(readiness).toHaveText("No readiness score: the check did not finish.");
});

test("rate limit is announced with the backend's wait time and keeps the sources", async ({ page }) => {
  await page.goto("/studio");
  const source = await page.getByLabel("Source 2 text").inputValue();
  const detail = "Too many requests from this network. Try again in 12 min.";
  await page.route("**/api/personas", (route) => route.fulfill({ status: 429, headers: { "Retry-After": "720" }, json: { detail } }));
  await page.getByRole("button", { name: "Create persona", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(detail);
  await expect(page.getByTestId("persona-card")).toHaveCount(0);
  await expect(page.getByLabel("Source 2 text")).toHaveValue(source);
});

test("a failed turn still reaches a debrief that says the transcript may have gaps, and only quotes saved turns", async ({ page, request }) => {
  const session = await startInterview(page);
  expect(session.product?.name).toBeTruthy();
  await page.getByLabel("Type a question").fill(typedQuestion);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await answer(page, "answer-1", answers[0]);
  await emit(page, { type: "input_audio_buffer.committed", item_id: "lost-1" });
  await emit(page, { type: "conversation.item.input_audio_transcription.failed", item_id: "lost-1" });
  await emit(page, { type: "response.done", response: { id: "lost-response", status: "completed", output: [] } });
  await page.getByRole("button", { name: "End interview", exact: true }).click();
  await expect(page.getByText("This transcript may have gaps", { exact: false }).first()).toBeVisible();
  const details = page.getByTestId("interview-room").locator("details").filter({ hasText: "Transcript (" });
  await expect(details.locator("summary")).toContainText("may have gaps");
  const debrief = page.getByTestId("debrief");
  await expect(debrief.getByTestId("transcript-gaps")).toContainText("This transcript may have gaps");
  await expect(debrief.getByTestId("debrief-product")).toHaveText(`Product tested: ${session.product?.name}`);
  // The fixed fake debrief quotes both fixture answers; the persona only said the first.
  await expect(debrief.locator("blockquote")).toHaveCount(1);
  await expect(debrief.locator("blockquote")).toContainText(answers[0]);
  await expect(debrief).not.toContainText(answers[1]);
  const events: SessionEvent[] = await (await request.get(`/api/sessions/${session.id}/events`)).json();
  expect(events.map((event) => event.type)).toEqual(["utterance", "utterance", "session.ended"]);
  expect(events[2].data).toMatchObject({ transcriptGaps: true });
  // The shared link can't look complete either.
  const report: InsightReport = await (await request.get(`/api/sessions/${session.id}/insights`)).json();
  expect(report.transcriptGaps).toBe(true);
  await page.goto(`/report/${session.id}`);
  await expect(page.getByTestId("transcript-gaps")).toContainText("This transcript may have gaps");
  await expect(page.getByTestId("debrief-product")).toHaveText(`Product tested: ${session.product?.name}`);
});

test("a persona created earlier can be picked after a reload and interviewed", async ({ page }) => {
  const created = page.waitForResponse((response) => response.url().endsWith("/api/personas") && response.request().method() === "POST");
  await createPersona(page);
  const persona = await (await created).json();
  await page.reload();
  const card = page.getByTestId("persona-card");
  await expect(card).toHaveCount(0);
  let rebuilt = false;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/personas")) rebuilt = true;
  });
  // Newest first, and other tests share this store.
  await page.getByRole("region", { name: "Recent personas" }).getByRole("button", { name: /^Sandra/ }).first().click();
  await page.getByRole("button", { name: "Persona", exact: true }).click();
  await expect(card.getByRole("heading", { name: "Sandra" })).toBeVisible();
  await expect(card).not.toContainText("Ready in");
  await expect(page.getByRole("region", { name: "Recent personas" })).toBeHidden();
  await page.getByRole("button", { name: "Interview", exact: true }).click();
  await expect(page.getByLabel(guideLabel)).toHaveValue("");
  await page.getByLabel(guideLabel).fill(questions.join("\n"));

  const started = page.waitForResponse((response) => response.url().endsWith("/api/sessions") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Start video interview" }).click();
  const session: Session = await (await started).json();
  expect(session.personaId).toBe(persona.id);
  const dialog = page.getByRole("dialog", { name: "Interview with Sandra" });
  await expect(dialog.getByText("Live, speak now")).toBeVisible();
  expect(rebuilt).toBe(false);
});

test("a persona edited from the library keeps its place and comes back edited after a reload", async ({ page, request }) => {
  const created = page.waitForResponse((response) => response.url().endsWith("/api/personas") && response.request().method() === "POST");
  await createPersona(page);
  const persona = await (await created).json();
  const before = await (await request.get("/api/personas")).json();
  expect(before[0].id).toBe(persona.id);

  await page.reload();
  const library = page.getByRole("region", { name: "Recent personas" });
  const card = page.getByTestId("persona-card");
  await library.getByRole("button", { name: /^Sandra/ }).first().click();
  await page.getByRole("button", { name: "Persona", exact: true }).click();
  const original = persona.jobs[0].text;
  await card.getByRole("button", { name: `Edit: ${original}`, exact: true }).click();
  const saved = page.waitForResponse((response) => response.url().endsWith(`/api/personas/${persona.id}`) && response.request().method() === "PATCH");
  await card.getByLabel("Fact text").fill("Edited by hand");
  await card.getByLabel("Fact text").press("Enter");
  expect((await saved).status()).toBe(200);
  await expect(card.getByText("Edited by hand")).toBeVisible();
  await expect(card).not.toContainText("Ready in");
  // An edit drops the readiness score (it is not re-checked) but keeps the persona's place.
  expect(await (await request.get("/api/personas")).json()).toEqual([{ ...before[0], readiness: null }, ...before.slice(1)]);

  await page.reload();
  await expect(card).toHaveCount(0);
  await library.getByRole("button", { name: /^Sandra/ }).first().click();
  await page.getByRole("button", { name: "Persona", exact: true }).click();
  await expect(card.getByText("Edited by hand")).toBeVisible();
  await expect(card.getByText(original, { exact: true })).toHaveCount(0);
});

test("a save that finishes after a library pick cannot bring the previous persona back", async ({ page, request }) => {
  const { first, second } = await twoPersonas(page);
  const card = page.getByTestId("persona-card");
  let release = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/personas/${second.id}`, async (route) => {
    await released;
    await route.fallback();
  });
  await card.getByRole("button", { name: `Edit: ${second.jobs[0].text}`, exact: true }).click();
  await card.getByLabel("Fact text").fill("Meant for the second persona");
  await card.getByLabel("Fact text").press("Enter");

  await pickFromLibrary(page, request, first.id);
  const saved = page.waitForResponse((response) => response.url().endsWith(`/api/personas/${second.id}`) && response.request().method() === "PATCH");
  release();
  expect((await saved).status()).toBe(200);

  await expect(card.getByText("Meant for the second persona")).toHaveCount(0);
  await page.getByRole("button", { name: "Interview", exact: true }).click();
  await page.getByLabel(guideLabel).fill(questions.join("\n"));
  const started = page.waitForResponse((response) => response.url().endsWith("/api/sessions") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Start video interview" }).click();
  expect(((await (await started).json()) as Session).personaId).toBe(first.id);
});

test("an open fact edit and a failed save stay behind when another persona is picked", async ({ page, request }) => {
  const { first, second } = await twoPersonas(page);
  const card = page.getByTestId("persona-card");
  await page.route(`**/api/personas/${second.id}`, (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ status: 503, contentType: "application/json", body: '{"detail":"store down"}' })
      : route.fallback(),
  );
  await card.getByRole("button", { name: `Remove: ${second.jobs[0].text}`, exact: true }).click();
  await expect(card.getByRole("alert")).toContainText("Could not save");
  await card.getByRole("button", { name: `Edit: ${second.jobs[0].text}`, exact: true }).click();
  await card.getByLabel("Fact text").fill("Meant for the second persona");

  await pickFromLibrary(page, request, first.id);
  await expect(card.getByLabel("Fact text")).toHaveCount(0);
  await expect(card.getByRole("alert")).toHaveCount(0);
  await expect(card.getByRole("button", { name: `Edit: ${first.jobs[0].text}`, exact: true })).toBeVisible();
});

test("a call can't start while a library pick is loading, so the pick can't cut it off", async ({ page, request }) => {
  const { first } = await twoPersonas(page);
  // The interview tab is hidden during the pick, so find its button by text, not by role.
  const start = page.locator("button", { hasText: "Start video interview" }).last();
  let release = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/personas/${first.id}`, async (route) => {
    await released;
    await route.fallback();
  });

  const picking = pickFromLibrary(page, request, first.id);
  await expect(start).toBeDisabled();
  release();
  await picking;
  await page.getByRole("button", { name: "Interview", exact: true }).click();
  await page.getByLabel(guideLabel).fill(questions.join("\n"));

  const started = page.waitForResponse((response) => response.url().endsWith("/api/sessions") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Start video interview" }).click();
  expect(((await (await started).json()) as Session).personaId).toBe(first.id);
});

test("the persona list sends the passcode and stays away when refused", async ({ page }) => {
  await page.route("**/api/personas", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 401, contentType: "application/json", body: '{"detail":"passcode missing or wrong"}' })
      : route.fallback(),
  );
  const listed = page.waitForRequest((request) => request.method() === "GET" && request.url().endsWith("/api/personas"));
  await page.goto("/?code=team-pass");
  expect((await listed).headers()["x-demo-passcode"]).toBe("team-pass");
  await page.getByRole("button", { name: "Create persona", exact: true }).click();
  await expect(page.getByTestId("persona-score").getByRole("heading", { name: /Sandra/ })).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  await expect(page.getByRole("region", { name: "Recent personas" })).toHaveCount(0);
});

test("the sample sprint questions stay with the example, and a saved persona comes back without them", async ({ page }) => {
  await createPersona(page);
  await page.getByRole("button", { name: "Interview", exact: true }).click();
  const guide = page.getByLabel(guideLabel);
  const start = page.getByRole("button", { name: "Start video interview" });
  const sample = page.getByRole("button", { name: "Use sample interview" });
  const room = page.getByTestId("interview-room");
  await expect(guide).toHaveValue(QUARTIER_BOERSE_GUIDE.join("\n"));
  await expect(room.getByTestId("guide-check")).toBeVisible();
  await expect(start).toBeEnabled();
  await expect(sample).toBeEnabled();
  await expect(room).toContainText("not a real person");
  await expect(room).toContainText("an image is sent to OpenAI every 15 seconds");

  await page.reload();
  await page.getByRole("region", { name: "Recent personas" }).getByRole("button", { name: /^Sandra/ }).first().click();
  await expect(page.getByTestId("persona-score").getByRole("heading", { name: /Sandra/ })).toBeVisible();
  await page.getByRole("button", { name: "Interview", exact: true }).click();
  await expect(guide).toHaveValue("");
  await expect(room.getByTestId("product-under-test")).toContainText("No product described");
  await expect(room.getByTestId("guide-check")).toBeVisible();
  await expect(room.getByRole("button", { name: "Check questions" })).toBeDisabled();
  await expect(start).toBeDisabled();
  await expect(sample).toBeDisabled();
  await expect(room).toContainText("not a real person");

  await guide.fill("What did you try last week?");
  await expect(room.getByRole("button", { name: "Check questions" })).toBeEnabled();
  await expect(start).toBeEnabled();
  await expect(sample).toBeEnabled();
});

test("sources that are not the sample sprint start the interview with an empty guide", async ({ page }) => {
  await page.goto("/studio");
  await page.getByLabel("Source 1 text").fill("A neighbour said the bins are always full.");
  await page.getByLabel("Source 2 text").fill("They want to see the money arrive.");
  await page.getByRole("button", { name: "Create persona", exact: true }).click();
  await expect(page.getByTestId("persona-score").getByRole("heading", { name: /Sandra/ })).toBeVisible();

  await page.getByRole("button", { name: "Interview", exact: true }).click();
  const room = page.getByTestId("interview-room");
  const guide = page.getByLabel(guideLabel);
  await expect(guide).toHaveValue("");
  await expect(room.getByTestId("product-under-test")).toContainText("No product described");
  await expect(room.getByTestId("guide-check")).toBeVisible();
  await expect(room.getByRole("button", { name: "Check questions" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Start video interview" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Use sample interview" })).toBeDisabled();
  await expect(room).toContainText("not a real person");
  await expect(room).toContainText("an image is sent to OpenAI every 15 seconds");
});

test("mute silences the microphone without ending the call; typing still works", async ({ page }) => {
  await startInterview(page);
  expect(await page.evaluate(() => window.e2eRealtime.audioConstraints)).toEqual([
    { echoCancellation: true, noiseSuppression: true },
  ]);
  const enabled = () => page.evaluate(() => window.e2eRealtime.microphones.map((track) => track.enabled));
  await page.getByRole("button", { name: "Mute mic", exact: true }).click();
  expect(await enabled()).toEqual([false]);
  await expect(page.getByRole("button", { name: "Unmute mic", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Type a question").fill(typedQuestion);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await answer(page, "answer-1", answers[0]);
  await page.getByRole("button", { name: "Unmute mic", exact: true }).click();
  expect(await enabled()).toEqual([true]);
  expect(await page.evaluate(() => window.e2eRealtime.closed)).toBe(false);
});

test("the script panel lists the questions, ticks them by hand and keeps the transcript one tab away", async ({ page }) => {
  await startInterview(page);
  const dialog = page.getByRole("dialog", { name: "Interview with Sandra" });
  await expect(dialog.getByText("AI test user, not a real person")).toBeVisible();
  const script = dialog.getByTestId("interview-script");
  await expect(script).toBeVisible();
  await expect(script).toContainText(`0 of ${questions.length}`);
  await script.getByRole("checkbox", { name: questions[0] }).check();
  await expect(script).toContainText(`1 of ${questions.length}`);

  await dialog.getByRole("button", { name: "transcript", exact: true }).click();
  await expect(dialog.getByTestId("transcript")).toBeVisible();
  await expect(script).toBeHidden();
  await dialog.getByRole("button", { name: "script", exact: true }).click();
  await expect(script).toContainText(`1 of ${questions.length}`);
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

test("a persona deleted from the library is gone after a reload; Cancel keeps it", async ({ page, request }) => {
  const created = page.waitForResponse((response) => response.url().endsWith("/api/personas") && response.request().method() === "POST");
  await createPersona(page);
  const persona = await (await created).json();

  await page.reload();
  const library = page.getByRole("region", { name: "Recent personas" });
  const remove = library.getByRole("button", { name: /^Delete Sandra/ }).first();

  page.once("dialog", (dialog) => dialog.dismiss());
  await remove.click();
  expect((await (await request.get("/api/personas")).json()).map((p: { id: string }) => p.id)).toContain(persona.id);

  const deleted = page.waitForResponse((response) => response.url().endsWith(`/api/personas/${persona.id}`) && response.request().method() === "DELETE");
  page.once("dialog", (dialog) => dialog.accept());
  await remove.click();
  expect((await deleted).status()).toBe(204);

  expect((await (await request.get("/api/personas")).json()).map((p: { id: string }) => p.id)).not.toContain(persona.id);
  expect((await request.get(`/api/personas/${persona.id}`)).status()).toBe(404);
  await page.reload();
  await expect(library.getByRole("button", { name: /^Delete Sandra/ })).toHaveCount(
    (await (await request.get("/api/personas")).json()).length,
  );
});

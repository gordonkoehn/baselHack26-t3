import { expect, test, type Page } from "@playwright/test";
import exampleReport from "../../shared/examples/insight-report.json";
import examplePersona from "../../shared/examples/persona.json";
import { readFile } from "node:fs/promises";
import type { InsightReport, Session, SessionEvent } from "../src/lib/contracts";
import { formatReportMarkdown } from "../src/lib/reportMarkdown";
import { installRealtime } from "./realtime";

const questions = exampleReport.questions.map((question) => question.question);
const sampleLabel = "Sample interview: a scripted demo transcript with no live call.";

declare global {
  interface Window {
    e2eSimliStart: () => void;
    e2eSimliSocketFailed: () => void;
  }
}

let unexpected: string[];
let requests: string[];
let simliSockets: { closed: boolean }[];

test.beforeEach(async ({ page, context }) => {
  unexpected = [];
  requests = [];
  simliSockets = [];
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:3165") {
      if (url.pathname.startsWith("/api/")) requests.push(`${route.request().method()} ${url.pathname}`);
      if (url.pathname.endsWith("/avatar-token")) {
        // The e2e backend has no Simli key; the rest of the avatar runs for real.
        return route.fulfill({ json: { provider: "simli", token: "e2e-not-a-credential", url: null, expiresAt: "2026-10-31T23:59:00Z" } });
      }
      return route.continue();
    }
    if (url.href === "https://api.openai.com/v1/realtime/calls") {
      requests.push("POST realtime/calls");
      return route.fulfill({ status: 200, contentType: "application/sdp", body: "e2e-answer" });
    }
    unexpected.push(`${url.origin}${url.pathname}`);
    await route.abort("blockedbyclient");
  });
  await context.routeWebSocket("**/*", (socket) => {
    if (new URL(socket.url()).origin !== "wss://api.simli.ai") {
      unexpected.push("unexpected WebSocket");
      return socket.close();
    }
    const state = { closed: false };
    simliSockets.push(state);
    socket.onClose(() => { state.closed = true; });
    socket.onMessage(() => {});
  });
  await installRealtime(page);
  // A real first frame needs a LiveKit video track and a mocked socket can't fail, so fire the
  // SDK's own "start" and "startup_error" handlers instead.
  await page.addInitScript(() => {
    const set = Map.prototype.set;
    let handlers: Set<() => void> | undefined;
    let failures: Set<(reason: string) => void> | undefined;
    Map.prototype.set = function (key, value) {
      if (key === "start" && value instanceof Set) handlers = value;
      // The first one is the transport's, with the SDK's retry on it; the app's own listener gets a later Set.
      if (key === "startup_error" && value instanceof Set) failures ??= value;
      return set.call(this, key, value);
    };
    window.e2eSimliStart = () => handlers?.forEach((handler) => handler());
    window.e2eSimliSocketFailed = () => failures?.forEach((handler) => handler("Websocket Failed"));
  });
});

test.afterEach(() => { expect(unexpected).toEqual([]); });

async function createPersona(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Create persona", exact: true }).click();
  await expect(page.getByTestId("persona-score").getByRole("heading", { name: /Sandra/ })).toBeVisible();
  await page.getByRole("button", { name: "Interview", exact: true }).click();
  await page.getByLabel("Interview questions, one per line (the debrief answers these)").fill(questions.join("\n"));
}

async function startCall(page: Page) {
  await page.getByRole("button", { name: "Start video interview" }).click();
  await expect(page.getByRole("dialog").getByText("Live, speak now")).toBeVisible();
}

const avatarTokens = () => requests.filter((request) => request.endsWith("/avatar-token")).length;

test("the avatar switch hands the voice back mid-call and can bring the avatar back", async ({ page }) => {
  await createPersona(page);
  await startCall(page);
  const dialog = page.getByRole("dialog");
  const callAudio = page.locator('[data-testid="interview-room"] > audio');
  await page.evaluate(() => window.e2eRealtime.voice());
  await expect(dialog.getByTestId("avatar")).toBeVisible();
  await expect.poll(() => simliSockets.length).toBe(1);
  await expect(callAudio).toHaveJSProperty("muted", false);

  await page.evaluate(() => window.e2eSimliStart());
  await expect(callAudio).toHaveJSProperty("muted", true); // The avatar plays the voice now.
  await expect(dialog.getByText("Avatar is joining…")).toHaveCount(0);

  await dialog.getByRole("button", { name: "Turn avatar off", exact: true }).click();
  await expect(dialog.getByTestId("avatar")).toHaveCount(0);
  await expect(dialog.getByText("Avatar off, voice only.")).toBeVisible();
  await expect(callAudio).toHaveJSProperty("muted", false);
  await expect.poll(() => simliSockets[0].closed).toBe(true);
  // The call itself is untouched: same microphone, same peer, and it still takes questions.
  expect(await page.evaluate(() => ({
    microphone: window.e2eRealtime.microphones[0].readyState,
    closed: window.e2eRealtime.closed,
  }))).toEqual({ microphone: "live", closed: false });
  await expect(dialog.getByText("Live, speak now")).toBeVisible();
  await dialog.getByLabel("Type a question").fill("Hörst du mich noch?");
  await dialog.getByRole("button", { name: "Ask", exact: true }).click();
  expect(await page.evaluate(() => window.e2eRealtime.sent.map((event) => event.type))).toEqual(["conversation.item.create", "response.create"]);
  expect(avatarTokens()).toBe(1);

  await dialog.getByRole("button", { name: "Turn avatar on", exact: true }).click();
  await expect(dialog.getByTestId("avatar")).toBeVisible();
  await expect(dialog.getByText("Avatar off, voice only.")).toHaveCount(0);
  await expect.poll(avatarTokens).toBe(2);
  await expect.poll(() => simliSockets.length).toBe(2);
});

test("turning the avatar off during the SDK's retry backoff closes the socket that retry opens", async ({ page }) => {
  await createPersona(page);
  await startCall(page);
  const dialog = page.getByRole("dialog");
  const consoleLines: string[] = [];
  page.on("console", (message) => consoleLines.push(message.text()));
  await page.evaluate(() => window.e2eRealtime.voice());
  await expect.poll(() => simliSockets.length).toBe(1);

  await page.evaluate(() => window.e2eSimliSocketFailed()); // The SDK now waits 1 to 1.2 s to retry.
  await expect.poll(() => consoleLines).toContain("[avatar] attempt failed: Websocket Failed");
  await dialog.getByRole("button", { name: "Turn avatar off", exact: true }).click();
  await expect(dialog.getByText("Avatar off, voice only.")).toBeVisible();
  await expect.poll(() => simliSockets.length).toBe(2);
  await expect.poll(() => simliSockets[1].closed).toBe(true);
  await expect(dialog.getByText("Live, speak now")).toBeVisible();
});

test("with the avatar turned off before the call, no avatar is requested", async ({ page }) => {
  await createPersona(page);
  await page.getByRole("button", { name: "Turn avatar off", exact: true }).click();
  await startCall(page);
  const dialog = page.getByRole("dialog");
  await page.evaluate(() => window.e2eRealtime.voice());
  await expect(page.locator('[data-testid="interview-room"] > audio')).toHaveJSProperty("muted", false);
  await expect(dialog.getByText("Avatar off, voice only.")).toBeVisible();
  await expect(dialog.getByTestId("avatar")).toHaveCount(0);
  expect(avatarTokens()).toBe(0);
  expect(simliSockets).toEqual([]);
});

test("the sample interview reaches a labelled debrief without a live call", async ({ page, request }) => {
  await createPersona(page);
  requests.length = 0;
  const created = page.waitForResponse((response) => response.url().endsWith("/api/sessions") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Use sample interview", exact: true }).click();
  const session: Session = await (await created).json();

  const debrief = page.getByTestId("debrief");
  await expect(debrief.getByTestId("sample-label")).toContainText(sampleLabel);
  await expect(debrief).toContainText(questions[0]);
  await expect(page.getByTestId("interview-room")).toContainText("No live call took place and nobody was interviewed.");
  const transcript = page.getByTestId("interview-room").locator("details").filter({ hasText: "Sample transcript" });
  await transcript.locator("summary").click();
  await expect(transcript).toContainText("Sample participant: Wir haben seit einem Jahr das Abo");
  await expect(transcript).toContainText("Interviewer: Wie entsorgt ihr heute");
  await expect(page.getByRole("button", { name: "Start video interview" })).toBeVisible();

  // Nothing of a live call happened.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Past interviews refetch as the call ends and the debrief lands, however often that turns out to be.
  expect(requests.filter((request) => !/^GET \/api\/personas\/[^/]+\/sessions$/.test(request))).toEqual([
    "POST /api/sessions",
    `POST /api/sessions/${session.id}/events`,
    `PATCH /api/sessions/${session.id}`,
    `POST /api/sessions/${session.id}/debrief`,
  ]);
  expect(await page.evaluate(() => ({
    microphones: window.e2eRealtime.audioConstraints.length,
    cameras: window.e2eRealtime.cameraRequests,
  }))).toEqual({ microphones: 0, cameras: 0 });

  // What the backend holds says the same, and the session is complete enough for the real debrief route.
  const saved: Session = await (await request.get(`/api/sessions/${session.id}`)).json();
  expect(saved).toMatchObject({ sample: true, status: "ended", startedAt: null });
  const events: SessionEvent[] = await (await request.get(`/api/sessions/${session.id}/events`)).json();
  expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
  expect(events.at(-1)).toMatchObject({ type: "session.ended", data: { durationSeconds: 0 } });
  expect(events.filter((event) => event.type === "utterance")).toHaveLength(16);
  expect(events[0]).toMatchObject({ data: { speaker: "interviewer", text: "Wie entsorgt ihr heute Papier, PET und Alu?" } });
  expect(events[1]).toMatchObject({ data: { speaker: "persona" } });

  // The shared link keeps the label, from the persisted session.
  await page.goto(`/report/${session.id}`);
  await expect(page.getByTestId("sample-label")).toContainText(sampleLabel);

  // A hand-edited comparison link can't count it as an interview.
  await page.goto(`/compare?id=${session.id}`);
  await expect(page.getByRole("heading", { name: "Sample interview included" })).toBeVisible();
  await expect(page.getByTestId("compare-table")).toHaveCount(0);
});

test("a call stuck connecting can be cancelled and the sample interview still runs", async ({ page, request }) => {
  await createPersona(page);
  // The call setup is never answered, so only Cancel can get out of the popup.
  const posted = page.waitForRequest("https://api.openai.com/v1/realtime/calls");
  await page.route("https://api.openai.com/v1/realtime/calls", () => {});
  const created = page.waitForResponse((response) => response.url().endsWith("/api/sessions") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Start video interview" }).click();
  const abandoned: Session = await (await created).json();
  await posted;
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Connecting…")).toBeVisible();
  await expect(page.getByRole("button", { name: "Use sample interview", exact: true })).toHaveCount(0);

  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => ({
    microphone: window.e2eRealtime.microphones[0].readyState,
    closed: window.e2eRealtime.closed,
  }))).toEqual({ microphone: "ended", closed: true });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${abandoned.id}`)).json()).status).toBe("ended");
  await expect(page.getByTestId("interview-room").getByRole("alert")).toHaveCount(0);

  await page.getByRole("button", { name: "Use sample interview", exact: true }).click();
  await expect(page.getByTestId("debrief").getByTestId("sample-label")).toContainText(sampleLabel);
});

test("a sample interview stuck on its first request can be cancelled", async ({ page }) => {
  await createPersona(page);
  const posted = page.waitForRequest((request) => request.url().endsWith("/api/sessions") && request.method() === "POST");
  await page.route("**/api/sessions", () => {});
  await page.getByRole("button", { name: "Use sample interview", exact: true }).click();
  await posted;
  const room = page.getByTestId("interview-room");
  await expect(room).toContainText("Loading the sample interview…");

  await room.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(room).not.toContainText("Loading the sample interview…");
  await expect(room.getByRole("alert")).toHaveCount(0);
  await expect(page.getByTestId("debrief")).toHaveCount(0);
  await page.unroute("**/api/sessions");
  await page.getByRole("button", { name: "Use sample interview", exact: true }).click();
  await expect(page.getByTestId("debrief").getByTestId("sample-label")).toContainText(sampleLabel);
});

test("the sample interview after a failed start shows only the sample status", async ({ page }) => {
  await createPersona(page);
  await page.route("https://api.openai.com/v1/realtime/calls", (route) => route.fulfill({ status: 500, body: "" }));
  await page.getByRole("button", { name: "Start video interview" }).click();
  const room = page.getByTestId("interview-room");
  await expect(room).toContainText("Interview could not start.");

  await page.getByRole("button", { name: "Use sample interview", exact: true }).click();
  await expect(page.getByTestId("debrief").getByTestId("sample-label")).toContainText(sampleLabel);
  await expect(room).toContainText("No live call took place and nobody was interviewed.");
  await expect(room).not.toContainText("Interview could not start.");
  await expect(room.getByRole("alert")).toHaveCount(0);
});

test("a saved sample report labels quotes and exports; a real one does not", async ({ page }) => {
  const sessionId = "s-sample-74";
  const report: InsightReport = { ...(exampleReport as InsightReport), sessionId };
  const quote = report.questions[0].insights[0];
  const open = async (sample: boolean) => {
    await page.unroute("**/api/**").catch(() => {});
    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === `/api/sessions/${sessionId}`) {
        return route.fulfill({ json: { id: sessionId, personaId: examplePersona.id, status: "ended", provider: "openai-realtime", sample } });
      }
      if (path === `/api/personas/${examplePersona.id}`) return route.fulfill({ json: examplePersona });
      if (path === `/api/sessions/${sessionId}/insights`) return route.fulfill({ json: report });
      unexpected.push(path);
      return route.abort("blockedbyclient");
    });
    await page.goto(`/report/${sessionId}`);
    await expect(page.getByTestId("debrief")).toContainText(quote.quote);
  };
  const download = async () => {
    const started = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download .md", exact: true }).click();
    return readFile(await (await started).path(), "utf8");
  };

  await open(true);
  await expect(page.getByTestId("sample-label")).toContainText(`${examplePersona.name} did not say these lines`);
  await expect(page.getByTestId("sample-label")).toContainText("If this persona uses the prefilled example sources");
  await expect(page.getByTestId("debrief")).toContainText(`Sample script · turn ${quote.turnSeq}`);
  await expect(page.getByTestId("debrief")).not.toContainText(`${examplePersona.name} · interview turn`);
  const sampleExport = await download();
  expect(sampleExport).toContain("SAMPLE INTERVIEW");
  expect(sampleExport).toContain(`Sample script turn ${quote.turnSeq}`);
  expect(sampleExport).not.toContain("Interview turn");
  expect(sampleExport).not.toContain("simulated interview");
  expect(sampleExport).toContain("If the persona uses the prefilled example sources");

  await open(false);
  await expect(page.getByTestId("sample-label")).toHaveCount(0);
  await expect(page.getByTestId("debrief")).toContainText(`${examplePersona.name} · interview turn ${quote.turnSeq}`);
  expect(await download()).toBe(formatReportMarkdown(report, examplePersona.name));
});

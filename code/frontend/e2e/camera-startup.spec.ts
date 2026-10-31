import { expect, test, type Page } from "@playwright/test";
import exampleReport from "../../shared/examples/insight-report.json";
import { emit, installRealtime } from "./realtime";

// #109: the optional camera prompt must never hold up voice, and a late answer must never leave
// the camera on. The prompt stays open until the test calls grantCamera().

const questions = exampleReport.questions.map((question) => question.question);

test.beforeEach(async ({ context, page }) => {
  await context.route("https://api.openai.com/v1/realtime/calls", (route) =>
    route.fulfill({ status: 200, contentType: "application/sdp", body: "e2e-answer" }),
  );
  await installRealtime(page, { camera: "pending" });
});

async function openInterview(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Create persona", exact: true }).click();
  await expect(page.getByTestId("persona-card").getByRole("heading", { name: "Sandra" })).toBeVisible();
  await page.getByRole("button", { name: "Interview", exact: true }).click();
  await page.getByLabel("Interview questions, one per line (the debrief answers these)").fill(questions.join("\n"));
}

const cameraStates = (page: Page) => page.evaluate(() => window.e2eRealtime.cameraTracks.map((t) => t.readyState));

test("voice goes live while the camera prompt is still open; a later grant shows the camera", async ({ page }) => {
  await openInterview(page);
  await page.getByRole("button", { name: "Start video interview" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Live, speak now")).toBeVisible();
  expect(await page.evaluate(() => window.e2eRealtime.cameraRequests)).toBe(1);

  await page.evaluate(() => window.e2eRealtime.grantCamera());
  await expect(dialog.getByLabel("Your camera")).toBeVisible();
  expect(await cameraStates(page)).toEqual(["live"]);
});

test("a camera granted after Cancel is stopped at once", async ({ page }) => {
  await openInterview(page);
  // The call setup is never answered, so the call stays connecting.
  await page.route("https://api.openai.com/v1/realtime/calls", () => {});
  await page.getByRole("button", { name: "Start video interview" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Connecting…", { exact: true })).toBeVisible();

  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.evaluate(() => window.e2eRealtime.grantCamera());

  await expect.poll(() => cameraStates(page)).toEqual(["ended"]);
});

test("a camera granted after End, while an answer is still pending, is stopped at once", async ({ page }) => {
  await openInterview(page);
  await page.getByRole("button", { name: "Start video interview" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Live, speak now")).toBeVisible();
  // Speech that never finishes keeps End waiting, with the channel still open.
  await emit(page, { type: "input_audio_buffer.speech_started", item_id: "pending-speech" });
  await dialog.getByRole("button", { name: "End interview" }).click();
  await expect(dialog.getByRole("status")).toBeVisible();

  await page.evaluate(() => window.e2eRealtime.grantCamera());

  await expect.poll(() => cameraStates(page)).toEqual(["ended"]);
  await expect(dialog.getByLabel("Your camera")).toBeHidden();
});

test("a call stuck connecting gives up after the startup deadline and can start again", async ({ page }) => {
  await page.clock.install();
  await openInterview(page);
  await page.route("https://api.openai.com/v1/realtime/calls", () => {});
  await page.getByRole("button", { name: "Start video interview" }).click();
  await expect(page.getByRole("dialog").getByText("Connecting…", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.e2eRealtime.microphones.length)).toBe(1);

  await page.clock.runFor(45_000);

  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("interview-room").getByRole("alert")).toContainText("Connecting took too long");
  await expect(page.getByRole("button", { name: "Start again" })).toBeEnabled();
  expect(await page.evaluate(() => window.e2eRealtime.microphones.map((t) => t.readyState))).toEqual(["ended"]);
});

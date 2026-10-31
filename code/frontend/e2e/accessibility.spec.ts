import { expect, test, type Page, type Route } from "@playwright/test";
import { readFile } from "node:fs/promises";
import exampleCoverage from "../../shared/examples/coverage-report.json";
import persona from "../../shared/examples/persona.json";
import type { InsightReport } from "../src/lib/contracts";
import { formatReportMarkdown, reportMarkdownFilename } from "../src/lib/reportMarkdown";
import { installRealtime } from "./realtime";

const sessionId = "synthetic-a11y-72";
const report: InsightReport = {
  sessionId,
  generatedAt: "2026-10-31T12:00:00Z",
  questions: [{
    question: "Does the synthetic idea help?",
    signal: "unclear",
    insights: [{ id: "synthetic-insight", theme: "An unvalidated assumption", quote: "Maybe it helps.", turnSeq: 1, label: "guess", evidenceId: null }],
    followUps: ["Ask real users for evidence."],
  }],
};

declare global {
  interface Window {
    e2eA11yExports: { copied: string[]; failCopy: boolean; failDownload: boolean };
  }
}

let unexpected: string[];
let pendingDebriefs: Route[];
let debriefCalls: number;

// Every API and SDP response is synthetic. Only frontend assets may reach the local server.
test.beforeEach(async ({ page, context, baseURL }) => {
  if (!baseURL) throw new Error("Missing Playwright baseURL for synthetic accessibility tests");
  const localOrigin = new URL(baseURL).origin;
  unexpected = [];
  pendingDebriefs = [];
  debriefCalls = 0;
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const fulfill = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (url.href === "https://example.invalid/synthetic-a11y-sdp" && request.method() === "POST") {
      expect(request.postData()).toBe("e2e-offer");
      return route.fulfill({ contentType: "application/sdp", body: "synthetic-answer" });
    }
    if (url.origin === localOrigin) {
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (url.pathname === "/api/personas" && request.method() === "POST") return fulfill(persona);
      if (url.pathname === "/api/personas" && request.method() === "GET") return fulfill([]);
      if (url.pathname === "/api/faces") return fulfill([]);
      if (url.pathname.endsWith("/coverage")) return fulfill(exampleCoverage);
      if (url.pathname === "/api/sessions" && request.method() === "POST") {
        return fulfill({ id: sessionId, personaId: persona.id, status: "created", provider: "openai-realtime" }, 201);
      }
      if (url.pathname === `/api/sessions/${sessionId}/token` && request.method() === "POST") {
        return fulfill({ provider: "openai-realtime", token: "synthetic-not-a-credential", url: "https://example.invalid/synthetic-a11y-sdp", expiresAt: "2099-01-01T00:00:00Z" });
      }
      if (url.pathname === `/api/sessions/${sessionId}/events` && request.method() === "POST") return fulfill({ accepted: 1 });
      if (url.pathname === `/api/sessions/${sessionId}` && request.method() === "PATCH") {
        return fulfill({ id: sessionId, personaId: persona.id, provider: "openai-realtime", ...request.postDataJSON() });
      }
      if (url.pathname === `/api/sessions/${sessionId}/debrief` && request.method() === "POST") {
        debriefCalls++;
        pendingDebriefs.push(route);
        return;
      }
    }
    unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
    await route.abort("blockedbyclient");
  });
  await context.routeWebSocket("**/*", (socket) => {
    unexpected.push("unexpected WebSocket");
    socket.close();
  });
  await installRealtime(page);
  await page.addInitScript(() => {
    const state = { copied: [] as string[], failCopy: false, failDownload: false };
    window.e2eA11yExports = state;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text: string) => {
        if (state.failCopy) throw new Error("Synthetic clipboard denial");
        state.copied.push(text);
      },
    } });
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      if (state.failDownload) throw new Error("Synthetic download failure");
      return create(blob);
    };
  });
});

test.afterEach(() => { expect(unexpected).toEqual([]); });

async function respondToDebrief(fail = false) {
  await expect.poll(() => pendingDebriefs.length).toBe(1);
  const route = pendingDebriefs.shift()!;
  await route.fulfill(fail ? { status: 503, json: { detail: "Synthetic unavailability" } } : { json: report });
}

async function openDebrief(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Create persona", exact: true }).click();
  await page.getByRole("button", { name: "Interview", exact: true }).click();
  await page.getByRole("button", { name: "Start video interview", exact: true }).click();
  await expect(page.getByRole("dialog").getByText("Live, speak now")).toBeVisible();
  await page.getByRole("button", { name: "End interview", exact: true }).click();
  const status = page.getByTestId("debrief-generation-status");
  await expect(status).toHaveText("Writing debrief…");
  await expect(status).toHaveAttribute("role", "status");
  await expect(status).toHaveAttribute("aria-live", "polite");
  await expect(status).toHaveAttribute("aria-atomic", "true");
  const node = await status.elementHandle();
  if (!node) throw new Error("Missing generation status node");
  return { status, node };
}

test("file upload is reachable by Tab, visibly focused and opens with Enter and Space", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("Add files…", { exact: true });
  await expect(input).toHaveAttribute("multiple", "");
  await expect(input).toHaveAttribute("accept", ".txt,.md,.csv,.json,.tsv,.pdf,.png,.jpg,.jpeg,.webp,.gif");
  for (const [index, key] of ["Enter", "Space"].entries()) {
    await page.getByRole("button", { name: "Add text source", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(input).toBeFocused();
    const label = input.locator("..");
    await expect(label).toHaveCSS("outline-style", "solid");
    await expect(label).toHaveCSS("outline-width", "2px");
    await expect(label).toHaveCSS("outline-offset", "2px");
    const choosing = page.waitForEvent("filechooser");
    await page.keyboard.press(key);
    const chooser = await choosing;
    expect(chooser.isMultiple()).toBe(true);
    const text = `Synthetic source ${index + 1}: keyboard upload only.`;
    await chooser.setFiles({ name: `keyboard-${index + 1}.txt`, mimeType: "text/plain", buffer: Buffer.from(text) });
    await expect(page.getByLabel(`Source ${index + 3} title`, { exact: true })).toHaveValue(`keyboard-${index + 1}.txt`);
    await expect(page.getByLabel(`Source ${index + 3} text`, { exact: true })).toHaveValue(text);
  }
  let pendingPersona: Route | undefined;
  await page.route("**/api/personas", (route) => { pendingPersona = route; });
  await page.getByRole("button", { name: "Create persona", exact: true }).click();
  await expect.poll(() => Boolean(pendingPersona)).toBe(true);
  await expect(input).toBeDisabled();
  await expect(input.locator("..")).toHaveCSS("opacity", "0.4");
  await pendingPersona!.fulfill({ status: 503, json: { detail: "Synthetic busy-state check" } });
  await expect(input).toBeEnabled();
  expect(debriefCalls).toBe(0);
});

test("one polite generation node survives loading, failure, retry and completion", async ({ page }) => {
  const { status, node } = await openDebrief(page);
  await expect(page.getByRole("button", { name: "Writing debrief…", exact: true })).toBeDisabled();
  await respondToDebrief(true);
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("The debrief model is unavailable right now. Try again in a moment.");
  await expect(status).toHaveText("Debrief generation failed.");
  expect(await status.evaluate((element, original) => element === original, node)).toBe(true);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(status).toHaveText("Writing debrief…");
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  expect(await status.evaluate((element, original) => element === original, node)).toBe(true);
  await respondToDebrief();
  await expect(page.getByTestId("debrief")).toBeVisible();
  await expect(status).toHaveText("Debrief ready.");
  expect(await status.evaluate((element, original) => element === original, node)).toBe(true);
  expect(await node.evaluate((element) => element.isConnected)).toBe(true);
  expect(debriefCalls).toBe(2);
});

test("generation completion preserves copy/download success and failure feedback", async ({ page }) => {
  const { status, node } = await openDebrief(page);
  await respondToDebrief();
  await expect(status).toHaveText("Debrief ready.");
  const debrief = page.getByTestId("debrief");
  const copy = debrief.getByRole("button", { name: "Copy as Markdown", exact: true });
  await page.evaluate(() => { window.e2eA11yExports.failCopy = true; });
  await copy.click();
  await expect(debrief.getByRole("alert")).toHaveText("Could not copy Markdown. Try again or use Download .md.");
  await page.evaluate(() => { window.e2eA11yExports.failCopy = false; });
  await copy.focus();
  await page.keyboard.press("Enter");
  await expect(debrief.getByRole("status")).toHaveText("Markdown copied to clipboard.");
  await expect(debrief.getByRole("alert")).toHaveCount(0);
  expect(await page.evaluate(() => window.e2eA11yExports.copied)).toEqual([formatReportMarkdown(report, persona.name)]);
  await page.evaluate(() => { window.e2eA11yExports.failDownload = true; });
  const downloadButton = debrief.getByRole("button", { name: "Download .md", exact: true });
  await downloadButton.click();
  await expect(debrief.getByRole("alert")).toHaveText("Could not download Markdown. Try again or use Copy as Markdown.");
  await page.evaluate(() => { window.e2eA11yExports.failDownload = false; });
  const downloading = page.waitForEvent("download");
  await downloadButton.click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(reportMarkdownFilename(report, persona.name));
  expect(await download.failure()).toBeNull();
  const path = await download.path();
  if (!path) throw new Error("Missing synthetic Markdown download");
  expect(await readFile(path, "utf8")).toBe(formatReportMarkdown(report, persona.name));
  await expect(debrief.getByRole("status")).toHaveText("Markdown download started.");
  await expect(debrief.getByRole("alert")).toHaveCount(0);
  await expect(status).toHaveText("Debrief ready.");
  expect(await status.evaluate((element, original) => element === original, node)).toBe(true);
  expect(debriefCalls).toBe(1);
});

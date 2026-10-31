import { expect, test, type Page } from "@playwright/test";
import examplePersona from "../../shared/examples/persona.json";
import exampleReport from "../../shared/examples/insight-report.json";

const sessionId = "s-report-91";
const label = "Simulated interview with an AI persona";

// Synthetic answers per /api path. Anything else, and any write, is recorded as unexpected.
async function mockApi(page: Page, answer: (path: string) => { status: number; json: unknown } | undefined) {
  const unexpected: string[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== "http://127.0.0.1:3165") {
      unexpected.push(url.href);
      return route.abort("blockedbyclient");
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const response = request.method() === "GET" ? answer(url.pathname) : undefined;
    if (response) return route.fulfill(response);
    unexpected.push(`${request.method()} ${url.pathname}`);
    await route.abort("blockedbyclient");
  });
  return unexpected;
}

const session = { status: 200, json: { id: sessionId, personaId: examplePersona.id, status: "ended", provider: "openai-realtime" } };
const persona = { status: 200, json: examplePersona };
const notFound = (detail: string) => ({ status: 404, json: { detail } });

test("an unknown session shows the not-found state from the real backend", async ({ page }) => {
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") posts.push(request.url());
  });
  await page.goto("/report/s_does_not_exist");
  await expect(page.getByRole("heading", { name: "Debrief not found" })).toBeVisible();
  await expect(page.getByText(label)).toBeVisible();
  await expect(page.getByTestId("debrief")).toHaveCount(0);
  expect(posts).toEqual([]);
});

test("a session without a report shows not found and offers no way to generate one", async ({ page }) => {
  const unexpected = await mockApi(page, (path) => {
    if (path === `/api/sessions/${sessionId}`) return session;
    if (path === `/api/personas/${examplePersona.id}`) return persona;
    if (path === `/api/sessions/${sessionId}/insights`) return notFound("report not found");
  });
  await page.goto(`/report/${sessionId}`);
  await expect(page.getByRole("heading", { name: "Debrief not found" })).toBeVisible();
  await expect(page.getByText(label)).toBeVisible();
  await expect(page.getByRole("button", { name: "Create debrief", exact: true })).toHaveCount(0);
  expect(unexpected).toEqual([]);
});

test("a temporary failure is not reported as not found, and retry shows the read-only debrief", async ({ page }) => {
  let insightsUp = false;
  const unexpected = await mockApi(page, (path) => {
    if (path === `/api/sessions/${sessionId}`) return session;
    if (path === `/api/personas/${examplePersona.id}`) return persona;
    if (path === `/api/sessions/${sessionId}/insights`) {
      return insightsUp ? { status: 200, json: { ...exampleReport, sessionId } } : { status: 503, json: { detail: "store unavailable" } };
    }
  });
  await page.goto(`/report/${sessionId}`);
  await expect(page.getByRole("alert").filter({ hasText: "Could not load this debrief" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Debrief not found" })).toHaveCount(0);
  insightsUp = true;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  const debrief = page.getByTestId("debrief");
  await expect(debrief).toContainText(exampleReport.questions[0].insights[0].quote);
  await expect(debrief).toContainText(`${examplePersona.name}, an AI persona`);
  await expect(page.getByText(label)).toBeVisible();
  await expect(debrief.getByRole("button", { name: "Copy as Markdown", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy link", exact: true })).toHaveCount(0);
  expect(unexpected).toEqual([]);
});

test("a comparison with a missing debrief shows no counts, against the real backend", async ({ page }) => {
  await page.goto("/compare?id=s_does_not_exist&id=s_neither");
  await expect(page.getByRole("heading", { name: "Debrief not found" })).toBeVisible();
  await expect(page.getByText("Simulated personas: hypotheses for real customer research.")).toBeVisible();
  await expect(page.getByTestId("compare-table")).toHaveCount(0);
});

test("a comparison page without interviews says what to do and asks the backend nothing", async ({ page }) => {
  const calls: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) calls.push(request.url());
  });
  await page.goto("/compare");
  await expect(page.getByRole("heading", { name: "Nothing to compare" })).toBeVisible();
  await expect(page.getByText("Simulated personas: hypotheses for real customer research.")).toBeVisible();
  expect(calls).toEqual([]);
});

test("a temporary comparison failure is not reported as not found, and retry shows the table", async ({ page }) => {
  let up = false;
  await page.route("**/api/insights/summary", (route) =>
    route.fulfill(
      up
        ? { status: 200, json: { transcriptGapSessionIds: [], questions: [{ question: "Q", supports: 1, contradicts: 0, unclear: 0, insights: [] }] } }
        : { status: 503, json: { detail: "store unavailable" } },
    ),
  );
  await page.goto("/compare?id=s_1&id=s_2");
  await expect(page.getByRole("alert").filter({ hasText: "Could not load this comparison" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Debrief not found" })).toHaveCount(0);
  up = true;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByTestId("compare-table")).toContainText("Q");
});

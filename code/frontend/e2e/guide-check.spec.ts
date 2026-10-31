import { expect, test, type Page } from "@playwright/test";
import example from "../../shared/examples/guide-review.json";
import persona from "../../shared/examples/persona.json";

const [flagged, neutral] = example.items;
const guideLabel = "Interview questions, one per line (the debrief answers these)";

async function openGuide(page: Page) {
  await page.goto("/");
  await expect(page.getByLabel("Source 2 text")).toContainText("SYNTHETIC INTERVIEW");
  await page.getByRole("button", { name: "Create persona", exact: true }).click();
  await expect(page.getByTestId("persona-card").getByRole("heading", { name: "Sandra" })).toBeVisible();
  return page.getByLabel(guideLabel);
}

test("flags a hypothetical question and swaps in its rewrite, keeping the other lines", async ({ page }) => {
  const guide = await openGuide(page);
  await guide.fill(`${neutral.question}\n  ${flagged.question}  \n`);

  const sent = page.waitForRequest("**/api/guides/review");
  await page.getByRole("button", { name: "Check questions" }).click();
  const body = (await sent).postDataJSON();
  expect(body.questions).toEqual([neutral.question, flagged.question]);
  expect(body.language).toBe(persona.language);

  const check = page.getByTestId("guide-check");
  const items = check.getByRole("listitem");
  await expect(items).toHaveCount(1);
  await expect(items).toContainText(flagged.question);
  await expect(items).toContainText("Hypothetical");
  await expect(items).toContainText("Yes/no");
  await expect(items).toContainText(flagged.rewrite!);

  await items.getByRole("button", { name: "Use rewrite" }).click();
  await expect(guide).toHaveValue(`${neutral.question}\n${flagged.rewrite}\n`);
  await expect(items).toHaveCount(0);
});

test("editing a checked question drops its now stale suggestion", async ({ page }) => {
  const guide = await openGuide(page);
  await guide.fill(flagged.question);
  await page.getByRole("button", { name: "Check questions" }).click();
  await expect(page.getByTestId("guide-check").getByRole("listitem")).toHaveCount(1);
  await guide.fill("How did you pay last time?");
  await expect(page.getByTestId("guide-check").getByRole("listitem")).toHaveCount(0);
});

test("says so when nothing is flagged, until the guide changes", async ({ page }) => {
  const guide = await openGuide(page);
  await guide.fill(neutral.question);
  await page.getByRole("button", { name: "Check questions" }).click();
  const clear = page.getByText("No leading, hypothetical, yes/no or pitch questions found.");
  await expect(clear).toBeVisible();
  await guide.fill(flagged.question);
  await expect(clear).toBeHidden();
});

test("a provider failure shows a message and leaves the guide alone", async ({ page }) => {
  const guide = await openGuide(page);
  await guide.fill(flagged.question);
  await page.route("**/api/guides/review", (route) => route.fulfill({ status: 503, json: { detail: "guide review provider unavailable" } }));
  await page.getByRole("button", { name: "Check questions" }).click();
  await expect(page.getByTestId("guide-check").getByRole("alert")).toHaveText("Could not check the questions right now. Try again.");
  await expect(guide).toHaveValue(flagged.question);
});

test("a rate limit shows the backend's wait time and leaves the guide alone", async ({ page }) => {
  const guide = await openGuide(page);
  await guide.fill(flagged.question);
  const detail = "Too many requests from this network. Try again in 12 min.";
  await page.route("**/api/guides/review", (route) => route.fulfill({ status: 429, headers: { "Retry-After": "720" }, json: { detail } }));
  await page.getByRole("button", { name: "Check questions" }).click();
  await expect(page.getByTestId("guide-check").getByRole("alert")).toHaveText(detail);
  await expect(guide).toHaveValue(flagged.question);
});

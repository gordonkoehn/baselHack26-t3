import { expect, test, type Page } from "@playwright/test";
import type { CoverageReport } from "../src/lib/contracts";

// A small laptop: the score screen must fit without scrolling.
test.use({ viewport: { width: 1280, height: 720 } });

async function createPersona(page: Page) {
  await page.goto("/");
  await expect(page.getByLabel("Source 2 text")).toContainText("SYNTHETIC INTERVIEW");
  await page.getByRole("button", { name: "Create persona", exact: true }).click();
  await expect(page.getByTestId("persona-score")).toBeVisible();
}

const COVERAGE = "**/api/personas/*/coverage";
const good = (report: CoverageReport): CoverageReport => ({
  ...report,
  overall: "good_enough",
  categories: report.categories.map((c) => ({ ...c, level: "green", score: 0.86, recommendation: null })),
});

test("a new persona opens on the score: three levels, one line of advice, no scrolling", async ({ page }) => {
  await createPersona(page);
  const score = page.getByTestId("persona-score");
  await expect(score.getByRole("heading", { name: "Your persona: Sandra." })).toBeVisible();
  await expect(score.getByTestId("score-overall")).toHaveText("Add more first.");
  for (const title of ["Persona", "Challenge understanding", "Solution"]) {
    await expect(score.getByTestId(`score-${title}`)).toContainText("Red");
    await expect(score.getByTestId(`score-${title}`)).toContainText("0%");
    await expect(score.getByTestId(`score-${title}`)).toContainText("Add a source that covers");
  }
  await expect(score.getByTestId("source-diversity")).toContainText("2 of at least 2 sources (note, transcript)");

  // The detail is not on this screen, and neither is the overall number.
  await expect(page.getByTestId("persona-card")).toBeHidden();
  await expect(page.getByTestId("coverage-check")).toBeHidden();
  await expect(page.getByRole("button", { name: "Go to verification" })).toHaveCount(0);

  await expect(score.getByRole("button", { name: "Go to the interview" })).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeLessThanOrEqual(0);
});

test("long category text still fits one laptop screen", async ({ page }) => {
  await page.route(COVERAGE, async (route) => {
    const response = await route.fetch();
    const report: CoverageReport = await response.json();
    await route.fulfill({
      response,
      json: {
        ...report,
        categories: report.categories.map((c) => ({
          ...c,
          reason: "Evidence backs 2 of 7 points; open: digital literacy and tools used today, objections and trust in the tested solution and 3 more.",
          recommendation: "Add a source that covers: objections and trust in the tested solution.",
        })),
      },
    });
  });
  await createPersona(page);
  await expect(page.getByTestId("score-overall")).toHaveText("Add more first.");
  expect(await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeLessThanOrEqual(0);
});

test("the screens click through, and the detail stays one click away", async ({ page }) => {
  await createPersona(page);
  await expect(page.getByTestId("score-overall")).toHaveText("Add more first.");
  await page.getByTestId("persona-score").getByRole("button", { name: "Add more" }).click();
  await expect(page.getByTestId("persona-score")).toBeHidden();
  await expect(page.getByTestId("coverage-check")).toBeVisible();
  await expect(page.getByLabel("What will you test with this persona?")).toHaveValue(/Quartier-Börse/);
  await expect(page.getByTestId("coverage-score")).toBeVisible();

  await page.getByRole("button", { name: "Persona", exact: true }).click();
  await expect(page.getByTestId("persona-card").getByRole("heading", { name: "Sandra" })).toBeVisible();
  await page.getByRole("button", { name: "Next: add more" }).click();
  await expect(page.getByTestId("coverage-check")).toBeVisible();
  await page.getByRole("button", { name: "Back to the score" }).click();
  await expect(page.getByTestId("persona-score")).toBeVisible();
  await page.getByTestId("persona-score").getByRole("button", { name: "Add more" }).click();
  await page.getByTestId("verify").getByRole("button", { name: "Go to the interview" }).click();
  await expect(page.getByRole("button", { name: "Start video interview" })).toBeVisible();
});

test("another test goal outdates the levels, and an empty one asks for a goal", async ({ page }) => {
  await createPersona(page);
  await expect(page.getByTestId("score-overall")).toHaveText("Add more first.");
  await page.getByTestId("persona-score").getByRole("button", { name: "Add more" }).click();
  const goal = page.getByLabel("What will you test with this persona?");
  await goal.fill("Another test entirely");
  await expect(page.getByTestId("verify")).toContainText("The test changed since this check.");
  await page.getByRole("button", { name: "Back to the score" }).click();
  const overall = page.getByTestId("score-overall");
  await expect(overall).toContainText("The test changed since the last check.");
  await expect(page.getByTestId("score-Persona")).toContainText("Not checked");

  await page.getByRole("button", { name: "Add more", exact: true }).first().click();
  await goal.fill("");
  await page.getByRole("button", { name: "Back to the score" }).click();
  await page.getByRole("button", { name: "Check now" }).click();
  await expect(overall).toContainText("Say what you will test first");
});

test("good enough makes the interview the primary choice", async ({ page }) => {
  await page.route(COVERAGE, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: good(await response.json()) });
  });
  await createPersona(page);
  await expect(page.getByTestId("score-overall")).toHaveText("Good enough to test.");
  await expect(page.getByTestId("score-Persona")).toContainText("86%");
  await expect(page.getByTestId("score-Persona")).toContainText("Green");
  await expect(page.getByTestId("score-Persona")).not.toContainText("Add a source");
});

test("a failed check is honest and never blocks the interview", async ({ page }) => {
  await page.route(COVERAGE, (route) => route.fulfill({ status: 503, json: { detail: "coverage provider unavailable" } }));
  await createPersona(page);
  const overall = page.getByTestId("score-overall");
  await expect(overall).toContainText("No check has run yet.");
  await expect(overall).toContainText("temporarily unavailable");
  await expect(page.getByTestId("score-Persona")).toContainText("Not checked");
  await expect(page.getByTestId("source-diversity")).toContainText("2 of at least 2 sources");

  await page.unroute(COVERAGE);
  await page.getByRole("button", { name: "Check now" }).click();
  await expect(overall).toHaveText("Add more first.");
});

test("a slow check doesn't hold anyone up", async ({ page }) => {
  await page.route(COVERAGE, () => {}); // Never answers.
  await createPersona(page);
  await expect(page.getByRole("status")).toContainText("Checking Sandra.");
  await page.getByTestId("persona-score").getByRole("button", { name: "Go to the interview" }).click();
  await expect(page.getByRole("button", { name: "Start video interview" })).toBeEnabled();
});

test("an edit outdates the levels instead of leaving them on screen", async ({ page }) => {
  await createPersona(page);
  await expect(page.getByTestId("score-overall")).toHaveText("Add more first.");
  await page.getByRole("button", { name: "Persona", exact: true }).click();
  await page.getByRole("button", { name: /^Remove: / }).first().click();
  await expect(page.getByTestId("readiness")).toContainText("edited after creation");
  await page.getByRole("button", { name: "Score", exact: true }).click();
  await expect(page.getByTestId("score-overall")).toContainText("Sandra changed since the last check.");
  await expect(page.getByTestId("score-Persona")).toContainText("Not checked");
  await page.getByRole("button", { name: "Check now" }).click();
  await expect(page.getByTestId("score-overall")).toHaveText("Add more first.");
});

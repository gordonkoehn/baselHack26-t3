import { expect, test } from "@playwright/test";
import exampleReport from "../../shared/examples/coverage-report.json";
import examplePersona from "../../shared/examples/persona.json";
import type { CoverageReport, CoverageRequest, Persona } from "../src/lib/contracts";

const persona = examplePersona as Persona;
const highScore: CoverageReport = {
  ...exampleReport as CoverageReport,
  score: 0.92,
  recommendation: "ready",
  overall: "add_more",
  criteria: (exampleReport as CoverageReport).criteria.filter((c) => !c.custom),
  categories: (exampleReport as CoverageReport).categories.map((c) => ({
    ...c, score: 0.92, level: "green", recommendation: null,
  })),
};

const cases: { name: string; report: CoverageReport; label: string }[] = [
  { name: "one source overrides a ready numerical recommendation", report: {
    ...highScore, sourceDiversity: { count: 1, kinds: ["note"], minimum: 2, met: false },
  }, label: "Add more first." },
  { name: "a red category overrides a ready numerical recommendation", report: {
    ...highScore, categories: [(exampleReport as CoverageReport).categories[0], ...highScore.categories.slice(1)],
  }, label: "Add more first." },
  { name: "a good-enough overall stays consistent", report: {
    ...highScore, overall: "good_enough", recommendation: "needs_input",
  }, label: "Good enough to test." },
];

for (const scenario of cases) {
  test(`${scenario.name} across Score, Add more, Persona and header`, async ({ page, baseURL }) => {
    if (!baseURL) throw new Error("This regression requires the parent Playwright baseURL.");
    const origin = new URL(baseURL).origin;
    const unexpected: string[] = [];
    // All API responses are local fixtures; no provider or backend request can escape.
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) {
        unexpected.push(`${url.origin}${url.pathname}`);
        return route.abort();
      }
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (url.pathname === "/api/personas") {
        return route.fulfill({ json: request.method() === "POST" ? persona : [] });
      }
      if (url.pathname === "/api/faces") return route.fulfill({ json: [] });
      if (url.pathname === `/api/personas/${persona.id}/coverage`) {
        const input = request.postDataJSON() as CoverageRequest;
        return route.fulfill({ json: { ...scenario.report, testGoal: input.testGoal } });
      }
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 500, json: { detail: "Unexpected API request in verdict regression" } });
    });

    await page.goto("/studio");
    if (scenario.report.sourceDiversity.count === 1) {
      await page.getByRole("button", { name: "Remove source 2", exact: true }).click();
    }
    await page.getByRole("button", { name: "Create persona", exact: true }).click();
    await expect(page.getByTestId("score-overall")).toHaveText(scenario.label);
    const score = page.getByTestId("persona-score");
    await expect(score.getByRole("button", { name: "Go to the interview" })).toBeEnabled();
    await score.getByRole("button", { name: "Add more", exact: true }).click();

    const verdict = page.getByTestId("coverage-verdict");
    const header = page.getByTestId("workspace-coverage");
    await expect(verdict).toHaveText(scenario.label);
    await expect(page.getByTestId("coverage-score")).toHaveText("92%");
    await expect(header).toHaveText(`AI 92% · ${scenario.label}`);
    for (const badge of [verdict, header]) {
      if (scenario.report.overall === "add_more") {
        await expect(badge).not.toHaveClass(/bg-accent-soft|text-accent/);
      } else {
        await expect(badge).toHaveClass(/bg-accent-soft/);
      }
    }

    await page.getByRole("button", { name: "Persona", exact: true }).click();
    const tile = page.getByTestId("persona-card").getByRole("button", { name: /^Coverage/ });
    await expect(tile).toContainText(scenario.label);
    await expect(tile).toContainText("92%");

    // A changed goal invalidates the same report everywhere without blocking the interview.
    await page.getByRole("button", { name: "Next: add more" }).click();
    await page.getByLabel("What will you test with this persona?").fill("A different test goal");
    await expect(verdict).toHaveText("Needs a new check.");
    await expect(verdict).not.toHaveClass(/bg-accent-soft|text-accent/);
    await expect(header).toHaveText("AI – · Not checked");
    await expect(header).not.toHaveClass(/bg-accent-soft|text-accent/);
    await page.getByRole("button", { name: "Persona", exact: true }).click();
    await expect(tile).toContainText("not checked yet");
    await expect(tile).not.toContainText("92%");
    await page.getByRole("button", { name: "Score", exact: true }).click();
    await expect(page.getByTestId("score-overall")).toContainText("Needs a new check.");
    await expect(page.getByTestId("score-Persona")).toContainText("Not checked");
    await score.getByRole("button", { name: "Go to the interview" }).click();
    await page.getByLabel("Interview questions, one per line (the debrief answers these)").fill("How did you handle recycling last time?");
    await expect(page.getByRole("button", { name: "Start video interview" })).toBeEnabled();
    expect(unexpected).toEqual([]);
  });
}

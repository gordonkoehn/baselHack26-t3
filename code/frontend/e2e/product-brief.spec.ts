import { expect, test, type Page } from "@playwright/test";
import type { Persona, PersonaSummary, Product, Session } from "../src/lib/contracts";
import { LUMEN_GUIDE, LUMEN_PRODUCT, QUARTIER_BOERSE_GUIDE } from "../src/lib/sample";
import { installRealtime } from "./realtime";

const product: Product = {
  name: "Synthetic plant monitor",
  description: "A synthetic sensor prototype that tells apartment residents when to water their plants.",
  prototypeUrl: "https://example.invalid/plant-monitor",
};
const guide = "How do you decide when to water a plant?";
const questionsLabel = "Interview questions, one per line (the debrief answers these)";
const sessionCreated = (page: Page) => page.waitForResponse((response) =>
  response.url().endsWith("/api/sessions") && response.request().method() === "POST",
);

async function describeProduct(page: Page, selected: boolean) {
  await page.getByRole("button", { name: "Product", exact: true }).click();
  await page.getByLabel("Product name", { exact: true }).fill(product.name);
  await page.getByLabel("What it is").fill(product.description);
  await page.getByLabel("Prototype link (optional)").fill(product.prototypeUrl!);
  await page.getByLabel("Sprint questions, one per line").fill(guide);
  await page.getByRole("button", { name: selected ? "Back to the interview" : "Next: add sources", exact: true }).click();
}

async function build(page: Page): Promise<Persona> {
  const built = page.waitForResponse((response) => response.url().endsWith("/api/personas") && response.request().method() === "POST");
  await page.getByRole("button", { name: /^(Create|Rebuild) persona$/ }).click();
  const response = await built;
  expect(response.ok()).toBe(true);
  await expect(page.getByTestId("persona-score")).toBeVisible();
  return response.json();
}

let unexpected: string[];
test.beforeEach(async ({ page, context, baseURL }) => {
  unexpected = [];
  const origin = new URL(baseURL!).origin;
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    if (url.href === "https://api.openai.com/v1/realtime/calls") {
      return route.fulfill({ status: 200, contentType: "application/sdp", body: "e2e-answer" });
    }
    unexpected.push(`${url.origin}${url.pathname}`);
    return route.abort("blockedbyclient");
  });
  await context.routeWebSocket("**/*", (socket) => {
    unexpected.push("unexpected WebSocket");
    socket.close();
  });
  // The store is shared by the suite. Keep earlier Lumen fixtures out of this test's library;
  // the real list endpoint, persona GETs, session routes and Product persistence still run.
  await page.route("**/api/personas", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const personas: PersonaSummary[] = await response.json();
    await route.fulfill({ response, json: personas.filter((persona) => !persona.name.includes("Kessler")) });
  });
  await installRealtime(page);
});
test.afterEach(() => { expect(unexpected).toEqual([]); });

for (const mode of ["interview", "test call"] as const) {
  test(`the chosen Product is persisted by the ${mode} session routes`, async ({ page, request }) => {
    await page.goto("/studio");
    await describeProduct(page, false);
    const persona = await build(page);
    await page.getByRole("button", { name: mode === "interview" ? "Interview" : "Add more", exact: true }).first().click();
    const room = page.getByTestId("interview-room").filter({ visible: true });
    await expect(room.getByTestId("product-under-test")).toContainText(product.name);
    await expect(room.getByTestId("product-under-test")).not.toContainText("No product described");
    if (mode === "interview") await expect(room.getByLabel(questionsLabel)).toHaveValue(guide);
    const created = sessionCreated(page);
    await room.getByRole("button", { name: "Start video interview", exact: true }).click();
    const response = await created;
    expect(response.status()).toBe(201);
    expect(response.request().postDataJSON()).toMatchObject({ personaId: persona.id, product });
    const session: Session = await response.json();
    expect(session.product).toEqual(product);
    const saved = await request.get(`/api/sessions/${session.id}`);
    expect(saved.ok()).toBe(true);
    expect(await saved.json()).toMatchObject({ personaId: persona.id, product });
    await expect(page.getByRole("dialog", { name: "Interview with Sandra" })).toContainText("Live, speak now");
    await page.getByRole("button", { name: "End interview", exact: true }).click();
    await expect(room.getByTestId("product-under-test")).toContainText(product.name);
    // The independent export suite checks debrief metadata with a matching provider fixture.
    // This fixed-provider harness deliberately cannot debrief arbitrary questions or no speech.
  });

  for (const field of ["name", "prototypeUrl"] as const) {
    test(`${field}-only draft edits never send sample siblings to a custom-source ${mode}`, async ({ page, request }) => {
      await page.goto("/studio");
      await page.getByRole("button", { name: "Product", exact: true }).click();
      await expect(page.getByLabel("Product name", { exact: true })).toHaveValue("Quartier-Börse");
      await expect(page.getByLabel("What it is")).toHaveValue(/Kilo-Shares/);
      await page.getByLabel(field === "name" ? "Product name" : "Prototype link (optional)", { exact: field === "name" }).fill(product[field]!);
      await page.getByRole("button", { name: "Sources", exact: true }).click();
      await page.getByLabel("Source 1 text").fill("SYNTHETIC own research about apartment plant care.");
      await page.getByLabel("Source 2 text").fill("SYNTHETIC resident forgets when their plants need watering.");
      const persona = await build(page);
      await page.getByRole("button", { name: "Product", exact: true }).click();
      await expect(page.getByLabel("Product name", { exact: true })).toHaveValue(field === "name" ? product.name : "");
      await expect(page.getByLabel("What it is")).toHaveValue("");
      await expect(page.getByLabel("Prototype link (optional)")).toHaveValue(field === "prototypeUrl" ? product.prototypeUrl! : "");
      await expect(page.getByLabel("Sprint questions, one per line")).toHaveValue("");
      // Give the normal interview explicit own questions after building. The short test call
      // intentionally has no interview guide and must still get the same scoped Product.
      await page.getByRole("button", { name: "Interview", exact: true }).click();
      await page.getByLabel(questionsLabel).fill(guide);
      if (mode === "test call") await page.getByRole("button", { name: "Add more", exact: true }).first().click();
      const room = page.getByTestId("interview-room").filter({ visible: true });
      await expect(room.getByTestId("product-under-test")).toContainText("No product described");

      async function startAndCheck(expectedProduct: Product | null): Promise<Session> {
        const created = sessionCreated(page);
        await room.getByRole("button", { name: /^(Start video interview|Start again)$/ }).click();
        const response = await created;
        expect(response.status()).toBe(201);
        const expected = {
          personaId: persona.id,
          product: expectedProduct,
          interviewGuide: mode === "interview" ? [guide] : [],
        };
        const payload: unknown = response.request().postDataJSON();
        expect(payload).toMatchObject(expected);
        expect(JSON.stringify(payload)).not.toMatch(/Quartier|Kilo-Shares|A recycling pickup service/);
        const session: Session = await response.json();
        expect(session).toMatchObject(expected);
        const saved = await request.get(`/api/sessions/${session.id}`);
        expect(saved.ok()).toBe(true);
        const stored: Session = await saved.json();
        expect(stored).toMatchObject(expected);
        expect(JSON.stringify(stored.product)).not.toMatch(/Quartier|Kilo-Shares|A recycling pickup service/);
        await expect(page.getByRole("dialog")).toContainText("Live, speak now");
        await page.getByRole("button", { name: "End interview", exact: true }).click();
        await expect(room.getByTestId("product-under-test")).toBeVisible();
        return session;
      }

      const incomplete = await startAndCheck(null);
      // Complete only the missing fields on the selected persona. Earlier explicit fields
      // survive; an optional link can also be explicitly cleared without restoring defaults.
      await page.getByRole("button", { name: "Product", exact: true }).click();
      if (field === "prototypeUrl") await page.getByLabel("Product name", { exact: true }).fill(product.name);
      await page.getByLabel("What it is").fill(product.description);
      if (field === "name") {
        await page.getByLabel("Prototype link (optional)").fill(product.prototypeUrl!);
        await page.getByLabel("Prototype link (optional)").fill("");
      }
      await page.getByRole("button", { name: mode === "interview" ? "Interview" : "Add more", exact: true }).first().click();
      await startAndCheck({ ...product, prototypeUrl: field === "name" ? null : product.prototypeUrl });
      const original = await request.get(`/api/sessions/${incomplete.id}`);
      expect(original.ok()).toBe(true);
      expect(await original.json()).toMatchObject({ personaId: persona.id, product: null });
    });
  }
}

test("draft edits, selected personas and existing sessions keep their own product", async ({ page, request }) => {
  await page.goto("/studio");
  const first = await build(page);
  await describeProduct(page, true);
  await expect(page.getByLabel(questionsLabel)).toHaveValue(guide);
  // New draft sources do not change the selected persona's brief.
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  await page.getByLabel("Source 1 text").fill("SYNTHETIC own material about a bicycle repair service.");
  await page.getByLabel("Source 2 text").fill("SYNTHETIC customer says they repair their bike once a month.");
  await expect(page.getByText("No product described yet", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Interview", exact: true }).click();
  await expect(page.getByTestId("product-under-test")).toContainText(product.name);
  const created = sessionCreated(page);
  await page.getByRole("button", { name: "Start video interview", exact: true }).click();
  const original: Session = await (await created).json();
  await expect(page.getByRole("dialog")).toContainText("Live, speak now");
  await page.getByRole("button", { name: "End interview", exact: true }).click();
  await expect(page.getByTestId("product-under-test")).toContainText(product.name);
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  const second = await build(page);
  await page.getByRole("button", { name: "Interview", exact: true }).click();
  await expect(page.getByLabel(questionsLabel)).toHaveValue("");
  await expect(page.getByTestId("product-under-test")).toContainText("No product described");
  await describeProduct(page, true);
  await page.getByRole("button", { name: "Product", exact: true }).click();
  await page.getByLabel("Product name", { exact: true }).fill("Synthetic bicycle service");
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  const library = page.getByRole("region", { name: "Recent personas" });
  // Each row also has a Delete button; count and click only the persona buttons.
  const rows = library.getByRole("button").filter({ hasNotText: /^Delete$/ });
  // Identify each persona by its real GET request, using the backend list's displayed order.
  const listed = await request.get("/api/personas");
  expect(listed.ok()).toBe(true);
  const summaries: PersonaSummary[] = (await listed.json()).filter((persona: PersonaSummary) => !persona.name.includes("Kessler"));
  await expect(rows).toHaveCount(summaries.length);
  await rows.nth(summaries.findIndex((p) => p.id === first.id)).click();
  await page.getByRole("button", { name: "Interview", exact: true }).click();
  await expect(page.getByTestId("product-under-test")).toContainText(product.name);
  await expect(page.getByLabel(questionsLabel)).toHaveValue(guide);
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  await rows.nth(summaries.findIndex((p) => p.id === second.id)).click();
  await page.getByRole("button", { name: "Interview", exact: true }).click();
  await expect(page.getByTestId("product-under-test")).toContainText("Synthetic bicycle service");
  await page.getByRole("button", { name: "Product", exact: true }).click();
  await expect(page.getByLabel("Product name", { exact: true })).toHaveValue("Synthetic bicycle service");
  await expect(page.getByLabel("What it is")).toHaveValue(product.description);
  await expect(page.getByLabel("Prototype link (optional)")).toHaveValue(product.prototypeUrl!);
  await expect(page.getByLabel("Sprint questions, one per line")).toHaveValue(guide);
  const stored = await request.get(`/api/sessions/${original.id}`);
  expect(await stored.json()).toMatchObject({ product, personaId: first.id });
});

test("changing the sample sources clears automatic defaults without discarding an explicit product", async ({ page }) => {
  await page.goto("/studio");
  await page.getByRole("button", { name: "Product", exact: true }).click();
  await expect(page.getByLabel("Sprint questions, one per line")).toHaveValue(QUARTIER_BOERSE_GUIDE.join("\n"));
  await page.getByLabel("Product name", { exact: true }).fill(product.name);
  await page.getByLabel("What it is").fill(product.description);
  // The guide was never edited: it must follow the source scope instead of becoming an override.
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  await page.getByLabel("Source 1 text").fill("SYNTHETIC custom plant care material.");
  await build(page);
  await page.getByRole("button", { name: "Interview", exact: true }).click();
  await expect(page.getByLabel(questionsLabel)).toHaveValue("");
  await expect(page.getByTestId("product-under-test")).toContainText(product.name);
  await expect(page.getByRole("button", { name: "Start video interview" })).toBeDisabled();
});

test("a newly built Miriam uses the Lumen brief and guide with English as the default", async ({ page }) => {
  // Rename only the extractor response, keeping the real build, scoring and interview UI.
  await page.route("**/api/personas", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), name: "Dr. Miriam Kessler" } });
  });
  await page.goto("/studio");
  await expect(page.getByLabel("Conversation language")).toHaveValue("en");
  await expect(page.getByText("The spoken interview language. Source quotes stay in their original language.")).toBeVisible();
  await page.getByRole("button", { name: "Team twin", exact: true }).click();
  await expect(page.getByLabel("Source 1 text")).not.toHaveValue(/Kilo-Shares/);
  await build(page);
  await page.getByRole("button", { name: "Interview", exact: true }).click();
  await expect(page.getByLabel(questionsLabel)).toHaveValue(LUMEN_GUIDE.join("\n"));
  await expect(page.getByTestId("product-under-test")).toContainText(LUMEN_PRODUCT.name);
  await expect(page.getByTestId("product-under-test")).not.toContainText("Quartier");
});

import { expect, test } from "@playwright/test";

test("the homepage explains the product and leads into the studio", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Interview your customer before you have met them.");
  await expect(page.getByRole("heading", { name: "Four steps from sprint material to answers." })).toBeVisible();
  await page.getByRole("link", { name: "Start a test", exact: true }).click();
  await expect(page).toHaveURL(/\/studio$/);
  await expect(page.getByRole("button", { name: "Create persona", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "OpenTwin", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("an old team link on the homepage forwards to the studio with its code", async ({ page }) => {
  const listed = page.waitForRequest((request) => request.method() === "GET" && request.url().endsWith("/api/personas"));
  await page.goto("/?code=team-pass");
  expect((await listed).headers()["x-demo-passcode"]).toBe("team-pass");
  await expect(page).toHaveURL(/\/studio$/);
});

for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
  test(`landing and studio navigation fit ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await page.getByRole("link", { name: "Open the studio", exact: true }).first().click();
    await expect(page.getByRole("button", { name: "Create persona", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Product", exact: true })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("button", { name: "Interview", exact: true })).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });
}

test("the in-memory team code survives every landing link with storage blocked", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new Error("synthetic storage denied"); };
    Storage.prototype.getItem = () => { throw new Error("synthetic storage denied"); };
    // A full document navigation changes this marker; soft navigation keeps the same document.
    Object.defineProperty(window, "e2eDocumentMarker", { value: Math.random() });
  });
  const listed = page.waitForRequest((request) => request.method() === "GET" && request.url().endsWith("/api/personas"));
  await page.goto("/?code=team-pass");
  expect((await listed).headers()["x-demo-passcode"]).toBe("team-pass");
  await expect(page).toHaveURL(/\/studio$/);
  const marker = await page.evaluate(() => Reflect.get(window, "e2eDocumentMarker"));
  for (const target of [{ label: "Open the studio", index: 0 }, { label: "Start a test", index: 0 }, { label: "Open the studio", index: 1 }]) {
    await page.getByRole("link", { name: "OpenTwin", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.getByRole("link", { name: target.label, exact: true }).nth(target.index).click();
    await expect(page).toHaveURL(/\/studio$/);
    // Cache Components may preserve the previous workspace screen on soft navigation.
    await page.getByRole("button", { name: "Sources", exact: true }).click();
    const created = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith("/api/personas"));
    await page.getByRole("button", { name: /^(Create|Rebuild) persona$/ }).click();
    expect((await created).headers()["x-demo-passcode"]).toBe("team-pass");
    await expect(page.getByTestId("persona-score")).toBeVisible();
    expect(await page.evaluate(() => Reflect.get(window, "e2eDocumentMarker"))).toBe(marker);
  }
});

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

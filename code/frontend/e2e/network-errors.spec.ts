import { expect, test } from "@playwright/test";

// #201: a lost connection during an upload is not blamed on the file.
test("a PDF upload that never reaches the server asks to check the connection", async ({ page }) => {
  await page.route("**/api/sources/pdf", (route) => route.abort("internetdisconnected"));
  await page.goto("/");
  const input = page.getByLabel("Add files…", { exact: true });
  await expect(input).toBeAttached();

  await input.setInputFiles({ name: "brief.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") });

  await expect(page.getByText("brief.pdf: Couldn't connect. Check your connection and try again.")).toBeVisible();
});

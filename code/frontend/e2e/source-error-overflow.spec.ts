import { expect, test, type Page } from "@playwright/test";

const accepted = ".txt, .md, .csv, .json, .tsv, .pdf, .png, .jpg, .jpeg, .webp, .gif";

async function expectPageFits(page: Page) {
  const size = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(size.scrollWidth).toBeLessThanOrEqual(size.innerWidth);
}

// Nothing cut off inside the box, and the box stays inside its source card.
async function expectErrorInsideCard(page: Page) {
  const box = await page.locator('p[role="alert"]').evaluate((alert) => ({
    scrollWidth: alert.scrollWidth,
    clientWidth: alert.clientWidth,
    right: alert.getBoundingClientRect().right,
    cardRight: alert.closest("section")!.getBoundingClientRect().right,
  }));
  expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
  expect(box.right).toBeLessThanOrEqual(box.cardRight);
}

test.beforeEach(async ({ context }) => {
  // Nothing here needs a backend, and nothing may leave the machine.
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://127.0.0.1:3165") return route.abort("blockedbyclient");
    if (url.pathname === "/api/personas") return route.fulfill({ json: [] });
    return route.continue();
  });
});

for (const width of [320, 360, 390, 414]) {
  test(`source file errors wrap inside their box at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    // The five step tabs overflow on their own below 414 px, with or without an error, and would
    // hide what this test measures. Drop this line once they fit.
    await page.addStyleTag({ content: 'nav[aria-label="Steps"] { display: none; }' });
    const input = page.getByLabel("Add files…", { exact: true });
    const titles = page.getByRole("textbox", { name: /^Source \d+ title$/ });
    await expect(input).toBeAttached();
    await expectPageFits(page);

    const text = "Synthetic source for the narrow-screen check.";
    await input.setInputFiles({ name: "synthetic.txt", mimeType: "text/plain", buffer: Buffer.from(text) });
    await expect(titles.last()).toHaveValue("synthetic.txt");
    await expect(page.getByRole("textbox", { name: /^Source \d+ text$/ }).last()).toHaveValue(text);
    await expectPageFits(page);
    const sources = await titles.count();

    const alert = page.locator('p[role="alert"]');
    // The accepted-extension list, then a file name long enough to have nowhere to break.
    for (const name of ["synthetic.docx", `${"syntheticfilename".repeat(10)}.docx`]) {
      await input.setInputFiles({ name, mimeType: "application/octet-stream", buffer: Buffer.from("synthetic") });
      await expect(alert).toContainText(name);
      await expectPageFits(page);
      await expectErrorInsideCard(page);
      await expect(alert).toHaveText(`${name}: not supported (use ${accepted})`);
    }

    // A rejected file adds nothing, and the imported source stays.
    await expect(titles).toHaveCount(sources);
    await expect(titles.last()).toHaveValue("synthetic.txt");
  });
}

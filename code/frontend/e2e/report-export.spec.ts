import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import examplePersona from "../../shared/examples/persona.json";
import type { InsightReport } from "../src/lib/contracts";
import { formatReportMarkdown, reportMarkdownFilename } from "../src/lib/reportMarkdown";
import { installRealtime } from "./realtime";

const personaName = "Äda [Ops] / Team";
const report: InsightReport = {
  sessionId: "s-export-90",
  generatedAt: "2026-10-31T23:30:00-02:00",
  questions: [
    {
      question: "Does *matching* help?\nWhat about [fees](https://example.invalid)?",
      signal: "supports",
      insights: [
        {
          id: "synthetic-grounded", theme: "Trust [draft]\n# No validation",
          quote: "I use *stars* and [brackets].\r\n> Keep <this> & that.\n\n1. Still my words.",
          turnSeq: 2, label: "grounded", evidenceId: "synthetic-source",
        },
        {
          id: "synthetic-guess", theme: "An assumption", quote: "Maybe; this is a guess.",
          turnSeq: 4, label: "guess", evidenceId: null,
        },
      ],
      followUps: ["Ask about `cost`.\n- Without a leading question?", "Where is the evidence?"],
    },
    { question: "Would they pay?", signal: "contradicts", insights: [], followUps: [] },
    { question: "What remains unknown?", signal: "unclear", insights: [] },
  ],
};

test("formatter: preserves synthetic evidence, multiline text and literal Markdown", () => {
  const markdown = formatReportMarkdown(report, personaName);
  expect(markdown).toContain("Persona: Äda \\[Ops\\] / Team\n\nDate (UTC): 2026-11-01");
  expect(markdown).toContain("Simulated AI persona: hypotheses, not customer evidence.");
  expect(markdown).toContain('"grounded" means the persona\'s sources also support the statement; "guess" means they do not. Neither is validated customer evidence.');
  expect(markdown).toContain("Does \\*matching\\* help?  \nWhat about \\[fees\\]\\(https://example.invalid\\)?");
  expect(markdown).toContain("- **[grounded]** Trust \\[draft\\]  \n  \\# No validation");
  expect(markdown).toContain("  > I use \\*stars\\* and \\[brackets\\].  \n  > \\> Keep \\<this\\> &amp; that.  \n  > \n  > 1\\. Still my words.  ");
  expect(markdown).toContain("Interview turn 2 · also in the persona's sources");
  expect(markdown).toContain("- **[guess]** An assumption\n\n  > Maybe; this is a guess.");
  expect(markdown).toContain("Interview turn 4 · not backed by the persona's sources");
  expect(markdown).toContain("- Ask about \\`cost\\`.  \n  \\- Without a leading question?\n- Where is the evidence?");
  expect(markdown.match(/^Signal: .+$/gm)).toEqual(["Signal: supports", "Signal: contradicts", "Signal: unclear"]);
  expect(markdown.match(/^### Follow-up questions for real customers$/gm)).toHaveLength(3);
  expect(markdown.match(/^No follow-up questions recorded\.$/gm)).toHaveLength(2);
  expect(markdown).not.toContain("\r");
  expect(markdown.endsWith("\n")).toBe(true);
});

test("formatter: safe bounded filenames and explicit missing-date fallback", () => {
  expect(reportMarkdownFilename(report, personaName)).toBe("debrief-ada-ops-team-2026-11-01.md");
  expect(reportMarkdownFilename(report, "../../CON:\\*?\"<>|\n")).toBe("debrief-con-2026-11-01.md");
  expect(reportMarkdownFilename(report, "😀/.. ")).toBe("debrief-persona-2026-11-01.md");
  expect(reportMarkdownFilename(report, "X".repeat(300))).toBe(`debrief-${"x".repeat(64)}-2026-11-01.md`);
  const undated = { ...report, generatedAt: "not a date", questions: [] };
  expect(reportMarkdownFilename(undated, "")).toBe("debrief-persona-undated.md");
  expect(formatReportMarkdown(undated, "")).toContain("Date (UTC): unavailable");
});

declare global {
  interface Window {
    e2eReportExport: {
      copied: string[];
      failCopy: boolean;
      activeUrls: string[];
      revokedUrls: string[];
      blobTypes: string[];
    };
  }
}

async function installExports(page: Page) {
  await page.addInitScript(() => {
    const state: Window["e2eReportExport"] = {
      copied: [], failCopy: false, activeUrls: [], revokedUrls: [], blobTypes: [],
    };
    window.e2eReportExport = state;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text: string) => {
        if (state.failCopy) throw new DOMException("Synthetic clipboard denial", "NotAllowedError");
        state.copied.push(text);
      },
    } });
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      state.activeUrls.push(url);
      state.blobTypes.push(blob instanceof Blob ? blob.type : "media-source");
      return url;
    };
    URL.revokeObjectURL = (url) => {
      state.activeUrls = state.activeUrls.filter((active) => active !== url);
      state.revokedUrls.push(url);
      revoke(url);
    };
  });
}

// All API responses and SDP are synthetic; no backend/provider request escapes this page.
async function openDebrief(page: Page, options: { failDebrief?: boolean } = {}) {
  let debriefCalls = 0;
  const unexpected: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const fulfill = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (url.href === "https://example.invalid/synthetic-sdp") {
      return route.fulfill({ contentType: "application/sdp", body: "synthetic-answer" });
    }
    if (url.origin === "http://127.0.0.1:3165") {
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (url.pathname === "/api/faces") return fulfill([]);
      if (url.pathname === "/api/personas") return fulfill({ ...examplePersona, name: personaName });
      if (url.pathname === `/api/personas/${examplePersona.id}/sessions`) return fulfill([]);
      if (url.pathname === "/api/sessions") return fulfill({ id: report.sessionId, personaId: examplePersona.id, status: "created", provider: "openai-realtime" }, 201);
      if (url.pathname === `/api/sessions/${report.sessionId}/token`) {
        return fulfill({ provider: "openai-realtime", token: "synthetic-not-a-credential", url: "https://example.invalid/synthetic-sdp", expiresAt: "2099-01-01T00:00:00Z" });
      }
      if (url.pathname === `/api/sessions/${report.sessionId}/events`) return fulfill({ accepted: 1 });
      if (url.pathname === `/api/sessions/${report.sessionId}`) {
        return fulfill({ id: report.sessionId, personaId: examplePersona.id, provider: "openai-realtime", ...route.request().postDataJSON() });
      }
      if (url.pathname === `/api/sessions/${report.sessionId}/debrief`) {
        debriefCalls++;
        return options.failDebrief ? fulfill({ detail: "Synthetic report unavailable" }, 503) : fulfill(report);
      }
    }
    unexpected.push(`${url.origin}${url.pathname}`);
    await route.abort("blockedbyclient");
  });
  await page.routeWebSocket("**/*", (socket) => {
    unexpected.push("unexpected WebSocket");
    socket.close();
  });
  await installRealtime(page);
  await installExports(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Copy as Markdown" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Download .md" })).toHaveCount(0);
  await page.getByRole("button", { name: "Create persona", exact: true }).click();
  await page.getByRole("button", { name: "Interview", exact: true }).click();
  await page.getByRole("button", { name: "Start video interview", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Interview with ${personaName}`, exact: true });
  await expect(dialog.getByText("Live, speak now")).toBeVisible();
  await page.getByRole("button", { name: "End interview", exact: true }).click();
  if (options.failDebrief) {
    await expect(page.getByRole("main").getByRole("alert")).toContainText("The debrief model is unavailable");
  } else {
    await expect(page.getByTestId("debrief")).toBeVisible();
  }
  return { calls: () => debriefCalls, unexpected };
}

test("loaded report copies and downloads identical Markdown without regenerating", async ({ page }) => {
  const state = await openDebrief(page);
  const debrief = page.getByTestId("debrief");
  const copy = debrief.getByRole("button", { name: "Copy as Markdown", exact: true });
  await copy.focus();
  await page.keyboard.press("Enter");
  await expect(debrief.getByRole("status")).toHaveText("Markdown copied to clipboard.");
  const copied = await page.evaluate(() => window.e2eReportExport.copied);
  expect(copied).toEqual([formatReportMarkdown(report, personaName)]);
  await page.clock.setFixedTime(new Date("2035-05-20T12:00:00Z"));
  const downloading = page.waitForEvent("download");
  await debrief.getByRole("button", { name: "Download .md", exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("debrief-ada-ops-team-2026-11-01.md");
  expect(await download.failure()).toBeNull();
  const path = await download.path();
  expect(path).not.toBeNull();
  expect(await readFile(path!, "utf8")).toBe(copied[0]);
  await expect(debrief.getByRole("status")).toHaveText("Markdown download started.");
  await expect.poll(() => page.evaluate(() => window.e2eReportExport.activeUrls)).toEqual([]);
  expect(await page.evaluate(() => window.e2eReportExport.blobTypes)).toEqual(["text/markdown;charset=utf-8"]);
  expect(await page.evaluate(() => window.e2eReportExport.revokedUrls.length)).toBe(1);
  expect(await page.locator('a[download]').count()).toBe(0);
  expect(state.calls()).toBe(1);
  expect(state.unexpected).toEqual([]);
});

test("clipboard denial is announced, retry succeeds, and unavailable clipboard permits download", async ({ page }) => {
  const state = await openDebrief(page);
  const debrief = page.getByTestId("debrief");
  const copy = debrief.getByRole("button", { name: "Copy as Markdown", exact: true });
  await page.evaluate(() => { window.e2eReportExport.failCopy = true; });
  await copy.click();
  await expect(debrief.getByRole("alert")).toHaveText("Could not copy Markdown. Try again or use Download .md.");
  await expect(copy).toBeEnabled();
  await page.evaluate(() => { window.e2eReportExport.failCopy = false; });
  await copy.click();
  await expect(debrief.getByRole("status")).toHaveText("Markdown copied to clipboard.");
  await expect(debrief.getByRole("alert")).toHaveCount(0);
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }));
  await copy.click();
  await expect(debrief.getByRole("alert")).toContainText("Could not copy Markdown");
  const downloading = page.waitForEvent("download");
  await debrief.getByRole("button", { name: "Download .md", exact: true }).click();
  expect((await downloading).suggestedFilename()).toBe("debrief-ada-ops-team-2026-11-01.md");
  await expect(debrief.getByRole("alert")).toHaveCount(0);
  // Unmount immediately while the delayed URL cleanup is still pending.
  await page.getByRole("button", { name: "Start again", exact: true }).click();
  await expect(debrief).toHaveCount(0);
  expect(await page.evaluate(() => window.e2eReportExport.activeUrls)).toEqual([]);
  expect(state.calls()).toBe(1);
  expect(state.unexpected).toEqual([]);
});

test("copy link falls back to showing the address when the clipboard is denied", async ({ page }) => {
  const state = await openDebrief(page);
  const debrief = page.getByTestId("debrief");
  const copyLink = debrief.getByRole("button", { name: "Copy link", exact: true });
  const link = `http://127.0.0.1:3165/report/${report.sessionId}`;
  await page.evaluate(() => { window.e2eReportExport.failCopy = true; });
  await copyLink.click();
  await expect(debrief.getByRole("alert")).toHaveText(`Could not copy the link. Copy it from here: ${link}`);
  await page.evaluate(() => { window.e2eReportExport.failCopy = false; });
  await copyLink.click();
  await expect(debrief.getByRole("status")).toContainText("Link copied");
  await expect(debrief.getByRole("alert")).toHaveCount(0);
  expect(await page.evaluate(() => window.e2eReportExport.copied)).toEqual([link]);
  expect(state.calls()).toBe(1);
  expect(state.unexpected).toEqual([]);
});

test("failed report cannot expose export actions", async ({ page }) => {
  const state = await openDebrief(page, { failDebrief: true });
  await expect(page.getByRole("button", { name: "Copy as Markdown" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Download .md" })).toHaveCount(0);
  expect(state.calls()).toBe(1);
  expect(state.unexpected).toEqual([]);
});

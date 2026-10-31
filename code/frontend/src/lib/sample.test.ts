import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { QUARTIER_BOERSE, QUARTIER_BOERSE_GUIDE, SAMPLE_TRANSCRIPT } from "./sample";

describe("demo samples", () => {
  it("keeps the test case an exact copy of the documentation", () => {
    // npm test runs from code/frontend.
    const doc = resolve(process.cwd(), "../../documentation/testcase-quartier-boerse.md");

    expect(QUARTIER_BOERSE).toBe(readFileSync(doc, "utf8"));
  });

  it("marks the transcript as synthetic, so it is never taken for a real person", () => {
    expect(SAMPLE_TRANSCRIPT.startsWith("SYNTHETIC INTERVIEW")).toBe(true);
  });

  it("has distinct, non-empty sprint questions for the debrief", () => {
    expect(QUARTIER_BOERSE_GUIDE.length).toBeGreaterThan(0);
    expect(QUARTIER_BOERSE_GUIDE.every((question) => question.trim().length > 0)).toBe(true);
    expect(new Set(QUARTIER_BOERSE_GUIDE).size).toBe(QUARTIER_BOERSE_GUIDE.length);
  });
});

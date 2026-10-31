import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { QUARTIER_BOERSE, QUARTIER_BOERSE_GUIDE, SAMPLE_TRANSCRIPT } from "./sample";

describe("demo samples", () => {
  it("keeps the test case an exact copy of the documentation", () => {
    const doc = resolve(import.meta.dirname, "../../../../documentation/testcase-quartier-boerse.md");

    const text = readFileSync(doc, "utf8");

    // The document opens with a status banner for readers; the copy starts at its title.
    expect(QUARTIER_BOERSE).toBe(text.slice(text.indexOf("# Test case:")));
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

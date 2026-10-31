import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LUMEN_GUIDE,
  QUARTIER_BOERSE,
  QUARTIER_BOERSE_GUIDE,
  SAMPLE_TRANSCRIPT,
  isMiriamKessler,
} from "./sample";

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

  it("keeps the Lumen guide an exact copy of the short guide in the documentation", () => {
    const doc = resolve(
      import.meta.dirname,
      "../../../../documentation/usecases/lumen-ipp/interview/guide-short-miriam-kessler.txt",
    );

    expect(LUMEN_GUIDE).toEqual(readFileSync(doc, "utf8").split("\n").filter(Boolean));
  });

  it("gives only Miriam Kessler the Lumen guide, whatever her title", () => {
    expect(isMiriamKessler("Dr. Miriam Kessler")).toBe(true);
    expect(isMiriamKessler("Miriam Kessler")).toBe(true);
    expect(isMiriamKessler("Sandra")).toBe(false);
    expect(isMiriamKessler("Dr. Rainer Hollmann")).toBe(false);
  });
});

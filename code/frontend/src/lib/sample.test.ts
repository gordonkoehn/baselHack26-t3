import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LUMEN_GUIDE,
  QUARTIER_BOERSE,
  QUARTIER_BOERSE_GUIDE,
  SAMPLE_TRANSCRIPT,
  isLumenPersona,
} from "./sample";

describe("demo samples", () => {
  it("keeps the test case an exact copy of the documentation", () => {
    const doc = resolve(import.meta.dirname, "../../../../documentation/testcase-quartier-boerse.md");

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

  it("keeps the Lumen guide an exact copy of the short guide in the documentation", () => {
    const doc = resolve(
      import.meta.dirname,
      "../../../../documentation/usecases/lumen-ipp/interview/guide-short-miriam-kessler.txt",
    );

    expect(LUMEN_GUIDE).toEqual(readFileSync(doc, "utf8").split("\n").filter(Boolean));
  });

  it("gives Lumen personas the Lumen guide, whatever their title", () => {
    expect(isLumenPersona("Dr. Miriam Kessler")).toBe(true);
    expect(isLumenPersona("Miriam Kessler")).toBe(true);
    expect(isLumenPersona("Sandra")).toBe(false);
  });
});

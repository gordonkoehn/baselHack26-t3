import { describe, expect, it } from "vitest";
import { guideLines, productForSession } from "./ProductBrief";
import { formatReportMarkdown } from "@/lib/reportMarkdown";
import type { InsightReport } from "@/lib/contracts";

describe("productForSession", () => {
  it("trims the brief and turns an empty link into null", () => {
    expect(productForSession({ name: "  GlowPot ", description: " A smart pot. ", prototypeUrl: "  " })).toEqual({
      name: "GlowPot",
      description: "A smart pot.",
      prototypeUrl: null,
    });
  });

  it("keeps a link", () => {
    expect(productForSession({ name: "A", description: "B", prototypeUrl: " https://x.test " })?.prototypeUrl).toBe(
      "https://x.test",
    );
  });

  it("sends nothing while name or description is blank, so the backend never sees an invalid brief", () => {
    expect(productForSession({ name: " ", description: "B" })).toBeNull();
    expect(productForSession({ name: "A", description: "" })).toBeNull();
  });
});

describe("guideLines", () => {
  it("drops blank lines and trims each question", () => {
    expect(guideLines(" Q1 \n\n  \nQ2")).toEqual(["Q1", "Q2"]);
  });
});

describe("Markdown export", () => {
  const report: InsightReport = { sessionId: "s_1", generatedAt: "2026-10-31T18:00:00Z", questions: [] };

  it("names the product tested, escaped like other report text", () => {
    expect(formatReportMarkdown(report, "Sandra", false, "Glow*Pot")).toContain("Product tested: Glow\\*Pot");
  });

  it("leaves the line out without a product", () => {
    expect(formatReportMarkdown(report, "Sandra")).not.toContain("Product tested");
  });
});

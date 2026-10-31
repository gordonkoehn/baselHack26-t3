import { createElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProductBrief, guideLines, productForSession } from "./ProductBrief";
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

  it("preserves an explicitly cleared link as null", () => {
    expect(productForSession({ name: "A", description: "B", prototypeUrl: null })).toEqual({
      name: "A", description: "B", prototypeUrl: null,
    });
  });

  it("sends nothing while name or description is blank, so the backend never sees an invalid brief", () => {
    expect(productForSession({ name: " ", description: "B" })).toBeNull();
    expect(productForSession({ name: "A", description: "" })).toBeNull();
  });
});

describe("Product field intent", () => {
  it.each([
    { label: /Product name/, value: "Own name", patch: { name: "Own name" } },
    { label: /What it is/, value: "Own description", patch: { description: "Own description" } },
    { label: /Prototype link/, value: "https://example.invalid/own", patch: { prototypeUrl: "https://example.invalid/own" } },
    { label: /Product name/, value: "", patch: { name: "" } },
    { label: /What it is/, value: "", patch: { description: "" } },
    { label: /Prototype link/, value: "", patch: { prototypeUrl: "" } },
  ])("reports only the edited field, including clears: $patch", ({ label, value, patch }) => {
    const onProduct = vi.fn();
    const onGuide = vi.fn();
    render(createElement(ProductBrief, {
      product: { name: "Sample", description: "Sample description", prototypeUrl: "https://example.invalid/sample" },
      onProduct, guide: "Sample question?", onGuide, onNext: vi.fn(),
    }));
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
    expect(onProduct).toHaveBeenCalledExactlyOnceWith(patch);
    expect(onGuide).not.toHaveBeenCalled();
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

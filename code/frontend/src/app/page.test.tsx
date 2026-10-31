import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TEAM_TWIN, QUARTIER_BOERSE_GUIDE } from "@/lib/sample";
import Home from "./studio/page";

// The home page only needs the persona list on load; it stays empty here.
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: { listPersonas: vi.fn().mockResolvedValue([]) },
}));

describe("studio page", () => {
  it("fills the sources form with the team twin sample", () => {
    render(<Home />);

    fireEvent.click(screen.getByRole("button", { name: "Team twin" }));

    TEAM_TWIN.forEach((source, i) => {
      expect(screen.getByLabelText(`Source ${i + 1} title`)).toHaveProperty("value", source.title);
      expect(screen.getByLabelText(`Source ${i + 1} kind`)).toHaveProperty("value", source.kind);
      expect(screen.getByLabelText(`Source ${i + 1} text`)).toHaveProperty("value", source.text);
    });
    expect(screen.queryByLabelText(`Source ${TEAM_TWIN.length + 1} text`)).toBeNull();
  });
});

describe("scoped studio defaults", () => {
  it("starts with English and keeps the spoken language separate from source quotes", () => {
    render(<Home />);
    expect(screen.getByLabelText("Conversation language")).toHaveProperty("value", "en");
    expect(screen.getByText("The spoken interview language. Source quotes stay in their original language.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Conversation language"), { target: { value: "de" } });
    expect(screen.getByLabelText("Conversation language")).toHaveProperty("value", "de");
  });

  it.each([
    { label: "Product name", value: "Own prototype", name: "Own prototype", prototypeUrl: "" },
    { label: "Prototype link (optional)", value: "https://example.invalid/own", name: "", prototypeUrl: "https://example.invalid/own" },
  ])("clears untouched sample fields for custom sources after editing only $label", ({ label, value, name, prototypeUrl }) => {
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "Product" }));
    expect(screen.getByLabelText("Product name")).toHaveProperty("value", "Quartier-Börse");
    fireEvent.change(screen.getByLabelText(label, { exact: false }), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    fireEvent.change(screen.getByLabelText("Source 1 text"), { target: { value: "Own source material" } });
    fireEvent.click(screen.getByRole("button", { name: "Product" }));
    expect(screen.getByLabelText(/What it is/)).toHaveProperty("value", "");
    expect(screen.getByLabelText("Product name")).toHaveProperty("value", name);
    expect(screen.getByLabelText("Prototype link (optional)", { exact: false })).toHaveProperty("value", prototypeUrl);
    expect(screen.getByLabelText(/Sprint questions, one per line/)).toHaveProperty("value", "");
  });

  it("gives the Team twin empty product/questions and restores defaults only on reset", () => {
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "Team twin" }));
    fireEvent.click(screen.getByRole("button", { name: "Product" }));
    expect(screen.getByLabelText("Product name")).toHaveProperty("value", "");
    expect(screen.getByLabelText(/Sprint questions, one per line/)).toHaveProperty("value", "");
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset to example" }));
    fireEvent.click(screen.getByRole("button", { name: "Product" }));
    expect(screen.getByLabelText("Product name")).toHaveProperty("value", "Quartier-Börse");
    expect(screen.getByLabelText(/Sprint questions, one per line/)).toHaveProperty("value", QUARTIER_BOERSE_GUIDE.join("\n"));
  });

  it("retains each explicit field and empty guide when sources change and defaults return", () => {
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "Product" }));
    fireEvent.change(screen.getByLabelText("Product name"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText(/What it is/), { target: { value: "Own description" } });
    fireEvent.change(screen.getByLabelText(/Prototype link/), { target: { value: "https://example.invalid/own" } });
    fireEvent.change(screen.getByLabelText(/Prototype link/), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText(/Sprint questions/), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    const original = (screen.getByLabelText("Source 1 text") as HTMLTextAreaElement).value;
    for (const text of ["Own source", original]) {
      fireEvent.change(screen.getByLabelText("Source 1 text"), { target: { value: text } });
      fireEvent.click(screen.getByRole("button", { name: "Product" }));
      expect(screen.getByLabelText("Product name")).toHaveProperty("value", "");
      expect(screen.getByLabelText(/What it is/)).toHaveProperty("value", "Own description");
      expect(screen.getByLabelText(/Prototype link/)).toHaveProperty("value", "");
      expect(screen.getByLabelText(/Sprint questions/)).toHaveProperty("value", "");
      expect(screen.getByRole("button", { name: "Next: add sources" })).toHaveProperty("disabled", true);
      fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    }
  });
});

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

  it("clears sample defaults for custom sources while retaining an explicitly described product", () => {
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "Product" }));
    expect(screen.getByLabelText("Product name")).toHaveProperty("value", "Quartier-Börse");
    fireEvent.change(screen.getByLabelText("Product name"), { target: { value: "Own prototype" } });
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    fireEvent.change(screen.getByLabelText("Source 1 text"), { target: { value: "Own source material" } });
    fireEvent.click(screen.getByRole("button", { name: "Product" }));
    expect(screen.getByLabelText("Product name")).toHaveProperty("value", "Own prototype");
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
});

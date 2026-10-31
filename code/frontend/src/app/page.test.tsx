import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TEAM_TWIN } from "@/lib/sample";
import Home from "./page";

// The home page only needs the persona list on load; it stays empty here.
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: { listPersonas: vi.fn().mockResolvedValue([]) },
}));

describe("home page", () => {
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

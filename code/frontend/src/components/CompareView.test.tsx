import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { CompareView } from "./CompareView";

const IDS = ["s_1", "s_2"];

afterEach(() => vi.restoreAllMocks());

describe("CompareView", () => {
  it("names the interview whose transcript may have gaps", async () => {
    vi.spyOn(api, "insightSummary").mockResolvedValue({ transcriptGapSessionIds: ["s_2"], questions: [] });
    render(<CompareView sessionIds={IDS} />);
    expect((await screen.findByTestId("compare-gaps")).textContent).toContain("The transcript of Interview 2 may have gaps");
  });

  it("says nothing about gaps when none is known", async () => {
    vi.spyOn(api, "insightSummary").mockResolvedValue({ transcriptGapSessionIds: [], questions: [] });
    render(<CompareView sessionIds={IDS} />);
    await screen.findByTestId("compare-table");
    expect(screen.queryByTestId("compare-gaps")).toBeNull();
  });
});

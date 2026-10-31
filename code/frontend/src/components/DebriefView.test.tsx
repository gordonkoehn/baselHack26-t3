import { fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "@/lib/api";
import type { InsightReport } from "@/lib/contracts";
import { DebriefView } from "./DebriefView";

const REPORT: InsightReport = {
  sessionId: "s_1",
  generatedAt: "2026-10-31T14:31:30Z",
  questions: [
    {
      question: "Does matching work?",
      signal: "contradicts",
      insights: [
        { id: "i1", theme: "Doubling convinces", quote: "Dann geb ich alles.", turnSeq: 3, label: "grounded", evidenceId: "e1" },
        { id: "i2", theme: "Feels like marketing", quote: "Klingt nach Werbung.", turnSeq: 5, label: "guess", evidenceId: null },
      ],
      followUps: ["Ask how they split without the badge."],
    },
  ],
};

function show(props = { sessionId: "s_1", personaName: "Anna" }) {
  return render(<DebriefView {...props} />);
}

beforeEach(() => {
  // jsdom has no layout, so it doesn't implement this.
  Element.prototype.scrollIntoView = vi.fn();
});

describe("DebriefView", () => {
  it("renders themes, quotes, source labels and follow-ups per insight", async () => {
    vi.spyOn(api, "debrief").mockResolvedValue(REPORT);
    const { container } = show();

    await screen.findByTestId("debrief");

    screen.getByText("Does matching work?");
    screen.getByText("contradicts");
    // Once in the summary and once in the details.
    expect(screen.getAllByText("Doubling convinces", { exact: false })).toHaveLength(2);
    screen.getByText("Feels like marketing", { exact: false });
    screen.getByText("Ask real users next: Ask how they split without the badge.");
    const [backed, unbacked] = Array.from(container.querySelectorAll("blockquote"), (quote) => quote.textContent);
    expect(backed).toBe("“Dann geb ich alles.”Anna · interview turn 3 · also in the sources");
    expect(unbacked).toBe("“Klingt nach Werbung.”Anna · interview turn 5 · not backed by the sources");
    const labels = Array.from(container.querySelectorAll("li li > span"), (label) => label.textContent);
    expect(labels).toEqual(["grounded", "guess"]);
  });

  it("leads with a summary of what held up and what didn't", async () => {
    render(<DebriefView sessionId="s_1" personaName="Sandra" savedReport={REPORT} />);

    const summary = await screen.findByTestId("debrief-summary");
    expect(summary.textContent).toContain("Doubling convinces");
    expect(screen.getByTestId("debrief").firstElementChild?.nextElementSibling).toBe(summary);
  });

  it("states that the persona is an AI and the quotes are hypotheses", async () => {
    vi.spyOn(api, "debrief").mockResolvedValue(REPORT);
    show();

    const debrief = await screen.findByTestId("debrief");

    expect(debrief.textContent).toContain("Anna, an AI persona: hypotheses to check with real users, not findings.");
  });

  it("shows the gaps banner on a report whose transcript has gaps, generated or saved", async () => {
    vi.spyOn(api, "debrief").mockResolvedValue({ ...REPORT, transcriptGaps: true });
    const { unmount } = show();
    expect((await screen.findByTestId("transcript-gaps")).textContent).toContain("This transcript has gaps");
    unmount();

    render(<DebriefView sessionId="s_1" personaName="Anna" savedReport={{ ...REPORT, transcriptGaps: true }} />);
    expect((await screen.findByTestId("transcript-gaps")).textContent).toContain("This transcript has gaps");
  });

  it("opens a gapped report with the warning, before the summary", async () => {
    render(<DebriefView sessionId="s_1" personaName="Anna" savedReport={{ ...REPORT, transcriptGaps: true }} />);
    const position = screen.getByTestId("transcript-gaps").compareDocumentPosition(screen.getByTestId("debrief-summary"));
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows no gaps banner when none are known", async () => {
    vi.spyOn(api, "debrief").mockResolvedValue({ ...REPORT, transcriptGaps: false });
    show();
    await screen.findByTestId("debrief");
    expect(screen.queryByTestId("transcript-gaps")).toBeNull();
  });

  it("explains a call with nothing to debrief and offers no retry that cannot succeed", async () => {
    const debrief = vi.spyOn(api, "debrief").mockRejectedValue(new ApiError(422, "finalized transcript needs a nonblank persona utterance"));
    show();

    const alert = await screen.findByRole("alert");

    expect(alert.textContent).toContain("no persona answer was saved");
    expect(alert.textContent).not.toContain("422");
    expect(alert.textContent).not.toContain("nonblank");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create debrief" })).toBeNull();
    expect(debrief).toHaveBeenCalledOnce();
  });

  it("renders an empty report without questions or errors", async () => {
    vi.spyOn(api, "debrief").mockResolvedValue({ ...REPORT, questions: [] });
    const { container } = show();

    await screen.findByTestId("debrief");

    expect(container.querySelectorAll("li")).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders a question without insights or follow-ups", async () => {
    vi.spyOn(api, "debrief").mockResolvedValue({
      ...REPORT,
      questions: [{ question: "Anyone there?", signal: "unclear", insights: [] }],
    });
    const { container } = show();

    await screen.findByText("Anyone there?");

    expect(container.querySelectorAll("blockquote")).toHaveLength(0);
    expect(screen.queryByText("Ask real users next", { exact: false })).toBeNull();
  });

  it("asks for the debrief once per session, also when React runs effects twice", async () => {
    const debrief = vi.spyOn(api, "debrief").mockResolvedValue(REPORT);
    render(
      <StrictMode>
        <DebriefView sessionId="s_1" personaName="Anna" />
      </StrictMode>,
    );

    await screen.findByTestId("debrief");

    expect(debrief).toHaveBeenCalledOnce();
    expect(debrief).toHaveBeenCalledWith("s_1");
  });

  it("shows a saved report read-only: no model call and no link to copy", async () => {
    const debrief = vi.spyOn(api, "debrief").mockResolvedValue(REPORT);
    render(<DebriefView sessionId="s_1" personaName="Anna" savedReport={REPORT} />);

    await screen.findByTestId("debrief");

    expect(debrief).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull();
  });

  it.each([
    [new ApiError(409, "turn 4 missing"), "The transcript is not complete yet: turn 4 missing"],
    [new ApiError(503, "down"), "The debrief model is unavailable right now. Try again in a moment."],
    [new ApiError(500, "boom"), "Debrief failed (500): boom"],
    [new TypeError("Failed to fetch"), "Backend not reachable."],
  ])("explains %s and recovers on retry", async (failure, message) => {
    const debrief = vi.spyOn(api, "debrief").mockRejectedValueOnce(failure).mockResolvedValueOnce(REPORT);
    show();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(message);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await screen.findByTestId("debrief");
    expect(debrief).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

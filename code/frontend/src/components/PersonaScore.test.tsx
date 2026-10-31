import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { StrictMode, useMemo } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import exampleReport from "../../../shared/examples/coverage-report.json";
import examplePersona from "../../../shared/examples/persona.json";
import { ApiError, api } from "@/lib/api";
import type { CoverageReport, Persona, PersonaSource } from "@/lib/contracts";
import { QUARTIER_BOERSE } from "@/lib/sample";
import { OPEN_GOAL, SAMPLE_GOAL, localDiversity, startingInput, useCoverage, type Coverage } from "@/lib/useCoverage";
import { PersonaScore } from "./PersonaScore";

const PERSONA = { ...examplePersona, id: "p_1", version: 1 } as unknown as Persona;
const REPORT = exampleReport as unknown as CoverageReport;
const NOTE: PersonaSource = { kind: "note", title: "Guide", text: "Schritt eins" };
const CALL: PersonaSource = { kind: "transcript", title: "Call", text: "Ich zahle mit TWINT" };

const idle = (over: Partial<Coverage> = {}) =>
  ({ current: null, stale: false, checking: false, error: null, check: vi.fn(), ...over }) as unknown as Coverage;

function show(coverage: Coverage, sources: PersonaSource[] = [NOTE, CALL]) {
  const onInterview = vi.fn();
  const onAddMore = vi.fn();
  render(<PersonaScore persona={PERSONA} sources={sources} coverage={coverage} onInterview={onInterview} onAddMore={onAddMore} />);
  return { onInterview, onAddMore };
}

const interview = () => screen.getByRole("button", { name: "Go to the interview" });
const addMore = () => screen.getByRole("button", { name: "Add more" });

describe("PersonaScore", () => {
  it("shows each category's percentage, level word, reason and recommendation", () => {
    show(idle({ current: REPORT }));
    const persona = screen.getByTestId("score-Persona");
    expect(persona.textContent).toContain("29%");
    expect(persona.textContent).toContain("Red");
    expect(persona.textContent).toContain(REPORT.categories[0].reason);
    expect(persona.textContent).toContain(REPORT.categories[0].recommendation!);
    expect(screen.getByTestId("score-Challenge understanding").textContent).toContain("Yellow");
    const solution = screen.getByTestId("score-Solution");
    expect(solution.textContent).toContain("75%");
    expect(solution.textContent).toContain("Green");
    expect(solution.textContent).not.toContain("Add a source");
  });

  it("gives one overall line in words and no overall number", () => {
    show(idle({ current: REPORT }));
    expect(screen.getByTestId("score-overall").textContent).toContain("Add more first.");
    expect(screen.queryByText(`${Math.round(REPORT.score * 100)}%`)).toBeNull();
  });

  it("says good enough to test and makes the interview the primary choice", () => {
    show(idle({ current: { ...REPORT, overall: "good_enough" } }));
    expect(screen.getByTestId("score-overall").textContent).toContain("Good enough to test.");
    expect(interview().className).toContain("bg-accent");
    expect(addMore().className).not.toContain("bg-accent");
  });

  it("makes adding more the primary choice when that is the advice, and still lets you interview", () => {
    const { onInterview, onAddMore } = show(idle({ current: REPORT }));
    expect(addMore().className).toContain("bg-accent");
    fireEvent.click(interview());
    fireEvent.click(addMore());
    expect(onInterview).toHaveBeenCalledOnce();
    expect(onAddMore).toHaveBeenCalledOnce();
  });

  it("says so when no check has run, with no level anywhere", () => {
    show(idle());
    expect(screen.getByTestId("score-overall").textContent).toContain("No check has run yet.");
    expect(screen.getAllByText("Not checked")).toHaveLength(3);
    expect(screen.queryByText(/^(Red|Yellow|Green)$/)).toBeNull();
    expect(screen.getByTestId("score-Persona").textContent).not.toContain("%");
  });

  it("announces a running check and leaves both buttons working", () => {
    show(idle({ checking: true }));
    expect(screen.getByRole("status").textContent).toContain("Checking");
    expect((interview() as HTMLButtonElement).disabled).toBe(false);
    expect((addMore() as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a failed check, offers a retry and does not block the interview", () => {
    const check = vi.fn();
    const { onInterview } = show(idle({ error: "The coverage service is temporarily unavailable.", check }));
    expect(screen.getByRole("alert").textContent).toContain("temporarily unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(check).toHaveBeenCalledOnce();
    fireEvent.click(interview());
    expect(onInterview).toHaveBeenCalledOnce();
  });

  it("never shows the levels of an older version", () => {
    show(idle({ stale: true }));
    expect(screen.getByTestId("score-overall").textContent).toContain("changed since the last check");
    expect(screen.queryByText("Red")).toBeNull();
  });

  it("uses the server's source count once there is a report", () => {
    show(idle({ current: { ...REPORT, sourceDiversity: { count: 3, kinds: ["note"], minimum: 2, met: true } } }), []);
    expect(screen.getByTestId("source-diversity").textContent).toContain("3 of at least 2 sources (note)");
  });

  it("counts the sources it holds before a check, and flags too few", () => {
    show(idle(), [NOTE]);
    expect(screen.getByTestId("source-diversity").textContent).toContain("1 of at least 2 sources (note). Too few to rely on.");
  });

  it("doesn't guess a source count for a library persona without a check", () => {
    show(idle(), []);
    expect(screen.getByTestId("source-diversity").textContent).toContain("not counted yet.");
  });
});

describe("localDiversity", () => {
  it("counts the same text once, like the server", () => {
    expect(localDiversity([NOTE, { ...NOTE, text: "  schritt   EINS " }, CALL])).toEqual({
      count: 2,
      kinds: ["note", "transcript"],
      minimum: 2,
      met: true,
    });
  });
});

describe("startingInput", () => {
  const sample: PersonaSource[] = [{ kind: "note", title: "x", text: QUARTIER_BOERSE }];

  it("keeps what the user wrote", () => {
    expect(startingInput({ goal: "My test", criteria: ["a", 1] }, [])).toEqual({ goal: "My test", criteria: ["a"] });
  });

  it("uses the sample's goal only for the sample's sources", () => {
    expect(startingInput(null, sample).goal).toBe(SAMPLE_GOAL);
    expect(startingInput(null, [NOTE]).goal).toBe(OPEN_GOAL);
    expect(startingInput({ goal: SAMPLE_GOAL }, [NOTE]).goal).toBe(OPEN_GOAL);
  });
});

describe("useCoverage", () => {
  const options = { onReport: vi.fn(), onAnswered: vi.fn() };
  const mount = (initial: CoverageReport | null, sources: PersonaSource[] = [NOTE]) =>
    renderHook(() => useCoverage({ persona: PERSONA, sources: useMemo(() => sources, []), initial, ...options }), {
      wrapper: StrictMode,
    });

  beforeEach(() => {
    localStorage.clear();
    options.onReport.mockClear();
  });

  it("runs one check by itself, even in strict mode", async () => {
    const check = vi.spyOn(api, "checkCoverage").mockResolvedValue(REPORT);
    const { result } = mount(null);
    await waitFor(() => expect(result.current.current).toEqual(REPORT));
    expect(check).toHaveBeenCalledOnce();
    expect(check).toHaveBeenCalledWith("p_1", { testGoal: OPEN_GOAL, criteria: [] });
    expect(options.onReport).toHaveBeenCalledWith(REPORT);
  });

  it("doesn't pay for a check the workspace still holds", async () => {
    const check = vi.spyOn(api, "checkCoverage").mockResolvedValue(REPORT);
    const { result } = mount(REPORT);
    await waitFor(() => expect(result.current.goal).toBe(OPEN_GOAL));
    expect(check).not.toHaveBeenCalled();
  });

  it("keeps the failure for the screen to show", async () => {
    vi.spyOn(api, "checkCoverage").mockRejectedValue(new ApiError(503, "down"));
    const { result } = mount(null);
    await waitFor(() => expect(result.current.error).toBe("The coverage service is temporarily unavailable."));
    expect(result.current.current).toBeNull();
  });

  it("remembers an edited goal, not a default that was only shown", async () => {
    vi.spyOn(api, "checkCoverage").mockResolvedValue(REPORT);
    const { result } = mount(null);
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(localStorage.getItem("opentwin.coverage")).toBeNull();
    act(() => result.current.setGoal("My test"));
    expect(JSON.parse(localStorage.getItem("opentwin.coverage")!).goal).toBe("My test");
  });
});

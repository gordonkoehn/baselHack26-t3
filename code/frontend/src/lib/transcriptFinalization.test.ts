import { describe, expect, it } from "vitest";
import { TranscriptWork, drainDescription } from "./transcriptFinalization";

// Sorted: what is outstanding matters here, not the order it was added in.
function pendingOf(work: TranscriptWork) {
  return [...work.pending].sort();
}

describe("TranscriptWork", () => {
  it("waits for speech, its transcript, the response and its playback before it is drained", () => {
    const work = new TranscriptWork();

    work.speech("one");
    expect(pendingOf(work)).toEqual(["s:one", "v:one"]);

    work.commit("one");
    expect(pendingOf(work)).toEqual(["t:one", "v:one"]);

    expect(work.transcribed("one")).toBe(true);
    expect(pendingOf(work)).toEqual(["v:one"]);

    work.created("answer");
    expect(pendingOf(work)).toEqual(["r:answer"]);

    work.playback("answer", false);
    expect(work.done("answer")).toBe(true);
    expect(pendingOf(work)).toEqual(["p:answer"]);

    work.playback("answer", true);
    expect(pendingOf(work)).toEqual([]);
  });

  it("records a redelivered transcript and a redelivered response only once", () => {
    const work = new TranscriptWork();
    work.speech("one");
    work.commit("one");

    expect(work.transcribed("one")).toBe(true);
    expect(work.transcribed("one")).toBe(false);
    expect(work.done("answer")).toBe(true);
    expect(work.done("answer")).toBe(false);
  });

  it("does not record a failed transcription, but no longer waits for it", () => {
    const work = new TranscriptWork();
    work.speech("one");
    work.commit("one");

    expect(work.transcribed("one", true)).toBe(false);
    expect(pendingOf(work)).toEqual(["v:one"]);
  });

  it("handles a response that finishes before response.created arrives", () => {
    const work = new TranscriptWork();
    work.speech("one");
    work.commit("one");
    work.transcribed("one");

    work.done("answer");
    work.created("answer");

    expect(pendingOf(work)).toEqual([]);
  });

  it("only reserves a manual commit while speech is still waiting for one", () => {
    const work = new TranscriptWork();
    expect(work.reserveCommit()).toBe(false);

    work.speech("one");
    expect(work.reserveCommit()).toBe(true);

    work.commit("one");
    expect(work.reserveCommit()).toBe(false);
  });
});

describe("TranscriptWork.missingTurns", () => {
  it("does not count audio still playing once its response has finished: the words are saved", () => {
    const work = new TranscriptWork();
    work.created("answer");
    work.playback("answer", false);
    expect(work.missingTurns).toBe(true);

    work.done("answer");
    expect(pendingOf(work)).toEqual(["p:answer"]);
    expect(work.missingTurns).toBe(false);
  });

  it("counts audio from a response with no terminal event: its words have not arrived", () => {
    const work = new TranscriptWork();
    work.playback("answer", false);
    expect(work.missingTurns).toBe(true);
  });

  it.each([
    ["speech not committed", (work: TranscriptWork) => work.speech("one")],
    ["a transcript not arrived", (work: TranscriptWork) => work.commit("one")],
    ["a response not finished", (work: TranscriptWork) => work.created("answer")],
    ["a typed question not answered", (work: TranscriptWork) => work.pending.add("a:1")],
  ])("counts %s", (_name, open) => {
    const work = new TranscriptWork();
    open(work);
    expect(work.missingTurns).toBe(true);
  });

  it("is false when nothing is open", () => {
    expect(new TranscriptWork().missingTurns).toBe(false);
  });
});

describe("TranscriptWork.unrecordedTurns", () => {
  it("counts a finished response that was heard but saved no words", () => {
    const work = new TranscriptWork();
    work.created("silent");
    work.playback("silent", false);
    expect(work.unrecordedTurns).toBe(false); // Not finished: missingTurns covers it.
    work.done("silent");
    work.playback("silent", true);
    expect(work.unrecordedTurns).toBe(true);
    expect(work.missingTurns).toBe(false); // Nothing can arrive to wait for.
  });

  it.each([
    ["before the response ends", true],
    ["after the response ends", false],
  ])("does not count heard words saved %s", (_name, first) => {
    const work = new TranscriptWork();
    work.created("answer");
    work.playback("answer", false);
    if (first) work.spoke("answer");
    work.done("answer");
    if (!first) work.spoke("answer");
    expect(work.unrecordedTurns).toBe(false);
  });

  it("does not count a response nobody heard", () => {
    const work = new TranscriptWork();
    work.created("unheard");
    work.done("unheard");
    expect(work.unrecordedTurns).toBe(false);
  });

  it.each([
    ["while the response runs", ["commit", "created", "blank", "spoke", "done"]],
    ["after the response ended", ["commit", "created", "spoke", "done", "blank"]],
    ["with no response.created", ["commit", "blank", "spoke", "done"]],
  ])("counts words answering speech that transcribed to nothing, blank %s", (_name, steps) => {
    const work = new TranscriptWork();
    const run: Record<string, () => void> = {
      commit: () => work.commit("speech"), blank: () => work.blank("speech"),
      created: () => work.created("answer"), spoke: () => work.spoke("answer"), done: () => work.done("answer"),
    };
    steps.forEach((step) => run[step]());
    expect(work.unrecordedTurns).toBe(true);
  });

  it("does not count blank speech alone, a wordless reply to it, or a later unrelated answer", () => {
    const work = new TranscriptWork();
    work.commit("noise");
    work.blank("noise");
    expect(work.unrecordedTurns).toBe(false);
    work.done("empty-reply");
    expect(work.unrecordedTurns).toBe(false);
    work.commit("real");
    work.transcribed("real");
    work.created("answer");
    work.spoke("answer");
    work.done("answer");
    expect(work.unrecordedTurns).toBe(false);
  });

  // That input was in the model's context when it answered, and blank can't tell noise from lost
  // speech. Blaming only the latest input would let a real lost question look complete.
  it("warns when blank speech that got no reply of its own is followed by an answer", () => {
    const work = new TranscriptWork();
    work.commit("noise");
    work.transcribed("noise");
    work.blank("noise");
    work.commit("real");
    work.transcribed("real");
    work.created("answer");
    work.spoke("answer");
    work.done("answer");
    expect(work.unrecordedTurns).toBe(true);
  });
});

describe("drainDescription", () => {
  it.each([
    [["s:one"], "Transcribing the last sentence"],
    [["t:one"], "Transcribing the last sentence"],
    [["v:one"], "Waiting for the persona response"],
    [["r:one"], "Waiting for the persona response"],
    [["p:one"], "Waiting for the persona response"],
    [["a:one"], "Waiting for the typed question or shared screen response"],
    [["t:one", "r:two"], "Transcribing the last sentence · Waiting for the persona response"],
    [[], "Checking the final provider events"],
  ])("describes %j", (pending, description) => {
    expect(drainDescription(new Set(pending))).toBe(description);
  });
});

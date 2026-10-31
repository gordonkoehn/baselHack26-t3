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

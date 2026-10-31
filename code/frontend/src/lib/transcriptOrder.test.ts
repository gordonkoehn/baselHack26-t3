import { describe, expect, it } from "vitest";
import { TranscriptOrder } from "./transcriptOrder";

const texts = (order: TranscriptOrder) => order.release().map((turn) => turn.text);

describe("TranscriptOrder", () => {
  it("releases past a failed transcription, whose place stays visible without text", () => {
    const order = new TranscriptOrder();
    order.speechCommitted("u1");
    order.speechFailed("u1");
    order.responseCreated("r1");
    order.answer("r1", "a1", "Answer.");
    order.responseDone("r1", false);

    expect(texts(order)).toEqual(["Answer."]);
    expect(order.turns()).toEqual([{ who: "interviewer", text: null }, { who: "persona", text: "Answer." }]);
  });

  it("still holds later turns behind a transcription that is on its way", () => {
    const order = new TranscriptOrder();
    order.speechCommitted("u1");
    order.responseCreated("r1");
    order.answer("r1", "a1", "Answer.");
    order.responseDone("r1", false);

    expect(texts(order)).toEqual([]);
    expect(order.turns().map((turn) => turn.held)).toEqual([undefined, true]);

    order.speechDone("u1", "Question?");
    expect(texts(order)).toEqual(["Question?", "Answer."]);
  });

  it("keeps a transcript that arrives after its failure at the end, because stored text can't move", () => {
    const order = new TranscriptOrder();
    order.speechCommitted("u1");
    order.speechFailed("u1");
    order.answer("r1", "a1", "Answer.");
    expect(texts(order)).toEqual(["Answer."]);

    order.speechDone("u1", "Late question?");

    expect(texts(order)).toEqual(["Late question?"]);
    expect(order.turns().map((turn) => turn.text)).toEqual(["Answer.", "Late question?"]);
  });

  it("at close gives up what is still open, so everything it held back is released", () => {
    const order = new TranscriptOrder();
    order.speechCommitted("u1");
    order.responseCreated("r1");
    order.answer("r1", "a1", "Part of an answer.");
    expect(texts(order)).toEqual([]);

    expect(order.close()).toBe(true);

    expect(texts(order)).toEqual(["Part of an answer."]);
    expect(order.turns()).toEqual([{ who: "interviewer", text: null }, { who: "persona", text: "Part of an answer." }]);
  });

  it("at close reports nothing given up when every turn had settled", () => {
    const order = new TranscriptOrder();
    order.speechCommitted("u1");
    order.speechDone("u1", "Question?");
    order.responseDone("r1", false);

    expect(order.close()).toBe(false);
    expect(texts(order)).toEqual(["Question?"]);
  });
});

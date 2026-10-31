// Offline checks supplement the behavioral browser suite; no provider or socket is used.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function sourceModule(path) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

const { TranscriptWork, drainDescription } = await sourceModule("../src/lib/transcriptFinalization.ts");
const { api, RequestDeadlineError, ApiError } = await sourceModule("../src/lib/api.ts");

test("transcription cannot settle the expected automatic VAD response", () => {
  const work = new TranscriptWork();
  work.speech("one");
  work.commit("one");
  assert.equal(work.transcribed("one"), true);
  assert.equal(work.transcribed("one"), false);
  assert.deepEqual([...work.pending], ["v:one"]);
  work.created("answer");
  assert.deepEqual([...work.pending], ["r:answer"]);
  work.done("answer");
  work.commit("one");
  work.speech("one");
  assert.equal(work.pending.size, 0);
});

test("speech terminal before commit and duplicate speech cannot reopen a finished input", () => {
  const work = new TranscriptWork();
  work.speech("one");
  work.speech("two");
  work.transcribed("two");
  work.commit("two");
  work.speech("two");
  assert.equal(work.transcribed("two"), false);
  work.transcribed("one");
  work.done("answer-one");
  work.done("answer-two");
  assert.equal(work.pending.size, 0);
});

for (const commits of [["vad", "manual"], ["manual", "vad"]]) {
  test(`manual/VAD race preserves both committed items (${commits.join(" first, then ")})`, () => {
    const work = new TranscriptWork();
    work.speech("vad");
    assert.equal(work.reserveCommit(), true);
    for (const id of commits) work.commit(id);
    for (const id of commits) work.commit(id); // Redelivery must not expect a second manual response.
    assert.equal(work.transcribed("vad"), true);
    assert.equal(work.transcribed("manual"), true);
    assert.equal(work.transcribed("vad"), false);
    assert.equal(work.transcribed("manual"), false);
    assert.deepEqual([...work.pending], ["v:vad"]);
    work.done("answer");
    for (const id of commits) work.commit(id);
    assert.equal(work.pending.size, 0);
  });
}

test("manual-first response remains attributed when the distinct VAD commit arrives later", () => {
  const work = new TranscriptWork();
  work.speech("vad");
  assert.equal(work.reserveCommit(), true);
  work.commit("manual");
  work.transcribed("manual");
  work.created("answer");
  work.commit("vad");
  work.transcribed("vad");
  work.done("answer");
  assert.deepEqual([...work.pending], []);
});

// Synthetic causal permutations, not observed transport traces. A response is
// attributed to the oldest confirmed request first, then suspended source speech;
// these groups contain one actual default-conversation response, never an
// arbitrary unrelated response. Input IDs remain independent transcription work.
function causalOrders(events, prerequisites) {
  if (events.length === 0) return [[]];
  return events.flatMap((event) => {
    if ((prerequisites[event] ?? []).some((prior) => events.includes(prior))) return [];
    return causalOrders(events.filter((other) => other !== event), prerequisites)
      .map((rest) => [event, ...rest]);
  });
}

const distinctOrders = causalOrders(["manualCommit", "manualText", "vadCommit", "vadText", "created", "done", "stopped"], {
  manualText: ["manualCommit"], vadText: ["vadCommit"], done: ["created"],
});
const retainedOrders = causalOrders(["vadCommit", "vadText", "created", "done", "stopped"], {
  vadText: ["vadCommit"], done: ["created"], stopped: ["vadCommit", "created"],
});

for (const retained of [false, true]) {
  for (const missing of [null, "manualText", "vadText", "done"]) {
    if (retained && missing === "manualText") continue;
    test(`causal ${retained ? "retained-ID late-stop" : "distinct-ID manual/VAD"} permutations preserve ${missing ?? "complete work"}`, () => {
      const orders = retained ? retainedOrders : distinctOrders;
      assert.equal(orders.length, retained ? 16 : 630);
      for (const order of orders) {
        for (const duplicate of [false, true]) {
          const work = new TranscriptWork();
          work.speech("vad");
          assert.equal(work.reserveCommit(), true);
          const actions = {
            manualCommit: () => work.commit("manual"),
            manualText: () => work.transcribed("manual"),
            vadCommit: () => work.commit("vad"),
            vadText: () => work.transcribed("vad"),
            created: () => work.created("answer"),
            done: () => work.done("answer"),
            stopped: () => work.stopped("vad"),
          };
          const deliver = (event) => { if (event !== missing) actions[event](); };
          for (const event of order) {
            deliver(event);
            if (duplicate) deliver(event);
          }
          if (duplicate) {
            for (const event of order) deliver(event);
            work.speech("vad");
          }
          const context = `${order.join(",")} duplicate=${duplicate}`;
          if (!missing) assert.deepEqual([...work.pending], [], context);
          else assert.deepEqual([...work.pending], [missing === "done" ? "r:answer" : `t:${missing === "vadText" ? "vad" : "manual"}`], context);
        }
      }
    });
  }
}

test("manual-first suspended speech cannot consume a response belonging to an older typed request", () => {
  const work = new TranscriptWork();
  work.pending.add("a:older");
  work.speech("vad");
  work.reserveCommit();
  work.commit("manual");
  work.transcribed("manual");
  work.created("older-answer");
  work.done("older-answer");
  work.commit("vad");
  work.transcribed("vad");
  assert.deepEqual([...work.pending], ["v:vad"]);
  work.created("actual-answer");
  assert.deepEqual([...work.pending], ["r:actual-answer"]);
  work.done("actual-answer");
  assert.equal(work.pending.size, 0);
});

test("manual acknowledgement settles only provisional speech, retaining other committed inputs", () => {
  const work = new TranscriptWork();
  work.speech("older");
  work.speech("active");
  assert.equal(work.reserveCommit(), true);
  work.commit("older");
  work.commit("manual-item");
  assert.deepEqual([...work.pending].sort(), ["t:manual-item", "t:older", "v:older"]);
  work.transcribed("manual-item");
  work.speech("active");
  assert.equal(work.reserveCommit(), false);
  work.transcribed("older");
  work.done("older-response");
  assert.equal(work.pending.size, 0);
});

test("manual-only success resolves without a model response or phantom reservation", () => {
  const work = new TranscriptWork();
  work.speech("active");
  assert.equal(work.reserveCommit(), true);
  work.commit("manual-final");
  assert.equal(work.transcribed("manual-final"), true);
  work.commit("manual-final");
  work.speech("active");
  assert.equal(work.pending.size, 0);
});

for (const transcriptionFirst of [false, true]) {
  test(`retained-ID manual commit needs no automatic response (${transcriptionFirst ? "transcription" : "commit"} first)`, () => {
    const work = new TranscriptWork();
    work.speech("same-item");
    assert.equal(work.reserveCommit(), true);
    if (transcriptionFirst) work.transcribed("same-item");
    work.commit("same-item");
    work.transcribed("same-item");
    work.commit("same-item");
    work.speech("same-item");
    assert.equal(work.transcribed("same-item"), false);
    assert.equal(work.pending.size, 0);
  });
}

test("retained-ID manual commit preserves earlier VAD and active response/playback work", () => {
  const work = new TranscriptWork();
  work.speech("older");
  work.commit("older");
  work.transcribed("older");
  work.speech("same-item");
  work.reserveCommit();
  work.created("older-answer");
  work.created("active-answer");
  work.playback("active-answer", false);
  work.commit("same-item");
  work.transcribed("same-item");
  assert.deepEqual([...work.pending].sort(), ["p:active-answer", "r:active-answer", "r:older-answer"]);
  work.done("older-answer");
  work.done("active-answer");
  assert.deepEqual([...work.pending], ["p:active-answer"]);
  work.playback("active-answer", true);
  assert.equal(work.pending.size, 0);
});

test("retained-ID manual commit never releases a different VAD expectation", () => {
  const work = new TranscriptWork();
  work.speech("older");
  work.commit("older");
  work.transcribed("older");
  work.speech("same-item");
  work.reserveCommit();
  work.commit("same-item");
  work.transcribed("same-item");
  assert.deepEqual([...work.pending], ["v:older"]);
  work.done("older-answer");
  assert.equal(work.pending.size, 0);
});

for (const terminalFirst of [false, true]) {
  for (const confirmation of ["stopped-before-done", "stopped-after-done", "distinct-commit"]) {
    test(`observed response stays attributed after retained manual acknowledgement (${confirmation}, ${terminalFirst ? "terminal" : "created"} first)`, () => {
      const work = new TranscriptWork();
      work.speech("vad");
      assert.equal(work.reserveCommit(), true);
      work.commit("vad");
      work.transcribed("vad");
      if (terminalFirst) work.done("answer");
      else work.created("answer");
      if (confirmation === "stopped-before-done") {
        work.stopped("vad");
        assert.deepEqual([...work.pending], terminalFirst ? [] : ["r:answer"]);
      }
      work.done("answer");
      if (confirmation === "stopped-after-done") work.stopped("vad");
      if (confirmation === "distinct-commit") {
        work.commit("manual");
        assert.deepEqual([...work.pending], ["t:manual"]);
        assert.equal(work.transcribed("manual"), true);
      }
      work.stopped("vad");
      work.created("answer");
      assert.equal(work.done("answer"), false);
      assert.equal(work.pending.size, 0);
    });
  }
}

test("an older response cannot satisfy a suspended retained-ID VAD expectation", () => {
  const work = new TranscriptWork();
  work.speech("older");
  work.commit("older");
  work.transcribed("older");
  work.speech("vad");
  work.reserveCommit();
  work.commit("vad");
  work.transcribed("vad");
  work.created("older-answer");
  work.done("older-answer");
  work.stopped("vad");
  assert.deepEqual([...work.pending], ["v:vad"]);
  work.done("vad-answer");
  assert.equal(work.pending.size, 0);
});

test("a distinct manual acknowledgement restores VAD work after retained-ID transcription", () => {
  const work = new TranscriptWork();
  work.speech("vad");
  work.reserveCommit();
  work.commit("vad");
  work.transcribed("vad");
  work.commit("manual");
  work.transcribed("manual");
  assert.deepEqual([...work.pending], ["v:vad"]);
  work.created("delayed-vad-answer");
  work.commit("vad");
  work.commit("manual");
  assert.deepEqual([...work.pending], ["r:delayed-vad-answer"]);
  work.done("delayed-vad-answer");
  assert.equal(work.pending.size, 0);
});

for (const stoppedFirst of [false, true]) {
  test(`VAD speech_stopped preserves a retained-ID response (${stoppedFirst ? "before" : "after"} manual acknowledgement)`, () => {
    const work = new TranscriptWork();
    work.speech("same-item");
    work.reserveCommit();
    if (stoppedFirst) work.stopped("same-item");
    work.commit("same-item");
    work.transcribed("same-item");
    if (!stoppedFirst) work.stopped("same-item");
    assert.deepEqual([...work.pending], ["v:same-item"]);
    work.created("delayed-answer");
    work.stopped("same-item");
    assert.deepEqual([...work.pending], ["r:delayed-answer"]);
    work.done("delayed-answer");
    work.stopped("same-item");
    assert.equal(work.pending.size, 0);
  });
}

for (const transcriptionFirst of [false, true]) {
  test(`manual acknowledgement retains a distinct VAD transcript (${transcriptionFirst ? "transcription" : "manual acknowledgement"} first)`, () => {
    const work = new TranscriptWork();
    work.speech("active");
    work.reserveCommit();
    if (transcriptionFirst) work.transcribed("active");
    work.commit("manual-final");
    work.transcribed("manual-final");
    if (!transcriptionFirst) work.transcribed("active");
    assert.deepEqual([...work.pending], ["v:active"]);
    work.done("vad-answer");
    work.commit("active");
    assert.equal(work.pending.size, 0);
  });
}

test("manual acknowledgement never releases a response already created", () => {
  const work = new TranscriptWork();
  work.speech("active");
  work.reserveCommit();
  work.created("answer");
  work.commit("manual-final");
  work.transcribed("manual-final");
  assert.deepEqual([...work.pending], ["r:answer"]);
  work.done("answer");
  assert.equal(work.pending.size, 0);
});

test("a failure settles only transcription without discarding later captured text", () => {
  const work = new TranscriptWork();
  work.speech("one");
  assert.equal(work.transcribed("one", true), false);
  assert.deepEqual([...work.pending], ["v:one"]);
  assert.equal(work.transcribed("one"), true);
  assert.equal(work.transcribed("one"), false);
  work.done("answer");
  assert.equal(work.pending.size, 0);
});

test("idle, unknown and already committed speech never warrant a manual commit", () => {
  const work = new TranscriptWork();
  assert.equal(work.reserveCommit(), false);
  work.speech();
  assert.equal(work.reserveCommit(), false);
  work.commit("vad-item");
  work.speech("vad-item");
  assert.equal(work.reserveCommit(), false);
  work.transcribed("vad-item");
  work.done("answer");
  assert.equal(work.pending.size, 0);
});

test("terminal-before-created and duplicate responses release exactly one waiting ask", () => {
  const work = new TranscriptWork();
  work.pending.add("a:1");
  work.pending.add("a:2");
  assert.equal(work.done("one"), true);
  work.created("one");
  assert.equal(work.done("one"), false);
  assert.deepEqual([...work.pending], ["a:2"]);
  work.created("two");
  work.created("two");
  assert.deepEqual([...work.pending], ["r:two"]);
  work.done("two");
  assert.equal(work.pending.size, 0);
});

test("response generation completion does not clear playback; terminal playback is idempotent", () => {
  const work = new TranscriptWork();
  work.created("one");
  work.playback("one", false);
  work.done("one");
  assert.equal(drainDescription(work.pending), "Waiting for the persona response");
  work.playback("one", true);
  work.playback("one", false);
  assert.equal(work.pending.size, 0);
});

for (const target of ["events", "patch"]) {
  for (const body of [false, true]) {
    test(`${target} deadline includes ${body ? "response body" : "fetch"}, even when abort is ignored`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      let signal;
      t.mock.method(globalThis, "fetch", (_url, init) => {
        signal = init.signal;
        return body
          ? Promise.resolve(new Response(new ReadableStream({ start() {} })))
          : new Promise(() => {});
      });
      const request = target === "events" ? api.postEvents("synthetic", []) : api.updateSession("synthetic", { status: "ended" });
      const rejected = assert.rejects(request, RequestDeadlineError);
      await Promise.resolve();
      await Promise.resolve();
      t.mock.timers.tick(4_000);
      await rejected;
      assert.equal(signal.aborted, true);
    });
  }
}

test("persistence preserves typed success and non-2xx API errors", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", () => Promise.resolve(Response.json({ accepted: 0 })));
  assert.deepEqual(await api.postEvents("synthetic", []), { accepted: 0 });
  fetch.mock.mockImplementation(() => Promise.resolve(Response.json({ detail: "synthetic conflict" }, { status: 409 })));
  await assert.rejects(api.postEvents("synthetic", []), (error) => error instanceof ApiError && error.status === 409);
});

for (const failure of ["gateway", "transport", "deadline", "body"]) {
  test(`startup ${failure} failure permits bounded ended recovery`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const writes = [];
    t.mock.method(globalThis, "fetch", (_url, init) => {
      const status = JSON.parse(init.body).status;
      writes.push(status);
      if (status === "ended") return Promise.resolve(Response.json({ status }));
      if (failure === "gateway") return Promise.resolve(Response.json({ detail: "gateway timeout" }, { status: 504 }));
      if (failure === "transport") return Promise.reject(new TypeError("synthetic transport failure"));
      return failure === "body"
        ? Promise.resolve(new Response(new ReadableStream({ start() {} })))
        : new Promise(() => {});
    });
    const rejected = assert.rejects(api.updateSession("startup", { status: "live" }));
    await api.updateSession("startup", { status: "ended" });
    t.mock.timers.tick(4_000);
    await rejected;
    assert.deepEqual(writes, ["live", "ended"]);
  });
}

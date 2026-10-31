import { beforeEach, describe, expect, it, vi } from "vitest";

const ID = "a/b";
const ENCODED = "a%2Fb";

type Api = (typeof import("./api"))["api"];

// The link passcode lives in module state, so each test loads a fresh module (like a page load).
async function load() {
  vi.resetModules();
  return import("./api");
}

function answer(status: number, body: string) {
  const fetchMock = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(async () => new Response(body, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function passcodeHeader(init: RequestInit | undefined) {
  return (init?.headers as Record<string, string> | undefined)?.["X-Demo-Passcode"];
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  localStorage.clear();
});

describe("ApiError mapping", () => {
  it("keeps a FastAPI string detail and the status", async () => {
    answer(409, JSON.stringify({ detail: "not complete" }));
    const { api, ApiError } = await load();

    const error = await api.health().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, detail: "not complete", message: "409 not complete" });
  });

  it("flattens FastAPI validation errors into a string", async () => {
    const detail = [{ loc: ["body", "language"], msg: "bad" }];
    answer(422, JSON.stringify({ detail }));
    const { api } = await load();

    await expect(api.health()).rejects.toMatchObject({ status: 422, detail: JSON.stringify(detail) });
  });

  it("falls back to the raw body when the answer is not JSON", async () => {
    answer(500, "Internal Server Error");
    const { api } = await load();

    await expect(api.health()).rejects.toMatchObject({ status: 500, detail: "Internal Server Error" });
  });

  it("returns the parsed body of a successful answer", async () => {
    answer(200, JSON.stringify({ status: "ok" }));
    const { api } = await load();

    await expect(api.health()).resolves.toEqual({ status: "ok" });
  });
});

describe("proxy paths", () => {
  const file = new File(["%PDF"], "a.pdf");
  const image = new Blob(["png"], { type: "image/png" });
  // `paid` mirrors the routes guarded by require_passcode in the backend.
  const routes: [string, (api: Api) => Promise<unknown>, string, string, boolean][] = [
    ["health", (a) => a.health(), "GET", "/api/health", false],
    ["createPersona", (a) => a.createPersona({ language: "de", sources: [] }), "POST", "/api/personas", true],
    ["extractPdf", (a) => a.extractPdf(file), "POST", "/api/sources/pdf", true],
    ["extractImage", (a) => a.extractImage(image), "POST", "/api/sources/image", true],
    ["createSession", (a) => a.createSession({ personaId: "p" }), "POST", "/api/sessions", true],
    ["updateSession", (a) => a.updateSession(ID, { status: "ended" }), "PATCH", `/api/sessions/${ENCODED}`, false],
    ["sessionToken", (a) => a.sessionToken(ID), "POST", `/api/sessions/${ENCODED}/token`, true],
    ["avatarToken", (a) => a.avatarToken(ID), "POST", `/api/sessions/${ENCODED}/avatar-token`, true],
    ["postEvents", (a) => a.postEvents(ID, []), "POST", `/api/sessions/${ENCODED}/events`, false],
    ["debrief", (a) => a.debrief(ID), "POST", `/api/sessions/${ENCODED}/debrief`, true],
    ["updatePersona", (a) => a.updatePersona(ID, { jobs: [] }), "PATCH", `/api/personas/${ENCODED}`, true],
    ["getPersona", (a) => a.getPersona(ID), "GET", `/api/personas/${ENCODED}`, false],
    ["listPersonaSessions", (a) => a.listPersonaSessions(ID), "GET", `/api/personas/${ENCODED}/sessions`, true],
    ["getSession", (a) => a.getSession(ID), "GET", `/api/sessions/${ENCODED}`, false],
    ["getInsights", (a) => a.getInsights(ID), "GET", `/api/sessions/${ENCODED}/insights`, false],
  ];

  it.each(routes)("%s calls the right same-origin path", async (_name, call, method, path, paid) => {
    localStorage.setItem("demoPasscode", "secret");
    const fetchMock = answer(200, "{}");
    const { api } = await load();

    await call(api);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [calledPath, init] = fetchMock.mock.calls[0];
    expect(calledPath).toBe(path);
    expect(init?.method ?? "GET").toBe(method);
    expect(passcodeHeader(init)).toBe(paid ? "secret" : undefined);
  });
});

describe("request deadline", () => {
  const requests: [string, (api: Api) => Promise<unknown>, number][] = [
    ["a saved-transcript request", (a) => a.postEvents(ID, []), 4_000],
    ["a final session update", (a) => a.updateSession(ID, { status: "ended" }), 4_000],
    ["a startup session update, which may wait on a cold backend", (a) => a.updateSession(ID, { status: "live" }), 15_000],
  ];

  it.each(requests)("gives up on %s whose answer never arrives, and aborts it", async (_name, call, deadlineMs) => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(() => new Promise(() => {}));
      vi.stubGlobal("fetch", fetchMock);
      const { api, RequestDeadlineError } = await load();
      let settled = false;

      const result = call(api)
        .catch((e: unknown) => e)
        .finally(() => {
          settled = true;
        });
      const signal = fetchMock.mock.calls[0][1]?.signal;

      await vi.advanceTimersByTimeAsync(deadlineMs - 1);
      expect(settled).toBe(false);
      expect(signal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toBeInstanceOf(RequestDeadlineError);
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("demo passcode", () => {
  it("sends the link code, removes it from the address bar and keeps it for reloads", async () => {
    window.history.replaceState(null, "", "/?code=abc&keep=1");
    const fetchMock = answer(200, "{}");
    const { api } = await load();

    await api.debrief(ID);

    expect(passcodeHeader(fetchMock.mock.calls[0][1])).toBe("abc");
    expect(window.location.search).toBe("?keep=1");
    expect(localStorage.getItem("demoPasscode")).toBe("abc");
  });

  it("prefers a new link code over the stored one", async () => {
    localStorage.setItem("demoPasscode", "old");
    window.history.replaceState(null, "", "/?code=new");
    const fetchMock = answer(200, "{}");
    const { api } = await load();

    await api.debrief(ID);

    expect(passcodeHeader(fetchMock.mock.calls[0][1])).toBe("new");
  });

  it("sends no header without a code", async () => {
    const fetchMock = answer(200, "{}");
    const { api } = await load();

    await api.debrief(ID);

    expect(passcodeHeader(fetchMock.mock.calls[0][1])).toBeUndefined();
  });

  it("still works for this page when storage is blocked", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    window.history.replaceState(null, "", "/?code=abc");
    const fetchMock = answer(200, "{}");
    const { api } = await load();

    await api.debrief(ID);
    await api.debrief(ID);

    expect(fetchMock.mock.calls.map(([, init]) => passcodeHeader(init))).toEqual(["abc", "abc"]);
  });

  it("sends no header when reading storage is blocked", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const fetchMock = answer(200, "{}");
    const { api } = await load();

    await api.debrief(ID);

    expect(passcodeHeader(fetchMock.mock.calls[0][1])).toBeUndefined();
  });
});

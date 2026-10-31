import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { Avatar } from "./Avatar";

// The real simli-client runs here, so the event names and shapes are the SDK's own. Only its
// websocket is fake, which also keeps the test off the network.
vi.mock("@/lib/api", () => ({ api: { avatarToken: vi.fn() } }));

const TOKEN = "session-token-do-not-log";
const VISIBLE = "Avatar unavailable, voice only.";

class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket | undefined;
  readyState = 1;
  onopen?: () => void;
  onmessage?: (message: { data: string }) => void;
  onerror?: (event: object) => void;
  constructor(readonly url: URL) {
    FakeSocket.last = this;
  }
  addEventListener() {}
  send() {}
  close() {}
}

const settle = () => act(() => vi.advanceTimersByTimeAsync(0));
const server = async (data: string) => {
  await act(async () => FakeSocket.last?.onmessage?.({ data }));
  await settle();
};

// Everything written to the console, by us or by the SDK.
function consoleText() {
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => {}),
  );
  return () => spies.flatMap((spy) => spy.mock.calls.flat().map(String)).join("\n");
}

async function show() {
  const view = render(<Avatar sessionId="s1" track={{} as MediaStreamTrack} onActive={() => {}} />);
  await settle();
  await act(async () => FakeSocket.last?.onopen?.());
  await settle();
  return view;
}

describe("Avatar failure logging", () => {
  let logged: () => string;

  beforeEach(() => {
    // SDK timers stay frozen: no 15 s timeout, and no retry opening a socket after the test.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    FakeSocket.last = undefined;
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("AudioContext", class { close = async () => {}; });
    vi.mocked(api.avatarToken).mockResolvedValue({ token: TOKEN } as Awaited<ReturnType<typeof api.avatarToken>>);
    logged = consoleText();
    return () => void vi.useRealTimers();
  });

  it("logs the server's reason once and keeps the visible message", async () => {
    await show();
    await server("ERROR: SESSION_TOKEN_EXPIRED");
    expect(logged()).toBe("[avatar] off: ERROR: SESSION_TOKEN_EXPIRED");
    expect(screen.getByText(VISIBLE)).toBeTruthy();
    expect(screen.queryByText(/SESSION_TOKEN_EXPIRED/)).toBeNull();
  });

  it("logs a stop, which carries no reason", async () => {
    await show();
    await server("STOP");
    expect(logged()).toBe("[avatar] off: Simli ended the session (stop event)");
    expect(screen.getByText(VISIBLE)).toBeTruthy();
  });

  it("logs a startup error while the SDK retries, without giving up", async () => {
    await show();
    await act(async () => FakeSocket.last?.onerror?.({}));
    expect(logged()).toContain("[avatar] attempt failed: Websocket Failed");
    expect(screen.queryByText(VISIBLE)).toBeNull();
    expect(screen.getByText("Avatar is joining…")).toBeTruthy();
  });

  it("logs a timed-out attempt, which only the SDK's own error line reports", async () => {
    await show();
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(logged()).toBe("[avatar] sdk: FAILED: Connection Timed Out");
    expect(screen.queryByText(VISIBLE)).toBeNull();
  });

  it("logs a failed token request", async () => {
    vi.mocked(api.avatarToken).mockRejectedValue(new Error("503 Avatar unavailable"));
    await show();
    expect(logged()).toBe("[avatar] off: Error: 503 Avatar unavailable");
  });

  it("keeps tokens out of the console, also out of the SDK's own error lines", async () => {
    // Join details the SDK can't read: it reports them raw, as "unknown" and through its logger.
    const secret = "lk-secret-do-not-log";
    await show();
    await server(`{"livekit_token":"${secret}"}`);
    expect(screen.getByText(VISIBLE)).toBeTruthy();
    expect(logged()).toContain("[avatar] off: [redacted]");
    expect(logged()).not.toContain(secret);
    expect(logged()).not.toContain(TOKEN);
    expect(FakeSocket.last?.url.toString()).toContain(TOKEN); // The socket did get it.
  });

  it("logs nothing on a normal hang-up", async () => {
    const view = await show();
    view.unmount();
    await settle();
    expect(logged()).toBe("");
  });
});

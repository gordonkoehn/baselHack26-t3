import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchConnection } from "./useConnectionWatch";

function fakeCall(connectionState = "connected", readyState = "open") {
  const pc = Object.assign(new EventTarget(), { connectionState });
  const dc = Object.assign(new EventTarget(), { readyState });
  const onLoss = vi.fn();
  const dispose = watchConnection(pc as unknown as RTCPeerConnection, dc as unknown as RTCDataChannel, onLoss);
  const setState = (state: string) => {
    pc.connectionState = state;
    pc.dispatchEvent(new Event("connectionstatechange"));
  };
  return { dc, onLoss, dispose, setState };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("watchConnection", () => {
  it.each(["failed", "closed"])("reports the loss at once when the connection is %s, and only once", (state) => {
    const { dc, onLoss, setState } = fakeCall();

    setState(state);
    expect(onLoss).toHaveBeenCalledOnce();

    dc.dispatchEvent(new Event("close"));
    expect(onLoss).toHaveBeenCalledOnce();
  });

  it.each(["close", "error"])("reports the loss on a data channel %s", (event) => {
    const { dc, onLoss } = fakeCall();

    dc.dispatchEvent(new Event(event));

    expect(onLoss).toHaveBeenCalledOnce();
  });

  it("gives a disconnect five seconds of grace", () => {
    const { onLoss, setState } = fakeCall();

    setState("disconnected");
    vi.advanceTimersByTime(4_999);
    expect(onLoss).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onLoss).toHaveBeenCalledOnce();
  });

  it("does not restart the grace period on a repeated disconnect", () => {
    const { onLoss, setState } = fakeCall();

    setState("disconnected");
    vi.advanceTimersByTime(3_000);
    setState("disconnected");
    vi.advanceTimersByTime(2_000);

    expect(onLoss).toHaveBeenCalledOnce();
  });

  it("forgives a repeated disconnect that recovers: no earlier timer is left running", () => {
    const { onLoss, setState } = fakeCall();

    setState("disconnected");
    setState("disconnected");
    setState("connected");
    vi.advanceTimersByTime(10_000);

    expect(onLoss).not.toHaveBeenCalled();
  });

  it("forgives a disconnect that recovers", () => {
    const { onLoss, setState } = fakeCall();

    setState("disconnected");
    vi.advanceTimersByTime(4_000);
    setState("connected");
    vi.advanceTimersByTime(10_000);

    expect(onLoss).not.toHaveBeenCalled();
  });

  it("stays quiet after disposal: intentional closes and pending timers are not a loss", () => {
    const { dc, onLoss, dispose, setState } = fakeCall();

    setState("disconnected");
    dispose();
    dc.dispatchEvent(new Event("close"));
    setState("failed");
    vi.advanceTimersByTime(10_000);

    expect(onLoss).not.toHaveBeenCalled();
  });

  it.each([
    ["connection", "failed", "open"],
    ["data channel", "connected", "closed"],
  ])("reports a %s that is already gone when the watch starts", (_name, connectionState, readyState) => {
    const { onLoss } = fakeCall(connectionState, readyState);

    expect(onLoss).toHaveBeenCalledOnce();
  });
});

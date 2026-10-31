import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureFrame } from "@/lib/screenFrames";
import { ScreenShareButton } from "./ScreenShareButton";

vi.mock("@/lib/screenFrames", () => ({ captureFrame: vi.fn() }));

const IMAGE = "data:image/jpeg;base64,abc";

function fakeStream() {
  const track = Object.assign(new EventTarget(), { stop: vi.fn() });
  return { track, stream: { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let getDisplayMedia: ReturnType<typeof vi.fn>;
let ask: ReturnType<typeof vi.fn<(content: object[]) => boolean>>;

function show(maxMessageSize?: number) {
  const pc = { current: (maxMessageSize ? { sctp: { maxMessageSize } } : null) as RTCPeerConnection | null };
  return render(<ScreenShareButton pc={pc} ask={ask} />);
}

const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

async function startSharing(maxMessageSize?: number) {
  const fake = fakeStream();
  getDisplayMedia.mockResolvedValueOnce(fake.stream);
  const view = show(maxMessageSize);
  click("Share screen");
  await screen.findByRole("button", { name: "Show screen to persona" });
  return { ...fake, ...view };
}

beforeEach(() => {
  vi.mocked(captureFrame).mockReset();
  ask = vi.fn<(content: object[]) => boolean>(() => true);
  getDisplayMedia = vi.fn();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getDisplayMedia } });
});

describe("sharing", () => {
  it("starts with a video-only capture and offers show and stop", async () => {
    await startSharing();

    expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false });
    screen.getByRole("button", { name: "Stop sharing" });
    expect(screen.queryByRole("button", { name: "Share screen" })).toBeNull();
  });

  it("stops the tracks and returns to the start on stop", async () => {
    const { track } = await startSharing();

    click("Stop sharing");

    expect(track.stop).toHaveBeenCalledOnce();
    screen.getByRole("button", { name: "Share screen" });
  });

  it("returns to the start when the browser's own 'Stop sharing' ends the track", async () => {
    const { track } = await startSharing();

    act(() => {
      track.dispatchEvent(new Event("ended"));
    });

    screen.getByRole("button", { name: "Share screen" });
  });

  it("says so when the picker is cancelled", async () => {
    getDisplayMedia.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    show();

    click("Share screen");

    await screen.findByText("Screen sharing was cancelled or blocked.");
    screen.getByRole("button", { name: "Share screen" });
  });

  it("opens one picker at a time", async () => {
    const picker = deferred<MediaStream>();
    getDisplayMedia.mockReturnValueOnce(picker.promise);
    show();

    click("Share screen");
    click("Share screen");
    await act(async () => picker.resolve(fakeStream().stream));

    expect(getDisplayMedia).toHaveBeenCalledOnce();
  });

  it("stops the tracks when unmounted", async () => {
    const { track, unmount } = await startSharing();

    unmount();

    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("doesn't leave the screen captured when access is granted after unmount", async () => {
    const picker = deferred<MediaStream>();
    getDisplayMedia.mockReturnValueOnce(picker.promise);
    const { track, stream } = fakeStream();
    const { unmount } = show();

    click("Share screen");
    unmount();
    await act(async () => picker.resolve(stream));

    expect(track.stop).toHaveBeenCalledOnce();
  });
});

describe("showing a frame", () => {
  it("sends the labelled frame to the persona", async () => {
    vi.mocked(captureFrame).mockResolvedValueOnce(IMAGE);
    const { stream } = await startSharing();

    click("Show screen to persona");

    await screen.findByText("Shown to the persona.");
    expect(vi.mocked(captureFrame).mock.calls[0][0]).toBe(stream);
    expect(ask).toHaveBeenCalledExactlyOnceWith([
      { type: "input_text", text: "(Interviewer's shared screen, the prototype, right now.)" },
      { type: "input_image", image_url: IMAGE },
    ]);
  });

  it("keeps the stream and sends under StrictMode's double effect run", async () => {
    vi.mocked(captureFrame).mockResolvedValueOnce(IMAGE);
    const { track, stream } = fakeStream();
    getDisplayMedia.mockResolvedValueOnce(stream);
    render(
      <StrictMode>
        <ScreenShareButton pc={{ current: null }} ask={ask} />
      </StrictMode>,
    );

    click("Share screen");
    await screen.findByRole("button", { name: "Show screen to persona" });
    click("Show screen to persona");

    await screen.findByText("Shown to the persona.");
    expect(ask).toHaveBeenCalledOnce();
    expect(track.stop).not.toHaveBeenCalled();
  });

  it.each([
    ["the fallback without a negotiated size", undefined, 256 * 1024 - 1024],
    ["a smaller negotiated size", 64 * 1024, 64 * 1024 - 1024],
    ["the fallback when more was negotiated", 1024 * 1024, 256 * 1024 - 1024],
  ])("budgets for %s, leaving room for the envelope", async (_name, negotiated, maxBytes) => {
    vi.mocked(captureFrame).mockResolvedValueOnce(IMAGE);
    await startSharing(negotiated);

    click("Show screen to persona");

    await screen.findByText("Shown to the persona.");
    expect(vi.mocked(captureFrame).mock.calls[0][1]).toEqual({ maxBytes });
  });

  it("says so when the call is not open", async () => {
    vi.mocked(captureFrame).mockResolvedValueOnce(IMAGE);
    ask.mockReturnValueOnce(false);
    await startSharing();

    click("Show screen to persona");

    await screen.findByText("The call is not open.");
  });

  it("shows why a capture failed, sends nothing and allows another try", async () => {
    vi.mocked(captureFrame).mockRejectedValueOnce(new Error("The screen video track has ended."));
    await startSharing();

    click("Show screen to persona");

    await screen.findByText("The screen video track has ended.");
    expect(ask).not.toHaveBeenCalled();
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "Show screen to persona" });
    expect(button.disabled).toBe(false);
  });

  it("disables the button while capturing", async () => {
    const capture = deferred<string>();
    vi.mocked(captureFrame).mockReturnValueOnce(capture.promise);
    await startSharing();

    click("Show screen to persona");

    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Capturing…" }).disabled).toBe(true);
    await act(async () => capture.resolve(IMAGE));
  });
});

// #58: a frame captured just as sharing ends must never reach the persona.
describe("no send after sharing ended", () => {
  async function captureInFlight() {
    const capture = deferred<string>();
    vi.mocked(captureFrame).mockReturnValueOnce(capture.promise);
    const sharing = await startSharing();
    click("Show screen to persona");
    return { ...sharing, capture };
  }

  it("drops the frame when stopped during the capture", async () => {
    const { capture } = await captureInFlight();

    click("Stop sharing");
    await act(async () => capture.resolve(IMAGE));

    expect(ask).not.toHaveBeenCalled();
    expect(screen.queryByText("Shown to the persona.")).toBeNull();
  });

  it("drops the frame when the browser ends the track during the capture", async () => {
    const { capture, track } = await captureInFlight();

    act(() => {
      track.dispatchEvent(new Event("ended"));
    });
    await act(async () => capture.resolve(IMAGE));

    expect(ask).not.toHaveBeenCalled();
  });

  it("drops the frame when unmounted during the capture", async () => {
    const { capture, unmount } = await captureInFlight();

    unmount();
    await act(async () => capture.resolve(IMAGE));

    expect(ask).not.toHaveBeenCalled();
  });

  it("drops the old frame after sharing again during the capture", async () => {
    const { capture } = await captureInFlight();

    click("Stop sharing");
    getDisplayMedia.mockResolvedValueOnce(fakeStream().stream);
    click("Share screen");
    await screen.findByRole("button", { name: "Stop sharing" });
    await act(async () => capture.resolve(IMAGE));

    expect(ask).not.toHaveBeenCalled();
  });
});

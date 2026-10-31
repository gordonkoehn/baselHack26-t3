import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureFrame } from "./screenFrames";

const PREFIX = "data:image/jpeg;base64,";

function fakeStream(readyState: "live" | "ended" = "live") {
  const track = Object.assign(new EventTarget(), { readyState });
  return { track, stream: { getVideoTracks: () => [track] } as unknown as MediaStream };
}

// jsdom has no media or canvas. These fakes stand in for the browser: a video of a given size that
// plays at once, and a canvas whose JPEGs are as long as `jpegLength` says.
let drawImage: ReturnType<typeof vi.fn>;
let qualities: number[];
let jpegLength: (width: number, quality: number) => number;
let played: HTMLVideoElement | null;

function videoOfSize(width: number, height: number) {
  vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(width);
  vi.spyOn(HTMLVideoElement.prototype, "videoHeight", "get").mockReturnValue(height);
}

function lastDrawnSize() {
  const [, , , width, height] = drawImage.mock.lastCall as [unknown, number, number, number, number];
  return [width, height];
}

beforeAll(() => {
  Object.defineProperty(HTMLMediaElement.prototype, "srcObject", { configurable: true, writable: true, value: null });
});

beforeEach(() => {
  drawImage = vi.fn();
  qualities = [];
  jpegLength = () => 100;
  played = null;
  videoOfSize(1280, 720);
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(2);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    played = this as HTMLVideoElement;
    return Promise.resolve();
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(function (
    this: HTMLCanvasElement,
    _type?: string,
    quality?: number,
  ) {
    qualities.push(quality as number);
    return PREFIX + "x".repeat(jpegLength(this.width, quality as number));
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("frame bounds", () => {
  it.each([
    ["a large landscape screen", 2560, 1440, 1280, 720],
    ["a tall portrait screen", 720, 1440, 360, 720],
    ["a small screen, never upscaled", 640, 360, 640, 360],
  ])("fits %s into 1280x720", async (_name, width, height, drawnWidth, drawnHeight) => {
    videoOfSize(width, height);

    await captureFrame(fakeStream().stream);

    expect(lastDrawnSize()).toEqual([drawnWidth, drawnHeight]);
  });

  it("lowers JPEG quality before shrinking the picture", async () => {
    jpegLength = (_width, quality) => (quality > 0.6 ? 1000 : 100);

    const frame = await captureFrame(fakeStream().stream, { maxBytes: 500 });

    expect(qualities).toEqual([0.8, 0.6]);
    expect(drawImage).toHaveBeenCalledOnce();
    expect(frame.length).toBeLessThanOrEqual(500);
  });

  it("halves the picture until the data URL fits the budget, prefix included", async () => {
    jpegLength = (width) => width;

    const frame = await captureFrame(fakeStream().stream, { maxBytes: 320 + PREFIX.length });

    expect(lastDrawnSize()).toEqual([320, 180]);
    expect(frame.length).toBe(320 + PREFIX.length);
  });

  it("gives up after reaching 1x1 instead of sending an oversized frame", async () => {
    jpegLength = () => 1000;

    await expect(captureFrame(fakeStream().stream, { maxBytes: 500 })).rejects.toThrow("cannot fit");

    // 1280x720 reaches 1x1 after ten halvings.
    expect(drawImage).toHaveBeenCalledTimes(11);
    expect(lastDrawnSize()).toEqual([1, 1]);
  });

  it("uses a 60 KiB budget by default", async () => {
    jpegLength = (width) => (width > 640 ? 60 * 1024 : 100);

    await captureFrame(fakeStream().stream);

    expect(lastDrawnSize()).toEqual([640, 360]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects a maxBytes of %d", async (maxBytes) => {
    await expect(captureFrame(fakeStream().stream, { maxBytes })).rejects.toThrow("finite, positive");
  });

  it("rejects a budget too small for the data URL prefix", async () => {
    await expect(captureFrame(fakeStream().stream, { maxBytes: PREFIX.length })).rejects.toThrow("cannot fit");
  });
});

describe("capture failures", () => {
  it("needs a live video track", async () => {
    await expect(captureFrame(fakeStream("ended").stream)).rejects.toThrow("live video track");
    const noTrack = { getVideoTracks: () => [] } as unknown as MediaStream;
    await expect(captureFrame(noTrack)).rejects.toThrow("live video track");
  });

  it("rejects when the track ends while waiting for a frame", async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockReturnValue(new Promise(() => {}));
    const { stream, track } = fakeStream();

    const capture = captureFrame(stream);
    track.dispatchEvent(new Event("ended"));

    await expect(capture).rejects.toThrow("track has ended");
  });

  it("times out when no frame ever arrives", async () => {
    vi.useFakeTimers();
    vi.mocked(HTMLMediaElement.prototype.play).mockReturnValue(new Promise(() => {}));

    const capture = captureFrame(fakeStream().stream);
    const assertion = expect(capture).rejects.toThrow("Timed out");
    await vi.advanceTimersByTimeAsync(5000);

    await assertion;
  });

  it("rejects an empty encoding", async () => {
    vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockReturnValue("data:,");

    await expect(captureFrame(fakeStream().stream)).rejects.toThrow("nonempty JPEG");
  });
});

it("lets go of the caller's stream after capturing, without stopping it", async () => {
  const { stream } = fakeStream();

  await captureFrame(stream);

  expect(played?.srcObject).toBeNull();
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
});

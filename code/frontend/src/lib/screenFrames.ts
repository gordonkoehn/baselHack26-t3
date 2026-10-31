const JPEG_PREFIX = "data:image/jpeg;base64,";

function waitForFrame(video: HTMLVideoElement, stream: MediaStream, track: MediaStreamTrack) {
  return new Promise<void>((resolve, reject) => {
    let played = false;
    let frameReady = false;
    let frameId: number | undefined;
    const supportsFrameCallback = typeof video.requestVideoFrameCallback === "function";
    const timer = window.setTimeout(
      () => finish(new Error("Timed out waiting for a screen video frame (5 seconds).")),
      5000,
    );

    function finish(error?: Error) {
      window.clearTimeout(timer);
      video.removeEventListener("loadeddata", checkReady);
      video.removeEventListener("error", onError);
      track.removeEventListener("ended", onEnded);
      if (frameId !== undefined) video.cancelVideoFrameCallback(frameId);
      if (error) reject(error);
      else resolve();
    }

    function checkReady() {
      const available = video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
      if (played && available && (frameReady || !supportsFrameCallback)) finish();
    }

    function onError() {
      finish(new Error("The screen video could not be loaded."));
    }

    function onEnded() {
      finish(new Error("The screen video track has ended."));
    }

    video.addEventListener("loadeddata", checkReady);
    video.addEventListener("error", onError);
    track.addEventListener("ended", onEnded);
    try {
      video.srcObject = stream;
      if (supportsFrameCallback) {
        frameId = video.requestVideoFrameCallback(() => {
          frameReady = true;
          checkReady();
        });
      }
      void video.play().then(() => {
        played = true;
        checkReady();
      }, () => finish(new Error("The screen video could not start playback.")));
    } catch {
      finish(new Error("Screen video capture is not supported in this browser."));
    }
  });
}

/** Captures one caller-owned stream frame; maxBytes includes the full ASCII data URL. */
export async function captureFrame(
  stream: MediaStream,
  options?: { maxBytes?: number },
): Promise<string> {
  const maxBytes = options?.maxBytes === undefined ? 60 * 1024 : options.maxBytes;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a finite, positive byte budget.");
  }
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("Screen frame capture is only supported in a browser.");
  }
  const track = stream.getVideoTracks()[0];
  if (!track || track.readyState !== "live") {
    throw new Error("Screen frame capture requires a live video track.");
  }
  if (maxBytes <= JPEG_PREFIX.length) {
    throw new Error("The JPEG frame cannot fit within the maxBytes budget.");
  }

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  try {
    if (!("srcObject" in video) || typeof video.play !== "function") {
      throw new Error("Screen video capture is not supported in this browser.");
    }
    // Source changes must reach the stream first; this waits for an available video frame.
    await waitForFrame(video, stream, track);
    if (track.readyState !== "live") throw new Error("The screen video track has ended.");

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas frame capture is not supported in this browser.");
    let scale = Math.min(1, 1280 / video.videoWidth, 720 / video.videoHeight);

    // Twelve sizes reach 1x1 from 1280x720. Compression can make small text unreadable.
    for (let attempt = 0; attempt < 12; attempt++) {
      canvas.width = Math.max(1, Math.floor(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.floor(video.videoHeight * scale));
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.8, 0.6, 0.4]) {
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        if (!dataUrl.startsWith(JPEG_PREFIX) || dataUrl.length <= JPEG_PREFIX.length) {
          throw new Error("The browser did not encode a nonempty JPEG frame.");
        }
        // JPEG data URLs are ASCII, so string length equals the encoded byte count.
        if (dataUrl.length <= maxBytes) return dataUrl;
      }
      if (canvas.width === 1 && canvas.height === 1) break;
      scale /= 2;
    }
    throw new Error("The JPEG frame cannot fit within the maxBytes budget.");
  } finally {
    video.pause();
    video.srcObject = null;
    video.remove();
  }
}

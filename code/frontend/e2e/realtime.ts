import type { Page } from "@playwright/test";

type WireEvent = {
  type: string;
  item_id?: string;
  response_id?: string;
  content_index?: number;
  transcript?: string;
  response?: {
    id: string;
    status?: string;
    output?: { id: string; content: { type: string; transcript?: string; text?: string }[] }[];
    usage?: { input_tokens: number; output_tokens: number };
  };
  error?: { event_id?: string; message?: string };
};
type SentEvent = {
  type: string;
  event_id?: string;
  item?: { id?: string; content: { type: string; text?: string }[] };
};

declare global {
  interface Window {
    e2eRealtime: {
      emit: (event: WireEvent) => void;
      lose: () => void;
      connection: (state: RTCPeerConnectionState) => void;
      voice: () => void;
      stale: (() => void)[];
      sent: SentEvent[];
      closed: boolean;
      channelClosed: boolean;
      microphones: MediaStreamTrack[];
      audioConstraints: (boolean | MediaTrackConstraints | undefined)[];
      cameraRequests: number;
      // camera: "pending" only: answers the open camera prompt with a synthetic video track.
      grantCamera: () => void;
      cameraTracks: MediaStreamTrack[];
    };
  }
}

// camera "denied" refuses at once; "pending" leaves the prompt open until grantCamera().
export async function installRealtime(page: Page, { camera = "denied" }: { camera?: "denied" | "pending" } = {}) {
  await page.addInitScript(({ keepMicrophoneLive, camera }) => {
    const state: Window["e2eRealtime"] = {
      emit: () => { throw new Error("No realtime channel yet"); },
      lose: () => {}, connection: () => {}, voice: () => {}, stale: [],
      sent: [], closed: false, channelClosed: false, microphones: [], audioConstraints: [], cameraRequests: 0,
      grantCamera: () => { throw new Error("No camera prompt open"); }, cameraTracks: [],
    };
    window.e2eRealtime = state;
    class Channel extends EventTarget {
      readyState = "connecting";
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      send(data: string) {
        if (this.readyState !== "open") throw new Error("Channel is not open");
        state.sent.push(JSON.parse(data) as SentEvent);
      }
      close() {
        this.readyState = "closed";
        state.channelClosed = true;
      }
    }
    class Peer extends EventTarget {
      channel = new Channel();
      link: RTCPeerConnectionState = "connected";
      get connectionState() { return this.link; }
      ontrack: ((event: { streams: MediaStream[]; track: MediaStreamTrack }) => void) | null = null;
      addTrack() {}
      createDataChannel() {
        // The persona's voice arriving: a silent synthetic track, for the avatar lifecycle.
        state.voice = () => {
          const stream = new AudioContext().createMediaStreamDestination().stream;
          this.ontrack?.({ streams: [stream], track: stream.getAudioTracks()[0] });
        };
        state.lose = () => {
          this.channel.readyState = "closed";
          this.channel.dispatchEvent(new Event("close"));
        };
        state.connection = (value) => {
          this.link = value;
          this.dispatchEvent(new Event("connectionstatechange"));
        };
        state.emit = (event) => this.channel.onmessage?.(new MessageEvent("message", { data: JSON.stringify(event) }));
        return this.channel;
      }
      async createOffer() { return { type: "offer", sdp: "e2e-offer" }; }
      async setLocalDescription() {}
      async setRemoteDescription() {
        const callback = this.channel.onmessage;
        state.stale.push(() => callback?.(new MessageEvent("message", { data: JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed", item_id: "stale-input", transcript: "Stale turn must not leak",
        }) })));
        this.channel.readyState = "open";
        this.channel.dispatchEvent(new Event("open"));
      }
      close() {
        state.closed = true;
      }
    }
    Object.defineProperty(window, "RTCPeerConnection", { value: Peer });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: async (constraints: MediaStreamConstraints) => {
        if (constraints.video) {
          state.cameraRequests += 1;
          if (camera === "pending") {
            return new Promise<MediaStream>((resolve) => {
              state.grantCamera = () => {
                const canvas = document.createElement("canvas");
                canvas.width = 64;
                canvas.height = 48;
                canvas.getContext("2d")!.fillRect(0, 0, 64, 48);
                const stream = canvas.captureStream(1);
                state.cameraTracks.push(stream.getVideoTracks()[0]);
                resolve(stream);
              };
            });
          }
          throw new DOMException("Camera is deliberately unavailable in this test", "NotAllowedError");
        }
        if (!constraints.audio) throw new Error("Expected an audio request");
        state.audioConstraints.push(constraints.audio);
        // A silent synthetic track; no OS microphone or screen permission is requested.
        const audio = new AudioContext();
        const stream = audio.createMediaStreamDestination().stream;
        const track = stream.getAudioTracks()[0];
        state.microphones.push(track);
        // Negative control: peer closure must not hide a missed microphone stop.
        if (keepMicrophoneLive) track.stop = () => {};
        return stream;
      },
    });
    Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
      configurable: true, // A test that shares its screen replaces this.
      value: () => Promise.reject(new Error("Screen capture is outside this test")),
    });
  }, { keepMicrophoneLive: process.env.E2E_KEEP_MIC_LIVE === "1", camera });
}

export async function emit(page: Page, event: WireEvent) {
  await page.evaluate((value) => window.e2eRealtime.emit(value), event);
}

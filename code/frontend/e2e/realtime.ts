import type { Page } from "@playwright/test";

type WireEvent = {
  type: string;
  item_id?: string;
  previous_item_id?: string | null;
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
  item?: { content: { type: string; text?: string }[] };
};

declare global {
  interface Window {
    e2eRealtime: {
      emit: (event: WireEvent) => void;
      lose: () => void;
      stale: (() => void)[];
      sent: SentEvent[];
      closed: boolean;
      channelClosed: boolean;
      microphones: MediaStreamTrack[];
      audioConstraints: (boolean | MediaTrackConstraints | undefined)[];
      cameraRequests: number;
    };
  }
}

export async function installRealtime(page: Page) {
  await page.addInitScript(({ keepMicrophoneLive }) => {
    const state: Window["e2eRealtime"] = {
      emit: () => { throw new Error("No realtime channel yet"); },
      lose: () => {}, stale: [],
      sent: [], closed: false, channelClosed: false, microphones: [], audioConstraints: [], cameraRequests: 0,
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
      addTrack() {}
      createDataChannel() {
        state.lose = () => {
          this.channel.readyState = "closed";
          this.channel.dispatchEvent(new Event("close"));
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
      value: () => Promise.reject(new Error("Screen capture is outside this test")),
    });
  }, { keepMicrophoneLive: process.env.E2E_KEEP_MIC_LIVE === "1" });
}

export async function emit(page: Page, event: WireEvent) {
  await page.evaluate((value) => window.e2eRealtime.emit(value), event);
}

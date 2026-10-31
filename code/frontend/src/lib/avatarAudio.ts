// Taps the persona's voice (the remote Realtime audio track) as 16 kHz mono PCM16, the format
// audio-driven avatars (Simli, HeyGen LiveAvatar LITE) take as input. Browser only.

const SAMPLE_RATE = 16000;
// 100 ms per chunk: small enough for lip sync, large enough not to flood the avatar connection.
const CHUNK_SAMPLES = 1600;

// Runs on the audio thread: float samples in, little-endian Int16 chunks out.
const WORKLET = `
class Pcm16 extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Int16Array(${CHUNK_SAMPLES}); this.n = 0; }
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
        this.buf = new Int16Array(${CHUNK_SAMPLES}); this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm16", Pcm16);
`;

/**
 * Calls onChunk with 100 ms PCM16 chunks of the stream's audio; returns a stop function.
 * Chrome only delivers remote WebRTC audio to Web Audio while the stream is also attached to a
 * media element, so keep the call's <audio> element attached (muted is fine).
 */
export async function tapPcm16(stream: MediaStream, onChunk: (pcm: Uint8Array) => void): Promise<() => void> {
  // The context resamples the 48 kHz call audio to 16 kHz for us.
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "pcm16");
  node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => onChunk(new Uint8Array(e.data));
  source.connect(node);
  // Not connected to ctx.destination: the avatar plays the voice, this only feeds it.
  await ctx.resume();
  return () => {
    node.port.onmessage = null;
    source.disconnect();
    node.disconnect();
    void ctx.close();
  };
}

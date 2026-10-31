// Transcription and automatic VAD responses finish independently. Silence is not an
// acknowledgement: every expected response needs an actual terminal provider event.
export class TranscriptWork {
  readonly pending = new Set<string>();
  private inputDone = new Set<string>();
  private inputRecorded = new Set<string>();
  private responseDone = new Set<string>();
  private committed = new Set<string>();
  private vadInputs = new Set<string>();
  private manualSpeech: string | null = null;
  private retainedManual: string | null = null;
  private activeSpeech: string | null = null;
  private speechIds = new Set<string>();
  private playbackDone = new Set<string>();
  private settledSpeech = new Set<string>();
  private expectedResponses = new Set<string>();
  private suspendedResponses = new Set<string>();

  speech(id?: string) {
    const key = id ?? "unknown";
    if (id) this.speechIds.add(id);
    this.activeSpeech = key;
    if (!this.settledSpeech.has(key)) this.expectResponse(key);
    if (!this.inputDone.has(key) && !this.committed.has(key) && !this.settledSpeech.has(key)) this.pending.add(`s:${key}`);
  }

  stopped(id?: string) {
    if (id) {
      // speech_stopped confirms VAD work even if a manual commit was in flight.
      this.vadInputs.add(id);
      this.expectResponse(id);
      if (this.retainedManual === id) this.retainedManual = null;
    }
    this.commit(id);
  }

  commit(id?: string) {
    if (!id || this.committed.has(id)) return; // Redelivery cannot reserve another response.
    this.committed.add(id);
    this.pending.delete(`s:${id}`);
    this.pending.delete("s:unknown");
    // A manual acknowledgement can settle the provisional speech reservation, but
    // cannot alias transcript IDs: VAD and the manual request may BOTH commit items.
    // Keep each committed item's t: reservation and deduplicate only its exact ID.
    if (this.manualSpeech === id && !this.vadInputs.has(id)) {
      // Manual commits may retain speech_started's item ID. That alone does not
      // confirm an automatic response. Keep any response already observed.
      this.retainedManual = id;
      this.settledSpeech.add(id);
      if (this.pending.delete(`v:${id}`)) {
        this.expectedResponses.delete(id);
        this.suspendedResponses.add(id);
      }
      // Keep the request association: a later distinct manual acknowledgement
      // proves this first item was an independent VAD commit instead.
    } else if (this.manualSpeech && !this.speechIds.has(id)) {
      if (this.retainedManual) {
        this.expectResponse(this.retainedManual);
        this.retainedManual = null;
      }
      this.pending.delete(`s:${this.manualSpeech}`);
      this.settledSpeech.add(this.manualSpeech);
      // Manual commit starts transcription only. Release its provisional response
      // expectation, but retain any response already created or confirmed by VAD.
      // Keep the source association while suspended: later VAD evidence may
      // confirm it after its actual response has already been observed.
      if (!this.committed.has(this.manualSpeech) && !this.inputDone.has(this.manualSpeech) && this.pending.delete(`v:${this.manualSpeech}`)) {
        this.expectedResponses.delete(this.manualSpeech);
        this.suspendedResponses.add(this.manualSpeech);
      }
      this.manualSpeech = null;
    } else if (this.expectedResponses.delete("unknown")) {
      this.expectedResponses.add(id);
      if (this.pending.delete("v:unknown")) this.pending.add(`v:${id}`);
    } else this.expectResponse(id);
    if (!this.inputDone.has(id)) this.pending.add(`t:${id}`);
  }

  transcribed(id?: string, failed = false): boolean {
    if (!id) return false;
    // A distinct original item actually transcribed despite the manual commit:
    // retain its independent VAD response even if the commit event arrives later.
    if (this.settledSpeech.has(id) && this.retainedManual !== id) this.expectResponse(id);
    this.pending.delete(`s:${id}`);
    this.pending.delete("s:unknown");
    this.pending.delete(`t:${id}`);
    this.inputDone.add(id);
    if (failed || this.inputRecorded.has(id)) return false;
    this.inputRecorded.add(id);
    return true;
  }

  reserveCommit(): boolean {
    const id = this.activeSpeech;
    if (!id || id === "unknown" || !this.pending.has(`s:${id}`)) return false;
    this.manualSpeech = id;
    return true;
  }

  created(id?: string) {
    if (!id || this.responseDone.has(id) || this.pending.has(`r:${id}`)) return;
    this.releaseResponse();
    this.pending.add(`r:${id}`);
  }

  done(id?: string): boolean {
    if (!id || this.responseDone.has(id)) return false;
    // A terminal response can arrive before response.created.
    if (!this.pending.delete(`r:${id}`)) this.releaseResponse();
    this.responseDone.add(id);
    return true;
  }

  playback(id: string | undefined, done: boolean) {
    if (!id) return;
    if (done) {
      this.playbackDone.add(id);
      this.pending.delete(`p:${id}`);
    } else if (!this.playbackDone.has(id)) this.pending.add(`p:${id}`);
  }

  // Whether closing now could lose a turn. Audio still playing can't: the words of a finished
  // response are already in the transcript. Every other open key is a turn that may not arrive.
  get missingTurns(): boolean {
    return [...this.pending].some((key) => !key.startsWith("p:") || !this.responseDone.has(key.slice(2)));
  }

  private expectResponse(id: string) {
    this.suspendedResponses.delete(id);
    if (this.expectedResponses.has(id)) return;
    this.expectedResponses.add(id);
    this.pending.add(`v:${id}`);
  }

  private releaseResponse() {
    // Realtime has one active default-conversation response. Bind the next observed
    // response to one waiting request, retaining every other response reservation.
    const request = [...this.pending].find((key) => key.startsWith("a:") || key.startsWith("v:"));
    if (request) this.pending.delete(request);
    else {
      const suspended = this.suspendedResponses.values().next().value;
      if (!suspended) return;
      // Either manual acknowledgement path may suspend a provisional VAD
      // reservation. Confirmed waiting requests above take precedence.
      // Remember that its response was observed, so later VAD evidence cannot
      // restore a second reservation for the same input (even after response.done).
      this.suspendedResponses.delete(suspended);
      this.expectedResponses.add(suspended);
    }
  }
}

export const DRAIN_ATTEMPT_MS = 10_000;
export const SAVE_ATTEMPTS = 2;

export function drainDescription(pending: Set<string>): string {
  const stages: string[] = [];
  if ([...pending].some((key) => key.startsWith("s:") || key.startsWith("t:"))) stages.push("Transcribing the last sentence");
  if ([...pending].some((key) => key.startsWith("v:") || key.startsWith("r:") || key.startsWith("p:"))) stages.push("Waiting for the persona response");
  if ([...pending].some((key) => key.startsWith("a:"))) stages.push("Waiting for the typed question or shared screen response");
  return stages.join(" · ") || "Checking the final provider events";
}

// Conversation order of an interview (#110). The provider finishes transcribing speech independently
// of its responses, so the moment a text becomes final says nothing about where it belongs. A turn's
// place is reserved when the provider announces it; text leaves for the immutable event stream only
// once everything before it is final. A failed transcription is a hole: nothing is released past it.

type Speaker = "interviewer" | "persona";

/** One row of the transcript as shown. No text: speech still being transcribed (pending), or lost. */
export type Turn = {
  who: Speaker;
  text: string | null;
  pending?: boolean;
  cancelled?: boolean;
  // Final, but behind an earlier turn, so not part of the stored transcript (yet).
  held?: boolean;
  // Held behind a failed transcription: it can never be stored, whatever happens later in the call.
  blocked?: boolean;
};

type Text = { text: string; cancelled?: boolean };

type Slot = {
  who: Speaker;
  responseId?: string;
  // Provider items in this slot, to resolve a later item's previous_item_id.
  items: string[];
  texts: Text[];
  released: number;
  open: boolean;
  failed?: boolean;
};

export class TranscriptOrder {
  private slots: Slot[] = [];
  // Slots before this one are fully released and can no longer change.
  private next = 0;

  private add(fields: Partial<Slot> & Pick<Slot, "who">, afterItem?: string | null): Slot {
    const slot: Slot = { items: [], texts: [], released: 0, open: false, ...fields };
    const after = afterItem ? this.slots.findIndex((s) => s.items.includes(afterItem)) : -1;
    // An unknown predecessor (a camera frame, typed text, or none) means the end. Stored text can't move.
    const firstFree = this.next + (this.slots[this.next]?.released ? 1 : 0);
    this.slots.splice(after < 0 ? this.slots.length : Math.max(after + 1, firstFree), 0, slot);
    return slot;
  }

  private speech(itemId: string) {
    return this.slots.find((s) => s.items.includes(itemId));
  }

  private response(responseId: string) {
    return this.slots.find((s) => s.responseId === responseId);
  }

  speechCommitted(itemId: string, previousItemId?: string | null) {
    if (!this.speech(itemId)) this.add({ who: "interviewer", items: [itemId], open: true }, previousItemId);
  }

  /** An empty transcript settles the slot without a turn. Speech never announced can only go to the end. */
  speechDone(itemId: string, text: string | undefined) {
    const slot = this.speech(itemId) ?? this.add({ who: "interviewer", items: [itemId] });
    slot.open = false;
    slot.failed = false;
    if (text) slot.texts.push({ text });
  }

  speechFailed(itemId: string) {
    const known = this.speech(itemId);
    if (known && !known.open) return;
    const slot = known ?? this.add({ who: "interviewer", items: [itemId] });
    slot.open = false;
    slot.failed = true;
  }

  typed(text: string) {
    this.add({ who: "interviewer", texts: [{ text }] });
  }

  responseCreated(responseId: string) {
    if (!this.response(responseId)) this.add({ who: "persona", responseId, open: true });
  }

  /** Output whose place has already passed, or that names no response, can only go to the end. */
  answer(responseId: string | undefined, itemId: string | undefined, text: string) {
    const index = this.slots.findIndex((s) => responseId !== undefined && s.responseId === responseId);
    const slot = index >= this.next ? this.slots[index] : this.add({ who: "persona", responseId: index < 0 ? responseId : undefined });
    slot.texts.push({ text });
    if (itemId) slot.items.push(itemId);
  }

  responseDone(responseId: string, cancelled: boolean) {
    const slot = this.response(responseId) ?? this.add({ who: "persona", responseId });
    slot.open = false;
    // Interrupted answers stay visible and stored, but marked, right behind what was said of them.
    if (!cancelled) return;
    const target = this.slots.indexOf(slot) >= this.next ? slot : this.add({ who: "persona" });
    target.texts.push({ text: "(interrupted)", cancelled: true });
  }

  /** Texts that may now be stored, in order. Each is returned exactly once. */
  release() {
    const released: { who: Speaker; text: string }[] = [];
    while (this.next < this.slots.length) {
      const slot = this.slots[this.next];
      for (const { text } of slot.texts.slice(slot.released)) released.push({ who: slot.who, text });
      slot.released = slot.texts.length;
      if (slot.open || slot.failed) break;
      this.next += 1;
    }
    return released;
  }

  turns(): Turn[] {
    let blocked = false;
    return this.slots.flatMap((slot) => {
      const rows: Turn[] = slot.texts.map((text, i) => ({
        who: slot.who,
        ...text,
        ...(i >= slot.released && { held: true, blocked }),
      }));
      if (slot.failed) {
        blocked = true;
        rows.push({ who: slot.who, text: null });
      } else if (slot.open && slot.who === "interviewer") rows.push({ who: slot.who, text: null, pending: true });
      return rows;
    });
  }
}

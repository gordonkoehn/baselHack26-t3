// What a failed avatar leaves in the browser console (#159): in DevTools, filter on this prefix.
export const AVATAR_LOG_PREFIX = "[avatar]";

const MAX_LENGTH = 200;
// Anything else in a word (=, ?, /, quotes, braces) is how URLs, query strings and JSON look.
const PLAIN_WORD = /^[\w.,:;()!'-]{1,40}$/;
// Long and with a digit: an id or a key, not a word. SESSION_TOKEN_EXPIRED stays readable.
const OPAQUE_WORD = /^(?=.*\d).{16,}$/;
const SECRET = "(?:token|key|secret|password|authorization|credential)s?:";
const LABEL_THEN_VALUE = new RegExp(`${SECRET}$|^bearer$`, "i");
const LABEL_WITH_VALUE = new RegExp(`${SECRET}.`, "i");
const SDP = /\bsdp\b|\bv=0\b|\bm=(?:audio|video)\b|\ba=(?:ice|candidate)/i;

function safeText(text: string): string {
  if (!text.trim()) return "no message";
  if (SDP.test(text)) return "[withheld: connection details]";
  let hideNext = false;
  const words = text.trim().split(/\s+/).map((word) => {
    const safe = !hideNext && PLAIN_WORD.test(word) && !OPAQUE_WORD.test(word) && !LABEL_WITH_VALUE.test(word);
    hideNext = LABEL_THEN_VALUE.test(word);
    return safe ? word : "[redacted]";
  });
  const line = words.join(" ");
  return line.length > MAX_LENGTH ? `${line.slice(0, MAX_LENGTH)}…` : line;
}

/**
 * The cause in words that are safe to paste into a chat. Simli's text isn't ours: its join details
 * carry a LiveKit token and SDP, and a server message or an SDK error can repeat them. Codes such
 * as "ERROR: INVALID_FACE_ID" pass; anything shaped like a credential, URL or JSON doesn't.
 */
export function safeCause(cause: unknown): string {
  if (typeof cause === "string") return safeText(cause);
  if (cause instanceof Error) return safeText(`${cause.name}: ${cause.message}`);
  // Never stringify an unknown object: it could hold anything.
  return `no readable message (${typeof cause})`;
}

export function logAvatarFailure(stage: string, cause: unknown): void {
  console.error(`${AVATAR_LOG_PREFIX} ${stage}: ${safeCause(cause)}`);
}

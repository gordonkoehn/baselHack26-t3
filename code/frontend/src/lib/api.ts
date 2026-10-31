import type {
  ExtractedText,
  InsightReport,
  Persona,
  PersonaCreate,
  Session,
  SessionCreate,
  SessionEvent,
  SessionToken,
  SessionUpdate,
} from "@/lib/contracts";

/** A non-2xx answer. `status` lets the UI tell bad input (422) from model (502) or setup (503) trouble. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`${status} ${detail}`);
  }
}

// Same-origin /api/* is proxied to the backend (see next.config.ts), so no CORS and no URLs here.
async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text();
    let detail = body;
    try {
      // FastAPI errors are {"detail": "..."} or {"detail": [validation errors]}.
      const parsed = JSON.parse(body).detail;
      detail = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
    } catch {}
    throw new ApiError(res.status, detail);
  }
  return res.json() as Promise<T>;
}

// Shared demo passcode. Opening the team link (?code=...) keeps it for this page and removes it
// from the address bar. Storage is only a convenience for reloads, and may be blocked.
let linkCode: string | null = null;

function passcode(): Record<string, string> {
  try {
    const url = new URL(window.location.href);
    const fromLink = url.searchParams.get("code");
    if (fromLink) {
      linkCode = fromLink;
      url.searchParams.delete("code");
      window.history.replaceState(null, "", url);
    }
  } catch {}
  let code = linkCode;
  try {
    if (linkCode) localStorage.setItem("demoPasscode", linkCode);
    else code = localStorage.getItem("demoPasscode");
  } catch {}
  return code ? { "X-Demo-Passcode": code } : {};
}

// Saving must never hang the end of a call: a stuck request fails here, and the caller retries it.
export const SAVE_TIMEOUT_MS = 6_000;

export const api = {
  health: () => fetch("/api/health", { cache: "no-store" }).then(json<{ status: string }>),
  createPersona: (body: PersonaCreate) =>
    fetch("/api/personas", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...passcode() },
      body: JSON.stringify(body),
    }).then(json<Persona>),
  // The raw file is the body; the backend pulls out the text layer so quotes stay verifiable.
  extractPdf: (file: File) =>
    fetch("/api/sources/pdf", {
      method: "POST",
      headers: { "Content-Type": "application/pdf", ...passcode() },
      body: file,
    }).then(json<ExtractedText>),
  // The backend sniffs the format from the bytes; the header is only a hint.
  extractImage: (image: Blob) =>
    fetch("/api/sources/image", {
      method: "POST",
      headers: { "Content-Type": image.type || "application/octet-stream", ...passcode() },
      body: image,
    }).then(json<ExtractedText>),
  createSession: (body: SessionCreate) =>
    fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<Session>),
  // No default deadline: a slow "live" only delays the start. Pass one where a stuck request must end.
  updateSession: (id: string, body: SessionUpdate, timeoutMs?: number) =>
    fetch(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    }).then(json<Session>),
  sessionToken: (id: string) =>
    fetch(`/api/sessions/${encodeURIComponent(id)}/token`, { method: "POST", cache: "no-store", headers: passcode() }).then(
      json<SessionToken>,
    ),
  // Short-lived Simli token for the persona's face; the browser opens the avatar stream itself.
  avatarToken: (id: string) =>
    fetch(`/api/sessions/${encodeURIComponent(id)}/avatar-token`, { method: "POST", cache: "no-store", headers: passcode() }).then(
      json<SessionToken>,
    ),
  // Idempotent per seq: resending the same events is safe, a changed event under an old seq is 409.
  postEvents: (id: string, events: SessionEvent[]) =>
    fetch(`/api/sessions/${encodeURIComponent(id)}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(events),
      signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
    }).then(json<{ accepted: number }>),
  // Needs an ended session with a complete transcript; 409 if it isn't, 422 without interview questions.
  debrief: (id: string) =>
    fetch(`/api/sessions/${encodeURIComponent(id)}/debrief`, { method: "POST", headers: passcode() }).then(json<InsightReport>),
  getPersona: (id: string) =>
    fetch(`/api/personas/${encodeURIComponent(id)}`, { cache: "no-store" }).then(json<Persona>),
};

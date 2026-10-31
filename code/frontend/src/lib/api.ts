import type {
  ExtractedText,
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

export const api = {
  health: () => fetch("/api/health", { cache: "no-store" }).then(json<{ status: string }>),
  createPersona: (body: PersonaCreate) =>
    fetch("/api/personas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<Persona>),
  // The raw file is the body; the backend pulls out the text layer so quotes stay verifiable.
  extractPdf: (file: File) =>
    fetch("/api/sources/pdf", {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: file,
    }).then(json<ExtractedText>),
  // The backend sniffs the format from the bytes; the header is only a hint.
  extractImage: (image: Blob) =>
    fetch("/api/sources/image", {
      method: "POST",
      headers: { "Content-Type": image.type || "application/octet-stream" },
      body: image,
    }).then(json<ExtractedText>),
  createSession: (body: SessionCreate) =>
    fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<Session>),
  updateSession: (id: string, body: SessionUpdate) =>
    fetch(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<Session>),
  sessionToken: (id: string) =>
    fetch(`/api/sessions/${encodeURIComponent(id)}/token`, { method: "POST", cache: "no-store" }).then(
      json<SessionToken>,
    ),
  // Idempotent per seq: resending the same events is safe, a changed event under an old seq is 409.
  postEvents: (id: string, events: SessionEvent[]) =>
    fetch(`/api/sessions/${encodeURIComponent(id)}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(events),
    }).then(json<{ accepted: number }>),
  getPersona: (id: string) =>
    fetch(`/api/personas/${encodeURIComponent(id)}`, { cache: "no-store" }).then(json<Persona>),
};

import type {
  CoverageReport,
  CoverageRequest,
  ExtractedText,
  Face,
  GuideReview,
  GuideReviewRequest,
  InsightReport,
  Persona,
  PersonaAnswers,
  PersonaCreate,
  PersonaSummary,
  PersonaUpdate,
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

// The deadline includes reading/parsing the response body, not just receiving headers.
// Race as well as abort: a stuck body reader must not keep the end-call UI waiting.
export class RequestDeadlineError extends Error {
  constructor() {
    super("Request deadline exceeded");
    this.name = "RequestDeadlineError";
  }
}

async function deadline<T>(request: (signal: AbortSignal) => Promise<T>, timeoutMs = 4_000): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new RequestDeadlineError());
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function persisted<T>(url: string, init: RequestInit, timeoutMs = 4_000): Promise<T> {
  return deadline((signal) => fetch(url, { ...init, signal }).then(json<T>), timeoutMs);
}

function updateSession(id: string, body: SessionUpdate): Promise<Session> {
  // Startup can include a cold backend; final saves keep their shorter budget.
  // The store makes ended terminal, including after ambiguous startup failures.
  return persisted<Session>(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, body.status === "live" ? 15_000 : 4_000);
}

export const api = {
  health: () => fetch("/api/health", { cache: "no-store" }).then(json<{ status: string }>),
  createPersona: (body: PersonaCreate) =>
    fetch("/api/personas", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...passcode() },
      body: JSON.stringify(body),
    }).then(json<Persona>),
  listPersonas: () =>
    fetch("/api/personas", { cache: "no-store", headers: passcode() }).then(json<PersonaSummary[]>),
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
  reviewGuide: (body: GuideReviewRequest) =>
    fetch("/api/guides/review", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...passcode() },
      body: JSON.stringify(body),
    }).then(json<GuideReview>),
  createSession: (body: SessionCreate) =>
    fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...passcode() },
      body: JSON.stringify(body),
    }).then(json<Session>),
  updateSession,
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
    persisted<{ accepted: number }>(`/api/sessions/${encodeURIComponent(id)}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(events),
    }),
  // Needs an ended session with a complete transcript; 409 if it isn't, 422 without interview questions.
  debrief: (id: string) =>
    fetch(`/api/sessions/${encodeURIComponent(id)}/debrief`, { method: "POST", headers: passcode() }).then(json<InsightReport>),
  updatePersona: (id: string, body: PersonaUpdate) =>
    fetch(`/api/personas/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...passcode() },
      body: JSON.stringify(body),
    }).then(json<Persona>),
  // Calls the model, not stored: is this persona good enough for what the team will test?
  checkCoverage: (id: string, body: CoverageRequest) =>
    fetch(`/api/personas/${encodeURIComponent(id)}/coverage`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...passcode() },
      body: JSON.stringify(body),
    }).then(json<CoverageReport>),
  // Adds facts from the team's gap answers to the same persona (version bump, same id).
  answerGaps: (id: string, body: PersonaAnswers) =>
    fetch(`/api/personas/${encodeURIComponent(id)}/answers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...passcode() },
      body: JSON.stringify(body),
    }).then(json<Persona>),
  listFaces: () => fetch("/api/faces").then(json<Face[]>),
  // The raw image is the body; the backend sniffs the type from the bytes.
  uploadPhoto: (id: string, image: Blob) =>
    fetch(`/api/personas/${encodeURIComponent(id)}/photo`, {
      method: "PUT",
      headers: { "Content-Type": image.type || "application/octet-stream", ...passcode() },
      body: image,
    }).then(json<Persona>),
  // Simli builds a call face from the stored photo; uses one of the account's paid generations.
  startFace: (id: string) =>
    fetch(`/api/personas/${encodeURIComponent(id)}/face`, { method: "POST", headers: passcode() }).then(json<Persona>),
  refreshFace: (id: string) =>
    fetch(`/api/personas/${encodeURIComponent(id)}/face/refresh`, { method: "POST", headers: passcode() }).then(
      json<Persona>,
    ),
  removePhoto: (id: string) =>
    fetch(`/api/personas/${encodeURIComponent(id)}/photo`, { method: "DELETE", headers: passcode() }).then(
      json<Persona>,
    ),
  getPersona: (id: string) =>
    fetch(`/api/personas/${encodeURIComponent(id)}`, { cache: "no-store" }).then(json<Persona>),
  // Newest first. Needs the passcode: a shared report link must not lead to the persona's other interviews.
  listPersonaSessions: (id: string) =>
    fetch(`/api/personas/${encodeURIComponent(id)}/sessions`, { cache: "no-store", headers: passcode() }).then(json<Session[]>),
  getSession: (id: string) =>
    fetch(`/api/sessions/${encodeURIComponent(id)}`, { cache: "no-store" }).then(json<Session>),
  // The saved report only, 404 if there is none. Unlike debrief() it never calls the model, so it needs no passcode.
  getInsights: (id: string) =>
    fetch(`/api/sessions/${encodeURIComponent(id)}/insights`, { cache: "no-store" }).then(json<InsightReport>),
};

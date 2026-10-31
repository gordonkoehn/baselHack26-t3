import { ApiError } from "@/lib/api";

/** What the persona form tells the user when a request fails. */
export function errorMessage(e: unknown): string {
  // `make dev` only helps someone running the app locally, so only `next dev` builds suggest it.
  const local = process.env.NODE_ENV === "development";
  if (!(e instanceof ApiError)) {
    return local ? "Backend not reachable. Is `make dev` running?" : "Couldn't connect. Check your connection and try again.";
  }
  if (e.status === 401) return "This needs the team link with the passcode. Ask in Discord.";
  if (e.status === 422) return `The input was rejected: ${e.detail}`;
  // The backend's detail says how long to wait.
  if (e.status === 429) return e.detail;
  if (e.status === 502) return "The model's answer couldn't be used. Try again.";
  if (e.status === 503) return "The persona service is temporarily unavailable. Try again in a moment.";
  // The Next proxy answers 500 when the backend process isn't running at all.
  if (e.status >= 500) {
    return local
      ? `Backend not reachable (${e.status}). Is \`make dev\` running?`
      : `The persona service is temporarily unavailable (${e.status}). Try again in a moment.`;
  }
  return `Unexpected error ${e.status}: ${e.detail}`;
}

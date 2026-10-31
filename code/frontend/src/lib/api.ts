// Same-origin /api/* is proxied to the backend (see next.config.ts), so no CORS and no URLs here.
async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  health: () => fetch("/api/health", { cache: "no-store" }).then(json<{ status: string }>),
};

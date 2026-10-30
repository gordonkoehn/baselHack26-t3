import type { Item, ItemCreate } from "./contracts";

// Same-origin /api/* is proxied to the backend (see next.config.ts), so no CORS and no URLs here.
async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  listItems: () => fetch("/api/items", { cache: "no-store" }).then(json<Item[]>),
  createItem: (body: ItemCreate) =>
    fetch("/api/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<Item>),
};

"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Item } from "@/lib/contracts";

export default function Home() {
  const [items, setItems] = useState<Item[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listItems().then(setItems).catch((e) => setError(String(e)));
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      const item = await api.createItem({ title });
      setItems((prev) => [...prev, item]);
      setTitle("");
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <main className="mx-auto max-w-xl p-8 font-sans">
      <h1 className="mb-6 text-2xl font-semibold">baselhack26</h1>
      {error && <p className="mb-4 text-red-600">Backend error: {error}</p>}
      <form onSubmit={add} className="mb-6 flex gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="New item"
          className="flex-1 rounded border px-3 py-2"
        />
        <button className="rounded bg-black px-4 py-2 text-white">Add</button>
      </form>
      <ul className="space-y-2" data-testid="items">
        {items.map((i) => (
          <li key={i.id} className="rounded border px-3 py-2">
            {i.title}
          </li>
        ))}
      </ul>
    </main>
  );
}

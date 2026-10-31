"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export default function Home() {
  const [status, setStatus] = useState("…");

  useEffect(() => {
    api
      .health()
      .then((r) => setStatus(r.status))
      .catch((e) => setStatus(`error: ${e}`));
  }, []);

  return (
    <main className="mx-auto max-w-xl p-8 font-sans">
      <h1 className="mb-2 text-2xl font-semibold">OpenTwin</h1>
      <p className="text-gray-600">Test case: Quartier-Börse</p>
      <p className="mt-6 text-sm text-gray-500" data-testid="backend-status">
        Backend: {status}
      </p>
    </main>
  );
}

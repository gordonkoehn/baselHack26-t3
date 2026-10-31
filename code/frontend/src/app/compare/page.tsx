import type { Metadata } from "next";
import { Suspense } from "react";
import { CompareView } from "@/components/CompareView";

export const metadata: Metadata = { title: "Compare interviews · OpenTwin" };

// Search params are runtime data under Cache Components, so they are read inside Suspense. The
// header sits outside it: the simulation label shows in every state.
export default function ComparePage({ searchParams }: PageProps<"/compare">) {
  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-10 font-sans sm:px-8">
      <header className="mb-6">
        <p className="mb-2 text-xs font-medium uppercase tracking-widest text-accent">OpenTwin</p>
        <h1 className="text-3xl font-semibold tracking-tight">Compare interviews</h1>
        <p className="mt-2 max-w-xl text-muted">Simulated personas: hypotheses for real customer research.</p>
      </header>
      <Suspense fallback={<p className="text-sm text-muted">Loading comparison…</p>}>
        {searchParams.then(({ id }) => (
          <CompareView sessionIds={[id ?? []].flat()} />
        ))}
      </Suspense>
    </main>
  );
}

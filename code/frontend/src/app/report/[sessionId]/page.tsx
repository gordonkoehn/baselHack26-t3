import type { Metadata } from "next";
import { Suspense } from "react";
import { ReportView } from "@/components/ReportView";

export const metadata: Metadata = { title: "Debrief · OpenTwin" };

// Params are runtime data under Cache Components, so they are read inside Suspense. The header sits
// outside it: the AI-simulation label shows in every state, including not found.
export default function ReportPage({ params }: PageProps<"/report/[sessionId]">) {
  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-10 font-sans sm:px-8">
      <header className="mb-6">
        <p className="mb-2 text-xs font-medium uppercase tracking-widest text-accent">OpenTwin</p>
        <h1 className="text-3xl font-semibold tracking-tight">Interview debrief</h1>
        <p className="mt-2 max-w-xl text-muted">
          Simulated interview with an AI persona, not feedback from real users.
        </p>
      </header>
      <Suspense fallback={<p className="text-sm text-muted">Loading debrief…</p>}>
        {params.then(({ sessionId }) => (
          <ReportView sessionId={sessionId} />
        ))}
      </Suspense>
    </main>
  );
}

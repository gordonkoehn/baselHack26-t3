"use client";

import { useState } from "react";

// The interviewer's checklist during a call. Ticks are a personal aid: they stay in the browser and
// never reach the debrief. The parent keys this by session, so a new call starts unticked.
export function InterviewScript({ questions }: { questions: string[] }) {
  const [done, setDone] = useState<Set<number>>(new Set());

  if (questions.length === 0) return null;

  function toggle(index: number) {
    setDone((current) => {
      const next = new Set(current);
      if (!next.delete(index)) next.add(index);
      return next;
    });
  }

  return (
    <section aria-label="Interview script" data-testid="interview-script">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h4 className="text-sm font-bold tracking-tight">Your script</h4>
        <p className="font-mono text-xs text-muted" aria-live="polite">
          {done.size} of {questions.length}
        </p>
      </div>
      <ul className="max-h-[40dvh] space-y-1 overflow-y-auto pr-1 text-sm">
        {questions.map((question, index) => (
          <li key={`${index}-${question}`}>
            <label className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1 hover:bg-line/40">
              <input
                type="checkbox"
                className="mt-0.5 size-4 shrink-0 accent-accent"
                checked={done.has(index)}
                onChange={() => toggle(index)}
              />
              <span className={done.has(index) ? "text-muted line-through" : ""}>{question}</span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}

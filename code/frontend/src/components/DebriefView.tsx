"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { InsightReport } from "@/lib/contracts";
import { formatReportMarkdown, reportMarkdownFilename } from "@/lib/reportMarkdown";

const SIGNAL = {
  supports: { text: "supports", className: "bg-accent-soft text-accent" },
  contradicts: { text: "contradicts", className: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200" },
  unclear: { text: "unclear", className: "bg-line text-foreground" },
} as const;

// Debrief of one ended interview: per sprint question, what the persona's answers say about it.
// Quotes are verbatim from the synthetic interview; "grounded" means the persona's sources say it
// too. Neither means "validated with real users".
export function DebriefView({ sessionId, personaName }: { sessionId: string; personaName: string }) {
  const [report, setReport] = useState<InsightReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  const [exportStatus, setExportStatus] = useState<{ error: boolean; text: string } | null>(null);
  const downloads = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const pending = downloads.current;
    return () => {
      for (const [url, timer] of pending) {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      pending.clear();
    };
  }, []);

  // Everyone wants the debrief after an interview: start it right away instead of waiting for a click.
  // Once per session: React dev mode runs effects twice, and two parallel POSTs would both call the model.
  const started = useRef<string | null>(null);
  useEffect(() => {
    if (started.current === sessionId) return;
    started.current = sessionId;
    void create();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    if (report) box.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [report]);

  async function create() {
    setLoading(true);
    setError(null);
    try {
      // Repeated POSTs return the saved report, so a retry after a network error is safe.
      setReport(await api.debrief(sessionId));
    } catch (e) {
      if (!(e instanceof ApiError)) setError("Backend not reachable.");
      else if (e.status === 409) setError(`The transcript is not complete yet: ${e.detail}`);
      else if (e.status === 503) setError("The debrief model is unavailable right now. Try again in a moment.");
      else setError(`Debrief failed (${e.status}): ${e.detail}`);
    } finally {
      setLoading(false);
    }
  }

  async function copyMarkdown() {
    if (!report || copying) return;
    setCopying(true);
    setExportStatus(null);
    try {
      await navigator.clipboard.writeText(formatReportMarkdown(report, personaName));
      setExportStatus({ error: false, text: "Markdown copied to clipboard." });
    } catch {
      setExportStatus({ error: true, text: "Could not copy Markdown. Try again or use Download .md." });
    } finally {
      setCopying(false);
    }
  }

  function downloadMarkdown() {
    if (!report) return;
    const link = document.createElement("a");
    let url: string | null = null;
    try {
      url = URL.createObjectURL(new Blob([formatReportMarkdown(report, personaName)], { type: "text/markdown;charset=utf-8" }));
      link.href = url;
      link.download = reportMarkdownFilename(report, personaName);
      document.body.append(link);
      link.click();
      const downloadUrl = url;
      // Let the browser consume the URL before releasing it; also clean up on unmount.
      downloads.current.set(downloadUrl, setTimeout(() => {
        URL.revokeObjectURL(downloadUrl);
        downloads.current.delete(downloadUrl);
      }, 1000));
      setExportStatus({ error: false, text: "Markdown download started." });
    } catch {
      if (url) URL.revokeObjectURL(url);
      setExportStatus({ error: true, text: "Could not download Markdown. Try again or use Copy as Markdown." });
    } finally {
      link.remove();
    }
  }

  if (!report) {
    return (
      <div className="mt-4">
        <button
          type="button"
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface hover:opacity-90 disabled:opacity-50"
          onClick={create}
          disabled={loading}
        >
          {loading ? "Writing debrief…" : error ? "Try again" : "Create debrief"}
        </button>
        {error && (
          <p role="alert" className="mt-2 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div ref={box} className="mt-6 scroll-mt-6 rounded-xl border border-line bg-background/60 p-5" data-testid="debrief">
      <h3 className="text-xs font-semibold uppercase tracking-widest text-muted">Debrief</h3>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        Quotes are from the interview with {personaName}, an AI persona: hypotheses to check with real users, not
        findings. &ldquo;grounded&rdquo; means the persona&apos;s real sources say it too.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={copyMarkdown}
          disabled={copying}
          className="rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium hover:bg-line disabled:opacity-50"
        >
          {copying ? "Copying…" : "Copy as Markdown"}
        </button>
        <button
          type="button"
          onClick={downloadMarkdown}
          className="rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium hover:bg-line"
        >
          Download .md
        </button>
      </div>
      <p role="status" className="mt-2 text-sm text-muted">
        {exportStatus && !exportStatus.error ? exportStatus.text : ""}
      </p>
      {exportStatus?.error && (
        <p role="alert" className="mt-2 text-sm text-red-800 dark:text-red-200">{exportStatus.text}</p>
      )}
      <ol className="mt-4 space-y-4">
        {report.questions.map((q) => (
          <li key={q.question} className="rounded-lg border border-line bg-surface p-4">
            <p className="text-sm font-medium">
              <span className={`mr-2 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${SIGNAL[q.signal].className}`}>
                {SIGNAL[q.signal].text}
              </span>
              {q.question}
            </p>
            <ul className="mt-3 space-y-3">
              {q.insights.map((i) => (
                <li key={i.id} className="text-sm leading-relaxed">
                  <span
                    className={`mr-2 inline-block rounded px-1.5 py-0.5 text-xs font-medium ${
                      i.label === "grounded" ? "bg-accent-soft text-accent" : "bg-line text-foreground"
                    }`}
                  >
                    {i.label === "grounded" ? "grounded" : "guess"}
                  </span>
                  {i.theme}
                  {/* The quote is always verbatim from the interview; the label says whether the
                      persona's real sources back it too. */}
                  <blockquote
                    className={`mt-1.5 border-l-2 pl-3 text-foreground/80 wrap-anywhere ${
                      i.label === "grounded" ? "border-accent/40" : "border-line"
                    }`}
                  >
                    “{i.quote}”
                    <span className="mt-0.5 block text-xs text-muted">
                      {personaName} · interview turn {i.turnSeq}
                      {i.label === "grounded" ? " · also in the sources" : " · not backed by the sources"}
                    </span>
                  </blockquote>
                </li>
              ))}
            </ul>
            {q.followUps && q.followUps.length > 0 && (
              <p className="mt-3 border-t border-line pt-2 text-xs text-muted">Ask real users next: {q.followUps.join(" · ")}</p>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

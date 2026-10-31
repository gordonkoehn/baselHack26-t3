"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { Evidence, Fact, Persona, PersonaSource, SourceKind } from "@/lib/contracts";
import { QUARTIER_BOERSE } from "@/lib/sample";

const KINDS: SourceKind[] = ["note", "transcript", "miro", "real_interview"];

type Result = { persona: Persona; sources: PersonaSource[]; seconds: number };

function errorMessage(e: unknown): string {
  if (!(e instanceof ApiError)) return "Backend not reachable. Is `make dev` running?";
  if (e.status === 422) return `The input was rejected: ${e.detail}`;
  if (e.status === 502) return "The model's answer couldn't be used. Try again.";
  if (e.status === 503) return "Backend not ready (OpenAI key or store missing in backend/.env).";
  // The Next proxy answers 500 when the backend process isn't running at all.
  if (e.status >= 500) return `Backend not reachable (${e.status}). Is \`make dev\` running?`;
  return `Unexpected error ${e.status}: ${e.detail}`;
}

export default function Home() {
  const [kind, setKind] = useState<SourceKind>("note");
  const [text, setText] = useState(QUARTIER_BOERSE);
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const startedAt = useRef(0);

  // Tick a visible timer while the persona is being built: the demo claims "ready in minutes".
  useEffect(() => {
    if (!loading) return;
    const id = setInterval(() => setElapsed((Date.now() - startedAt.current) / 1000), 100);
    return () => clearInterval(id);
  }, [loading]);

  async function create() {
    if (loading || !text.trim()) return;
    // Snapshot the input: the card's citations must keep pointing at what was actually sent.
    const sources: PersonaSource[] = [{ kind, title: "Pasted sources", text }];
    startedAt.current = Date.now();
    setElapsed(0);
    setLoading(true);
    setError(null);
    try {
      const persona = await api.createPersona({ language: "de", sources });
      setResult({ persona, sources, seconds: (Date.now() - startedAt.current) / 1000 });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl p-8 font-sans">
      <h1 className="mb-1 text-2xl font-semibold">OpenTwin</h1>
      <p className="mb-6 opacity-70">
        Paste sprint sources, get an interview-ready persona. Every fact is either grounded in a
        quote from the sources or marked as the persona&apos;s guess.
      </p>

      <section className="mb-8 space-y-3">
        <label className="block text-sm font-medium" htmlFor="sources">
          Sources
        </label>
        <textarea
          id="sources"
          className="h-56 w-full rounded border border-current/30 p-3 font-mono text-xs"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={loading}
        />
        <div className="flex flex-wrap items-center gap-3">
          <select
            aria-label="Source kind"
            className="rounded border border-current/30 px-2 py-1 text-sm"
            value={kind}
            onChange={(e) => setKind(e.target.value as SourceKind)}
            disabled={loading}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="rounded bg-foreground px-4 py-2 text-sm text-background disabled:opacity-40"
            onClick={create}
            disabled={loading || !text.trim()}
          >
            {loading ? "Building persona…" : "Create persona"}
          </button>
          {loading && <span className="text-sm tabular-nums opacity-70">{elapsed.toFixed(1)} s</span>}
          {!text.trim() && <span className="text-sm opacity-60">Paste some sources first.</span>}
        </div>
        {error && (
          <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-800">
            {error}
          </p>
        )}
      </section>

      {result && <PersonaCard {...result} />}
    </main>
  );
}

function PersonaCard({ persona, sources, seconds }: Result) {
  const facts = [...persona.jobs, ...persona.pains, ...persona.objections];
  const grounded = facts.filter((f) => f.label === "grounded").length;
  const meta = [persona.age && `${persona.age}`, persona.location, persona.context?.job]
    .filter(Boolean)
    .join(" · ");

  return (
    <article className="rounded border border-current/20 p-6" data-testid="persona-card">
      <p className="mb-4 text-xs opacity-60">
        Ready in {seconds.toFixed(1)} s · {grounded} grounded · {facts.length - grounded} guesses
      </p>
      <h2 className="text-xl font-semibold">{persona.name}</h2>
      {meta && <p className="text-sm opacity-70">{meta}</p>}
      <p className="mt-3">{persona.summary}</p>

      <FactList title="Jobs" facts={persona.jobs} persona={persona} sources={sources} />
      <FactList title="Pains" facts={persona.pains} persona={persona} sources={sources} />
      <FactList title="Objections" facts={persona.objections} persona={persona} sources={sources} />
    </article>
  );
}

function FactList(props: {
  title: string;
  facts: Fact[];
  persona: Persona;
  sources: PersonaSource[];
}) {
  const { title, facts, persona, sources } = props;
  return (
    <section className="mt-6">
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide opacity-60">{title}</h3>
      {facts.length === 0 ? (
        <p className="text-sm opacity-50">None.</p>
      ) : (
        <ul className="space-y-3">
          {facts.map((fact, i) => (
            <FactItem
              key={i}
              fact={fact}
              evidence={persona.evidence.find((e) => e.id === fact.evidenceId)}
              sources={sources}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function FactItem({
  fact,
  evidence,
  sources,
}: {
  fact: Fact;
  evidence?: Evidence;
  sources: PersonaSource[];
}) {
  // Only trust "grounded" when the evidence is really there; the backend guarantees it, this is a guard.
  const isGrounded = fact.label === "grounded" && evidence !== undefined;
  // sourceRef is "source:N" (1-based) into the submitted sources.
  const n = Number(evidence?.sourceRef?.split(":")[1]);
  const source = Number.isInteger(n) ? sources[n - 1] : undefined;

  return (
    <li className="text-sm">
      <span
        className={`mr-2 inline-block rounded px-1.5 py-0.5 text-xs font-medium ${
          isGrounded ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-600"
        }`}
      >
        {isGrounded ? "grounded" : "guess"}
      </span>
      {fact.text}
      {isGrounded && (
        <blockquote className="mt-1 border-l-2 border-green-300 pl-3 opacity-80">
          “{evidence.quote}”
          <span className="block text-xs opacity-50">
            {evidence.kind}
            {source?.title ? ` · ${source.title}` : ""}
            {evidence.sourceRef ? ` · ${evidence.sourceRef}` : ""}
          </span>
        </blockquote>
      )}
    </li>
  );
}

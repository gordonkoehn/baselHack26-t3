"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { Evidence, Fact, Language, Persona, PersonaSource, SourceKind } from "@/lib/contracts";
import { QUARTIER_BOERSE, SAMPLE_TRANSCRIPT } from "@/lib/sample";

const KINDS: SourceKind[] = ["note", "transcript", "miro", "real_interview"];
// Files the browser can read as plain text without any extra library.
const TEXT_FILES = ".txt,.md,.csv,.json,.tsv";

type Draft = PersonaSource & { id: number };
type Result = { persona: Persona; sources: PersonaSource[]; seconds: number };

let nextId = 0;
const draft = (kind: SourceKind, title: string, text: string): Draft => ({
  id: nextId++,
  kind,
  title,
  text,
});

const SAMPLES = (): Draft[] => [
  draft("note", "Interview guide Quartier-Börse", QUARTIER_BOERSE),
  draft("transcript", "Interview transcript (synthetic)", SAMPLE_TRANSCRIPT),
];

// A board export (Miro/FigJam CSV) is the usual .csv; everything else starts as a note.
const kindFor = (name: string): SourceKind => (name.toLowerCase().endsWith(".csv") ? "miro" : "note");

function errorMessage(e: unknown): string {
  if (!(e instanceof ApiError)) return "Backend not reachable. Is `make dev` running?";
  if (e.status === 422) return `The input was rejected: ${e.detail}`;
  if (e.status === 502) return "The model's answer couldn't be used. Try again.";
  if (e.status === 503) return "The persona service is temporarily unavailable. Try again in a moment.";
  // The Next proxy answers 500 when the backend process isn't running at all.
  if (e.status >= 500) return `Backend not reachable (${e.status}). Is \`make dev\` running?`;
  return `Unexpected error ${e.status}: ${e.detail}`;
}

export default function Home() {
  const [drafts, setDrafts] = useState<Draft[]>(SAMPLES);
  const [language, setLanguage] = useState<Language>("de");
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [dragging, setDragging] = useState(false);
  const startedAt = useRef(0);
  const filled = drafts.filter((d) => d.text.trim());

  // Tick a visible timer while the persona is being built: the demo claims "ready in minutes".
  useEffect(() => {
    if (!loading) return;
    const id = setInterval(() => setElapsed((Date.now() - startedAt.current) / 1000), 100);
    return () => clearInterval(id);
  }, [loading]);

  const update = (id: number, patch: Partial<PersonaSource>) =>
    setDrafts((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  async function addFiles(files: FileList | File[]) {
    setError(null);
    const added: Draft[] = [];
    const skipped: string[] = [];
    for (const file of Array.from(files)) {
      const ext = `.${file.name.split(".").pop()?.toLowerCase()}`;
      if (!TEXT_FILES.split(",").includes(ext)) {
        skipped.push(file.name);
        continue;
      }
      added.push(draft(kindFor(file.name), file.name, await file.text()));
    }
    setDrafts((ds) => [...ds, ...added]);
    if (skipped.length) setError(`Not supported yet (use ${TEXT_FILES}): ${skipped.join(", ")}`);
  }

  async function create() {
    if (loading || filled.length === 0) return;
    // Snapshot the input: the card's citations must keep pointing at what was actually sent.
    const sources: PersonaSource[] = filled.map(({ kind, title, text }) => ({ kind, title, text }));
    startedAt.current = Date.now();
    setElapsed(0);
    setLoading(true);
    setError(null);
    try {
      const persona = await api.createPersona({ language, sources });
      setResult({ persona, sources, seconds: (Date.now() - startedAt.current) / 1000 });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main
      className="mx-auto max-w-3xl p-8 font-sans"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (!loading) addFiles(e.dataTransfer.files);
      }}
    >
      <h1 className="mb-1 text-2xl font-semibold">OpenTwin</h1>
      <p className="mb-6 opacity-70">
        Add sprint sources, get an interview-ready persona. Every fact is either grounded in a
        quote from the sources or marked as the persona&apos;s guess.
      </p>

      <section
        className={`mb-8 space-y-4 rounded ${dragging ? "outline-2 outline-dashed outline-current/40" : ""}`}
      >
        <h2 className="text-sm font-medium">Sources ({filled.length})</h2>
        {drafts.map((d, i) => (
          <div key={d.id} className="space-y-2 rounded border border-current/20 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <input
                aria-label={`Source ${i + 1} title`}
                className="min-w-0 flex-1 rounded border border-current/30 bg-transparent px-2 py-1 text-sm"
                value={d.title ?? ""}
                onChange={(e) => update(d.id, { title: e.target.value })}
                disabled={loading}
              />
              <select
                aria-label={`Source ${i + 1} kind`}
                className="rounded border border-current/30 bg-transparent px-2 py-1 text-sm"
                value={d.kind}
                onChange={(e) => update(d.id, { kind: e.target.value as SourceKind })}
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
                className="rounded px-2 py-1 text-sm opacity-60 hover:opacity-100 disabled:opacity-30"
                onClick={() => setDrafts((ds) => ds.filter((x) => x.id !== d.id))}
                disabled={loading}
                aria-label={`Remove source ${i + 1}`}
              >
                Remove
              </button>
            </div>
            <textarea
              aria-label={`Source ${i + 1} text`}
              className="h-40 w-full rounded border border-current/30 bg-transparent p-3 font-mono text-xs"
              value={d.text}
              onChange={(e) => update(d.id, { text: e.target.value })}
              disabled={loading}
            />
          </div>
        ))}

        <div className="flex flex-wrap items-center gap-3 text-sm">
          <button
            type="button"
            className="rounded border border-current/30 px-3 py-1.5 disabled:opacity-40"
            onClick={() => setDrafts((ds) => [...ds, draft("note", `Source ${ds.length + 1}`, "")])}
            disabled={loading}
          >
            Add text source
          </button>
          <label className="cursor-pointer rounded border border-current/30 px-3 py-1.5">
            Add files…
            <input
              type="file"
              multiple
              accept={TEXT_FILES}
              className="hidden"
              disabled={loading}
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          <span className="opacity-60">or drop {TEXT_FILES} files anywhere</span>
          <button
            type="button"
            className="ml-auto rounded px-2 py-1 opacity-60 hover:opacity-100 disabled:opacity-30"
            onClick={() => setDrafts(SAMPLES())}
            disabled={loading}
          >
            Reset to example
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <select
            aria-label="Persona language"
            className="rounded border border-current/30 bg-transparent px-2 py-1 text-sm"
            value={language}
            onChange={(e) => setLanguage(e.target.value as Language)}
            disabled={loading}
          >
            <option value="de">Deutsch</option>
            <option value="en">English</option>
          </select>
          <button
            type="button"
            className="rounded bg-foreground px-4 py-2 text-sm text-background disabled:opacity-40"
            onClick={create}
            disabled={loading || filled.length === 0}
          >
            {loading ? "Building persona…" : "Create persona"}
          </button>
          {loading && <span className="text-sm tabular-nums opacity-70">{elapsed.toFixed(1)} s</span>}
          {filled.length === 0 && <span className="text-sm opacity-60">Add at least one source.</span>}
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

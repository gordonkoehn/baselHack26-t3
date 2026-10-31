"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "@/lib/api";
import { errorMessage } from "@/lib/errorMessage";
import type { Evidence, Fact, Language, Persona, PersonaSource, SourceKind } from "@/lib/contracts";
import { InterviewRoom } from "@/components/InterviewRoom";
import { QUARTIER_BOERSE, SAMPLE_TRANSCRIPT } from "@/lib/sample";

const KINDS: SourceKind[] = ["note", "transcript", "miro", "real_interview"];
// Files the browser can read as plain text without any extra library; PDFs and images go through
// the backend (text layer, or a transcription of the visible text).
const TEXT_FILES = ".txt,.md,.csv,.json,.tsv";
const IMAGE_FILES = ".png,.jpg,.jpeg,.webp,.gif";
const ACCEPTED = `${TEXT_FILES},.pdf,${IMAGE_FILES}`;

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

// Draw the image on white: the vision model reads text on a transparent PNG as black on black.
// Also shrink to 2048 px (the model downsizes anyway), so phone photos stay far below 10 MB.
async function onWhite(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas"))), "image/jpeg", 0.92),
  );
}

export default function Home() {
  const [drafts, setDrafts] = useState<Draft[]>(SAMPLES);
  const [language, setLanguage] = useState<Language>("de");
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  // Once a persona exists the sources fold away, so the persona and the interview get the screen.
  const [editing, setEditing] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const startedAt = useRef(0);
  const filled = drafts.filter((d) => d.text.trim());
  // While building or reading files, nothing is editable: a late file result can't land in a
  // reset list, and the submitted sources can't change under a running request.
  const busy = loading || reading;

  // Tick a visible timer while the persona is being built: the demo claims "ready in minutes".
  useEffect(() => {
    if (!loading) return;
    const id = setInterval(() => setElapsed((Date.now() - startedAt.current) / 1000), 100);
    return () => clearInterval(id);
  }, [loading]);

  // A new persona appears below the fold: bring it into view.
  useEffect(() => {
    if (result) card.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [result]);

  const update = (id: number, patch: Partial<PersonaSource>) =>
    setDrafts((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  async function addFiles(files: FileList | File[]) {
    setError(null);
    setReading(true);
    const problems: string[] = [];
    for (const file of Array.from(files)) {
      const ext = `.${file.name.split(".").pop()?.toLowerCase()}`;
      try {
        if (ext === ".pdf") {
          const { text, pages } = await api.extractPdf(file);
          const title = `${file.name} (${pages} ${pages === 1 ? "page" : "pages"})`;
          setDrafts((ds) => [...ds, draft("note", title, text)]);
        } else if (IMAGE_FILES.split(",").includes(ext)) {
          const { text } = await api.extractImage(await onWhite(file));
          setDrafts((ds) => [...ds, draft("note", `${file.name} (image, transcribed)`, text)]);
        } else if (TEXT_FILES.split(",").includes(ext)) {
          const text = await file.text();
          setDrafts((ds) => [...ds, draft("note", file.name, text)]);
        } else {
          problems.push(`${file.name}: not supported (use ${ACCEPTED})`);
        }
      } catch (e) {
        problems.push(`${file.name}: ${e instanceof ApiError ? e.detail : "could not be read"}`);
      }
    }
    setReading(false);
    if (problems.length) setError(problems.join(" · "));
  }

  async function create() {
    if (busy || filled.length === 0) return;
    // Snapshot the input: the card's citations must keep pointing at what was actually sent.
    const sources: PersonaSource[] = filled.map(({ kind, title, text }) => ({ kind, title, text }));
    startedAt.current = Date.now();
    setElapsed(0);
    setLoading(true);
    setError(null);
    try {
      const persona = await api.createPersona({ language, sources });
      setResult({ persona, sources, seconds: (Date.now() - startedAt.current) / 1000 });
      setEditing(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main
      className="mx-auto w-full max-w-3xl px-5 py-10 font-sans sm:px-8"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (!busy) addFiles(e.dataTransfer.files);
      }}
    >
      <header className="mb-10 pt-6">
        <Image src="/opentwin-logo.svg" alt="OpenTwin" width={140} height={32} className="mb-8 h-8 w-auto" priority />
        <h1 className="max-w-3xl text-5xl leading-[1.05] sm:text-6xl">
          It tells you what it knows. And what it&apos;s{" "}
          <span className="relative inline-block">
            guessing.
            <span
              aria-hidden
              className="evidence-bar absolute -bottom-2 left-0 !h-2 !w-full !border-0"
              data-grounded="false"
            />
          </span>
        </h1>
        <p className="mt-8 max-w-2xl text-lg text-muted">
          Turn real interview material into an AI test user, talk to it live, and see which answers
          the sources back up.
        </p>
        <p className="mt-6 flex items-center gap-3 font-mono text-sm text-muted">
          <span className="evidence-bar" data-grounded="true" aria-hidden /> on record
          <span className="evidence-bar ml-3" data-grounded="false" aria-hidden /> guess
        </p>
      </header>

      <section
        className={`mb-8 space-y-4 rounded-xl border border-line bg-surface p-5 shadow-sm ${dragging ? "outline-2 outline-dashed outline-accent" : ""}`}
      >
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-semibold">
            Sources <span className="font-normal text-muted">({filled.length})</span>
          </h2>
          {result && !editing && (
            <>
              <span className="min-w-0 flex-1 truncate text-sm text-muted">
                {result?.sources.map((src) => src.title || "Untitled").join(" · ")}
              </span>
              <button
                type="button"
                className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm hover:border-muted"
                onClick={() => setEditing(true)}
              >
                Edit sources
              </button>
            </>
          )}
        </div>
        <div hidden={result !== null && !editing} className="space-y-4">
        {drafts.map((d, i) => (
          <div key={d.id} className="space-y-2 rounded-lg border border-line bg-background/60 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <input
                aria-label={`Source ${i + 1} title`}
                className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 text-sm font-medium"
                value={d.title ?? ""}
                onChange={(e) => update(d.id, { title: e.target.value })}
                disabled={busy}
              />
              <select
                aria-label={`Source ${i + 1} kind`}
                className="rounded-md border border-line bg-surface px-2 py-1 text-sm"
                value={d.kind}
                onChange={(e) => update(d.id, { kind: e.target.value as SourceKind })}
                disabled={busy}
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="rounded-md px-2 py-1 text-sm text-muted hover:text-foreground disabled:opacity-30"
                onClick={() => setDrafts((ds) => ds.filter((x) => x.id !== d.id))}
                disabled={busy}
                aria-label={`Remove source ${i + 1}`}
              >
                Remove
              </button>
            </div>
            <textarea
              aria-label={`Source ${i + 1} text`}
              className="h-40 w-full rounded-md border border-line bg-surface p-3 font-mono text-xs leading-relaxed"
              value={d.text}
              onChange={(e) => update(d.id, { text: e.target.value })}
              disabled={busy}
            />
          </div>
        ))}

        <div className="flex flex-wrap items-center gap-3 text-sm">
          <button
            type="button"
            className="rounded-md border border-line bg-surface px-3 py-1.5 hover:border-muted disabled:opacity-40"
            onClick={() => setDrafts((ds) => [...ds, draft("note", `Source ${ds.length + 1}`, "")])}
            disabled={busy}
          >
            Add text source
          </button>
          <label
            className={`rounded-md border border-line bg-surface px-3 py-1.5 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent ${
              busy ? "pointer-events-none opacity-40" : "cursor-pointer hover:border-muted"
            }`}
          >
            Add files…
            <input
              type="file"
              multiple
              accept={ACCEPTED}
              className="sr-only"
              disabled={busy}
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          <span className="text-muted">
            {reading ? "Reading files…" : "or drop text, CSV, PDF or image files anywhere"}
          </span>
          <button
            type="button"
            className="ml-auto rounded-md px-2 py-1 text-muted hover:text-foreground disabled:opacity-30"
            onClick={() => setDrafts(SAMPLES())}
            disabled={busy}
          >
            Reset to example
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <select
            aria-label="Persona language"
            className="rounded-md border border-line bg-surface px-2 py-1 text-sm"
            value={language}
            onChange={(e) => setLanguage(e.target.value as Language)}
            disabled={busy}
          >
            <option value="de">Deutsch</option>
            <option value="en">English</option>
          </select>
          <button
            type="button"
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface hover:opacity-90 disabled:opacity-40"
            onClick={create}
            disabled={busy || filled.length === 0}
          >
            {loading ? "Building persona…" : result ? "Rebuild persona" : "Create persona"}
          </button>
          {loading && <span className="text-sm tabular-nums text-muted">{elapsed.toFixed(1)} s</span>}
          {filled.length === 0 && <span className="text-sm text-muted">Add at least one source.</span>}
          {result && !loading && (
            <button
              type="button"
              className="ml-auto rounded-md px-2 py-1 text-sm text-muted hover:text-foreground"
              onClick={() => setEditing(false)}
            >
              Done
            </button>
          )}
        </div>
        </div>
        {error && (
          <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
            {error}
          </p>
        )}
      </section>

      <div ref={card} className="scroll-mt-6">
        {result && <PersonaCard {...result} onPersona={(persona) => setResult({ ...result, persona })} />}
      </div>
    </main>
  );
}

type FactField = "jobs" | "pains" | "objections";

function readinessLine({ readiness, version }: Persona): string {
  if (readiness) {
    const { score, consistency, grounding } = readiness;
    return `Readiness ${score.toFixed(2)}: consistency ${consistency.toFixed(2)} · grounding ${grounding.toFixed(2)} (do two trial runs agree, and do answers rest on sourced facts?)`;
  }
  return (version ?? 1) > 1
    ? "No readiness score: this persona was edited after creation and is not re-checked."
    : "No readiness score: the check did not finish.";
}

function PersonaCard({ persona, sources, seconds, onPersona }: Result & { onPersona: (p: Persona) => void }) {
  const [saveError, setSaveError] = useState<string | null>(null);
  // The server decides the labels: an edited or new fact always comes back as a guess.
  async function save(field: FactField, facts: Fact[]) {
    setSaveError(null);
    try {
      onPersona(await api.updatePersona(persona.id, { [field]: facts }));
    } catch (e) {
      setSaveError(e instanceof ApiError ? `Could not save (${e.status}): ${e.detail}` : "Could not save the change.");
    }
  }
  const facts = [...persona.jobs, ...persona.pains, ...persona.objections];
  const grounded = facts.filter((f) => f.label === "grounded").length;
  const meta = [persona.age && `${persona.age}`, persona.location, persona.context?.job]
    .filter(Boolean)
    .join(" · ");

  return (
    <article className="rounded-xl border border-line bg-surface p-6 shadow-sm" data-testid="persona-card">
      <p className="mb-2 inline-block rounded-full bg-accent-soft px-2.5 py-1 text-xs text-accent">
        Ready in {seconds.toFixed(1)} s · {grounded} grounded · {facts.length - grounded} guesses
      </p>
      <p className="mb-4 text-xs text-muted" data-testid="readiness">
        {readinessLine(persona)}
      </p>
      <h2 className="text-2xl font-semibold tracking-tight">{persona.name}</h2>
      {meta && <p className="text-sm text-muted">{meta}</p>}
      <p className="mt-3 leading-relaxed">{persona.summary}</p>

      {saveError && (
        <p role="alert" className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          {saveError}
        </p>
      )}
      <FactList title="Jobs" facts={persona.jobs} persona={persona} sources={sources} onSave={(f) => save("jobs", f)} />
      <FactList title="Pains" facts={persona.pains} persona={persona} sources={sources} onSave={(f) => save("pains", f)} />
      <FactList
        title="Objections"
        facts={persona.objections}
        persona={persona}
        sources={sources}
        onSave={(f) => save("objections", f)}
      />
      {/* Keyed by persona so a new persona never inherits the previous call. */}
      <InterviewRoom key={persona.id} persona={persona} />
    </article>
  );
}

function FactList(props: {
  title: string;
  facts: Fact[];
  persona: Persona;
  sources: PersonaSource[];
  onSave: (facts: Fact[]) => void;
}) {
  const { title, facts, persona, sources, onSave } = props;
  return (
    <section className="mt-6">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted">{title}</h3>
      {facts.length === 0 ? (
        <p className="text-sm text-muted">None.</p>
      ) : (
        <ul className="space-y-3">
          {facts.map((fact, i) => (
            <FactItem
              key={i}
              fact={fact}
              evidence={persona.evidence.find((e) => e.id === fact.evidenceId)}
              sources={sources}
              onChange={(next) => onSave(next ? facts.map((f, j) => (j === i ? next : f)) : facts.filter((_, j) => j !== i))}
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
  onChange,
}: {
  fact: Fact;
  evidence?: Evidence;
  sources: PersonaSource[];
  /** A changed fact, or null to remove it. */
  onChange: (fact: Fact | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // Only trust "grounded" when the evidence is really there; the backend guarantees it, this is a guard.
  const isGrounded = fact.label === "grounded" && evidence !== undefined;
  // sourceRef is "source:N" (1-based) into the submitted sources.
  const n = Number(evidence?.sourceRef?.split(":")[1]);
  const source = Number.isInteger(n) ? sources[n - 1] : undefined;

  return (
    <li className="text-sm leading-relaxed">
      <span
        className="mr-2 inline-flex items-center gap-1.5 font-mono text-xs font-medium"
      >
        <span className="evidence-bar !w-6" data-grounded={isGrounded} aria-hidden />
        {isGrounded ? "grounded" : "guess"}
      </span>
      {draft === null ? (
        fact.text
      ) : (
        <input
          aria-label="Fact text"
          className="w-full max-w-xl rounded-md border border-line bg-surface px-2 py-1 text-sm"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setDraft(null);
            if (e.key !== "Enter") return;
            const text = draft.trim();
            setDraft(null);
            if (text && text !== fact.text) onChange({ text, label: "guess", evidenceId: null });
          }}
        />
      )}
      <span className="ml-2 inline-flex gap-1 text-xs text-muted">
        {draft === null && (
          <button type="button" className="hover:text-foreground" aria-label={`Edit: ${fact.text}`} onClick={() => setDraft(fact.text)}>
            edit
          </button>
        )}
        {isGrounded && (
          <button
            type="button"
            className="hover:text-foreground"
            aria-label={`Mark as guess: ${fact.text}`}
            onClick={() => onChange({ ...fact, label: "guess", evidenceId: null })}
          >
            mark guess
          </button>
        )}
        <button type="button" className="hover:text-foreground" aria-label={`Remove: ${fact.text}`} onClick={() => onChange(null)}>
          remove
        </button>
      </span>
      {isGrounded && (
        <blockquote className="mt-1.5 border-l-2 border-accent/40 pl-3 text-foreground/80 wrap-anywhere">
          “{evidence.quote}”
          <span className="mt-0.5 block text-xs text-muted">
            {evidence.kind}
            {source?.title ? ` · ${source.title}` : ""}
            {evidence.sourceRef ? ` · ${evidence.sourceRef}` : ""}
          </span>
        </blockquote>
      )}
    </li>
  );
}

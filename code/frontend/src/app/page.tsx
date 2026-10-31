"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type {
  Evidence,
  Fact,
  Language,
  Persona,
  PersonaSource,
  PersonaSummary,
  SourceKind,
} from "@/lib/contracts";
import { InterviewRoom } from "@/components/InterviewRoom";
import { QUARTIER_BOERSE, SAMPLE_TRANSCRIPT } from "@/lib/sample";

const KINDS: SourceKind[] = ["note", "transcript", "miro", "real_interview"];
// Files the browser can read as plain text without any extra library; PDFs and images go through
// the backend (text layer, or a transcription of the visible text).
const TEXT_FILES = ".txt,.md,.csv,.json,.tsv";
const IMAGE_FILES = ".png,.jpg,.jpeg,.webp,.gif";
const ACCEPTED = `${TEXT_FILES},.pdf,${IMAGE_FILES}`;

type Draft = PersonaSource & { id: number };
// seconds is null for a persona picked from the library: nothing was built, its sources stay on the server.
type Result = { persona: Persona; sources: PersonaSource[]; seconds: number | null };

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

function errorMessage(e: unknown): string {
  if (!(e instanceof ApiError)) return "Backend not reachable. Is `make dev` running?";
  if (e.status === 401) return "This needs the team link with the passcode. Ask in Discord.";
  if (e.status === 422) return `The input was rejected: ${e.detail}`;
  // The backend's detail says how long to wait.
  if (e.status === 429) return e.detail;
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
  const [reading, setReading] = useState(false);
  // Once a persona exists the sources fold away, so the persona and the interview get the screen.
  const [editing, setEditing] = useState(false);
  const [recent, setRecent] = useState<PersonaSummary[]>([]);
  const [opening, setOpening] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const startedAt = useRef(0);
  const filled = drafts.filter((d) => d.text.trim());
  // While building or reading files, nothing is editable: a late file result can't land in a
  // reset list, and the submitted sources can't change under a running request.
  const busy = loading || reading || opening;
  const personaId = result?.persona.id;
  const picked = result?.seconds === null;

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

  // On load and after each new persona. The list is optional: without the passcode or a store it
  // just stays away, and creating a persona still reports its own errors.
  useEffect(() => {
    let current = true;
    api
      .listPersonas()
      .then((personas) => {
        if (current) setRecent(personas);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [personaId]);

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

  async function pick(id: string) {
    if (busy) return;
    setOpening(true);
    setError(null);
    try {
      setResult({ persona: await api.getPersona(id), sources: [], seconds: null });
      setEditing(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setOpening(false);
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
      <header className="mb-8">
        <p className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-widest text-accent">
          <span aria-hidden className="inline-block size-2 rounded-full bg-accent" />
          Persona interviews
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">OpenTwin</h1>
        <p className="mt-2 max-w-xl text-muted">
        Add sprint sources, get an interview-ready persona. Every fact is either grounded in a
        quote from the sources or marked as the persona&apos;s guess.
        </p>
      </header>

      {/* Folds away with the sources, so a click here can't replace the persona being interviewed. */}
      {recent.length > 0 && (!result || editing) && (
        <section
          aria-labelledby="recent-personas"
          className="mb-8 rounded-xl border border-line bg-surface p-5 shadow-sm"
        >
          <h2 id="recent-personas" className="text-sm font-semibold">
            Recent personas
          </h2>
          <ul className="mt-2 divide-y divide-line">
            {recent.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="flex w-full flex-wrap items-baseline gap-x-3 py-2 text-left text-sm hover:text-accent disabled:opacity-40"
                  onClick={() => pick(p.id)}
                  disabled={busy}
                >
                  <span className="font-medium">{p.name}</span>
                  {p.role && <span className="min-w-0 truncate text-muted">{p.role}</span>}
                  <span className="ml-auto text-xs tabular-nums text-muted">
                    {p.readiness && `${Math.round(p.readiness.score * 100)} % ready · `}
                    {new Date(p.createdAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section
        className={`mb-8 space-y-4 rounded-xl border border-line bg-surface p-5 shadow-sm ${dragging ? "outline-2 outline-dashed outline-accent" : ""}`}
      >
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-semibold">
            Sources
            {/* A saved persona's sources stay on the server; the drafts here are unrelated to it. */}
            {!(picked && !editing) && <span className="font-normal text-muted"> ({filled.length})</span>}
          </h2>
          {result && !editing && (
            <>
              <span className="min-w-0 flex-1 truncate text-sm text-muted">
                {picked
                  ? "Saved persona"
                  : result?.sources.map((src) => src.title || "Untitled").join(" · ")}
              </span>
              <button
                type="button"
                className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm hover:border-muted"
                onClick={() => setEditing(true)}
              >
                {picked ? "New persona" : "Edit sources"}
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
            {loading ? "Building persona…" : result && !picked ? "Rebuild persona" : "Create persona"}
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
        {/* Keyed by persona, so an open fact edit can't be saved to the next persona. A save can
            also finish after a pick, and must not bring the previous persona back. */}
        {result && (
          <PersonaCard
            key={result.persona.id}
            {...result}
            onPersona={(persona) =>
              setResult((current) => (current?.persona.id === persona.id ? { ...current, persona } : current))
            }
          />
        )}
      </div>
    </main>
  );
}

type FactField = "jobs" | "pains" | "objections";

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
      <p className="mb-4 inline-block rounded-full bg-accent-soft px-2.5 py-1 text-xs text-accent">
        {seconds !== null && `Ready in ${seconds.toFixed(1)} s · `}
        {grounded} grounded · {facts.length - grounded} guesses
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
        className={`mr-2 inline-block rounded px-1.5 py-0.5 text-xs font-medium ${
          isGrounded ? "bg-accent-soft text-accent" : "bg-line text-foreground"
        }`}
      >
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

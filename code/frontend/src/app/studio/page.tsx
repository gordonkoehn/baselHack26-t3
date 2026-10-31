"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, api } from "@/lib/api";
import { errorMessage, NETWORK_ERROR } from "@/lib/errorMessage";
import type {
  CoverageReport,
  Evidence,
  Face,
  Fact,
  Language,
  Persona,
  PersonaSource,
  PersonaSummary,
  PersonaUpdate,
  Product,
  SourceKind,
} from "@/lib/contracts";
import { CoverageCheck } from "@/components/CoverageCheck";
import { CustomFaceStatus, FacePhoto, IdentityEditor } from "@/components/IdentityEditor";
import { InterviewRoom } from "@/components/InterviewRoom";
import { Card, PersonaOverview } from "@/components/PersonaOverview";
import { ProductBrief } from "@/components/ProductBrief";
import { PersonaScore } from "@/components/PersonaScore";
import {
  LUMEN_GUIDE,
  LUMEN_PRODUCT,
  LUMEN_PERSONAS,
  QUARTIER_BOERSE,
  QUARTIER_BOERSE_GUIDE,
  QUARTIER_BOERSE_PRODUCT,
  SAMPLE_TRANSCRIPT,
  TEAM_TWIN,
  isMiriamKessler,
} from "@/lib/sample";
import { useCoverage } from "@/lib/useCoverage";

const KINDS: SourceKind[] = ["note", "transcript", "miro", "real_interview"];
// Files the browser can read as plain text without any extra library; PDFs and images go through
// the backend (text layer, or a transcription of the visible text).
const TEXT_FILES = ".txt,.md,.csv,.json,.tsv";
const IMAGE_FILES = ".png,.jpg,.jpeg,.webp,.gif";
const ACCEPTED = `${TEXT_FILES},.pdf,${IMAGE_FILES}`;

// Once a Lumen persona has been built, the library shows the Lumen case: built ones open, the rest
// are listed as examples.
function library(recent: PersonaSummary[]) {
  const built = LUMEN_PERSONAS.map((l) => recent.find((p) => p.name.includes(l.surname))).filter(
    (p): p is PersonaSummary => p !== undefined,
  );
  if (built.length === 0) return { personas: recent, examples: [] };
  return {
    personas: built,
    examples: LUMEN_PERSONAS.filter((l) => !built.some((p) => p.name.includes(l.surname))),
  };
}

type Draft = PersonaSource & { id: number };
// seconds is null for a persona picked from the library: nothing was built, its sources stay on the server.
// A saved persona gets its own brief, never another persona's sample questions or product.
type Result = { persona: Persona; sources: PersonaSource[]; seconds: number | null; brief: Brief };

const EXAMPLE_GUIDE = QUARTIER_BOERSE_GUIDE.join("\n");

// The sample ships with its own questions. Any other material starts with an empty guide,
// so the debrief cannot answer a sprint the sources never mentioned.
function guideFor(sources: { text: string }[]): string {
  const example =
    sources.length === 2 && sources[0]?.text === QUARTIER_BOERSE && sources[1]?.text === SAMPLE_TRANSCRIPT;
  return example ? EXAMPLE_GUIDE : "";
}

// The Lumen demo twin starts with the short Lumen guide, built or picked from the library.
const guideForPersona = (persona: Persona, fallback: string) =>
  isMiriamKessler(persona.name) ? LUMEN_GUIDE.join("\n") : fallback;

type Brief = { product: Product; guide: string };
const EMPTY_PRODUCT: Product = { name: "", description: "", prototypeUrl: null };

function briefForSources(sources: PersonaSource[]): Brief {
  const guide = guideFor(sources);
  return { product: guide ? QUARTIER_BOERSE_PRODUCT : EMPTY_PRODUCT, guide };
}

function briefForPersona(persona: Persona, fallback: Brief): Brief {
  return isMiriamKessler(persona.name)
    ? { product: LUMEN_PRODUCT, guide: guideForPersona(persona, fallback.guide) }
    : fallback;
}

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

const TEAM_SAMPLES = (): Draft[] => TEAM_TWIN.map((source) => draft(source.kind, source.title, source.text));

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
  // Explicit draft edits belong to the sources being built. Selected personas keep their own brief.
  const [draftBrief, setDraftBrief] = useState<Partial<Brief>>({});
  const [editingDraft, setEditingDraft] = useState(true);
  const [personaBriefs, setPersonaBriefs] = useState(() => new Map<string, Brief>());
  const [language, setLanguage] = useState<Language>("en");
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const [tab, setTab] = useState<Tab>("sources");
  const [coverage, setCoverage] = useState<CoverageReport | null>(null);
  const [verdict, setVerdict] = useState<{ personaId: string; ok: boolean } | null>(null);
  const [recent, setRecent] = useState<PersonaSummary[]>([]);
  const [opening, setOpening] = useState(false);
  const startedAt = useRef(0);
  const filled = drafts.filter((d) => d.text.trim());
  // While building or reading files, nothing is editable: a late file result can't land in a
  // reset list, and the submitted sources can't change under a running request.
  const busy = loading || reading || opening;
  const personaId = result?.persona.id;
  const picked = result?.seconds === null;
  const sourceBrief = { ...briefForSources(filled), ...draftBrief };
  const brief = editingDraft || !result ? sourceBrief : result.brief;

  function updateBrief(patch: Partial<Brief>) {
    if (editingDraft || !result) setDraftBrief((current) => ({ ...current, ...patch }));
    else {
      const next = { ...result.brief, ...patch };
      setPersonaBriefs((current) => new Map(current).set(result.persona.id, next));
      setResult({ ...result, brief: next });
    }
  }

  function navigate(next: Tab) {
    if (next === "sources") setEditingDraft(true);
    else if (next !== "product") setEditingDraft(false);
    setTab(next);
  }

  // Tick a visible timer while the persona is being built: the demo claims "ready in minutes".
  useEffect(() => {
    if (!loading) return;
    const id = setInterval(() => setElapsed((Date.now() - startedAt.current) / 1000), 100);
    return () => clearInterval(id);
  }, [loading]);

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
          problems.push(`${file.name}: not supported (use ${ACCEPTED.replaceAll(",", ", ")})`);
        }
      } catch (e) {
        // fetch reports a lost connection as a TypeError; the file itself is fine then.
        const reason = e instanceof ApiError ? e.detail : e instanceof TypeError ? NETWORK_ERROR : "could not be read";
        problems.push(`${file.name}: ${reason}`);
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
      const createdBrief = { ...briefForPersona(persona, briefForSources(sources)), ...draftBrief };
      setPersonaBriefs((current) => new Map(current).set(persona.id, createdBrief));
      setResult({
        persona,
        sources,
        seconds: (Date.now() - startedAt.current) / 1000,
        brief: createdBrief,
      });
      setEditingDraft(false);
      setTab("score");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  // Only a check of exactly this persona version counts; edits, answers and rebuilds outdate it.
  const current =
    result && coverage?.personaId === result.persona.id && coverage.personaVersion === result.persona.version
      ? coverage
      : null;
  // The human verdict from a test call holds for the persona it was given to, edits included:
  // it's about how the persona sounds, which a fact edit rarely changes.
  const currentVerdict = result && verdict?.personaId === result.persona.id ? verdict.ok : null;

  async function pick(id: string) {
    if (busy) return;
    setOpening(true);
    setError(null);
    try {
      const persona = await api.getPersona(id);
      setResult({ persona, sources: [], seconds: null,
        brief: personaBriefs.get(persona.id) ?? briefForPersona(persona, { product: EMPTY_PRODUCT, guide: "" }),
      });
      setEditingDraft(false);
      setTab("score");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setOpening(false);
    }
  }

  return (
    <>
    <WorkspaceBar
      tab={tab}
      onTab={navigate}
      persona={result?.persona ?? null}
      coverage={current}
      verdict={currentVerdict}
    />
    <main
      className="mx-auto w-full max-w-4xl px-5 py-8 font-sans sm:px-8"
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
      <div hidden={tab !== "product"}>
        <ProductBrief
          product={brief.product}
          onProduct={(product) => updateBrief({ product })}
          guide={brief.guide}
          onGuide={(guide) => updateBrief({ guide })}
          nextLabel={editingDraft ? "Next: add sources" : "Back to the interview"}
          onNext={() => navigate(editingDraft ? "sources" : "interview")}
        />
      </div>
      <div hidden={tab !== "sources"}>
      <ProductLine product={sourceBrief.product} onEdit={() => navigate("product")} />
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

      {recent.length > 0 && (
        <section
          aria-labelledby="recent-personas"
          className="mb-8 rounded-xl border border-line bg-surface p-5 shadow-sm"
        >
          <h2 id="recent-personas" className="text-sm font-semibold">
            Recent personas
          </h2>
          <ul className="mt-2 divide-y divide-line">
            {library(recent).personas.map((p) => (
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
            {library(recent).examples.map((l) => (
              <li key={l.surname} className="flex flex-wrap items-baseline gap-x-3 py-2 text-sm text-muted">
                <span className="font-medium text-foreground">{l.name}</span>
                <span className="min-w-0 truncate">{l.role}</span>
                <span className="ml-auto text-xs">example</span>
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
            <span className="font-normal text-muted"> ({filled.length})</span>
          </h2>
        </div>
        <div className="space-y-4">
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
            onClick={() => { setDrafts(SAMPLES()); setDraftBrief({}); }}
            disabled={busy}
          >
            Reset to example
          </button>
          <button
            type="button"
            className="rounded-md px-2 py-1 text-muted hover:text-foreground disabled:opacity-30"
            onClick={() => { setDrafts(TEAM_SAMPLES()); setDraftBrief({}); }}
            disabled={busy}
          >
            Team twin
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <label htmlFor="conversation-language" className="text-sm font-bold">Conversation language</label>
          <select
            id="conversation-language"
            aria-describedby="conversation-language-help"
            className="rounded-md border border-line bg-surface px-2 py-1 text-sm"
            value={language}
            onChange={(e) => setLanguage(e.target.value as Language)}
            disabled={busy}
          >
            <option value="de">Deutsch</option>
            <option value="en">English</option>
          </select>
          <span id="conversation-language-help" className="text-sm text-muted">
            The spoken interview language. Source quotes stay in their original language.
          </span>
          <button
            type="button"
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface hover:opacity-90 disabled:opacity-40"
            onClick={() => void create()}
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
              onClick={() => navigate("score")}
            >
              Back to {result.persona.name} →
            </button>
          )}
        </div>
        </div>
        {error && (
          <p role="alert" className="rounded-md bg-red-50 p-3 text-sm break-words text-red-800 dark:bg-red-950 dark:text-red-200">
            {error}
          </p>
        )}
      </section>
      </div>

      {/* Hidden, not unmounted: a running call and an unfinished check survive switching tabs. */}
      {result && (
        <>
          <div hidden={tab === "interview"}>
            {/* Keyed by persona, so an open edit or save error can't carry over to the next persona. */}
            <PersonaProfile
              key={result.persona.id}
              {...result}
              product={result.brief.product}
              tab={tab}
              onTab={navigate}
              coverage={current}
              onReport={setCoverage}
              verdict={currentVerdict}
              onVerdict={(ok) => setVerdict({ personaId: result.persona.id, ok })}
              // Mounted only while visible, so the page never holds two call rooms' controls at once.
              showTestCall={tab === "verify"}
              opening={opening}
              // A save can finish after a pick, and must not bring the previous persona back.
              onPersona={(persona) =>
                setResult((current) => (current?.persona.id === persona.id ? { ...current, persona } : current))
              }
              onAnswered={(persona, source) => {
                // The answers are now source N on the backend; keep the card's citations and a later
                // rebuild in step with that.
                setResult({ ...result, persona, sources: [...result.sources, source] });
                setDrafts((ds) => [...ds, draft(source.kind, source.title ?? "", source.text)]);
              }}
            />
          </div>
          <div hidden={tab !== "interview"}>
            {/* Keyed by persona so a new persona never inherits the previous call. */}
            <InterviewRoom
              key={result.persona.id}
              persona={result.persona}
              startBlocked={opening}
              product={result.brief.product}
              guide={result.brief.guide}
              onGuideChange={(guide) => {
                const next = { ...result.brief, guide };
                setPersonaBriefs((current) => new Map(current).set(result.persona.id, next));
                setResult({ ...result, brief: next });
              }}
            />
          </div>
        </>
      )}
    </main>
    </>
  );
}

// One idea per screen, and each screen has one clear button to the next.
type Tab = "product" | "sources" | "score" | "persona" | "verify" | "interview";
const TABS: { id: Tab; label: string }[] = [
  { id: "product", label: "Product" },
  { id: "sources", label: "Sources" },
  { id: "score", label: "Score" },
  { id: "persona", label: "Persona" },
  { id: "verify", label: "Add more" },
  { id: "interview", label: "Interview" },
];

function readinessLine({ readiness, version }: Persona): string {
  if (readiness) {
    const { score, consistency, grounding } = readiness;
    return `Readiness ${score.toFixed(2)}: consistency ${consistency.toFixed(2)} · grounding ${grounding.toFixed(2)} (do two trial runs agree, and do answers rest on sourced facts?)`;
  }
  return (version ?? 1) > 1
    ? "No readiness score: this persona was edited after creation and is not re-checked."
    : "No readiness score: the check did not finish.";
}

function WorkspaceBar({
  tab,
  onTab,
  persona,
  coverage,
  verdict,
}: {
  tab: Tab;
  onTab: (tab: Tab) => void;
  persona: Persona | null;
  coverage: CoverageReport | null;
  verdict: boolean | null;
}) {
  return (
    <header className="sticky top-0 z-10 border-b border-line bg-surface/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-5 py-2.5 sm:px-8">
        <p className="flex min-w-0 flex-1 items-center gap-2 font-semibold tracking-tight">
          <Link href="/" className="flex items-center gap-2 hover:text-accent" title="Back to the homepage">
            <span aria-hidden className="inline-block size-2 rounded-full bg-accent" />
            OpenTwin
          </Link>
          {persona && <span className="truncate font-normal text-muted">/ {persona.name}</span>}
        </p>
        <nav aria-label="Steps" className="order-last flex w-full flex-wrap rounded-lg border border-line bg-background p-1 sm:order-none sm:w-auto">
          {TABS.map((t) => {
            const locked = t.id !== "product" && t.id !== "sources" && !persona;
            return (
              <button
                key={t.id}
                type="button"
                aria-current={tab === t.id ? "step" : undefined}
                disabled={locked}
                title={locked ? "Create a persona first" : undefined}
                onClick={() => onTab(t.id)}
                className={`flex-1 rounded-md px-3 py-1.5 font-mono text-xs whitespace-nowrap uppercase tracking-widest sm:flex-none sm:px-3 ${
                  tab === t.id ? "bg-surface text-accent shadow-sm" : "text-muted hover:text-foreground disabled:opacity-40"
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </nav>
        <div className="flex flex-1 justify-end gap-1.5 text-sm">
          {/* Not on the score screen: it shows the categories and no overall number. */}
          {persona && tab !== "score" && (
            <button type="button" onClick={() => onTab("verify")}
              className="flex gap-1.5"
              aria-label="Go to verification"
            >
              <span className={`rounded-full px-3 py-1 ${
                coverage?.overall === "good_enough"
                  ? "bg-accent-soft text-accent"
                  : coverage?.overall === "add_more"
                    ? "bg-alert-tint text-on-alert"
                    : "bg-line text-muted"
              }`} data-testid="workspace-coverage">
                {coverage ? `AI ${Math.round(coverage.score * 100)}%` : "AI –"}
                {coverage?.overall === "good_enough"
                  ? " · Good enough to test."
                  : coverage?.overall === "add_more"
                    ? " · Add more first."
                    : " · Not checked"}
              </span>
              <span className={`rounded-full px-3 py-1 ${tone(verdict)}`}>
                {verdict === null ? "Test call –" : verdict ? "Test call ✓" : "Test call ✗"}
              </span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

function tone(ok: boolean | null): string {
  if (ok === null) return "bg-line text-muted";
  return ok ? "bg-accent-soft text-accent" : "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200";
}

/** One line on the sources step, so the team always sees which product the persona is built for. */
function ProductLine({ product, onEdit }: { product: Product; onEdit: () => void }) {
  const name = product.name.trim();
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-6 text-sm">
      <span className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest text-accent">
        <span aria-hidden className="inline-block size-1.5 rounded-full bg-signal" />
        Testing
      </span>
      <span className="font-bold">{name || "No product described yet"}</span>
      <button type="button" onClick={onEdit} className="text-muted underline underline-offset-2 hover:text-foreground">
        {name ? "Edit product" : "Describe the product"}
      </button>
    </p>
  );
}

function SaveError({ text }: { text: string }) {
  return (
    <p role="alert" className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
      {text}
    </p>
  );
}

function NextButton({ onClick, back, children }: { onClick: () => void; back?: ReactNode; children: string }) {
  return (
    <div className="flex items-center justify-end gap-4">
      {back}
      <button type="button" className="rounded-lg bg-accent px-5 py-2.5 text-sm font-bold text-surface hover:opacity-90" onClick={onClick}>
        {children}
      </button>
    </div>
  );
}

function PersonaProfile({
  persona,
  sources,
  seconds,
  product,
  tab,
  onTab,
  coverage: currentReport,
  onReport,
  verdict,
  onVerdict,
  showTestCall,
  opening,
  onPersona,
  onAnswered,
}: Result & {
  product: Product;
  tab: Tab;
  onTab: (tab: Tab) => void;
  coverage: CoverageReport | null;
  onReport: (report: CoverageReport | null) => void;
  verdict: boolean | null;
  onVerdict: (ok: boolean) => void;
  showTestCall: boolean;
  opening: boolean;
  onPersona: (p: Persona) => void;
  onAnswered: (p: Persona, source: PersonaSource) => void;
}) {
  // Here, not on a screen: the score screen and Add more show the same single check.
  const coverage = useCoverage({ persona, sources, initial: currentReport, onReport, onAnswered });
  // Shown next to what failed: the identity editor or the fact lists.
  const [saveError, setSaveError] = useState<{ at: "identity" | "facts"; text: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [faces, setFaces] = useState<Face[]>([]);
  // Only for photos and the picker; without them the header falls back to initials.
  useEffect(() => {
    api.listFaces().then(setFaces, () => setFaces([]));
  }, []);
  // The server decides the labels: an edited or new fact always comes back as a guess.
  async function save(update: PersonaUpdate, at: "identity" | "facts") {
    setSaveError(null);
    try {
      onPersona(await api.updatePersona(persona.id, update));
      return true;
    } catch (e) {
      const text = e instanceof ApiError ? `Could not save (${e.status}): ${e.detail}` : "Could not save the change.";
      setSaveError({ at, text });
      return false;
    }
  }
  const meta = [persona.age && `${persona.age}`, persona.location, persona.context?.job]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
    <div hidden={tab !== "score"}>
      <PersonaScore
        persona={persona}
        sources={sources}
        coverage={coverage}
        onInterview={() => onTab("interview")}
        onAddMore={() => onTab("verify")}
      />
    </div>
    <div hidden={tab !== "persona"}>
    <article className="space-y-4" data-testid="persona-card">
      <NextButton onClick={() => onTab("verify")}>Next: add more</NextButton>
      <header className="rounded-xl border border-line bg-surface p-6 shadow-sm">
        {editing ? (
          <IdentityEditor
            persona={persona}
            faces={faces}
            onCancel={() => setEditing(false)}
            onPersona={onPersona}
            onSave={async (update) => {
              if (await save(update, "identity")) setEditing(false);
            }}
          />
        ) : (
          <div className="flex flex-wrap items-start gap-5">
            <FacePhoto persona={persona} size="size-20" />
            <div className="min-w-0 flex-1">
              <p className="text-xs uppercase tracking-widest text-muted">
                AI persona · v{persona.version}
                {seconds !== null && ` · built in ${seconds.toFixed(1)} s`}
              </p>
              <h2 className="text-2xl font-semibold tracking-tight">{persona.name}</h2>
              {meta && <p className="text-sm text-muted">{meta}</p>}
              <p className="mt-3 max-w-2xl leading-relaxed">{persona.summary}</p>
              <p className="mt-2 text-xs text-muted" data-testid="readiness">
                {readinessLine(persona)}
              </p>
              <div className="mt-3">
                <CustomFaceStatus persona={persona} onPersona={onPersona} />
              </div>
            </div>
            <button
              type="button"
              className="rounded-md border border-line px-3 py-1.5 text-sm hover:border-muted"
              onClick={() => setEditing(true)}
            >
              Edit profile
            </button>
          </div>
        )}
        {saveError?.at === "identity" && <SaveError text={saveError.text} />}
      </header>

      <PersonaOverview
        persona={persona}
        sources={sources}
        coverage={coverage.current}
        onVerify={() => onTab("verify")}
        onSave={(update) => void save(update, "identity")}
        onEditProfile={() => {
          setEditing(true);
          window.scrollTo({ top: 0, behavior: "smooth" });
        }}
      />

      <Card title="What drives them" hint="Jobs, pains and objections. Edit, downgrade or remove anything that is wrong.">
        {saveError?.at === "facts" && <SaveError text={saveError.text} />}
        <FactList title="Jobs" facts={persona.jobs} persona={persona} sources={sources} onSave={(f) => save({ jobs: f }, "facts")} />
        <FactList title="Pains" facts={persona.pains} persona={persona} sources={sources} onSave={(f) => save({ pains: f }, "facts")} />
        <FactList
          title="Objections"
          facts={persona.objections}
          persona={persona}
          sources={sources}
          onSave={(f) => save({ objections: f }, "facts")}
        />
      </Card>

    </article>
    </div>
    <div hidden={tab !== "verify"}>
      <section id="verify" className="space-y-4" data-testid="verify">
        <NextButton
          onClick={() => onTab("interview")}
          back={
            <button type="button" className="text-sm font-bold text-accent underline" onClick={() => onTab("score")}>
              Back to the score
            </button>
          }
        >
          Go to the interview
        </NextButton>
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Add more before you interview.</h2>
          <p className="text-sm text-muted">
            Two checks: the AI compares what {persona.name} knows with what you test, and you talk to them yourself.
          </p>
        </div>
        <CoverageCheck coverage={coverage} />
        <Card
          title="Test call"
          hint={`Talk to ${persona.name} for a minute. Does this sound like your customer? No questions needed; this is not the interview.`}
        >
          {/* Its own room, keyed apart from the interview's, so a test never mixes into the real call. */}
          {showTestCall && (
            <InterviewRoom
              key={`test-${persona.id}`}
              persona={persona}
              startBlocked={opening}
              questionsRequired={false}
              product={product}
            />
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4 text-sm">
            <span className="font-medium">Your verdict:</span>
            <button
              type="button"
              aria-pressed={verdict === true}
              className={`rounded-full border px-3 py-1 ${verdict === true ? "border-accent bg-accent-soft text-accent" : "border-line hover:border-muted"}`}
              onClick={() => onVerdict(true)}
            >
              Sounds like our customer
            </button>
            <button
              type="button"
              aria-pressed={verdict === false}
              className={`rounded-full border px-3 py-1 ${verdict === false ? "border-red-300 bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200" : "border-line hover:border-muted"}`}
              onClick={() => onVerdict(false)}
            >
              Not yet
            </button>
            {verdict === false && <span className="text-muted">Edit the profile or answer the gap questions above.</span>}
          </div>
        </Card>
      </section>
    </div>
    </>
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

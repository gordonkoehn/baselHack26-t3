"use client";

import { useState, type ReactNode } from "react";
import type { CoverageReport, Fact, Persona, PersonaSource, PersonaUpdate } from "@/lib/contracts";

type Scale = 1 | 2 | 3 | 4 | 5;

/** The customer's context at a glance: what the persona knows, how it behaves, where it comes from. */
export function PersonaOverview({
  persona,
  sources,
  coverage,
  onVerify,
  onSave,
  onEditProfile,
}: {
  persona: Persona;
  sources: PersonaSource[];
  /** The latest coverage check of this exact persona version, if any. */
  coverage: CoverageReport | null;
  onVerify: () => void;
  /** Every card edits in place; the server decides what changes (and bumps the version). */
  onSave: (update: PersonaUpdate) => void;
  onEditProfile: () => void;
}) {
  const [newTool, setNewTool] = useState("");
  const [speechOpen, setSpeechOpen] = useState(false);
  const tools = persona.context?.toolsToday ?? [];
  const saveTools = (next: string[]) => onSave({ context: { ...persona.context, toolsToday: next } });
  const facts = [...persona.jobs, ...persona.pains, ...persona.objections];
  const grounded = facts.filter((f) => f.label === "grounded").length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Grounded facts" value={grounded} hint="backed by a quote" />
        <Tile label="Guesses" value={facts.length - grounded} hint="invented, verify before trusting" />
        <Tile label="Sources" value={sources.length} hint={`${persona.evidence.length} quotes used`} />
        <button
          type="button"
          onClick={onVerify}
          className="rounded-xl border border-line bg-surface p-4 text-left shadow-sm hover:border-muted"
        >
          <p className="text-xs uppercase tracking-widest text-muted">Coverage</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {coverage ? `${Math.round(coverage.score * 100)}%` : "–"}
          </p>
          <p className="text-xs text-muted">
            {coverage
              ? coverage.overall === "good_enough"
                ? "Good enough to test."
                : coverage.overall === "add_more"
                  ? "Add more first."
                  : "not checked yet →"
              : "not checked yet →"}
          </p>
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card
          title="Who they are"
          hint="Demographics and situation."
          action={<EditButton label="Edit who they are" onClick={onEditProfile} />}
        >
          <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5 text-sm">
            <Row label="Age" value={persona.age} />
            <Row label="Location" value={persona.location} />
            <Row label="Job" value={persona.context?.job} />
            <Row label="Household" value={persona.context?.household} />
            <Row label="Interview language" value={persona.language === "de" ? "German" : "English"} />
          </dl>
        </Card>

        <Card title="Tools and habits today" hint="What they already use; the test competes with this.">
          <ul className="flex flex-wrap gap-1.5">
            {tools.map((t) => (
              <li key={t} className="inline-flex items-center gap-1 rounded-full border border-line bg-background px-2.5 py-0.5 text-sm">
                {t}
                <button
                  type="button"
                  className="text-muted hover:text-foreground"
                  aria-label={`Remove tool: ${t}`}
                  onClick={() => saveTools(tools.filter((x) => x !== t))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <input
            aria-label="Add a tool or habit"
            placeholder="+ add, e.g. TWINT"
            className="mt-2 w-full rounded-md border border-line bg-surface px-2 py-1 text-sm"
            value={newTool}
            onChange={(e) => setNewTool(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const t = newTool.trim();
              if (t && !tools.some((x) => x.toLowerCase() === t.toLowerCase())) saveTools([...tools, t]);
              setNewTool("");
            }}
          />
        </Card>

        <Card title="Attitudes" hint="Estimated by the model on a 1–5 scale; click to set it yourself.">
          <div className="space-y-2">
            <Meter
              label="Tech affinity"
              value={persona.attitudes?.techAffinity}
              onSet={(v) => onSave({ attitudes: { techAffinity: v } })}
            />
            <Meter
              label="Price sensitivity"
              value={persona.attitudes?.priceSensitivity}
              onSet={(v) => onSave({ attitudes: { priceSensitivity: v } })}
            />
            <Meter
              label="Trust in new brands"
              value={persona.attitudes?.trustInNewBrands}
              onSet={(v) => onSave({ attitudes: { trustInNewBrands: v } })}
            />
          </div>
        </Card>

        <Card
          title="How they speak"
          hint="Shapes the voice in the interview."
          action={!speechOpen && <EditButton label="Edit how they speak" onClick={() => setSpeechOpen(true)} />}
        >
          {speechOpen ? (
            <SpeechEditor
              persona={persona}
              onCancel={() => setSpeechOpen(false)}
              onSave={(speechStyle) => {
                onSave({ speechStyle });
                setSpeechOpen(false);
              }}
            />
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5 text-sm">
                {[persona.speechStyle?.register, persona.speechStyle?.verbosity && `${persona.speechStyle.verbosity} answers`]
                  .concat(persona.speechStyle?.fillers ? ["uses fillers"] : [])
                  .filter(Boolean)
                  .map((t) => (
                    <span key={t as string} className="rounded-full border border-line bg-background px-2.5 py-0.5">
                      {t}
                    </span>
                  ))}
              </div>
              {persona.speechStyle?.notes && <p className="mt-2 text-sm text-muted">{persona.speechStyle.notes}</p>}
            </>
          )}
        </Card>
      </div>

      <Card title="Sources and evidence" hint="Where the grounded facts come from.">
        <ol className="divide-y divide-line text-sm">
          {sources.map((s, i) => {
            const ref = `source:${i + 1}`;
            const quotes = persona.evidence.filter((e) => e.sourceRef === ref);
            const cited = citing(facts, new Set(quotes.map((e) => e.id)));
            return (
              <li key={ref} className="flex flex-wrap items-baseline gap-x-2 py-1.5">
                <span className="w-6 text-muted tabular-nums">{i + 1}</span>
                <span className="font-medium">{s.title || "Untitled"}</span>
                <span className="rounded bg-line px-1.5 py-0.5 text-xs">{s.kind}</span>
                <span className="ml-auto text-xs text-muted">
                  {quotes.length} {quotes.length === 1 ? "quote" : "quotes"} · {cited}{" "}
                  {cited === 1 ? "fact" : "facts"}
                </span>
              </li>
            );
          })}
        </ol>
      </Card>
    </div>
  );
}

function citing(facts: Fact[], ids: Set<string>): number {
  return facts.filter((f) => f.label === "grounded" && f.evidenceId && ids.has(f.evidenceId)).length;
}

function Tile({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
      <p className="text-xs uppercase tracking-widest text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="text-xs text-muted">{hint}</p>
    </div>
  );
}

export function Card({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-line bg-surface p-5 shadow-sm">
      <div className="flex items-baseline gap-2">
        <h3 className="font-semibold">{title}</h3>
        {action && <span className="ml-auto">{action}</span>}
      </div>
      {hint && <p className="mb-3 text-sm text-muted">{hint}</p>}
      {children}
    </section>
  );
}

function EditButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="text-xs text-muted hover:text-foreground" aria-label={label} onClick={onClick}>
      edit
    </button>
  );
}

function SpeechEditor({
  persona,
  onSave,
  onCancel,
}: {
  persona: Persona;
  onSave: (speechStyle: NonNullable<PersonaUpdate["speechStyle"]>) => void;
  onCancel: () => void;
}) {
  const style = persona.speechStyle ?? {};
  const [register, setRegister] = useState(style.register ?? "informal");
  const [verbosity, setVerbosity] = useState(style.verbosity ?? "medium");
  const [fillers, setFillers] = useState(style.fillers ?? false);
  const [notes, setNotes] = useState(style.notes ?? "");
  const select = "rounded-md border border-line bg-surface px-2 py-1";
  return (
    <form
      className="space-y-2 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ register, verbosity, fillers, notes: notes.trim() || null });
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Register" className={select} value={register} onChange={(e) => setRegister(e.target.value as typeof register)}>
          <option value="informal">informal</option>
          <option value="formal">formal</option>
        </select>
        <select aria-label="Answer length" className={select} value={verbosity} onChange={(e) => setVerbosity(e.target.value as typeof verbosity)}>
          <option value="short">short answers</option>
          <option value="medium">medium answers</option>
          <option value="long">long answers</option>
        </select>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={fillers} onChange={(e) => setFillers(e.target.checked)} />
          uses fillers
        </label>
      </div>
      <textarea
        aria-label="Speech notes"
        className="h-24 w-full rounded-md border border-line bg-surface p-2"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <div className="flex gap-2">
        <button type="submit" className="rounded-md border border-line px-3 py-1.5 hover:border-muted">
          Save
        </button>
        <button type="button" className="px-2 text-muted hover:text-foreground" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Row({ label, value }: { label: string; value?: string | number | null }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd>{value ?? <span className="text-muted">unknown</span>}</dd>
    </>
  );
}

function Meter({ label, value, onSet }: { label: string; value?: number; onSet: (value: Scale) => void }) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="w-36 shrink-0">{label}</span>
      <span className="flex gap-1" role="group" aria-label={`${label}: ${value ? `${value} of 5` : "unknown"}`}>
        {([1, 2, 3, 4, 5] as const).map((n) => (
          <button
            key={n}
            type="button"
            aria-label={`Set ${label} to ${n} of 5`}
            aria-pressed={value === n}
            onClick={() => onSet(n)}
            className="py-1.5"
          >
            <span className={`block h-2 w-6 rounded-full ${value && n <= value ? "bg-accent" : "bg-line hover:bg-muted"}`} />
          </button>
        ))}
      </span>
      {!value && <span className="text-muted">unknown</span>}
    </div>
  );
}

import type { ReactNode } from "react";
import type { CoverageReport, Fact, Persona, PersonaSource } from "@/lib/contracts";

/** The customer's context at a glance: what the persona knows, how it behaves, where it comes from. */
export function PersonaOverview({
  persona,
  sources,
  coverage,
  onVerify,
}: {
  persona: Persona;
  sources: PersonaSource[];
  /** The latest coverage check of this exact persona version, if any. */
  coverage: CoverageReport | null;
  onVerify: () => void;
}) {
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
              ? coverage.recommendation === "ready"
                ? "ready for this test"
                : "needs more input"
              : "not checked yet →"}
          </p>
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card title="Who they are" hint="Demographics and situation.">
          <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5 text-sm">
            <Row label="Age" value={persona.age} />
            <Row label="Location" value={persona.location} />
            <Row label="Job" value={persona.context?.job} />
            <Row label="Household" value={persona.context?.household} />
            <Row label="Interview language" value={persona.language === "de" ? "German" : "English"} />
          </dl>
        </Card>

        <Card title="Tools and habits today" hint="What they already use; the test competes with this.">
          {persona.context?.toolsToday?.length ? (
            <ul className="flex flex-wrap gap-1.5">
              {persona.context.toolsToday.map((t) => (
                <li key={t} className="rounded-full border border-line bg-background px-2.5 py-0.5 text-sm">
                  {t}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">Nothing known.</p>
          )}
        </Card>

        <Card title="Attitudes" hint="Estimated by the model on a 1–5 scale, never quoted.">
          <div className="space-y-2">
            <Meter label="Tech affinity" value={persona.attitudes?.techAffinity} />
            <Meter label="Price sensitivity" value={persona.attitudes?.priceSensitivity} />
            <Meter label="Trust in new brands" value={persona.attitudes?.trustInNewBrands} />
          </div>
        </Card>

        <Card title="How they speak" hint="Shapes the voice in the interview.">
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

export function Card({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-5 shadow-sm">
      <h3 className="font-semibold">{title}</h3>
      {hint && <p className="mb-3 text-sm text-muted">{hint}</p>}
      {children}
    </section>
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

function Meter({ label, value }: { label: string; value?: number }) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="w-36 shrink-0">{label}</span>
      {value ? (
        <span className="flex gap-1" role="img" aria-label={`${value} of 5`}>
          {[1, 2, 3, 4, 5].map((n) => (
            <span key={n} className={`h-2 w-6 rounded-full ${n <= value ? "bg-accent" : "bg-line"}`} />
          ))}
        </span>
      ) : (
        <span className="text-muted">unknown</span>
      )}
    </div>
  );
}

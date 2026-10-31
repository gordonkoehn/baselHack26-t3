"use client";

import type { Product } from "@/lib/contracts";

// Limits from code/shared/schema.json (Product); the backend rejects anything longer with 422.
const NAME_MAX = 120;
const DESCRIPTION_MAX = 4000;
const URL_MAX = 500;

/** The product to send with a session, or null while the brief is incomplete. */
export function productForSession(product: Product): Product | null {
  const name = product.name.trim();
  const description = product.description.trim();
  if (!name || !description) return null;
  const url = product.prototypeUrl?.trim();
  return { name, description, prototypeUrl: url ? url : null };
}

export function guideLines(guide: string): string[] {
  return guide
    .split("\n")
    .map((q) => q.trim())
    .filter(Boolean);
}

/**
 * Step 1: what the sprint tests. Everything after it hangs off this: the persona hears the
 * description as background, the interview starts with these sprint questions, and the debrief
 * answers each of them with supports, contradicts or unclear.
 */
export function ProductBrief({
  product,
  onProduct,
  guide,
  onGuide,
  onNext,
  nextLabel = "Next: add sources",
}: {
  product: Product;
  onProduct: (patch: Partial<Product>) => void;
  guide: string;
  onGuide: (guide: string) => void;
  onNext: () => void;
  nextLabel?: string;
}) {
  const questions = guideLines(guide);
  const ready = productForSession(product) !== null && questions.length > 0;
  const input = "mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm";

  return (
    <section aria-labelledby="product-heading" className="pt-6">
      <p className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest text-accent">
        <span aria-hidden className="inline-block size-1.5 rounded-full bg-signal" />
        Step 1 of 4
      </p>
      <h1 id="product-heading" className="mt-3 max-w-3xl text-4xl font-extrabold leading-tight tracking-tight sm:text-5xl">
        Start with what you are testing.
      </h1>
      <p className="mt-4 max-w-2xl text-lg text-muted">
        Describe the product and the questions your sprint must answer. The persona hears the description as
        background, and the debrief answers every sprint question.
      </p>

      <div className="mt-8 space-y-5 rounded-2xl border border-line bg-surface p-5 shadow-sm">
        <label className="block text-sm">
          <span className="font-bold">Product name</span>
          <input
            className={input}
            value={product.name}
            maxLength={NAME_MAX}
            onChange={(e) => onProduct({ name: e.target.value })}
            placeholder="For example: GlowPot"
          />
        </label>
        <label className="block text-sm">
          <span className="font-bold">What it is</span>
          <span className="block text-muted">
            Who it is for, what it does, and what the prototype shows. Plain words, as you would brief a test user.
          </span>
          <textarea
            className={`${input} h-36 leading-relaxed`}
            value={product.description}
            maxLength={DESCRIPTION_MAX}
            onChange={(e) => onProduct({ description: e.target.value })}
          />
        </label>
        <label className="block text-sm">
          <span className="font-bold">Prototype link (optional)</span>
          <span className="block text-muted">
            For your team. The persona never opens it; share your screen in the interview instead.
          </span>
          <input
            className={input}
            type="url"
            inputMode="url"
            value={product.prototypeUrl ?? ""}
            maxLength={URL_MAX}
            onChange={(e) => onProduct({ prototypeUrl: e.target.value })}
            placeholder="https://"
          />
        </label>
        <label className="block text-sm">
          <span className="font-bold">Sprint questions, one per line</span>
          <span className="block text-muted">
            The assumptions you need to check. The debrief marks each one as supports, contradicts or unclear.
          </span>
          <textarea
            className={`${input} h-28 leading-relaxed`}
            value={guide}
            onChange={(e) => onGuide(e.target.value)}
          />
        </label>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onNext}
          disabled={!ready}
          className="rounded-md bg-accent px-4 py-2 text-sm font-bold text-surface hover:opacity-90 disabled:opacity-40"
        >
          {nextLabel}
        </button>
        <p className="text-sm text-muted" role="status">
          {ready
            ? `${questions.length} sprint ${questions.length === 1 ? "question" : "questions"} ready.`
            : "Add a name, a description and at least one sprint question."}
        </p>
      </div>
    </section>
  );
}

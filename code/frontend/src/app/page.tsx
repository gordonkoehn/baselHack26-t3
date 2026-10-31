import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { TeamLinkForward } from "@/components/TeamLinkForward";

export const metadata: Metadata = {
  title: "OpenTwin · Interview your customer before you have met them",
  description:
    "AI test users built from your sprint material. Interview them live by video, share your prototype, and see which answers the sources back up.",
};

// Line icons on a 24px grid, 2px stroke, round caps (the Lucide style the design system asks for).
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="size-6"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

const STEPS = [
  {
    n: "01",
    title: "Describe the product.",
    text: "Name it, say what it does, and write the sprint questions you need answered.",
  },
  {
    n: "02",
    title: "Add your material.",
    text: "Paste or drop interview transcripts, Miro exports, notes and PDFs. Nothing else is needed.",
  },
  {
    n: "03",
    title: "Meet your persona.",
    text: "Jobs, pains and objections, each marked on record or a guess. Check it and fix it before you talk.",
  },
  {
    n: "04",
    title: "Interview and debrief.",
    text: "Talk by video, share your prototype, then get an answer to every sprint question with quotes.",
  },
];

const FEATURES: { title: string; text: string; icon: ReactNode }[] = [
  {
    title: "Every guess is marked.",
    text: "Facts the sources back up are on record. Everything else is labelled a guess, in the persona and in the debrief.",
    icon: (
      <Icon>
        <path d="M9 12l2 2 4-4" />
        <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
      </Icon>
    ),
  },
  {
    title: "It sees your screen.",
    text: "Share the prototype and the persona reacts to what is on it, the labels and buttons included.",
    icon: (
      <Icon>
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8M12 16v4" />
      </Icon>
    ),
  },
  {
    title: "It pushes back.",
    text: "The persona admits confusion, hesitates and says no when its story says no. It gives no design advice.",
    icon: (
      <Icon>
        <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z" />
        <path d="M9 10h6M9 14h3" />
      </Icon>
    ),
  },
  {
    title: "Ready in minutes.",
    text: "From sources to an interview-ready persona with a readiness score, faster than booking one real call.",
    icon: (
      <Icon>
        <circle cx="12" cy="13" r="8" />
        <path d="M12 9v4l2.5 2.5M9 2h6" />
      </Icon>
    ),
  },
];

function Eyebrow({ children, dark = false }: { children: ReactNode; dark?: boolean }) {
  return (
    <p
      className={`flex items-center gap-2 text-xs font-bold uppercase tracking-[0.16em] ${
        dark ? "text-room-muted" : "text-accent"
      }`}
    >
      <span aria-hidden className="inline-block size-1.5 rounded-full bg-signal" />
      {children}
    </p>
  );
}

// A still of the product's signature: one answer, its evidence mark and its source.
function AnswerPreview() {
  return (
    <div className="rounded-2xl border border-line bg-surface p-5 text-foreground shadow-xl">
      <p className="flex flex-wrap justify-between gap-2 text-xs font-bold uppercase tracking-[0.16em] text-muted">
        <span>Sandra · interview turn 7</span>
        <span>Example</span>
      </p>
      <p className="mt-3 text-lg leading-snug">
        &laquo;If I give my shares away, that&apos;s my reward gone. And a bakery doubling it sounds like a
        marketing gimmick.&raquo;
      </p>
      <ul className="mt-5 space-y-3 text-sm">
        <li className="flex items-start gap-3">
          <span className="evidence-bar mt-1.5 shrink-0" data-grounded="true" aria-hidden />
          <span>
            <span className="font-bold">ON RECORD</span>
            <span className="text-muted"> · collects points everywhere, rarely redeems them (interview transcript)</span>
          </span>
        </li>
        <li className="flex items-start gap-3">
          <span className="evidence-bar mt-1.5 shrink-0" data-grounded="false" aria-hidden />
          <span>
            <span className="font-bold">GUESS</span>
            <span className="text-muted"> · distrusts partner matching (no source says so yet)</span>
          </span>
        </li>
      </ul>
      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4 text-sm">
        <span className="rounded-full bg-accent-soft px-3 py-1 font-bold text-accent">CONTRADICTS</span>
        <span className="text-muted">Does the matching raise the share for the project?</span>
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <>
      <TeamLinkForward />
      <header className="sticky top-0 z-10 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-5 py-3 sm:px-8">
          <Link href="/" aria-label="OpenTwin home" className="mr-auto">
            <Image src="/opentwin-logo.svg" alt="OpenTwin" width={120} height={28} className="h-7 w-auto" priority />
          </Link>
          <nav aria-label="Page" className="hidden gap-6 text-sm text-muted sm:flex">
            <a href="#how" className="hover:text-foreground">
              How it works
            </a>
            <a href="#why" className="hover:text-foreground">
              Why OpenTwin
            </a>
          </nav>
          <Link
            href="/studio"
            className="rounded-md bg-accent px-4 py-2 text-sm font-bold text-surface hover:opacity-90"
          >
            Open the studio
          </Link>
        </div>
      </header>

      <main className="flex-1">
        {/* The one dark band: tinte ground with the emerald glow from one corner. */}
        <section
          aria-labelledby="hero-heading"
          className="room-glow text-room-text"
        >
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-20 sm:px-8 lg:grid-cols-[1.1fr_1fr] lg:py-28">
            <div>
              <Eyebrow dark>Sprint testing · on demand</Eyebrow>
              <h1 id="hero-heading" className="mt-5 text-5xl font-extrabold leading-[1.04] sm:text-6xl">
                Interview your customer before you have met them.
              </h1>
              <p className="mt-6 max-w-xl text-lg text-room-muted">
                OpenTwin turns your sprint material into an AI test user. Talk to it live by video, show it your
                prototype, and see which answers your sources back up and which are guesses.
              </p>
              <div className="mt-9 flex flex-wrap gap-3">
                <Link
                  href="/studio"
                  className="rounded-md bg-accent px-5 py-3 text-sm font-bold text-surface hover:opacity-90"
                >
                  Start a test
                </Link>
                <a
                  href="#how"
                  className="rounded-md border border-room-muted/40 px-5 py-3 text-sm font-bold text-room-text hover:border-room-text"
                >
                  See how it works
                </a>
              </div>
              <p className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-room-muted">
                <span className="flex items-center gap-2">
                  <span className="evidence-bar on-room" data-grounded="true" aria-hidden /> on record
                </span>
                <span className="flex items-center gap-2">
                  <span className="evidence-bar on-room" data-grounded="false" aria-hidden /> guess
                </span>
              </p>
            </div>
            <AnswerPreview />
          </div>
        </section>

        <section id="how" aria-labelledby="how-heading" className="scroll-mt-16">
          <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
            <Eyebrow>How it works</Eyebrow>
            <h2 id="how-heading" className="mt-4 max-w-3xl text-4xl leading-tight">
              Four steps from sprint material to answers.
            </h2>
            <p className="mt-4 max-w-2xl text-lg text-muted">The Friday user test, any day of the sprint.</p>
            <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {STEPS.map((s) => (
                <li key={s.n} className="rounded-2xl border border-line bg-surface p-5 shadow-sm">
                  <span className="inline-flex size-9 items-center justify-center rounded-lg bg-accent text-sm font-bold text-surface tabular-nums">
                    {s.n}
                  </span>
                  <h3 className="mt-4 text-lg font-bold">{s.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{s.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="why" aria-labelledby="why-heading" className="scroll-mt-16 border-y border-line bg-surface">
          <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
            <Eyebrow>Why OpenTwin</Eyebrow>
            <h2 id="why-heading" className="mt-4 max-w-3xl text-4xl leading-tight">
              Honest about what it knows.
            </h2>
            <p className="mt-4 max-w-2xl text-lg text-muted">
              Synthetic users tend to agree with everything. This one is built not to.
            </p>
            <div className="mt-10 grid gap-4 sm:grid-cols-2">
              {FEATURES.map((f) => (
                <div key={f.title} className="flex gap-4 rounded-2xl border border-line bg-background p-5">
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent text-surface">
                    {f.icon}
                  </span>
                  <div>
                    <h3 className="text-lg font-bold">{f.title}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-muted">{f.text}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section aria-labelledby="truth-heading">
          <div className="mx-auto grid max-w-6xl gap-10 px-5 py-20 sm:px-8 lg:grid-cols-2">
            <div>
              <Eyebrow>What it is not</Eyebrow>
              <h2 id="truth-heading" className="mt-4 text-4xl leading-tight">
                Hypotheses, not customer evidence.
              </h2>
              <p className="mt-4 text-lg text-muted">
                A persona helps you find weak spots before Friday. It does not replace talking to real users.
              </p>
            </div>
            <ul className="space-y-4 text-base">
              {[
                "The interview screen always says you are talking to an AI persona.",
                "Asked sincerely, the persona says it is a simulated test person.",
                "Every debrief lists follow-up questions to ask real customers next.",
                "Stock faces and voices by default. A clone only with written consent.",
              ].map((line) => (
                <li key={line} className="flex gap-3">
                  <span aria-hidden className="mt-2.5 inline-block size-1.5 shrink-0 rounded-full bg-signal" />
                  {line}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section aria-labelledby="cta-heading" className="bg-accent text-surface">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-6 px-5 py-14 sm:px-8">
            <div>
              <h2 id="cta-heading" className="text-3xl leading-tight">
                Test your next idea today.
              </h2>
              <p className="mt-2 opacity-90">Start with the Quartier-Börse example, or describe your own product.</p>
            </div>
            <Link
              href="/studio"
              className="rounded-md bg-surface px-5 py-3 text-sm font-bold text-accent hover:opacity-90"
            >
              Open the studio
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-5 py-6 text-sm text-muted sm:px-8">
          <span className="flex items-center gap-2">
            <span aria-hidden className="inline-block size-1.5 rounded-full bg-signal" />
            OpenTwin · BaselHack 2026 · Sprintbox AI challenge
          </span>
          <span className="sm:ml-auto">You prepare. The persona answers. Your team decides.</span>
        </div>
      </footer>
    </>
  );
}

// API contracts. Mirror of code/shared/schema.json — change that file first, then this one and code/backend/app/contracts.py.

export type Label = "grounded" | "guess";
export type SourceKind = "transcript" | "miro" | "note" | "real_interview";
export type Language = "de" | "en";
/** Integer 1–5. */
export type Scale5 = number;

export type Evidence = {
  id: string;
  kind: SourceKind;
  claim: string;
  quote?: string | null;
  sourceRef?: string | null;
};

export type Fact = {
  text: string;
  label: Label;
  /** Set when label is grounded, null for a guess. */
  evidenceId: string | null;
};

export type Persona = {
  id: string;
  sprintId?: string | null;
  version?: number;
  name: string;
  age?: number | null;
  location?: string | null;
  language: Language;
  summary: string;
  context?: { job?: string | null; household?: string | null; toolsToday?: string[] };
  jobs: Fact[];
  pains: Fact[];
  objections: Fact[];
  attitudes?: { techAffinity?: Scale5; priceSensitivity?: Scale5; trustInNewBrands?: Scale5 };
  speechStyle?: {
    register?: "formal" | "informal";
    verbosity?: "short" | "medium" | "long";
    fillers?: boolean;
    notes?: string | null;
  };
  voiceId: string;
  faceId: string;
  /** true only with written consent of the real person. */
  cloned: boolean;
  readiness?: { score: number; consistency: number; grounding: number } | null;
  evidence: Evidence[];
};

/** One row of the persona library (GET /api/personas). */
export type PersonaSummary = {
  id: string;
  name: string;
  /** The persona's context.job. */
  role: string | null;
  createdAt: string;
  readiness: { score: number; consistency: number; grounding: number } | null;
};

/** PATCH /api/personas/{id}: given lists replace the stored ones; edited or new facts come back as guesses. */
export type PersonaUpdate = {
  jobs?: Fact[];
  pains?: Fact[];
  objections?: Fact[];
  speechStyle?: { notes?: string | null };
};

/** Plain text pulled from an uploaded file (POST /api/sources/pdf). */
export type ExtractedText = { text: string; pages: number };

export type PersonaSource = { kind: SourceKind; title?: string | null; text: string };

export type PersonaCreate = {
  sprintId?: string | null;
  language: Language;
  sources: PersonaSource[];
};

export type Provider = "openai-realtime" | "simli";

export type Session = {
  id: string;
  personaId: string;
  status: "created" | "live" | "ended";
  provider: Provider;
  joinUrl?: string | null;
  interviewGuide?: string[];
  readySeconds?: number | null;
  startedAt?: string | null;
  endedAt?: string | null;
  /** Whether a saved debrief can be opened. Only in the persona's session list. */
  debriefReady?: boolean;
  /** Demo fallback: a scripted transcript with no live call. Every view of its debrief must say so. */
  sample?: boolean;
};

export type SessionCreate = { personaId: string; interviewGuide?: string[]; sample?: boolean };

export type SessionUpdate = { status: "live" | "ended" };

export type SessionToken = {
  provider: Provider;
  token?: string | null;
  url?: string | null;
  expiresAt: string;
};

type EventBase = { sessionId: string; seq: number; at: string };

export type SessionEvent = EventBase &
  (
    | {
        type: "utterance";
        data: {
          speaker: "interviewer" | "persona";
          text: string;
          tStart?: number | null;
          tEnd?: number | null;
        };
      }
    | { type: "screen.caption"; data: { caption: string; source: "vision" | "dom" } }
    | {
        type: "twin.reaction";
        data: { kind: "confused" | "pleased" | "sceptical"; intensity: Scale5 };
      }
    | {
        type: "copilot.suggestion";
        data: {
          kind: "leading_question" | "pitching" | "follow_up" | "coverage";
          text: string;
          turnSeq?: number | null;
        };
      }
    | { type: "session.ended"; data: { durationSeconds?: number } }
  );

export type Insight = {
  id: string;
  theme: string;
  /** Must match the transcript word for word. */
  quote: string;
  turnSeq: number;
  label: Label;
  evidenceId: string | null;
};

export type InsightReport = {
  sessionId: string;
  generatedAt: string;
  questions: {
    question: string;
    signal: "supports" | "contradicts" | "unclear";
    insights: Insight[];
    followUps?: string[];
  }[];
};

/** POST /api/insights/summary: 1 to 50 interviews. A repeated id counts once. */
export type InsightSummaryRequest = { sessionIds: string[] };

/** Saved debriefs side by side, grouped by exact question text. Computed without a model. */
export type InsightSummary = {
  questions: {
    question: string;
    /** Interviews with this signal. An interview whose guide lacks the question counts in none of the three. */
    supports: number;
    contradicts: number;
    unclear: number;
    /** Strongest quotes: at most two per interview, with grounded ones first. */
    insights: (Insight & { sessionId: string })[];
  }[];
};

export type GuideIssue = "leading" | "hypothetical" | "closed" | "pitch";

export type GuideReviewRequest = {
  /** 1 to 50 nonblank questions of at most 500 characters. */
  questions: string[];
  /** Language of the rewrites. */
  language: Language;
};

export type GuideReviewItem = {
  question: string;
  issues: GuideIssue[];
  /** Neutral, open version on one line. Null when there are no issues. */
  rewrite: string | null;
};

export type GuideReview = {
  /** One entry per question, in request order. */
  items: GuideReviewItem[];
};

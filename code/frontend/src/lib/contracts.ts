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

/** Plain text pulled from an uploaded file (POST /api/sources/pdf). */
export type ExtractedText = { text: string; pages: number };

export type PersonaSource = { kind: SourceKind; title?: string | null; text: string };

export type PersonaCreate = {
  sprintId?: string | null;
  language: Language;
  sources: PersonaSource[];
};

export type Provider = "tavus" | "anam" | "livekit" | "openai-realtime";

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
};

export type SessionCreate = { personaId: string; interviewGuide?: string[] };

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

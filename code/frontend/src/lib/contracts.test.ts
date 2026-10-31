import { describe, expect, it } from "vitest";
import schema from "../../../shared/schema.json";
import type { InsightReport, Label, Language, Provider, Session, SessionUpdate, SourceKind } from "./contracts";

// contracts.ts is types only, so this pairs the two checks that together keep the unions listed here
// in step with the schema: `satisfies` fails `tsc` if a key is missing from or unknown to the TS
// union, and the test fails if the keys differ from the schema's enum. Not covered: the SessionEvent
// and speechStyle enums, and PersonaCreate.language.
const unions = {
  Label: { grounded: 1, guess: 1 } satisfies Record<Label, 1>,
  SourceKind: { transcript: 1, miro: 1, note: 1, real_interview: 1 } satisfies Record<SourceKind, 1>,
  Provider: { "openai-realtime": 1, simli: 1 } satisfies Record<Provider, 1>,
  Language: { de: 1, en: 1 } satisfies Record<Language, 1>,
  "Session.status": { created: 1, live: 1, ended: 1 } satisfies Record<Session["status"], 1>,
  "SessionUpdate.status": { live: 1, ended: 1 } satisfies Record<SessionUpdate["status"], 1>,
  "InsightReport signal": { supports: 1, contradicts: 1, unclear: 1 } satisfies Record<
    InsightReport["questions"][number]["signal"],
    1
  >,
};

const defs = schema.$defs;
const schemaEnums: Record<keyof typeof unions, string[]> = {
  Label: defs.Label.enum,
  SourceKind: defs.SourceKind.enum,
  Provider: defs.Provider.enum,
  Language: defs.Persona.properties.language.enum,
  "Session.status": defs.Session.properties.status.enum,
  "SessionUpdate.status": defs.SessionUpdate.properties.status.enum,
  "InsightReport signal": defs.InsightReport.properties.questions.items.properties.signal.enum,
};

describe("contracts", () => {
  it.each(Object.keys(unions) as (keyof typeof unions)[])("%s matches the schema enum", (name) => {
    expect(Object.keys(unions[name]).sort()).toEqual([...schemaEnums[name]].sort());
  });
});

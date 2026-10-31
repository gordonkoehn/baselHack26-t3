import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LUMEN_GUIDE,
  LUMEN_SAMPLE_TRANSCRIPT,
  QUARTIER_BOERSE,
  QUARTIER_BOERSE_GUIDE,
  SAMPLE_TRANSCRIPT,
  TEAM_TWIN,
  TEAM_TWIN_CHECK,
  TEAM_TWIN_LEGEND,
  TEAM_TWIN_PLACEHOLDER,
  isMiriamKessler,
  sampleTurns,
} from "./sample";

describe("demo samples", () => {
  it("keeps the test case an exact copy of the documentation", () => {
    const doc = resolve(import.meta.dirname, "../../../../documentation/testcase-quartier-boerse.md");

    const text = readFileSync(doc, "utf8");

    // The document opens with a status banner for readers; the copy starts at its title.
    expect(QUARTIER_BOERSE).toBe(text.slice(text.indexOf("# Test case:")));
  });

  it("marks the transcript as synthetic, so it is never taken for a real person", () => {
    expect(SAMPLE_TRANSCRIPT.startsWith("SYNTHETIC INTERVIEW")).toBe(true);
  });

  it("has distinct, non-empty sprint questions for the debrief", () => {
    expect(QUARTIER_BOERSE_GUIDE.length).toBeGreaterThan(0);
    expect(QUARTIER_BOERSE_GUIDE.every((question) => question.trim().length > 0)).toBe(true);
    expect(new Set(QUARTIER_BOERSE_GUIDE).size).toBe(QUARTIER_BOERSE_GUIDE.length);
  });

  it("keeps the Lumen guide an exact copy of the short guide in the documentation", () => {
    const doc = resolve(
      import.meta.dirname,
      "../../../../documentation/usecases/lumen-ipp/interview/guide-short-miriam-kessler.txt",
    );

    expect(LUMEN_GUIDE).toEqual(readFileSync(doc, "utf8").split("\n").filter(Boolean));
  });

  it("gives only Miriam Kessler the Lumen guide, whatever her title", () => {
    expect(isMiriamKessler("Dr. Miriam Kessler")).toBe(true);
    expect(isMiriamKessler("Miriam Kessler")).toBe(true);
    expect(isMiriamKessler("Sandra")).toBe(false);
    expect(isMiriamKessler("Dr. Rainer Hollmann")).toBe(false);
  });

  it.each(["Dr. Miriam Kessler", "Miriam Kessler"])("selects the fictional Lumen sample for %s", (name) => {
    const turns = sampleTurns(name);
    expect(LUMEN_SAMPLE_TRANSCRIPT.startsWith("SYNTHETIC SAMPLE INTERVIEW")).toBe(true);
    expect(turns.filter((turn) => turn.speaker === "interviewer").map((turn) => turn.text)).toEqual(LUMEN_GUIDE);
    expect(turns).toHaveLength(8);
    const answers = turns.filter((turn) => turn.speaker === "persona").map((turn) => turn.text).join("\n");
    expect(answers).toContain("90 days before renewal");
    expect(answers).toContain("Savings against list price are not an independent comparison");
    expect(answers).toContain("board-ready one-page summary");
    expect(answers).toContain("Nothing has been annotated or changed.");
    expect(answers).not.toMatch(/Kilo-Shares|Papier|PET|Alu|Bäckerei|Spielplatz/);
  });

  it("preserves every original Quartier fallback turn, including the default and other Lumen personas", () => {
    const original = [
      "Wie entsorgt ihr heute Papier, PET und Alu?",
      "Wir haben seit einem Jahr das Abo mit der Abholung. Vorher bin ich jeden zweiten Samstag mit dem Auto zur Sammelstelle, das war mühsam mit den Kindern.",
      "Was gefällt dir am Abo?",
      "Dass ich nicht mehr daran denken muss. Der Sack steht am Dienstag vor der Tür und ist weg.",
      "Nutzt du Punkte- oder Treueprogramme?",
      "Supercard und Cumulus, klar. Aber ehrlich gesagt löse ich die Punkte fast nie ein. Es ist so wenig, dass ich es vergesse.",
      "Jetzt bekommst du Kilo-Shares für deinen Sack. Was machst du damit?",
      "Wenn es wieder so ein paar Rappen sind, ist es mir eigentlich egal. Dann gebe ich es lieber weiter, bevor es verfällt.",
      "Und wenn du einen Teil ans Quartier-Projekt gibst?",
      "Ein Spielplatz in Littau, das finde ich gut, da sind meine Kinder auch. Aber ich will sehen, dass das Geld wirklich dort ankommt. Sonst ist es für mich nur Werbung.",
      "Die Bäckerei Muff verdoppelt deinen Beitrag. Was denkst du?",
      "Hm. Klingt zuerst nett, aber auch ein bisschen nach Marketing. Was hat die Bäckerei davon? Wenn das transparent ist, okay.",
      "Würdest du dich im Projekt engagieren, zum Beispiel beim Pflanzen?",
      "Mit dem Job und den Kindern habe ich kaum Zeit. Mitmachen ja, aber per Klick, nicht an einem Samstagmorgen.",
      "Was müsste die App zeigen, damit du dabeibleibst?",
      "Einen Fortschrittsbalken, wie weit das Projekt ist. Und am Ende ein Foto vom fertigen Spielplatz. Dann wäre ich schon ein bisschen stolz.",
    ].map((text, index) => ({ speaker: index % 2 === 0 ? "interviewer" : "persona", text }));
    expect(sampleTurns()).toEqual(original);
    for (const name of ["", "Sandra", "Dr. Rainer Hollmann", "Prof. Dr. Sabine Aigner", "Dr. Ana Ferreira", "Jonas Brändli", "Ulrike Sandmann"]) {
      expect(sampleTurns(name)).toEqual(original);
    }
  });

  it.each(["Sandra", "Dr. Miriam Kessler"])("returns nonempty alternating interview roles for %s", (name) => {
    const turns = sampleTurns(name);
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.length % 2).toBe(0);
    turns.forEach((turn, index) => {
      expect(turn.speaker).toBe(index % 2 === 0 ? "interviewer" : "persona");
      expect(turn.text.trim().length).toBeGreaterThan(0);
      expect(turn.text).not.toContain("SYNTHETIC");
    });
  });
});

describe("team twin", () => {
  it("only holds marked placeholders until a member adds their own source", () => {
    expect(TEAM_TWIN.length).toBeGreaterThan(0);
    expect(TEAM_TWIN.every((source) => source.text.startsWith(TEAM_TWIN_PLACEHOLDER))).toBe(true);
  });

  it("has 5 distinct self-check questions and a mark for each outcome", () => {
    expect(new Set(TEAM_TWIN_CHECK).size).toBe(5);
    expect(Object.keys(TEAM_TWIN_LEGEND)).toEqual(["✅", "⚠️", "❌"]);
  });
});

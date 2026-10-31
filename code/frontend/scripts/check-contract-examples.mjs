import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const examples = resolve(frontend, "../shared/examples");
const contracts = resolve(frontend, "src/lib/contracts.ts");
const definitions = {
  "persona.json": "Persona",
  "session.json": "Session",
  "session-events.json": "SessionEvent[]",
  "insight-report.json": "InsightReport",
};

function checkExamples(examplesDirectory = examples, contractsPath = contracts) {
  const files = readdirSync(examplesDirectory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name).slice(resolve(examplesDirectory).length + 1))
    .sort();
  assert.deepEqual(files, Object.keys(definitions).sort(), "Every example needs a TypeScript mapping");

  const temporary = mkdtempSync(join(tmpdir(), "contract-examples-"));
  try {
    // Copy the actual contracts and emit actual JSON as contextually typed literals.
    // `satisfies` preserves enum literals and mutable arrays without unchecked casts.
    cpSync(contractsPath, join(temporary, "contracts.ts"));
    const source = [
      'import type { Persona, Session, SessionEvent, InsightReport } from "./contracts.js";',
      ...files.map((file, index) =>
        `const example${index} = ${JSON.stringify(JSON.parse(readFileSync(join(examplesDirectory, file), "utf8")))} satisfies ${definitions[file]};`,
      ),
    ].join("\n");
    const filename = join(temporary, "examples.ts");
    writeFileSync(filename, source);
    const program = ts.createProgram([filename], {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      types: [],
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length) {
      throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (file) => file,
        getCurrentDirectory: () => temporary,
        getNewLine: () => "\n",
      }));
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv.includes("--self-test")) {
  test("actual shared examples satisfy frontend contracts", () => checkExamples());
  for (const mutation of ["rename", "type", "enum", "unmapped", "missing"]) {
    test(`rejects ${mutation} drift in disposable inputs`, () => {
      const temporary = mkdtempSync(join(tmpdir(), "contract-drift-test-"));
      try {
        const fixtureExamples = join(temporary, "examples");
        const fixtureContracts = join(temporary, "contracts.ts");
        cpSync(examples, fixtureExamples, { recursive: true });
        cpSync(contracts, fixtureContracts);
        if (mutation === "rename" || mutation === "type") {
          const original = readFileSync(fixtureContracts, "utf8");
          const changed = mutation === "rename"
            ? original.replace("summary: string;", "biography: string;")
            : original.replace("summary: string;", "summary: number;");
          assert.notEqual(changed, original, "Mutation must change the actual contract");
          writeFileSync(fixtureContracts, changed);
        } else if (mutation === "enum") {
          const personaPath = join(fixtureExamples, "persona.json");
          const persona = JSON.parse(readFileSync(personaPath, "utf8"));
          persona.jobs[0].label = "unsupported-label";
          writeFileSync(personaPath, JSON.stringify(persona));
        } else if (mutation === "unmapped") {
          writeFileSync(join(fixtureExamples, "new-example.json"), "{}");
        } else {
          rmSync(join(fixtureExamples, "session.json"));
        }
        assert.throws(() => checkExamples(fixtureExamples, fixtureContracts),
          mutation === "unmapped" || mutation === "missing"
            ? /Every example needs a TypeScript mapping/
            : /TS\d+/);
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    });
  }
} else {
  checkExamples();
  console.log(`Typechecked ${Object.keys(definitions).length} shared examples against contracts.ts`);
}

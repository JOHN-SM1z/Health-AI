import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * AGENTS.md: AI may process only structured lab-result data for the approved
 * lab-summary feature — never clinical notes or history text, never
 * unnecessary identifiers. Guard that the AI lab module never even reads the
 * free-text parts of a result, documents, clinical text or patient identity,
 * whatever a future edit does.
 */

const DIR = "src/lib/labs/ai";
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((f) => join(DIR, f));

const FORBIDDEN = [
  /labComment|lab_comment|correctionReason|correction_reason/,
  /value_text|\.display\b|rangeText|range_text/,
  /documents/,
  /clinical_records|clinical-records|referral|handoff/,
  /full_name|fullName|patientName|phone|date_of_birth|telegram|pinfl|passport/,
  /orderedByName|verifiedByName/,
];

describe("AI lab module reads structured values only", () => {
  it("finds its files", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(3);
  });

  it.each(FILES)("%s never references free text, documents, clinical text or identity", (file) => {
    const code = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(FORBIDDEN.filter((p) => p.test(code)).map(String)).toEqual([]);
  });

  it("the general AI code still never reaches the lab modules (the summary calls AI, never the reverse)", () => {
    const aiFiles = readdirSync("src/lib/ai").filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    for (const f of aiFiles) expect(readFileSync(join("src/lib/ai", f), "utf8")).not.toMatch(/@\/lib\/labs/);
  });
});

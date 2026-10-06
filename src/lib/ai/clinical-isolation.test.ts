import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * AGENTS.md: AI must never write, read or summarise clinical text, and the
 * patient-facing bot / Mini App never show it. Guard that no AI, Telegram,
 * notification or patient-facing code path even references the clinical
 * tables or the modules that read them.
 */

const PATIENT_FACING_AND_AI = [
  "src/lib/ai",
  "src/lib/telegram",
  "src/lib/safety",
  "src/lib/transcription",
  "src/lib/notifications",
  "src/app/api/telegram",
  "src/app/api/me",
  "src/app/api/bookings",
  "src/app/api/catalog",
  "src/app/api/availability",
  "src/app/api/track",
  "src/app/(mini-app)",
];

const FORBIDDEN = [
  /clinical_records/,
  /from\(\s*["']referrals["']\s*\)/,
  /handoff_note/,
  /@\/lib\/clinical-records/,
  /@\/lib\/clinical-access/,
  /@\/lib\/referrals/,
  // Lab result data (20261005000004). Patients' own finalized results
  // (Phase 12) and structured AI summaries (Phase 18) will each be allowed
  // through one narrow, approved module when those phases are built — never
  // by referencing these tables directly.
  /lab_results/,
  /lab_result_values/,
  /lab_documents/,
  /@\/lib\/labs\/(ordering|guards|results|collection|history)/,
];

function sourceFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("clinical data never reaches AI or patient-facing code", () => {
  const files = PATIENT_FACING_AND_AI.flatMap(sourceFiles);

  it("finds the code it guards", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(PATIENT_FACING_AND_AI)("%s never references clinical tables or modules", (dir) => {
    const offenders = sourceFiles(dir).flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return FORBIDDEN.filter((pattern) => pattern.test(text)).map((pattern) => `${file}: ${pattern}`);
    });
    expect(offenders).toEqual([]);
  });
});

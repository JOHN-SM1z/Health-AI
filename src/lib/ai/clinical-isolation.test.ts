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
  // Lab result data (20261005000004). Never referenced directly: patients'
  // own released, verified results reach the Mini App and the notification
  // worker only through the one approved gateway below (Phase 12); a
  // structured AI summary (Phase 18) will get its own narrow module.
  /lab_results/,
  /lab_result_values/,
  /lab_documents/,
  /@\/lib\/labs\/(ordering|guards|results|collection|history|documents|imports|import\/)/,
  // Historical import rows hold patient identifiers and result values (Phase 13).
  /lab_import_/,
];

// The approved gateway for patients' own results (Phase 12) — allowed only in
// the Mini App and the notification worker, never in AI, the chat bot,
// safety or transcription code.
const PATIENT_RESULTS_GATEWAY = /@\/lib\/labs\/patient-results/;
const MAY_USE_PATIENT_RESULTS = ["src/lib/notifications", "src/app/api/me", "src/app/(mini-app)"];

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
    const forbidden = MAY_USE_PATIENT_RESULTS.includes(dir) ? FORBIDDEN : [...FORBIDDEN, PATIENT_RESULTS_GATEWAY];
    const offenders = sourceFiles(dir).flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return forbidden.filter((pattern) => pattern.test(text)).map((pattern) => `${file}: ${pattern}`);
    });
    expect(offenders).toEqual([]);
  });

  it("the patient-results gateway reads only released, verified results and no clinical text", () => {
    const text = readFileSync("src/lib/labs/patient-results.ts", "utf8");
    // Every result query is pinned to the verified version, the patient and the clinic, except
    // the worker's notice, which reports whether the version is still current.
    const resultQueries = text.split('.from("lab_results")').slice(1).map((q) => q.slice(0, 600));
    expect(resultQueries.length).toBeGreaterThanOrEqual(3);
    for (const q of resultQueries) expect(q).toMatch(/\.eq\("clinic_id", clinicId\)/);
    // Pinned to the patient's own merged record group (Phase 14), never wider.
    expect(text).toMatch(/const patientIds = await patientRecordIds\(clinicId, patientId\)/);
    expect(resultQueries.filter((q) => /\.eq\("status", "verified"\)/.test(q) && /\.in\("patient_id", patientIds\)/.test(q)).length).toBe(2);
    expect(text).toMatch(/lab_release_to_patient/);
    expect(text).toMatch(/\.is\("withdrawn_at", null\)/);
    for (const pattern of [/clinical_records/, /referrals/, /handoff_note/, /lab_comment/, /correction_reason/, /@\/lib\/labs\/(ordering|guards|results|collection|history|documents)/]) {
      expect(text).not.toMatch(pattern);
    }
  });
});

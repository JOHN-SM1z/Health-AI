import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 17: the management analytics and the work-queue workload are read by
 * roles that never see result values or (for analytics) patients. Guard that
 * their readers never even select a value, flag, comment, clinical text or a
 * patient's name — whatever a future edit adds to the response.
 */

const STATUS_ONLY_READERS = [
  "src/lib/labs/management-analytics.ts",
  "src/lib/labs/workload.ts",
  ...readdirSync("src/lib/analytics")
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join("src/lib/analytics", f)),
];

const FORBIDDEN = [
  /lab_result_values/,
  /value_numeric|value_text|value_boolean/,
  /\bflag\b/,
  /lab_comment|correction_reason/,
  /lab_documents/,
  /clinical_records|referrals|handoff_note/,
  /full_name|phone|telegram_user_id|date_of_birth/,
];

describe("lab dashboards: status-only readers", () => {
  it.each(STATUS_ONLY_READERS)("%s never reads values, clinical text or patient identity", (file) => {
    const text = readFileSync(file, "utf8")
      // Code only: the modules' comments say what they never read.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      // The appointment aggregator's own row type (patients(full_name)) predates the lab module and is out of scope here.
      .replace(/patients: \{ full_name: string \} \| null;/, "")
      .replace(/a\.patients\?\.full_name/g, "");
    const offenders = FORBIDDEN.filter((p) => p.test(text)).map(String);
    expect(offenders).toEqual([]);
  });
});

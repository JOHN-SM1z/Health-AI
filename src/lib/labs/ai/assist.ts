import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import type { LinkedDoctor } from "@/lib/auth/guards";
import { getAiProvider } from "@/lib/ai/provider";
import { getPatientLabHistory, type HistoryResult } from "@/lib/labs/history";
import { patientRecordIds } from "@/lib/patients/record-group";
import { getLabSettings } from "@/lib/labs/settings";
import { buildLabFacts, type FactPending, type FactResult, type Severity, type StatementKind } from "@/lib/labs/ai/facts";
import { rewriteStatements, type AiStatus } from "@/lib/labs/ai/rewrite";

/**
 * The doctor's laboratory summary (Phase 18): results, trends, comparable
 * tests and tests still pending, for preparing a consultation.
 *
 * An assistance layer only. It reads the patient through the same gate as
 * the lab history (doctor_patient_access(), each result read audited) and
 * changes nothing: no order, cancellation, verification or record depends on
 * it, and when AI is off, not allowed for the clinic, unavailable or its
 * answer fails the checks, the computed statements are shown instead.
 */

export const SUMMARY_WINDOW_DAYS = 730;

export type LabSummary = {
  bullets: Array<{ id: string; kind: StatementKind; severity: Severity; text: string }>;
  /** "ai" when the AI's rewording passed every check, else "computed". */
  source: "ai" | "computed";
  aiStatus: AiStatus;
  basis: { results: number; from: string | null; to: string | null; windowDays: number; nonNumericValues: number };
  generatedAt: string;
};

/** Structured fields only: never the lab comment, correction reason, free text or documents. */
export function toFactResult(r: HistoryResult): FactResult {
  return {
    resultId: r.resultId,
    testCode: r.testCode,
    testName: r.testName,
    takenAt: r.performedAt ?? r.collectedAt ?? r.verifiedAt,
    corrected: r.version > 1,
    values: r.values.map((v) => ({
      parameterCode: v.parameterCode,
      parameter: v.parameter,
      numeric: v.numeric,
      unit: v.unit,
      flag: v.flag,
      rangeLow: v.rangeLow,
      rangeHigh: v.rangeHigh,
    })),
  };
}

async function pendingTests(clinicId: string, patientId: string): Promise<FactPending[]> {
  const ids = await patientRecordIds(clinicId, patientId);
  const { data, error } = await createAdminClient()
    .from("lab_order_items")
    .select("test_name_snapshot, status, created_at")
    .eq("clinic_id", clinicId)
    .in("patient_id", ids)
    .in("status", ["ordered", "ready_for_collection", "collected", "processing", "resulted"])
    .order("created_at", { ascending: true })
    .limit(20);
  if (error) {
    logger.error("lab summary: pending tests failed", { code: error.code });
    throw new ApiError(500, "Laboratoriya xulosasini tuzib bo‘lmadi", "load_failed");
  }
  return (data ?? []).map((i) => ({ testName: i.test_name_snapshot, status: i.status, orderedAt: i.created_at }));
}

export async function getLabSummary(doctor: LinkedDoctor, patientId: string, now = new Date()): Promise<LabSummary> {
  // Access (404 when the doctor may not see the patient) and the per-result audit happen here.
  const history = await getPatientLabHistory(doctor, patientId, { via: "lab_summary" });
  const since = now.getTime() - SUMMARY_WINDOW_DAYS * 86_400_000;
  const results = history.map(toFactResult).filter((r) => Date.parse(r.takenAt) >= since);
  const [pending, settings] = await Promise.all([pendingTests(doctor.clinicId, patientId), getLabSettings(doctor.clinicId)]);

  const facts = buildLabFacts(results, pending, now);
  const rewritten = await rewriteStatements(getAiProvider(), facts.statements, { clinicEnabled: settings.aiSummaries });
  const textOf = new Map(rewritten.bullets.map((b) => [b.id, b.text]));

  await recordAudit({
    clinicId: doctor.clinicId,
    action: "lab_summary_generated",
    entityType: "patients",
    entityId: patientId,
    patientId,
    actor: { actorId: doctor.profileId, actorType: "staff" },
    // Ids, counts and the outcome only — never the text.
    metadata: { results: facts.basis.results, statements: facts.statements.length, ai_status: rewritten.status, ...(rewritten.reason ? { ai_reason: rewritten.reason } : {}) },
    strict: true,
  });

  return {
    bullets: facts.statements.map((s) => ({ id: s.id, kind: s.kind, severity: s.severity, text: textOf.get(s.id) ?? s.text })),
    source: rewritten.status === "used" ? "ai" : "computed",
    aiStatus: rewritten.status,
    basis: { results: facts.basis.results, from: facts.basis.from, to: facts.basis.to, windowDays: SUMMARY_WINDOW_DAYS, nonNumericValues: facts.basis.nonNumericValues },
    generatedAt: now.toISOString(),
  };
}

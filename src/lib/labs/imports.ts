import "server-only";
import { ageInYears } from "@/lib/patients/age";
import { serverHmac } from "@/lib/security/server-hmac";
import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import type { ClinicStaff } from "@/lib/labs/guards";
import type { Json } from "@/lib/supabase/database.types";
import { csvField, decodeImportFile, FILE_ERROR_MESSAGES, parseCsv } from "@/lib/labs/import/csv";
import { checkMapping, IMPORT_FIELDS, MAPPING_PROBLEM_MESSAGES, suggestMapping, type ImportMapping } from "@/lib/labs/import/mapping";
import { normalizeName, phoneKey, type ImportValue } from "@/lib/labs/import/fields";
import type { CandidatePatient } from "@/lib/labs/import/matching";
import {
  analyseRows,
  patientLookups,
  readRows,
  summarise,
  type AnalysedRow,
  type CatalogTest,
  type Confirmation,
  type ExistingResult,
  type ImportSummary,
} from "@/lib/labs/import/analyse";
import { IMPORT_ERROR_LABELS, IMPORT_STATUS_LABELS } from "@/lib/labs/import/labels";

/**
 * Historical laboratory-data import (Phase 13) — a migration tool for lab
 * staff (import.manage), not a patient workflow.
 *
 *   upload    a CSV file → a batch with its rows (cells only) and a
 *             suggested mapping. The same file can be in one live batch only.
 *   analyse   the preparer's mapping → every row validated, matched to a
 *             patient (exact identifiers only; weak matches need a staff
 *             member's confirmation; nothing is created or merged) and
 *             checked for duplicates in the file and in the clinic's records.
 *   dry run   every ready result inserted up to submission, then rolled back.
 *   confirm   a SECOND lab staff member confirms (not the preparer) and the
 *             import runs: each result on its own (partial import), failed
 *             ones retryable. Imported results are source = import, entered
 *             by the preparer and verified by the confirmer.
 *   report    statuses and error codes per row (CSV), no values or identifiers.
 *
 * Views of row contents are audited before they are returned; audit rows
 * hold ids, counts and codes only — never file names, cells or values.
 */

const NOT_FOUND = () => new ApiError(404, "Import topilmadi", "import_not_found");
const ANALYSIS_VALID_MS = 24 * 3_600_000;
const RUN_BUDGET_MS = 20_000;
const ROWS_PAGE = 100;
const CHUNK_GROUPS = 50;

function loadFailed(what: string, error: { code?: string }) {
  logger.error(`lab import: ${what} failed`, { code: error.code });
  return new ApiError(500, "Import ma’lumotlarini yuklab bo‘lmadi", "load_failed");
}

const RPC_ERRORS: Array<[RegExp, number, string, string]> = [
  [/lab_import_not_found/, 404, "Import topilmadi", "import_not_found"],
  [/lab_import_not_preparer/, 403, "Faylni faqat uni yuklagan xodim moslaydi va tahlil qiladi", "not_preparer"],
  [/lab_import_second_person/, 409, "Importni tayyorlagan xodim uni tasdiqlay olmaydi — ikkinchi xodim kerak", "second_person_required"],
  [/lab_import_not_editable|lab_import_not_analysed|lab_import_not_confirmed/, 409, "Import holati o‘zgargan — sahifani yangilang", "import_state_changed"],
  [/lab_import_not_staff/, 403, "Ruxsat yo‘q", "forbidden"],
];

function rpcError(error: { message?: string; code?: string }, what: string): ApiError {
  const known = RPC_ERRORS.find(([pattern]) => pattern.test(error.message ?? ""));
  if (known) return new ApiError(known[1], known[2], known[3]);
  logger.error(`lab import: ${what} failed`, { code: error.code });
  return new ApiError(500, "Importni bajarib bo‘lmadi", "import_failed");
}

type BatchRow = {
  id: string;
  clinic_id: string;
  source_system: string;
  file_name: string;
  status: "uploaded" | "analysed" | "confirmed" | "completed" | "cancelled";
  headers: Json;
  mapping: Json | null;
  row_count: number;
  summary: Json;
  created_by: string;
  analysed_at: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
};

async function loadBatch(staff: ClinicStaff, batchId: string): Promise<BatchRow> {
  const { data, error } = await createAdminClient()
    .from("lab_import_batches")
    .select("id, clinic_id, source_system, file_name, status, headers, mapping, row_count, summary, created_by, analysed_at, confirmed_by, confirmed_at, completed_at, cancelled_at, created_at")
    .eq("id", batchId)
    .eq("clinic_id", staff.clinicId)
    .maybeSingle();
  if (error) throw loadFailed("batch", error);
  if (!data) throw NOT_FOUND();
  return data as BatchRow;
}

function audit(staff: ClinicStaff, action: string, batchId: string, metadata: Record<string, unknown>, strict = false) {
  return recordAudit({
    clinicId: staff.clinicId,
    action,
    entityType: "lab_import_batches",
    entityId: batchId,
    actor: { actorId: staff.profileId, actorType: "staff" },
    metadata,
    strict,
  });
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export async function createImportBatch(
  staff: ClinicStaff,
  input: { fileName: string; sourceSystem: string; bytes: Uint8Array },
): Promise<{ id: string; rows: number; headers: string[]; mapping: ImportMapping }> {
  const decoded = decodeImportFile(input.bytes);
  if (!decoded.ok) throw new ApiError(decoded.code === "too_large" ? 413 : 415, FILE_ERROR_MESSAGES[decoded.code], `file_${decoded.code}`);
  const parsed = parseCsv(decoded.text);
  if (!parsed.ok) {
    const where = parsed.row ? ` (${parsed.row}-qator)` : "";
    throw new ApiError(422, FILE_ERROR_MESSAGES[parsed.code] + where, `file_${parsed.code}`);
  }
  const { headers, rows } = parsed.table;
  const mapping = suggestMapping(headers);
  const db = createAdminClient();

  const { data: batch, error } = await db
    .from("lab_import_batches")
    .insert({
      clinic_id: staff.clinicId,
      source_system: input.sourceSystem,
      file_name: input.fileName,
      file_sha256: createHash("sha256").update(input.bytes).digest("hex"),
      headers,
      mapping,
      row_count: rows.length,
      created_by: staff.profileId,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") throw new ApiError(409, "Bu fayl allaqachon yuklangan (import qilingan yoki jarayonda)", "file_already_uploaded");
    throw loadFailed("create batch", error);
  }

  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => ({ clinic_id: staff.clinicId, batch_id: batch.id, row_number: r.rowNumber, raw: r.cells }));
    const { error: rowsError } = await db.from("lab_import_rows").insert(chunk);
    if (rowsError) {
      // A half-stored file is never analysed: withdraw the batch.
      await db.from("lab_import_batches").update({ status: "cancelled", cancelled_at: new Date().toISOString(), cancelled_by: staff.profileId }).eq("id", batch.id);
      throw loadFailed("store rows", rowsError);
    }
  }
  await audit(staff, "lab_import_uploaded", batch.id, { rows: rows.length, columns: headers.length });
  return { id: batch.id, rows: rows.length, headers, mapping };
}

// ---------------------------------------------------------------------------
// Reading batches
// ---------------------------------------------------------------------------

export type ImportBatchListItem = {
  id: string;
  sourceSystem: string;
  fileName: string;
  status: BatchRow["status"];
  rows: number;
  createdAt: string;
  preparedByMe: boolean;
};

export async function listImportBatches(staff: ClinicStaff): Promise<ImportBatchListItem[]> {
  const { data, error } = await createAdminClient()
    .from("lab_import_batches")
    .select("id, source_system, file_name, status, row_count, created_at, created_by")
    .eq("clinic_id", staff.clinicId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw loadFailed("list", error);
  return (data ?? []).map((b) => ({
    id: b.id,
    sourceSystem: b.source_system,
    fileName: b.file_name,
    status: b.status,
    rows: b.row_count,
    createdAt: b.created_at,
    preparedByMe: b.created_by === staff.profileId,
  }));
}

type StoredSummary = { analysis?: ImportSummary; dryRun?: DryRunSummary };
export type DryRunSummary = { at: string; checked: number; wouldImport: number; failed: number; byCode: Record<string, number>; complete: boolean };

async function rowStatuses(batchId: string) {
  const { data, error } = await createAdminClient()
    .from("lab_import_rows")
    .select("status, group_key, patient_id")
    .eq("batch_id", batchId)
    .limit(5000);
  if (error) throw loadFailed("row statuses", error);
  return (data ?? []).map((r) => ({ status: r.status, groupKey: r.group_key, patientId: r.patient_id }));
}

async function names(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const { data } = await createAdminClient().from("profiles").select("id, full_name").in("id", ids);
  return new Map((data ?? []).map((p) => [p.id, p.full_name ?? "—"]));
}

export async function getImportBatch(staff: ClinicStaff, batchId: string) {
  const batch = await loadBatch(staff, batchId);
  const summary = (batch.summary ?? {}) as StoredSummary;
  const live = summarise(await rowStatuses(batch.id));
  const people = await names([batch.created_by, batch.confirmed_by].filter((v): v is string => Boolean(v)));
  const fresh = batch.analysed_at !== null && Date.now() - Date.parse(batch.analysed_at) < ANALYSIS_VALID_MS;
  const preparer = batch.created_by === staff.profileId;
  return {
    id: batch.id,
    sourceSystem: batch.source_system,
    fileName: batch.file_name,
    status: batch.status,
    rows: batch.row_count,
    headers: batch.headers as string[],
    mapping: (batch.mapping ?? {}) as ImportMapping,
    fields: IMPORT_FIELDS,
    preparedBy: people.get(batch.created_by) ?? "—",
    confirmedBy: batch.confirmed_by ? (people.get(batch.confirmed_by) ?? "—") : null,
    createdAt: batch.created_at,
    analysedAt: batch.analysed_at,
    confirmedAt: batch.confirmed_at,
    completedAt: batch.completed_at,
    cancelledAt: batch.cancelled_at,
    summary: live,
    dryRun: summary.dryRun ?? null,
    can: {
      analyse: preparer && (batch.status === "uploaded" || batch.status === "analysed"),
      dryRun: batch.status === "analysed",
      confirm: !preparer && batch.status === "analysed" && fresh && live.readyResults > 0,
      run: !preparer && batch.status === "confirmed",
      finish: batch.status === "confirmed",
      cancel: batch.status === "uploaded" || batch.status === "analysed" || batch.status === "confirmed",
    },
    preparer,
    analysisStale: batch.status === "analysed" && !fresh,
  };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

async function loadCatalog(clinicId: string): Promise<CatalogTest[]> {
  const { data, error } = await createAdminClient()
    .from("lab_tests")
    .select("id, code, name, lab_test_parameters(id, code, name, value_type, decimals, choices, unit, sort_order)")
    .eq("clinic_id", clinicId)
    .limit(2000);
  if (error) throw loadFailed("catalog", error);
  type Row = {
    id: string;
    code: string;
    name: string;
    lab_test_parameters: Array<{ id: string; code: string; name: string; value_type: CatalogTest["parameters"][number]["valueType"]; decimals: number | null; choices: string[] | null; unit: string | null; sort_order: number }>;
  };
  return ((data ?? []) as unknown as Row[]).map((t) => ({
    id: t.id,
    code: t.code,
    name: t.name,
    parameters: [...t.lab_test_parameters]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((p) => ({ id: p.id, code: p.code, name: p.name, valueType: p.value_type, decimals: p.decimals, choices: p.choices, unit: p.unit })),
  }));
}

const chunks = <T>(items: T[], size = 200): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/** Patients of the clinic that any row could be: by id, PINFL, document or birth date. */
async function loadCandidates(clinicId: string, lookups: ReturnType<typeof patientLookups>): Promise<CandidatePatient[]> {
  const db = createAdminClient();
  const found = new Map<string, CandidatePatient>();
  const columns = "id, full_name, phone, date_of_birth, sex, pinfl, document_number, merged_into_patient_id";
  const aliases = new Map<string, string[]>();
  const queries: Array<[string, string[]]> = [
    ["id", lookups.ids],
    ["pinfl", lookups.pinfls],
    ["document_number", lookups.documents],
    ["date_of_birth", lookups.birthDates],
  ];
  for (const [column, values] of queries) {
    for (const part of chunks(values)) {
      const { data, error } = await db.from("patients").select(columns).eq("clinic_id", clinicId).in(column, part).limit(5000);
      if (error) throw loadFailed("patients", error);
      for (const p of data ?? []) {
        // A merged record (Phase 14) is matched as its canonical record.
        if (p.merged_into_patient_id) {
          aliases.set(p.merged_into_patient_id, [...(aliases.get(p.merged_into_patient_id) ?? []), p.id]);
          continue;
        }
        found.set(p.id, {
          id: p.id,
          pinfl: p.pinfl,
          documentNumber: p.document_number,
          phoneKey: phoneKey(p.phone),
          dateOfBirth: p.date_of_birth,
          name: normalizeName(p.full_name),
          sex: p.sex,
        });
      }
    }
  }
  const canonicalMissing = [...aliases.keys()].filter((id) => !found.has(id));
  for (const part of chunks(canonicalMissing)) {
    const { data, error } = await db.from("patients").select(columns).eq("clinic_id", clinicId).in("id", part);
    if (error) throw loadFailed("patients", error);
    for (const p of data ?? []) {
      found.set(p.id, { id: p.id, pinfl: p.pinfl, documentNumber: p.document_number, phoneKey: phoneKey(p.phone), dateOfBirth: p.date_of_birth, name: normalizeName(p.full_name), sex: p.sex });
    }
  }
  for (const [canonical, ids] of aliases) {
    const c = found.get(canonical);
    if (c) c.aliasIds = ids;
  }
  return [...found.values()];
}

const asValue = (v: { value_numeric: number | string | null; value_text: string | null; value_boolean: boolean | null }): ImportValue => ({
  numeric: v.value_numeric === null ? null : String(v.value_numeric),
  text: v.value_text,
  boolean: v.value_boolean,
});

/** Current results (any status but superseded) of these patients — to refuse duplicates. */
async function loadExisting(clinicId: string, patientIds: string[]): Promise<ExistingResult[]> {
  const db = createAdminClient();
  const out: ExistingResult[] = [];
  for (const part of chunks(patientIds)) {
    const { data, error } = await db
      .from("lab_results")
      .select("patient_id, performed_at, verified_at, entered_at, lab_order_items!lab_results_item_fkey(test_id), lab_result_values(parameter_id, value_numeric, value_text, value_boolean)")
      .eq("clinic_id", clinicId)
      .in("patient_id", part)
      .neq("status", "superseded")
      .limit(10000);
    if (error) throw loadFailed("existing results", error);
    type Row = {
      patient_id: string;
      performed_at: string | null;
      verified_at: string | null;
      entered_at: string;
      lab_order_items: { test_id: string } | null;
      lab_result_values: Array<{ parameter_id: string; value_numeric: number | string | null; value_text: string | null; value_boolean: boolean | null }>;
    };
    for (const r of (data ?? []) as unknown as Row[]) {
      if (!r.lab_order_items) continue;
      out.push({
        patientId: r.patient_id,
        testId: r.lab_order_items.test_id,
        at: r.performed_at ?? r.verified_at ?? r.entered_at,
        values: new Map(r.lab_result_values.map((v) => [v.parameter_id, asValue(v)])),
      });
    }
  }
  return out;
}

type StoredRow = {
  row_number: number;
  raw: Json;
  patient_key: string | null;
  match_kind: string | null;
  patient_id: string | null;
  match_confirmed_by: string | null;
};

async function loadRowsForAnalysis(batchId: string): Promise<StoredRow[]> {
  const { data, error } = await createAdminClient()
    .from("lab_import_rows")
    .select("row_number, raw, patient_key, match_kind, patient_id, match_confirmed_by")
    .eq("batch_id", batchId)
    .order("row_number")
    .limit(5000);
  if (error) throw loadFailed("rows", error);
  return (data ?? []) as StoredRow[];
}

async function analyseAndStore(staff: ClinicStaff, batch: BatchRow, mapping: ImportMapping, extra?: { patientKey: string; patientId: string }): Promise<ImportSummary> {
  const headers = batch.headers as string[];
  const problem = checkMapping(mapping, headers.length);
  if (problem) throw new ApiError(400, MAPPING_PROBLEM_MESSAGES[problem], `mapping_${problem}`);

  const [stored, catalog] = await Promise.all([loadRowsForAnalysis(batch.id), loadCatalog(staff.clinicId)]);
  const readPlain = readRows(
    stored.map((r) => ({ rowNumber: r.row_number, cells: (r.raw as string[]).map(String) })),
    headers.length,
    mapping,
    catalog,
    staff.clinicTimezone,
    new Date(),
  );
  // The key that groups "the same person as written in the file" is built from passport, JSHSHIR, date of birth, phone and
  // name. It is stored and sent to the browser (to confirm a match) only as a server-keyed token (owner decision 2026-10-08).
  const read = readPlain.map((r) => ({ ...r, patientKey: r.patientKey ? serverHmac("lab-import-patient", r.patientKey) : r.patientKey }));

  // Earlier staff confirmations of a possible match survive re-analysis while
  // the same patient is still the one suggested.
  const confirmations = new Map<string, Confirmation>();
  for (const r of stored) {
    if (r.match_kind === "staff_confirmed" && r.patient_key && r.patient_id && r.match_confirmed_by) {
      confirmations.set(r.patient_key, { patientId: r.patient_id, by: r.match_confirmed_by });
    }
  }
  if (extra) confirmations.set(extra.patientKey, { patientId: extra.patientId, by: staff.profileId });

  const patients = await loadCandidates(staff.clinicId, patientLookups(read));
  const first = analyseRows(read, { patients, confirmations, existing: [], timezone: staff.clinicTimezone });
  const matched = [...new Set(first.map((r) => r.patientId).filter((v): v is string => Boolean(v)))];
  const existing = await loadExisting(staff.clinicId, matched);
  const rows = analyseRows(read, { patients, confirmations, existing, timezone: staff.clinicTimezone });

  if (extra && !rows.some((r) => r.patientKey === extra.patientKey && r.matchKind === "staff_confirmed" && r.patientId === extra.patientId)) {
    throw new ApiError(409, "Bu bemor ushbu qatorlar uchun taklif qilinmagan — sahifani yangilang", "match_not_offered");
  }

  const summary = summarise(rows);
  const payload = rows.map((r: AnalysedRow) => ({
    row_number: r.rowNumber,
    status: r.status,
    errors: r.errors,
    patient_key: r.patientKey || null,
    patient_id: r.patientId,
    match_kind: r.matchKind,
    match_confirmed_by: r.matchConfirmedBy,
    candidate_patient_ids: r.candidatePatientIds,
    test_id: r.testId,
    parameter_id: r.parameterId,
    value_numeric: r.status === "invalid" ? null : (r.value?.numeric ?? null),
    value_text: r.status === "invalid" ? null : (r.value?.text ?? null),
    value_boolean: r.status === "invalid" ? null : (r.value?.boolean ?? null),
    performed_at: r.performedAt,
    accession: r.accession,
    group_key: r.groupKey,
  }));
  const { error } = await createAdminClient().rpc("store_lab_import_analysis", {
    p_clinic_id: staff.clinicId,
    p_batch_id: batch.id,
    p_actor: staff.profileId,
    p_mapping: mapping as Json,
    p_summary: { analysis: summary } as unknown as Json,
    p_rows: payload as unknown as Json,
  });
  if (error) throw rpcError(error, "store analysis");
  return summary;
}

function preparerOnly(staff: ClinicStaff, batch: BatchRow) {
  if (batch.created_by !== staff.profileId) throw new ApiError(403, "Faylni faqat uni yuklagan xodim moslaydi va tahlil qiladi", "not_preparer");
  if (batch.status !== "uploaded" && batch.status !== "analysed") throw new ApiError(409, "Import tasdiqlangan yoki yopilgan — uni o‘zgartirib bo‘lmaydi", "import_state_changed");
}

export async function analyseImportBatch(staff: ClinicStaff, batchId: string, mapping: ImportMapping): Promise<ImportSummary> {
  const batch = await loadBatch(staff, batchId);
  preparerOnly(staff, batch);
  const summary = await analyseAndStore(staff, batch, mapping);
  await audit(staff, "lab_import_analysed", batch.id, { rows: summary.rows, by_status: summary.byStatus, ready_results: summary.readyResults });
  return summary;
}

/** The preparer confirms that the rows of one person in the file are this suggested patient. */
export async function confirmPatientMatch(staff: ClinicStaff, batchId: string, patientKey: string, patientId: string): Promise<ImportSummary> {
  const batch = await loadBatch(staff, batchId);
  preparerOnly(staff, batch);
  if (batch.status !== "analysed") throw new ApiError(409, "Avval faylni tahlil qiling", "not_analysed");
  const { data: offered, error } = await createAdminClient()
    .from("lab_import_rows")
    .select("row_number")
    .eq("batch_id", batch.id)
    .eq("patient_key", patientKey)
    .eq("status", "possible_match")
    .contains("candidate_patient_ids", [patientId])
    .limit(1);
  if (error) throw loadFailed("match check", error);
  if (!offered?.length) throw new ApiError(409, "Bu bemor ushbu qatorlar uchun taklif qilinmagan — sahifani yangilang", "match_not_offered");

  const summary = await analyseAndStore(staff, batch, (batch.mapping ?? {}) as ImportMapping, { patientKey, patientId });
  await recordAudit({
    clinicId: staff.clinicId,
    action: "lab_import_match_confirmed",
    entityType: "lab_import_batches",
    entityId: batch.id,
    patientId,
    actor: { actorId: staff.profileId, actorType: "staff" },
    metadata: {},
  });
  return summary;
}

// ---------------------------------------------------------------------------
// Dry run, confirmation, import
// ---------------------------------------------------------------------------

type RunRow = { group_key: string; first_row: number; outcome: string; error_code: string | null; lab_result_id: string | null };

async function runChunk(staff: ClinicStaff, batchId: string, dryRun: boolean, afterRow: number): Promise<RunRow[]> {
  const { data, error } = await createAdminClient().rpc("run_lab_import", {
    p_clinic_id: staff.clinicId,
    p_batch_id: batchId,
    p_actor: staff.profileId,
    p_dry_run: dryRun,
    p_after_row: afterRow,
    p_max_groups: CHUNK_GROUPS,
  });
  if (error) throw rpcError(error, dryRun ? "dry run" : "run");
  return (data ?? []) as RunRow[];
}

export async function dryRunImport(staff: ClinicStaff, batchId: string): Promise<DryRunSummary> {
  const batch = await loadBatch(staff, batchId);
  if (batch.status !== "analysed") throw new ApiError(409, "Sinov importi faqat tahlil qilingan fayl uchun", "not_analysed");
  const deadline = Date.now() + RUN_BUDGET_MS;
  const result: DryRunSummary = { at: new Date().toISOString(), checked: 0, wouldImport: 0, failed: 0, byCode: {}, complete: false };
  let after = 0;
  for (;;) {
    if (Date.now() > deadline) break;
    const rows = await runChunk(staff, batch.id, true, after);
    if (!rows.length) {
      result.complete = true;
      break;
    }
    for (const r of rows) {
      result.checked++;
      if (r.outcome === "would_import") result.wouldImport++;
      else {
        result.failed++;
        const code = r.error_code ?? "import_failed";
        result.byCode[code] = (result.byCode[code] ?? 0) + 1;
      }
    }
    after = rows[rows.length - 1].first_row;
    if (rows.length < CHUNK_GROUPS) {
      result.complete = true;
      break;
    }
  }
  const summary = { ...((batch.summary ?? {}) as StoredSummary), dryRun: result };
  const { error } = await createAdminClient().from("lab_import_batches").update({ summary: summary as unknown as Json }).eq("id", batch.id).eq("status", "analysed");
  if (error) throw loadFailed("store dry run", error);
  await audit(staff, "lab_import_dry_run", batch.id, { checked: result.checked, would_import: result.wouldImport, failed: result.failed, by_code: result.byCode });
  return result;
}

export type RunReport = { imported: number; duplicate: number; failed: number; byCode: Record<string, number>; remaining: number; status: BatchRow["status"] };

async function runUntilDone(staff: ClinicStaff, batchId: string): Promise<RunReport> {
  const deadline = Date.now() + RUN_BUDGET_MS;
  const report = { imported: 0, duplicate: 0, failed: 0, byCode: {} as Record<string, number> };
  while (Date.now() < deadline) {
    const rows = await runChunk(staff, batchId, false, 0);
    for (const r of rows) {
      if (r.outcome === "imported") report.imported++;
      else {
        if (r.outcome === "duplicate") report.duplicate++;
        else report.failed++;
        const code = r.error_code ?? "import_failed";
        report.byCode[code] = (report.byCode[code] ?? 0) + 1;
      }
    }
    // A short chunk was the last one (the database completes the batch when nothing is left).
    if (rows.length < CHUNK_GROUPS) break;
  }
  const after = await loadBatch(staff, batchId);
  const live = summarise(await rowStatuses(batchId));
  await audit(staff, "lab_import_run", batchId, { imported: report.imported, duplicate: report.duplicate, failed: report.failed, by_code: report.byCode });
  return { ...report, remaining: live.readyResults, status: after.status };
}

/** A second lab staff member confirms the analysed import, which then runs. */
export async function confirmImport(staff: ClinicStaff, batchId: string): Promise<RunReport> {
  const batch = await loadBatch(staff, batchId);
  if (batch.created_by === staff.profileId) {
    throw new ApiError(409, "Importni tayyorlagan xodim uni tasdiqlay olmaydi — ikkinchi xodim kerak", "second_person_required");
  }
  if (batch.status !== "analysed") throw new ApiError(409, "Import tasdiqlash uchun tayyor emas", "import_state_changed");
  if (!batch.analysed_at || Date.now() - Date.parse(batch.analysed_at) >= ANALYSIS_VALID_MS) {
    throw new ApiError(409, "Tahlil 24 soatdan eski — tayyorlovchi faylni qayta tahlil qilsin", "analysis_stale");
  }
  if (summarise(await rowStatuses(batch.id)).readyResults === 0) throw new ApiError(409, "Import uchun tayyor natija yo‘q", "nothing_to_import");

  const { data, error } = await createAdminClient()
    .from("lab_import_batches")
    .update({ status: "confirmed", confirmed_by: staff.profileId, confirmed_at: new Date().toISOString() })
    .eq("id", batch.id)
    .eq("clinic_id", staff.clinicId)
    .eq("status", "analysed")
    .eq("analysed_at", batch.analysed_at)
    .select("id");
  if (error) throw loadFailed("confirm", error);
  if (!data?.length) throw new ApiError(409, "Import holati o‘zgargan — sahifani yangilang", "import_state_changed");
  await audit(staff, "lab_import_confirmed", batch.id, { prepared_by: batch.created_by }, true);
  return runUntilDone(staff, batch.id);
}

/** Continues a confirmed import (time budget reached), or retries its failed results. */
export async function continueImport(staff: ClinicStaff, batchId: string, retryFailed: boolean): Promise<RunReport> {
  const batch = await loadBatch(staff, batchId);
  if (batch.created_by === staff.profileId) {
    throw new ApiError(409, "Importni tayyorlagan xodim uni bajara olmaydi — ikkinchi xodim kerak", "second_person_required");
  }
  if (batch.status !== "confirmed") throw new ApiError(409, "Import tasdiqlanmagan yoki yopilgan", "import_state_changed");
  if (retryFailed) {
    const { error } = await createAdminClient().from("lab_import_rows").update({ status: "ready", errors: [] }).eq("batch_id", batch.id).eq("status", "failed");
    if (error) throw loadFailed("retry", error);
  }
  return runUntilDone(staff, batch.id);
}

async function skipRemaining(batchId: string) {
  const { error } = await createAdminClient().from("lab_import_rows").update({ status: "skipped" }).eq("batch_id", batchId).in("status", ["ready", "failed", "pending"]);
  if (error) throw loadFailed("skip rows", error);
}

/** Closes a confirmed import; what was not imported stays out (skipped). */
export async function finishImport(staff: ClinicStaff, batchId: string) {
  const batch = await loadBatch(staff, batchId);
  if (batch.status !== "confirmed") throw new ApiError(409, "Faqat tasdiqlangan import yopiladi", "import_state_changed");
  const { data, error } = await createAdminClient()
    .from("lab_import_batches")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", batch.id)
    .eq("status", "confirmed")
    .select("id");
  if (error) throw loadFailed("finish", error);
  if (!data?.length) throw new ApiError(409, "Import holati o‘zgargan — sahifani yangilang", "import_state_changed");
  await skipRemaining(batch.id);
  await audit(staff, "lab_import_finished", batch.id, {});
  return { status: "completed" as const };
}

/** Cancels an import. Results already imported stay (they are verified records); nothing more is imported. */
export async function cancelImport(staff: ClinicStaff, batchId: string) {
  const batch = await loadBatch(staff, batchId);
  if (!["uploaded", "analysed", "confirmed"].includes(batch.status)) throw new ApiError(409, "Import allaqachon yopilgan", "import_state_changed");
  const { data, error } = await createAdminClient()
    .from("lab_import_batches")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString(), cancelled_by: staff.profileId })
    .eq("id", batch.id)
    .eq("status", batch.status)
    .select("id");
  if (error) throw loadFailed("cancel", error);
  if (!data?.length) throw new ApiError(409, "Import holati o‘zgargan — sahifani yangilang", "import_state_changed");
  await skipRemaining(batch.id);
  await audit(staff, "lab_import_cancelled", batch.id, { previous_status: batch.status });
  return { status: "cancelled" as const };
}

// ---------------------------------------------------------------------------
// Rows (preview) and report
// ---------------------------------------------------------------------------

export const ROW_FILTERS = ["all", "ready", "problems", "possible_match", "imported"] as const;
export type RowFilter = (typeof ROW_FILTERS)[number];

const PROBLEM_STATUSES = ["invalid", "unmatched", "conflict", "duplicate", "failed", "skipped"] as const;

export async function listImportRows(staff: ClinicStaff, batchId: string, filter: RowFilter, offset: number) {
  const batch = await loadBatch(staff, batchId);
  const db = createAdminClient();
  let q = db
    .from("lab_import_rows")
    .select(
      "row_number, status, errors, patient_key, patient_id, match_kind, candidate_patient_ids, value_numeric, value_text, value_boolean, performed_at, accession, lab_result_id, " +
        "lab_tests!lab_import_rows_test_fkey(name), lab_test_parameters!lab_import_rows_parameter_fkey(name, unit)",
      { count: "exact" },
    )
    .eq("batch_id", batch.id)
    .eq("clinic_id", staff.clinicId)
    .order("row_number")
    .range(offset, offset + ROWS_PAGE - 1);
  if (filter === "problems") q = q.in("status", [...PROBLEM_STATUSES]);
  else if (filter !== "all") q = q.eq("status", filter);
  const { data, error, count } = await q;
  if (error) throw loadFailed("rows page", error);
  type Row = {
    row_number: number;
    status: string;
    errors: string[];
    patient_key: string | null;
    patient_id: string | null;
    match_kind: string | null;
    candidate_patient_ids: string[];
    value_numeric: number | string | null;
    value_text: string | null;
    value_boolean: boolean | null;
    performed_at: string | null;
    accession: string | null;
    lab_result_id: string | null;
    lab_tests: { name: string } | null;
    lab_test_parameters: { name: string; unit: string | null } | null;
  };
  const rows = (data ?? []) as unknown as Row[];

  const patientIds = [...new Set(rows.flatMap((r) => [r.patient_id, ...r.candidate_patient_ids]).filter((v): v is string => Boolean(v)))];
  // Name, age and phone of the matched/suggested patients — never their date of birth or documents (owner decision 2026-10-08).
  const patients = new Map<string, { name: string | null; age: number | null; phone: string | null }>();
  for (const part of chunks(patientIds)) {
    const { data: ps, error: pe } = await db.from("patients").select("id, full_name, date_of_birth, phone").eq("clinic_id", staff.clinicId).in("id", part);
    if (pe) throw loadFailed("row patients", pe);
    for (const p of ps ?? []) patients.set(p.id, { name: p.full_name, age: ageInYears(p.date_of_birth, staff.clinicTimezone), phone: p.phone });
  }

  // The page shows result values (not the file's identity cells, which stay server-side): recorded before it is returned.
  await audit(staff, "lab_import_rows_viewed", batch.id, { filter, offset, rows: rows.length }, true);

  return {
    total: count ?? rows.length,
    offset,
    pageSize: ROWS_PAGE,
    headers: batch.headers as string[],
    rows: rows.map((r) => ({
      rowNumber: r.row_number,
      status: r.status,
      errors: r.errors,
      patientKey: r.patient_key,
      patient: r.patient_id ? { id: r.patient_id, ...(patients.get(r.patient_id) ?? { name: null, age: null, phone: null }) } : null,
      matchKind: r.match_kind,
      candidates: r.candidate_patient_ids.map((id) => ({ id, ...(patients.get(id) ?? { name: null, age: null, phone: null }) })),
      test: r.lab_tests?.name ?? null,
      parameter: r.lab_test_parameters?.name ?? null,
      unit: r.lab_test_parameters?.unit ?? null,
      value: r.value_numeric !== null ? String(r.value_numeric) : r.value_boolean !== null ? (r.value_boolean ? "Ha" : "Yo‘q") : r.value_text,
      performedAt: r.performed_at,
      accession: r.accession,
      imported: r.lab_result_id !== null,
    })),
  };
}

/** Per-row outcome as CSV: row number, status and reasons — no cells, values or identifiers. */
export async function importReportCsv(staff: ClinicStaff, batchId: string): Promise<{ fileName: string; csv: string }> {
  const batch = await loadBatch(staff, batchId);
  const { data, error } = await createAdminClient()
    .from("lab_import_rows")
    .select("row_number, status, errors")
    .eq("batch_id", batch.id)
    .order("row_number")
    .limit(5000);
  if (error) throw loadFailed("report", error);
  const lines = [["Qator", "Holat", "Sabab"].map(csvField).join(";")];
  for (const r of data ?? []) {
    const reasons = (r.errors ?? []).map((e: string) => IMPORT_ERROR_LABELS[e as keyof typeof IMPORT_ERROR_LABELS] ?? e).join("; ");
    lines.push([String(r.row_number), IMPORT_STATUS_LABELS[r.status as keyof typeof IMPORT_STATUS_LABELS] ?? r.status, reasons].map(csvField).join(";"));
  }
  await audit(staff, "lab_import_report_downloaded", batch.id, { rows: data?.length ?? 0 });
  return { fileName: `import-hisobot-${batch.id.slice(0, 8)}.csv`, csv: "﻿" + lines.join("\r\n") + "\r\n" };
}

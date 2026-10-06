import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { resolveLabResultAccess, type ClinicStaff, type LabResultAccess } from "@/lib/labs/guards";
import { labCan } from "@/lib/labs/permissions";
import { getLabSettings, type LabSettings } from "@/lib/labs/settings";
import { parseParameterValue, type DbValueEntry, type LabValueType } from "@/lib/labs/values";

/**
 * Structured result entry (Phase 8), verification and corrections (Phase 9).
 *
 * Who: holders of result.enter (lab staff; doctors only for patients
 * doctor_patient_access() admits — resolveLabResultAccess). Everyone else,
 * and anyone of another clinic, gets "not found".
 *
 * Reads of a result's values are audited strictly before anything is
 * returned. Writes go through save_lab_result_draft / submit_lab_result /
 * discard_lab_result_draft, which lock, validate and audit in one
 * transaction. Flags only place a value against the clinic's configured
 * range — nothing here (or in the database) interprets a value clinically.
 */

const NOT_FOUND = () => new ApiError(404, "Tahlil topilmadi", "not_found");

function loadFailed(what: string, error: { code?: string }) {
  logger.error(`lab results: ${what} failed`, { code: error.code });
  return new ApiError(500, "Laboratoriya ma’lumotlarini yuklab bo‘lmadi", "load_failed");
}

const ENTRY_ERRORS: Array<[RegExp, number, string, string]> = [
  [/lab_result_unknown_item/, 404, "Tahlil topilmadi", "not_found"],
  [/lab_result_not_found/, 404, "Natija topilmadi", "result_not_found"],
  [/lab_result_imported/, 409, "Import qilingan buyurtma natijalari import orqali kiritiladi", "imported_order"],
  [/lab_result_submitted/, 409, "Natija tekshiruvga yuborilgan — uni o‘zgartirib bo‘lmaydi", "result_submitted"],
  [/lab_result_verified/, 409, "Natija tasdiqlangan — o‘zgartirish faqat tuzatish orqali", "result_verified"],
  [/lab_result_draft_owned/, 409, "Bu natijani boshqa xodim kiritmoqda", "draft_owned"],
  [/lab_result_item_not_ready/, 409, "Namuna hali laboratoriyaga qabul qilinmagan", "sample_not_received"],
  [/lab_result_incomplete/, 422, "Barcha ko‘rsatkichlar to‘ldirilmagan", "result_incomplete"],
  [/lab_result_has_documents/, 409, "Qoralamaga hujjat biriktirilgan — uni o‘chirib bo‘lmaydi; natijani to‘ldirib yuboring", "draft_has_documents"],
  [/lab_result_not_submitted/, 409, "Natija tekshiruvda emas (allaqachon tasdiqlangan yoki qaytarilgan) — sahifani yangilang", "not_awaiting_review"],
  [/lab_result_second_person/, 409, "Natijani kiritgan yoki yuborgan xodim uni tasdiqlay olmaydi", "second_person_required"],
  [/lab_result_reason_required/, 400, "Tuzatish sababini yozing", "reason_required"],
  [/lab_result_correction_exists/, 409, "Bu natijaning tuzatishi allaqachon boshlangan", "correction_exists"],
  [/lab_result_not_current/, 409, "Faqat joriy tasdiqlangan natija tuzatiladi", "not_current"],
  [/lab_result_bad_values|expects a|configured choices|decimal places|is inactive|invalid input syntax/, 400, "Qiymat ko‘rsatkich sozlamalariga mos kelmaydi", "invalid_value"],
];

function entryError(error: { message?: string; code?: string }, what: string): ApiError {
  const known = ENTRY_ERRORS.find(([pattern]) => pattern.test(error.message ?? ""));
  if (known) return new ApiError(known[1], known[2], known[3]);
  logger.error(`lab results: ${what} failed`, { code: error.code });
  return new ApiError(500, "Natijani saqlab bo‘lmadi", "save_failed");
}

/** The item in the staff member's clinic, if they may work on its patient's results. */
async function authorizedItem(staff: ClinicStaff, itemId: string) {
  const { data: item, error } = await createAdminClient()
    .from("lab_order_items")
    .select("id, order_id, patient_id, test_id, status, test_name_snapshot, test_code_snapshot, created_at")
    .eq("id", itemId)
    .eq("clinic_id", staff.clinicId)
    .maybeSingle();
  if (error) throw loadFailed("item", error);
  if (!item) throw NOT_FOUND();
  const access = await resolveLabResultAccess(staff, item.patient_id);
  if (access.kind === "none") throw NOT_FOUND();
  return { ...item, access };
}

async function authorizedResult(staff: ClinicStaff, resultId: string) {
  const { data: result, error } = await createAdminClient()
    .from("lab_results")
    .select("id, patient_id, order_item_id, status, entered_by, submitted_by")
    .eq("id", resultId)
    .eq("clinic_id", staff.clinicId)
    .maybeSingle();
  if (error) throw loadFailed("result", error);
  if (!result) throw new ApiError(404, "Natija topilmadi", "result_not_found");
  const access = await resolveLabResultAccess(staff, result.patient_id);
  if (access.kind === "none") throw new ApiError(404, "Natija topilmadi", "result_not_found");
  return { ...result, access };
}

/** Whether this staff member may verify results at all, by role and the clinic's verifier setting. */
function mayVerify(staff: ClinicStaff, access: LabResultAccess, settings: LabSettings): boolean {
  if (!labCan(staff.roles, "result.verify")) return false;
  if (access.kind === "lab") return settings.verifiers !== "doctor_only";
  if (access.kind === "doctor") return settings.verifiers !== "lab_only";
  return false;
}

// ---------------------------------------------------------------------------
// Read for entry
// ---------------------------------------------------------------------------

export type EntryRange = { low: number | null; high: number | null; text: string | null; criticalLow: number | null; criticalHigh: number | null };

export type EntryParameter = {
  id: string;
  code: string;
  name: string;
  valueType: LabValueType;
  unit: string | null;
  decimals: number | null;
  choices: string[] | null;
  active: boolean;
  /** The stored value's frozen range if there is a value, else the range a value would use now. */
  range: EntryRange | null;
  value: { numeric: string | null; text: string | null; boolean: boolean | null; flag: string } | null;
};

export type ResultEntry = {
  item: { id: string; orderId: string; testName: string; testCode: string; status: string; orderedAt: string };
  patient: { fullName: string | null; dateOfBirth: string | null; sex: string | null };
  /** The version being worked on (draft / submitted) or else the current verified one. */
  result: (VersionMeta & { mine: boolean; labComment: string | null }) | null;
  parameters: EntryParameter[];
  /** Every other version of this test's result, newest first (preserved, read-only). */
  versions: Array<VersionMeta & { values: Array<{ parameter: string; value: string; unit: string | null; flag: string }> }>;
  /** What this staff member may do now (the server checks again on every action). */
  can: { verify: boolean; giveBack: boolean; correct: boolean };
};

export type VersionMeta = {
  id: string;
  status: string;
  version: number;
  enteredByName: string | null;
  enteredAt: string;
  submittedByName: string | null;
  submittedAt: string | null;
  verifiedByName: string | null;
  verifiedAt: string | null;
  correctionReason: string | null;
};

const num = (v: number | string | null) => (v === null ? null : Number(v));

export async function getResultEntry(staff: ClinicStaff, itemId: string): Promise<ResultEntry> {
  const item = await authorizedItem(staff, itemId);
  const db = createAdminClient();
  const [patient, params, results, ranges, settings] = await Promise.all([
    db.from("patients").select("full_name, date_of_birth, sex").eq("id", item.patient_id).eq("clinic_id", staff.clinicId).single(),
    db
      .from("lab_test_parameters")
      .select("id, code, name, value_type, unit, decimals, choices, active, sort_order")
      .eq("test_id", item.test_id)
      .eq("clinic_id", staff.clinicId)
      .order("sort_order")
      .order("name"),
    db
      .from("lab_results")
      .select(
        "id, status, version, entered_by, entered_at, submitted_by, submitted_at, verified_by, verified_at, lab_comment, correction_reason, " +
          "entered:profiles!lab_results_entered_by_fkey(full_name), submitted:profiles!lab_results_submitted_by_fkey(full_name), " +
          "verified:profiles!lab_results_verified_by_fkey(full_name), " +
          "lab_result_values(parameter_id, value_numeric, value_text, value_boolean, unit_snapshot, flag, range_low, range_high, range_text, critical_low, critical_high)",
      )
      .eq("order_item_id", item.id)
      .eq("clinic_id", staff.clinicId)
      .order("version", { ascending: false }),
    db.rpc("lab_entry_ranges", { p_clinic_id: staff.clinicId, p_order_item_id: item.id }),
    getLabSettings(staff.clinicId),
  ]);
  if (patient.error) throw loadFailed("patient", patient.error);
  if (params.error) throw loadFailed("parameters", params.error);
  if (results.error) throw loadFailed("result", results.error);
  if (ranges.error) throw loadFailed("ranges", ranges.error);

  type ValueRow = {
    parameter_id: string;
    value_numeric: number | string | null;
    value_text: string | null;
    value_boolean: boolean | null;
    unit_snapshot: string | null;
    flag: string;
    range_low: number | string | null;
    range_high: number | string | null;
    range_text: string | null;
    critical_low: number | string | null;
    critical_high: number | string | null;
  };
  type ResultRow = {
    id: string;
    status: string;
    version: number;
    entered_by: string;
    entered_at: string;
    submitted_by: string | null;
    submitted_at: string | null;
    verified_by: string | null;
    verified_at: string | null;
    lab_comment: string | null;
    correction_reason: string | null;
    entered: { full_name: string | null } | null;
    submitted: { full_name: string | null } | null;
    verified: { full_name: string | null } | null;
    lab_result_values: ValueRow[];
  };
  const rows = (results.data ?? []) as unknown as ResultRow[];
  const current =
    rows.find((r) => r.status === "draft" || r.status === "submitted") ?? rows.find((r) => r.status === "verified") ?? null;

  // A read of result values is audited before it is returned (strict).
  if (current) {
    await recordAudit({
      clinicId: staff.clinicId,
      action: "lab_result_viewed",
      entityType: "lab_results",
      entityId: current.id,
      patientId: item.patient_id,
      actor: { actorId: staff.profileId, actorType: "staff" },
      metadata: { order_item_id: item.id, version: current.version, versions: rows.map((r) => r.version), via: "result_entry" },
      strict: true,
    });
  }

  const meta = (r: ResultRow): VersionMeta => ({
    id: r.id,
    status: r.status,
    version: r.version,
    enteredByName: r.entered?.full_name ?? null,
    enteredAt: r.entered_at,
    submittedByName: r.submitted?.full_name ?? null,
    submittedAt: r.submitted_at,
    verifiedByName: r.verified?.full_name ?? null,
    verifiedAt: r.verified_at,
    correctionReason: r.correction_reason,
  });

  const paramRows = params.data ?? [];
  const valueOf = new Map((current?.lab_result_values ?? []).map((v) => [v.parameter_id, v]));
  const previewOf = new Map((ranges.data ?? []).map((x) => [x.parameter_id, x]));
  const parameters: EntryParameter[] = paramRows
    .filter((p) => p.active || valueOf.has(p.id))
    .map((p) => {
      const v = valueOf.get(p.id);
      const preview = previewOf.get(p.id);
      const source = v
        ? { low: v.range_low, high: v.range_high, text: v.range_text, cl: v.critical_low, ch: v.critical_high }
        : preview
          ? { low: preview.range_low, high: preview.range_high, text: preview.range_text, cl: preview.critical_low, ch: preview.critical_high }
          : null;
      const hasRange = source && (source.low !== null || source.high !== null || source.text !== null);
      return {
        id: p.id,
        code: p.code,
        name: p.name,
        valueType: p.value_type as LabValueType,
        unit: p.unit,
        decimals: p.decimals,
        choices: p.choices,
        active: p.active,
        range: hasRange
          ? { low: num(source.low), high: num(source.high), text: source.text, criticalLow: num(source.cl), criticalHigh: num(source.ch) }
          : null,
        value: v
          ? { numeric: v.value_numeric === null ? null : String(v.value_numeric), text: v.value_text, boolean: v.value_boolean, flag: v.flag }
          : null,
      };
    });

  const nameOf = new Map(paramRows.map((p) => [p.id, { name: p.name, order: p.sort_order }]));
  const display = (v: ValueRow) =>
    v.value_numeric !== null ? String(v.value_numeric) : v.value_boolean !== null ? (v.value_boolean ? "Ha" : "Yo‘q") : (v.value_text ?? "—");
  const versions = rows
    .filter((r) => r !== current)
    .map((r) => ({
      ...meta(r),
      values: [...r.lab_result_values]
        .sort((a, b) => (nameOf.get(a.parameter_id)?.order ?? 0) - (nameOf.get(b.parameter_id)?.order ?? 0))
        .map((v) => ({ parameter: nameOf.get(v.parameter_id)?.name ?? "—", value: display(v), unit: v.unit_snapshot, flag: v.flag })),
    }));

  const inProgress = rows.some((r) => r.status === "draft" || r.status === "submitted");
  const verifier = mayVerify(staff, item.access, settings);
  const submitted = current?.status === "submitted";
  const can = {
    verify: Boolean(submitted && verifier && current!.entered_by !== staff.profileId && current!.submitted_by !== staff.profileId),
    giveBack: Boolean(submitted && (verifier || current!.entered_by === staff.profileId)),
    correct: Boolean(current?.status === "verified" && !inProgress && (item.access.kind === "lab" || current.entered_by === staff.profileId)),
  };

  return {
    item: { id: item.id, orderId: item.order_id, testName: item.test_name_snapshot, testCode: item.test_code_snapshot, status: item.status, orderedAt: item.created_at },
    patient: { fullName: patient.data.full_name, dateOfBirth: patient.data.date_of_birth, sex: patient.data.sex },
    result: current ? { ...meta(current), mine: current.entered_by === staff.profileId, labComment: current.lab_comment } : null,
    parameters,
    versions,
    can,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export type SaveDraftInput = {
  values: Array<{ parameterId: string; value: string | boolean | null }>;
  labComment: string | null;
};

export async function saveResultDraft(staff: ClinicStaff, itemId: string, input: SaveDraftInput): Promise<{ resultId: string; created: boolean }> {
  const item = await authorizedItem(staff, itemId);
  const { data: params, error } = await createAdminClient()
    .from("lab_test_parameters")
    .select("id, code, value_type, decimals, choices")
    .eq("test_id", item.test_id)
    .eq("clinic_id", staff.clinicId);
  if (error) throw loadFailed("parameters", error);
  const specOf = new Map((params ?? []).map((p) => [p.id, p]));

  const entries: DbValueEntry[] = [];
  for (const v of input.values) {
    const spec = specOf.get(v.parameterId);
    if (!spec) throw new ApiError(400, "Ko‘rsatkich bu tahlilga tegishli emas", "invalid_value");
    const parsed = parseParameterValue(v.parameterId, { code: spec.code, valueType: spec.value_type as LabValueType, decimals: spec.decimals, choices: spec.choices }, v.value);
    if (!parsed.ok) throw new ApiError(400, `${spec.code}: ${parsed.message}`, "invalid_value");
    entries.push(parsed.entry);
  }

  const { data, error: rpcError } = await createAdminClient().rpc("save_lab_result_draft", {
    p_clinic_id: staff.clinicId,
    p_order_item_id: item.id,
    p_entered_by: staff.profileId,
    p_values: entries,
    p_lab_comment: input.labComment ?? undefined,
  });
  if (rpcError) throw entryError(rpcError, "save");
  const row = (data as Array<{ lab_result_id: string; created: boolean }> | null)?.[0];
  if (!row) throw new ApiError(500, "Natijani saqlab bo‘lmadi", "save_failed");
  return { resultId: row.lab_result_id, created: row.created };
}

export async function submitResult(staff: ClinicStaff, resultId: string): Promise<{ changed: boolean }> {
  await authorizedResult(staff, resultId);
  const { data, error } = await createAdminClient().rpc("submit_lab_result", {
    p_clinic_id: staff.clinicId,
    p_result_id: resultId,
    p_submitted_by: staff.profileId,
  });
  if (error) throw entryError(error, "submit");
  return { changed: data === true };
}

export async function discardDraft(staff: ClinicStaff, resultId: string): Promise<{ changed: boolean }> {
  await authorizedResult(staff, resultId);
  const { data, error } = await createAdminClient().rpc("discard_lab_result_draft", {
    p_clinic_id: staff.clinicId,
    p_result_id: resultId,
    p_by: staff.profileId,
  });
  if (error) throw entryError(error, "discard");
  return { changed: data === true };
}

// ---------------------------------------------------------------------------
// Verification and corrections (Phase 9)
// ---------------------------------------------------------------------------

const NOT_ALLOWED = () => new ApiError(403, "Bu natijani tasdiqlash huquqingiz yo‘q", "verifier_not_allowed");

/** A second person verifies a submitted result (role, clinic setting and patient access checked first). */
export async function verifyResult(staff: ClinicStaff, resultId: string): Promise<{ changed: boolean }> {
  const result = await authorizedResult(staff, resultId);
  if (!mayVerify(staff, result.access, await getLabSettings(staff.clinicId))) throw NOT_ALLOWED();
  const { data, error } = await createAdminClient().rpc("verify_lab_result", {
    p_clinic_id: staff.clinicId,
    p_result_id: resultId,
    p_verified_by: staff.profileId,
  });
  if (error) throw entryError(error, "verify");
  return { changed: data === true };
}

/** A reviewer (or the author) sends a submitted result back to its author as a draft. */
export async function returnResult(staff: ClinicStaff, resultId: string): Promise<{ changed: boolean }> {
  const result = await authorizedResult(staff, resultId);
  const author = result.entered_by === staff.profileId;
  if (!author && !mayVerify(staff, result.access, await getLabSettings(staff.clinicId))) throw NOT_ALLOWED();
  const { data, error } = await createAdminClient().rpc("return_lab_result", {
    p_clinic_id: staff.clinicId,
    p_result_id: resultId,
    p_by: staff.profileId,
  });
  if (error) throw entryError(error, "return");
  return { changed: data === true };
}

/**
 * Starts a correction of the current verified result: a new version that
 * supersedes it once verified. Lab staff may correct; a doctor only a result
 * they entered themselves — reading another person's result never lets a
 * doctor change it.
 */
export async function startCorrection(staff: ClinicStaff, resultId: string, reason: string): Promise<{ resultId: string; created: boolean }> {
  const result = await authorizedResult(staff, resultId);
  if (result.access.kind !== "lab" && result.entered_by !== staff.profileId) {
    throw new ApiError(403, "Bu natijani faqat laboratoriya yoki uni kiritgan xodim tuzatadi", "correction_not_allowed");
  }
  const { data, error } = await createAdminClient().rpc("start_lab_result_correction", {
    p_clinic_id: staff.clinicId,
    p_result_id: resultId,
    p_by: staff.profileId,
    p_reason: reason,
  });
  if (error) throw entryError(error, "correction");
  const row = (data as Array<{ lab_result_id: string; created: boolean }> | null)?.[0];
  if (!row) throw new ApiError(500, "Tuzatishni boshlab bo‘lmadi", "save_failed");
  return { resultId: row.lab_result_id, created: row.created };
}

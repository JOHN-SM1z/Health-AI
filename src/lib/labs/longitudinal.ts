import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import type { LinkedDoctor } from "@/lib/auth/guards";
import { assertPatientAccess } from "@/lib/labs/ordering";
import { logger } from "@/lib/logger";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Finalised laboratory results as part of the patient's longitudinal clinic record (phase 7).
 *
 * No second history and no second access model: a doctor reaches these results through the SAME clinical access decision as every
 * other part of the patient's history (`doctor_patient_access()` via `canDoctorAccessPatientClinicalData()`, called by
 * `assertPatientAccess`) - a same-clinic doctor without a legitimate relationship gets the same 404/410 and audited refusal, and
 * nothing crosses clinics. With the relationship the doctor reads every doctor's finalised results, as they read every doctor's
 * records, and changes none of them: this module has no write path, and the laboratory routes admit laboratory staff only.
 *
 * WHAT is visible: a result that has a VERIFIED version (and the earlier verified versions it superseded). Never a draft, a submitted
 * but unverified result, an abandoned draft, a correction under preparation, or the existence of any of them - the doctor sees the
 * finalised result as it stands until the correction is verified. Values carry the database's flag ("outside the configured
 * reference range") and nothing else: no interpretation, no diagnosis.
 */

type Flag = Database["public"]["Enums"]["lab_flag"];
const OUTSIDE: Flag[] = ["low", "high", "critical_low", "critical_high"];

export type LabResultSummary = {
  itemId: string;
  orderId: string;
  testCode: string;
  testName: string;
  orderedAt: string;
  orderedBy: string | null;
  /** The ordering doctor is the caller. Seeing a colleague's result never makes it the caller's. */
  isOwnOrder: boolean;
  collectedAt: string | null;
  /** When the standing version was verified: the date of the result. */
  resultAt: string;
  verifiedBy: string | null;
  /** The number of the standing version; above 1 means the result was corrected. */
  version: number;
  versionCount: number;
  valueCount: number;
  /** How many values lie outside their configured reference range (a comparison, not a finding). */
  outsideCount: number;
  documentCount: number;
};

export type LabValueView = {
  code: string;
  name: string;
  unit: string | null;
  value: string | number;
  comparator: string | null;
  flag: Flag;
  refLow: number | null;
  refHigh: number | null;
  criticalLow: number | null;
  criticalHigh: number | null;
};

export type LabVersionView = {
  version: number;
  status: "verified" | "superseded";
  enteredBy: string | null;
  enteredAt: string;
  verifiedBy: string | null;
  verifiedAt: string;
  correctsVersion: number | null;
  correctionReason: string | null;
  values: LabValueView[];
};

export type LabDocumentView = { id: string; kind: string; contentType: string; sizeBytes: number; addedAt: string };

export type LabResultDetail = LabResultSummary & {
  current: LabVersionView;
  /** Earlier finalised versions of the same result, newest first. */
  previous: LabVersionView[];
  documents: LabDocumentView[];
};

type VersionRow = Database["public"]["Tables"]["lab_result_versions"]["Row"];
type ValueRow = Database["public"]["Tables"]["lab_result_values"]["Row"];
type AttachmentRow = Pick<Database["public"]["Tables"]["lab_result_attachments"]["Row"], "id" | "kind" | "content_type" | "size_bytes" | "created_at">;

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

type ResultRow = {
  id: string;
  order_item_id: string;
  order_id: string;
  lab_order_items: { id: string; test_code: string; test_name: string; lab_sample_items: Array<{ lab_samples: { status: string; collected_at: string | null } | null }> } | null;
  lab_orders: { created_at: string; ordering_doctor_id: string; doctors: { name: string } | null } | null;
  lab_result_versions: VersionRow[];
  lab_result_attachments: AttachmentRow[];
};

const SELECT =
  "id, order_item_id, order_id, lab_order_items!lab_results_item_fkey(id, test_code, test_name, lab_sample_items(lab_samples(status, collected_at))), lab_orders!lab_results_order_fkey(created_at, ordering_doctor_id, doctors(name)), lab_result_versions(*), lab_result_attachments(id, kind, content_type, size_bytes, created_at)";

async function nameMap(ids: string[]): Promise<Map<string, string | null>> {
  const names = new Map<string, string | null>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return names;
  const { data } = await createAdminClient().from("profiles").select("id, full_name").in("id", unique);
  for (const p of data ?? []) names.set(p.id, p.full_name);
  return names;
}

/** The documents that were part of the finalised result: added before the standing version was verified. */
function visibleDocuments(row: ResultRow, verifiedAt: string): AttachmentRow[] {
  return row.lab_result_attachments.filter((a) => a.created_at <= verifiedAt).sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function summarise(doctorId: string, row: ResultRow, standing: VersionRow, valueRows: ValueRow[], names: Map<string, string | null>): LabResultSummary {
  const collected = (row.lab_order_items?.lab_sample_items ?? [])
    .map((s) => s.lab_samples)
    .filter((s): s is { status: string; collected_at: string | null } => !!s && !!s.collected_at && s.status !== "cancelled" && s.status !== "rejected")
    .map((s) => s.collected_at as string)
    .sort();
  const finalised = row.lab_result_versions.filter((v) => v.status === "verified" || v.status === "superseded");
  const mine = valueRows.filter((v) => v.version_id === standing.id);
  return {
    itemId: row.order_item_id,
    orderId: row.order_id,
    testCode: row.lab_order_items?.test_code ?? "",
    testName: row.lab_order_items?.test_name ?? "",
    orderedAt: row.lab_orders?.created_at ?? "",
    orderedBy: row.lab_orders?.doctors?.name ?? null,
    isOwnOrder: row.lab_orders?.ordering_doctor_id === doctorId,
    collectedAt: collected.at(-1) ?? null,
    resultAt: standing.verified_at as string,
    verifiedBy: standing.verified_by ? names.get(standing.verified_by) ?? null : null,
    version: standing.version,
    versionCount: finalised.length,
    valueCount: mine.length,
    outsideCount: mine.filter((v) => OUTSIDE.includes(v.flag)).length,
    documentCount: visibleDocuments(row, standing.verified_at as string).length,
  };
}

async function loadRows(clinicId: string, patientId: string, itemId?: string): Promise<{ rows: ResultRow[]; values: ValueRow[]; names: Map<string, string | null> }> {
  const db = createAdminClient();
  let query = db.from("lab_results").select(SELECT).eq("clinic_id", clinicId).eq("patient_id", patientId);
  if (itemId) query = query.eq("order_item_id", itemId);
  const { data, error } = await query.limit(500);
  if (error) {
    logger.error("lab results read failed", { code: error.code });
    throw new ApiError(500, "Tahlil natijalarini yuklab bo‘lmadi");
  }
  // Only results with a verified version are ever part of the record; the rest are not even read further.
  const rows = ((data ?? []) as unknown as ResultRow[]).filter((r) => r.lab_result_versions.some((v) => v.status === "verified"));
  const versionIds = rows.flatMap((r) => r.lab_result_versions.filter((v) => v.status === "verified" || v.status === "superseded").map((v) => v.id));
  let values: ValueRow[] = [];
  if (versionIds.length) {
    const { data: vals } = await db.from("lab_result_values").select("*").eq("clinic_id", clinicId).in("version_id", versionIds);
    values = vals ?? [];
  }
  const names = await nameMap(rows.flatMap((r) => r.lab_result_versions.flatMap((v) => [v.entered_by, v.verified_by].filter((x): x is string => !!x))));
  return { rows, values, names };
}

/** The finalised results of a patient, newest first - read after the caller's access was decided (see the callers). */
export async function loadFinalisedSummaries(doctorId: string, clinicId: string, patientId: string, limit = 100): Promise<LabResultSummary[]> {
  const { rows, values, names } = await loadRows(clinicId, patientId);
  return rows
    .map((r) => summarise(doctorId, r, r.lab_result_versions.find((v) => v.status === "verified") as VersionRow, values, names))
    .sort((a, b) => b.resultAt.localeCompare(a.resultAt))
    .slice(0, limit);
}

/** List route: the access decision, then the finalised results, audited (ids only) before they are returned. */
export async function listFinalisedLabResults(doctor: LinkedDoctor, patientId: string): Promise<LabResultSummary[]> {
  await assertPatientAccess(doctor, patientId);
  const results = await loadFinalisedSummaries(doctor.doctorId, doctor.clinicId, patientId);
  await recordAudit({
    clinicId: doctor.clinicId,
    action: "lab_result_viewed",
    entityType: "patients",
    entityId: patientId,
    patientId,
    actor: { actorId: doctor.profileId, actorType: "staff" },
    metadata: { via: "doctor_list", doctor_id: doctor.doctorId, item_ids: results.map((r) => r.itemId) },
    strict: true,
  });
  return results;
}

/** One finalised result with its values, its earlier finalised versions and its documents. Audited. */
export async function getFinalisedLabResult(doctor: LinkedDoctor, patientId: string, itemId: string): Promise<LabResultDetail> {
  await assertPatientAccess(doctor, patientId);
  const { rows, values, names } = await loadRows(doctor.clinicId, patientId, itemId);
  const row = rows[0];
  if (!row) throw new ApiError(404, "Natija topilmadi", "lab_not_found");
  const standing = row.lab_result_versions.find((v) => v.status === "verified") as VersionRow;
  const byNumber = new Map(row.lab_result_versions.map((v) => [v.id, v.version]));

  const view = (v: VersionRow): LabVersionView => ({
    version: v.version,
    status: v.status as "verified" | "superseded",
    enteredBy: names.get(v.entered_by) ?? null,
    enteredAt: v.entered_at,
    verifiedBy: v.verified_by ? names.get(v.verified_by) ?? null : null,
    verifiedAt: v.verified_at as string,
    correctsVersion: v.corrects_version_id ? byNumber.get(v.corrects_version_id) ?? null : null,
    correctionReason: v.correction_reason,
    values: values
      .filter((x) => x.version_id === v.id)
      .map((x) => ({
        code: x.parameter_code,
        name: x.parameter_name,
        unit: x.unit,
        value: x.value_numeric !== null ? Number(x.value_numeric) : x.value_text ?? "",
        comparator: x.comparator,
        flag: x.flag,
        refLow: num(x.ref_low),
        refHigh: num(x.ref_high),
        criticalLow: num(x.critical_low),
        criticalHigh: num(x.critical_high),
      })),
  });
  const previous = row.lab_result_versions
    .filter((v) => v.status === "superseded")
    .sort((a, b) => b.version - a.version)
    .map(view);
  const documents = visibleDocuments(row, standing.verified_at as string).map((a) => ({
    id: a.id,
    kind: a.kind,
    contentType: a.content_type,
    sizeBytes: Number(a.size_bytes),
    addedAt: a.created_at,
  }));

  await recordAudit({
    clinicId: doctor.clinicId,
    action: "lab_result_viewed",
    entityType: "lab_order_items",
    entityId: itemId,
    patientId,
    actor: { actorId: doctor.profileId, actorType: "staff" },
    metadata: { via: "doctor_detail", doctor_id: doctor.doctorId, result_id: row.id, version: standing.version },
    strict: true,
  });

  return {
    ...summarise(doctor.doctorId, row, standing, values, names),
    current: view(standing),
    previous,
    documents,
  };
}

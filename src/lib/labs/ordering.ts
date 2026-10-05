import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import type { LinkedDoctor } from "@/lib/auth/guards";
import { canDoctorAccessPatientClinicalData } from "@/lib/clinical-access/access";
import { patientAccessDenied } from "@/lib/clinical-access/denial";

/**
 * Doctor laboratory ordering (Phase 5).
 *
 * The doctor works from the patient workspace, so every call first applies
 * the same access decision the workspace uses (doctor_patient_access: own
 * patient or active referral). Clinic, patient, orderer and ordering doctor
 * come from the session and the URL — never from the request body — and the
 * order itself is created by create_lab_order() in one transaction (snapshots,
 * proportional panel prices, idempotent replay).
 *
 * The recent-test warning is information for the doctor only: it never
 * blocks an order and never suggests a test is unnecessary.
 */

/** How far back an earlier order of the same test counts as "recent". */
export const RECENT_TEST_DAYS = 30;

async function requireAccess(doctor: LinkedDoctor, patientId: string) {
  const access = await canDoctorAccessPatientClinicalData(doctor.doctorId, patientId);
  if (access.relationship === "none") throw await patientAccessDenied(doctor, patientId);
  return access;
}

function loadFailed(what: string, error: { code?: string }) {
  logger.error(`lab ordering: ${what} failed`, { code: error.code });
  return new ApiError(500, "Laboratoriya ma’lumotlarini yuklab bo‘lmadi", "load_failed");
}

// ---------------------------------------------------------------------------
// Orderable catalog
// ---------------------------------------------------------------------------

export type OrderableTest = {
  id: string;
  code: string;
  name: string;
  category: string | null;
  sampleType: string;
  preparationText: string | null;
  turnaroundHours: number | null;
  price: number;
};

export type OrderablePanel = { id: string; code: string; name: string; price: number; testIds: string[] };

/** Active tests, and the active panels whose tests are all active. */
export async function getOrderableCatalog(clinicId: string): Promise<{ tests: OrderableTest[]; panels: OrderablePanel[] }> {
  const db = createAdminClient();
  const [tests, panels, members] = await Promise.all([
    db
      .from("lab_tests")
      .select("id, code, name, sample_type, preparation_text, turnaround_hours, price, lab_test_categories(name, active)")
      .eq("clinic_id", clinicId)
      .eq("active", true)
      .order("sort_order")
      .order("name"),
    db.from("lab_panels").select("id, code, name, price").eq("clinic_id", clinicId).eq("active", true).order("sort_order").order("name"),
    db.from("lab_panel_tests").select("panel_id, test_id, sort_order").eq("clinic_id", clinicId).order("sort_order"),
  ]);
  if (tests.error) throw loadFailed("catalog", tests.error);
  if (panels.error) throw loadFailed("catalog", panels.error);
  if (members.error) throw loadFailed("catalog", members.error);

  const orderable: OrderableTest[] = (tests.data ?? []).map((t) => {
    const category = t.lab_test_categories as { name: string; active: boolean } | null;
    return {
      id: t.id,
      code: t.code,
      name: t.name,
      category: category?.name ?? null,
      sampleType: t.sample_type,
      preparationText: t.preparation_text,
      turnaroundHours: t.turnaround_hours,
      price: Number(t.price),
    };
  });
  const active = new Set(orderable.map((t) => t.id));
  const panelList: OrderablePanel[] = (panels.data ?? [])
    .map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      price: Number(p.price),
      testIds: (members.data ?? []).filter((m) => m.panel_id === p.id).map((m) => m.test_id),
    }))
    .filter((p) => p.testIds.length > 0 && p.testIds.every((id) => active.has(id)));
  return { tests: orderable, panels: panelList };
}

// ---------------------------------------------------------------------------
// The patient's lab orders (status only)
// ---------------------------------------------------------------------------

export type LabOrderItemView = {
  id: string;
  testId: string;
  testCode: string;
  testName: string;
  panelName: string | null;
  status: string;
  price: number;
};

export type LabOrderView = {
  id: string;
  createdAt: string;
  status: string;
  source: string;
  orderedByName: string | null;
  orderingDoctorName: string | null;
  mine: boolean;
  items: LabOrderItemView[];
};

export async function getPatientLabOrders(doctor: LinkedDoctor, patientId: string): Promise<LabOrderView[]> {
  await requireAccess(doctor, patientId);
  const { data, error } = await createAdminClient()
    .from("lab_orders")
    .select(
      "id, created_at, status, source, ordered_by, profiles!lab_orders_ordered_by_fkey(full_name), doctors!lab_orders_ordering_doctor_fkey(name), " +
        "lab_order_items(id, test_id, test_code_snapshot, test_name_snapshot, status, price_snapshot, lab_panels(name))",
    )
    .eq("clinic_id", doctor.clinicId)
    .eq("patient_id", patientId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw loadFailed("orders", error);

  type Row = {
    id: string;
    created_at: string;
    status: string;
    source: string;
    ordered_by: string;
    profiles: { full_name: string | null } | null;
    doctors: { name: string } | null;
    lab_order_items: Array<{
      id: string;
      test_id: string;
      test_code_snapshot: string;
      test_name_snapshot: string;
      status: string;
      price_snapshot: number;
      lab_panels: { name: string } | null;
    }>;
  };
  return ((data ?? []) as unknown as Row[]).map((o) => ({
    id: o.id,
    createdAt: o.created_at,
    status: o.status,
    source: o.source,
    orderedByName: o.profiles?.full_name ?? null,
    orderingDoctorName: o.doctors?.name ?? null,
    mine: o.ordered_by === doctor.profileId,
    items: o.lab_order_items.map((i) => ({
      id: i.id,
      testId: i.test_id,
      testCode: i.test_code_snapshot,
      testName: i.test_name_snapshot,
      panelName: i.lab_panels?.name ?? null,
      status: i.status,
      price: Number(i.price_snapshot),
    })),
  }));
}

// ---------------------------------------------------------------------------
// Creating an order
// ---------------------------------------------------------------------------

export type CreateLabOrderInput = {
  appointmentId?: string | null;
  testIds: string[];
  panelIds: string[];
  creationKey: string;
};

export const ORDER_ERRORS: Array<[RegExp, number, string, string]> = [
  [/date of birth/, 422, "Bemorning tug‘ilgan sanasi kiritilmagan — buyurtmadan oldin qabulxona uni to‘ldirishi kerak", "dob_required"],
  [/lab_order_empty/, 400, "Kamida bitta tahlil yoki panel tanlang", "empty_order"],
  [/lab_order_too_large/, 400, "Bitta buyurtmada ko‘pi bilan 50 ta tahlil", "order_too_large"],
  [/lab_order_duplicate_test/, 409, "Bitta tahlil ikki marta tanlangan (alohida va panel ichida yoki ikki panelda)", "duplicate_test"],
  [/lab_order_key_reused/, 409, "Bu so‘rov boshqa ma’lumotlar bilan allaqachon yuborilgan", "idempotency_key_reused"],
  [/inactive/, 409, "Tanlangan tahlil yoki panel endi faol emas — ro‘yxatni yangilang", "inactive_test"],
  [/unknown test|unknown_panel/, 400, "Tahlil yoki panel bu klinikada topilmadi", "unknown_test"],
  [/in progress or completed/, 409, "Buyurtma faqat boshlangan yoki yakunlangan qabulga bog‘lanadi", "consultation_not_started"],
];

export async function createDoctorLabOrder(
  doctor: LinkedDoctor,
  patientId: string,
  input: CreateLabOrderInput,
): Promise<{ orderId: string; replayed: boolean }> {
  await requireAccess(doctor, patientId);
  const db = createAdminClient();

  // The consultation must be this doctor's own with this patient (the
  // database also pins it; this gives a clear answer first).
  if (input.appointmentId) {
    const { data: visit, error } = await db
      .from("appointments")
      .select("id")
      .eq("id", input.appointmentId)
      .eq("clinic_id", doctor.clinicId)
      .eq("patient_id", patientId)
      .eq("doctor_id", doctor.doctorId)
      .maybeSingle();
    if (error) throw loadFailed("consultation", error);
    if (!visit) throw new ApiError(404, "Qabul topilmadi", "consultation_not_found");
  }

  const { data, error } = await db.rpc("create_lab_order", {
    p_clinic_id: doctor.clinicId,
    p_patient_id: patientId,
    p_ordered_by: doctor.profileId,
    p_ordering_doctor_id: doctor.doctorId,
    p_appointment_id: input.appointmentId ?? undefined,
    p_source: input.appointmentId ? "consultation" : "walk_in",
    p_test_ids: input.testIds,
    p_panel_ids: input.panelIds,
    p_creation_key: input.creationKey,
  });
  if (error) {
    const known = ORDER_ERRORS.find(([pattern]) => pattern.test(error.message ?? ""));
    if (known) throw new ApiError(known[1], known[2], known[3]);
    if (error.code === "23503") throw new ApiError(404, "Bemor, qabul yoki tahlil topilmadi", "not_found");
    logger.error("lab ordering: create failed", { code: error.code });
    throw new ApiError(500, "Buyurtmani saqlab bo‘lmadi", "save_failed");
  }
  const row = (data as Array<{ lab_order_id: string; replayed: boolean }> | null)?.[0];
  if (!row) throw new ApiError(500, "Buyurtmani saqlab bo‘lmadi", "save_failed");
  return { orderId: row.lab_order_id, replayed: row.replayed };
}

// ---------------------------------------------------------------------------
// One verified result (the "View result" of the recent-test warning)
// ---------------------------------------------------------------------------

export type LabResultValueView = {
  parameter: string;
  value: string;
  unit: string | null;
  rangeLabel: string | null;
  flag: string;
};

export type LabResultView = {
  itemId: string;
  testName: string;
  orderedAt: string;
  performedAt: string | null;
  verifiedAt: string;
  version: number;
  labComment: string | null;
  values: LabResultValueView[];
};

function rangeLabel(v: { range_low: number | null; range_high: number | null; range_text: string | null }): string | null {
  if (v.range_text) return v.range_text;
  if (v.range_low != null && v.range_high != null) return `${v.range_low}–${v.range_high}`;
  if (v.range_low != null) return `≥ ${v.range_low}`;
  if (v.range_high != null) return `≤ ${v.range_high}`;
  return null;
}

/**
 * The current verified result of one order item of the patient, for a doctor
 * whom doctor_patient_access() admits. The read is audited (strictly) before
 * anything is returned; unverified results are never shown here.
 */
export async function getVerifiedLabResultForDoctor(doctor: LinkedDoctor, patientId: string, itemId: string): Promise<LabResultView> {
  await requireAccess(doctor, patientId);
  const db = createAdminClient();
  const { data: item, error: itemError } = await db
    .from("lab_order_items")
    .select("id, test_name_snapshot, created_at")
    .eq("id", itemId)
    .eq("clinic_id", doctor.clinicId)
    .eq("patient_id", patientId)
    .maybeSingle();
  if (itemError) throw loadFailed("result item", itemError);
  if (!item) throw new ApiError(404, "Natija topilmadi", "result_not_found");

  const { data: result, error } = await db
    .from("lab_results")
    .select(
      "id, version, performed_at, verified_at, lab_comment, " +
        "lab_result_values(value_numeric, value_text, value_boolean, unit_snapshot, range_low, range_high, range_text, flag, lab_test_parameters(name, sort_order))",
    )
    .eq("order_item_id", itemId)
    .eq("clinic_id", doctor.clinicId)
    .eq("status", "verified")
    .maybeSingle();
  if (error) throw loadFailed("result", error);
  if (!result) throw new ApiError(404, "Tasdiqlangan natija hali yo‘q", "result_not_verified");

  type Row = {
    id: string;
    version: number;
    performed_at: string | null;
    verified_at: string;
    lab_comment: string | null;
    lab_result_values: Array<{
      value_numeric: number | null;
      value_text: string | null;
      value_boolean: boolean | null;
      unit_snapshot: string | null;
      range_low: number | null;
      range_high: number | null;
      range_text: string | null;
      flag: string;
      lab_test_parameters: { name: string; sort_order: number } | null;
    }>;
  };
  const r = result as unknown as Row;

  await recordAudit({
    clinicId: doctor.clinicId,
    action: "lab_result_viewed",
    entityType: "lab_results",
    entityId: r.id,
    patientId,
    actor: { actorId: doctor.profileId, actorType: "staff" },
    metadata: { order_item_id: itemId, version: r.version, via: "doctor_workspace" },
    strict: true,
  });

  return {
    itemId,
    testName: item.test_name_snapshot,
    orderedAt: item.created_at,
    performedAt: r.performed_at,
    verifiedAt: r.verified_at,
    version: r.version,
    labComment: r.lab_comment,
    values: [...r.lab_result_values]
      .sort((a, b) => (a.lab_test_parameters?.sort_order ?? 0) - (b.lab_test_parameters?.sort_order ?? 0))
      .map((v) => ({
        parameter: v.lab_test_parameters?.name ?? "—",
        value:
          v.value_numeric != null ? String(v.value_numeric) : v.value_boolean != null ? (v.value_boolean ? "Ha" : "Yo‘q") : (v.value_text ?? "—"),
        unit: v.unit_snapshot,
        rangeLabel: rangeLabel(v),
        flag: v.flag,
      })),
  };
}

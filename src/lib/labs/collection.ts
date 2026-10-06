import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { anyColumnContains } from "@/lib/api/postgrest";
import { logger } from "@/lib/logger";
import type { ClinicStaff } from "@/lib/labs/guards";
import { ORDER_ERRORS } from "@/lib/labs/ordering";

/**
 * The lab work queue and sample collection (Phase 7).
 *
 * Operational data only: who the patient is (name, date of birth — enough to
 * label and match a tube), which tests were ordered, what sample they need,
 * where each test is in the workflow, and the specimens taken. Never result
 * values, doctor notes, diagnoses, referrals or history.
 *
 * Every change goes through one database function (collect_lab_sample,
 * receive_lab_sample, reject_lab_sample, create_lab_order) that locks, checks
 * and writes in a single transaction; clinic and actor always come from the
 * session.
 */

function loadFailed(what: string, error: { code?: string }) {
  logger.error(`lab queue: ${what} failed`, { code: error.code });
  return new ApiError(500, "Laboratoriya ma’lumotlarini yuklab bo‘lmadi", "load_failed");
}

// ---------------------------------------------------------------------------
// Work queue
// ---------------------------------------------------------------------------

export type QueueItem = {
  id: string;
  testId: string;
  testCode: string;
  testName: string;
  sampleType: string;
  preparationText: string | null;
  status: string;
  sampleId: string | null;
  /** A correction of the verified result in progress (status only, never values). */
  correction: "draft" | "submitted" | null;
};

export type QueueSample = {
  id: string;
  code: string;
  sampleType: string;
  status: string;
  collectedAt: string;
  notes: string | null;
  rejectReason: string | null;
  itemIds: string[];
};

export type QueueOrder = {
  id: string;
  createdAt: string;
  source: string;
  status: string;
  patient: { id: string; fullName: string | null; dateOfBirth: string | null };
  items: QueueItem[];
  samples: QueueSample[];
};

export const QUEUE_LIMIT = 200;
/** Completed orders stay in the queue this long (to review or correct a verified result). */
export const RECENTLY_COMPLETED_DAYS = 14;

/** Active (and recently completed) lab orders of the clinic, newest first, with status and specimens only. */
export async function getWorkQueue(staff: ClinicStaff): Promise<QueueOrder[]> {
  const { data, error } = await createAdminClient()
    .from("lab_orders")
    .select(
      "id, created_at, source, status, " +
        "patients!lab_orders_patient_fkey(id, full_name, date_of_birth), " +
        "lab_order_items!lab_order_items_order_fkey(id, test_id, test_code_snapshot, test_name_snapshot, status, lab_tests!lab_order_items_test_fkey(sample_type, preparation_text)), " +
        "lab_samples!lab_samples_order_fkey(id, sample_code, sample_type, status, collected_at, notes, reject_reason, lab_sample_items!lab_sample_items_sample_fkey(order_item_id))",
    )
    .eq("clinic_id", staff.clinicId)
    // Historical imports (Phase 13) arrive completed: they are not lab work.
    .neq("source", "external_import")
    .or(`status.eq.active,and(status.eq.completed,updated_at.gte.${new Date(Date.now() - RECENTLY_COMPLETED_DAYS * 86_400_000).toISOString()})`)
    .order("created_at", { ascending: false })
    .limit(QUEUE_LIMIT);
  if (error) throw loadFailed("queue", error);

  // Corrections in progress on verified tests: statuses only (no values).
  const verifiedItems = ((data ?? []) as unknown as Array<{ lab_order_items: Array<{ id: string; status: string }> }>)
    .flatMap((o) => o.lab_order_items)
    .filter((i) => i.status === "verified")
    .map((i) => i.id);
  const corrections = new Map<string, "draft" | "submitted">();
  if (verifiedItems.length > 0) {
    const { data: pending, error: pendingError } = await createAdminClient()
      .from("lab_results")
      .select("order_item_id, status")
      .eq("clinic_id", staff.clinicId)
      .in("order_item_id", verifiedItems)
      .in("status", ["draft", "submitted"]);
    if (pendingError) throw loadFailed("queue corrections", pendingError);
    for (const r of pending ?? []) corrections.set(r.order_item_id, r.status as "draft" | "submitted");
  }

  type Row = {
    id: string;
    created_at: string;
    source: string;
    status: string;
    patients: { id: string; full_name: string | null; date_of_birth: string | null } | null;
    lab_order_items: Array<{
      id: string;
      test_id: string;
      test_code_snapshot: string;
      test_name_snapshot: string;
      status: string;
      lab_tests: { sample_type: string; preparation_text: string | null } | null;
    }>;
    lab_samples: Array<{
      id: string;
      sample_code: string;
      sample_type: string;
      status: string;
      collected_at: string;
      notes: string | null;
      reject_reason: string | null;
      lab_sample_items: Array<{ order_item_id: string }>;
    }>;
  };

  return ((data ?? []) as unknown as Row[]).map((o) => {
    const samples = [...o.lab_samples]
      .sort((a, b) => a.collected_at.localeCompare(b.collected_at))
      .map((s) => ({
        id: s.id,
        code: s.sample_code,
        sampleType: s.sample_type,
        status: s.status,
        collectedAt: s.collected_at,
        notes: s.notes,
        rejectReason: s.reject_reason,
        itemIds: s.lab_sample_items.map((si) => si.order_item_id),
      }));
    const liveSampleOf = (itemId: string) => samples.find((s) => s.status !== "rejected" && s.itemIds.includes(itemId))?.id ?? null;
    return {
      id: o.id,
      createdAt: o.created_at,
      source: o.source,
      status: o.status,
      patient: { id: o.patients?.id ?? "", fullName: o.patients?.full_name ?? null, dateOfBirth: o.patients?.date_of_birth ?? null },
      items: o.lab_order_items
        .map((i) => ({
          id: i.id,
          testId: i.test_id,
          testCode: i.test_code_snapshot,
          testName: i.test_name_snapshot,
          sampleType: i.lab_tests?.sample_type ?? "",
          preparationText: i.lab_tests?.preparation_text ?? null,
          status: i.status,
          sampleId: liveSampleOf(i.id),
          correction: corrections.get(i.id) ?? null,
        }))
        .sort((a, b) => a.testName.localeCompare(b.testName)),
      samples,
    };
  });
}

// ---------------------------------------------------------------------------
// Samples
// ---------------------------------------------------------------------------

const SAMPLE_ERRORS: Array<[RegExp, number, string, string]> = [
  [/lab_sample_empty/, 400, "Namuna uchun kamida bitta tahlil tanlang", "empty_sample"],
  [/lab_sample_too_large|lab_sample_duplicate_item/, 400, "Tahlillar ro‘yxati noto‘g‘ri", "invalid_items"],
  [/lab_sample_key_reused/, 409, "Bu so‘rov boshqa namuna uchun allaqachon yuborilgan", "idempotency_key_reused"],
  [/lab_sample_unknown_order|lab_sample_foreign_item/, 404, "Buyurtma yoki tahlil topilmadi", "not_found"],
  [/lab_sample_order_not_active/, 409, "Buyurtma faol emas (bekor qilingan yoki yakunlangan)", "order_not_active"],
  [/lab_sample_item_cancelled/, 409, "Tanlangan tahlil bekor qilingan", "item_cancelled"],
  [/lab_sample_item_not_ready/, 409, "Tahlil hali namuna olishga tayyor emas — avval to‘lov qabul qilinishi kerak", "awaiting_payment"],
  [/lab_sample_item_already_collected/, 409, "Bu tahlil uchun namuna allaqachon olingan — ro‘yxatni yangilang", "already_collected"],
  [/lab_sample_mixed_types/, 409, "Har xil namuna turini talab qiladigan tahlillar bitta namunaga birlashtirilmaydi", "mixed_sample_types"],
  [/lab_sample_not_found/, 404, "Namuna topilmadi", "sample_not_found"],
  [/lab_sample_not_collected/, 409, "Namuna allaqachon rad etilgan", "sample_not_collected"],
  [/lab_sample_reason_required/, 400, "Rad etish sababini yozing", "reason_required"],
  [/lab_sample_has_results/, 409, "Bu namuna tahlillari uchun natija kiritilgan — namunani rad etib bo‘lmaydi", "has_results"],
];

function mapRpcError(error: { message?: string; code?: string }, table: Array<[RegExp, number, string, string]>, what: string): ApiError {
  const known = table.find(([pattern]) => pattern.test(error.message ?? ""));
  if (known) return new ApiError(known[1], known[2], known[3]);
  if (error.code === "23503") return new ApiError(404, "Ma’lumot topilmadi", "not_found");
  logger.error(`lab queue: ${what} failed`, { code: error.code });
  return new ApiError(500, "Saqlab bo‘lmadi", "save_failed");
}

export type CollectInput = { itemIds: string[]; notes: string | null; creationKey: string };

export async function collectSample(
  staff: ClinicStaff,
  orderId: string,
  input: CollectInput,
): Promise<{ sampleId: string; sampleCode: string; replayed: boolean }> {
  const { data, error } = await createAdminClient().rpc("collect_lab_sample", {
    p_clinic_id: staff.clinicId,
    p_order_id: orderId,
    p_item_ids: input.itemIds,
    p_collected_by: staff.profileId,
    p_notes: input.notes ?? undefined,
    p_creation_key: input.creationKey,
  });
  if (error) throw mapRpcError(error, SAMPLE_ERRORS, "collect");
  const row = (data as Array<{ lab_sample_id: string; sample_code: string; replayed: boolean }> | null)?.[0];
  if (!row) throw new ApiError(500, "Saqlab bo‘lmadi", "save_failed");
  return { sampleId: row.lab_sample_id, sampleCode: row.sample_code, replayed: row.replayed };
}

export async function receiveSample(staff: ClinicStaff, sampleId: string): Promise<{ changed: boolean }> {
  const { data, error } = await createAdminClient().rpc("receive_lab_sample", {
    p_clinic_id: staff.clinicId,
    p_sample_id: sampleId,
    p_received_by: staff.profileId,
  });
  if (error) throw mapRpcError(error, SAMPLE_ERRORS, "receive");
  return { changed: data === true };
}

export async function rejectSample(staff: ClinicStaff, sampleId: string, reason: string): Promise<{ changed: boolean }> {
  const { data, error } = await createAdminClient().rpc("reject_lab_sample", {
    p_clinic_id: staff.clinicId,
    p_sample_id: sampleId,
    p_rejected_by: staff.profileId,
    p_reason: reason,
  });
  if (error) throw mapRpcError(error, SAMPLE_ERRORS, "reject");
  return { changed: data === true };
}

// ---------------------------------------------------------------------------
// Walk-in orders (reception / lab desk)
// ---------------------------------------------------------------------------

export type PatientMatch = { id: string; fullName: string | null; dateOfBirth: string | null; phoneTail: string | null };

/** Patients of the clinic by name or phone — just enough to pick the right person. */
export async function searchPatients(staff: ClinicStaff, q: string): Promise<PatientMatch[]> {
  const text = q.trim().slice(0, 80);
  if (text.length < 2) return [];
  const { data, error } = await createAdminClient()
    .from("patients")
    .select("id, full_name, date_of_birth, phone")
    .eq("clinic_id", staff.clinicId)
    .is("merged_into_patient_id", null)
    .or(anyColumnContains(["full_name", "phone"], text))
    .order("full_name")
    .limit(10);
  if (error) throw loadFailed("patient search", error);
  return (data ?? []).map((p) => ({
    id: p.id,
    fullName: p.full_name,
    dateOfBirth: p.date_of_birth,
    phoneTail: p.phone ? p.phone.replace(/\D/g, "").slice(-4) || null : null,
  }));
}

export type WalkInInput = { testIds: string[]; panelIds: string[]; creationKey: string };

/** A walk-in lab order placed by the signed-in staff member (no doctor, no consultation). */
export async function createWalkInOrder(
  staff: ClinicStaff,
  patientId: string,
  input: WalkInInput,
): Promise<{ orderId: string; replayed: boolean }> {
  const db = createAdminClient();
  const { data: patient, error: patientError } = await db
    .from("patients")
    .select("id, merged_into_patient_id")
    .eq("id", patientId)
    .eq("clinic_id", staff.clinicId)
    .maybeSingle();
  if (patientError) throw loadFailed("patient", patientError);
  if (!patient) throw new ApiError(404, "Bemor topilmadi", "patient_not_found");
  // A merged record takes no new orders (Phase 14): order for the person's canonical record.
  const orderPatientId = patient.merged_into_patient_id ?? patient.id;

  const { data, error } = await db.rpc("create_lab_order", {
    p_clinic_id: staff.clinicId,
    p_patient_id: orderPatientId,
    p_ordered_by: staff.profileId,
    p_source: "walk_in",
    p_test_ids: input.testIds,
    p_panel_ids: input.panelIds,
    p_creation_key: input.creationKey,
  });
  if (error) throw mapRpcError(error, ORDER_ERRORS, "walk-in order");
  const row = (data as Array<{ lab_order_id: string; replayed: boolean }> | null)?.[0];
  if (!row) throw new ApiError(500, "Buyurtmani saqlab bo‘lmadi", "save_failed");
  return { orderId: row.lab_order_id, replayed: row.replayed };
}

// ---------------------------------------------------------------------------
// Cancelling an order (Phase 20: the database supported it since Phase 2; this
// is the application path). The database decides what may be cancelled: an
// active order none of whose tests has a sample yet. Cancelling cancels its
// open tests (trigger), lowers an unpaid bill to the remaining tests or leaves
// a paid one for refund at the Kassa ("Qaytarish kerak"), notifies the lab,
// managers and the ordering doctor (Phase 16) and is audited. Idempotent: a
// cancelled order stays cancelled and a repeat changes nothing.

export async function cancelLabOrder(staff: ClinicStaff, orderId: string, reason: string): Promise<{ changed: boolean }> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("lab_orders")
    .update({ status: "cancelled", cancelled_by: staff.profileId, cancelled_at: new Date().toISOString(), cancel_reason: reason })
    .eq("id", orderId)
    .eq("clinic_id", staff.clinicId)
    .eq("status", "active")
    .select("id");
  if (error) {
    if (/collected samples cannot be cancelled/.test(error.message ?? "")) {
      throw new ApiError(409, "Namuna olingan tahlillari bor buyurtmani bekor qilib bo‘lmaydi — namunani rad eting yoki natijani kiriting", "order_has_samples");
    }
    logger.error("lab queue: cancel order failed", { code: error.code });
    throw new ApiError(500, "Buyurtmani bekor qilib bo‘lmadi", "save_failed");
  }
  if (data && data.length > 0) return { changed: true };

  const { data: current, error: readError } = await db.from("lab_orders").select("status").eq("id", orderId).eq("clinic_id", staff.clinicId).maybeSingle();
  if (readError) throw loadFailed("order", readError);
  if (!current) throw new ApiError(404, "Buyurtma topilmadi", "order_not_found");
  if (current.status === "cancelled") return { changed: false };
  throw new ApiError(409, "Yakunlangan buyurtmani bekor qilib bo‘lmaydi", "order_completed");
}

/** The patient of an order of the staff member's clinic (for a doctor's access check), or null. */
export async function orderPatientId(staff: ClinicStaff, orderId: string): Promise<string | null> {
  const { data, error } = await createAdminClient().from("lab_orders").select("patient_id").eq("id", orderId).eq("clinic_id", staff.clinicId).maybeSingle();
  if (error) throw loadFailed("order", error);
  return data?.patient_id ?? null;
}

import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import { hasAnyRole, type StaffContext } from "@/lib/auth/staff";
import { canDoctorAccessPatientClinicalData } from "@/lib/clinical-access/access";

/**
 * The staff inbox (Phase 16): a staff member's in-app lab notifications.
 *
 * Rows hold an event type and ids only. The wording is built here, when it
 * is read, from what the reader may see now:
 *   - only the reader's own notifications of their own clinic;
 *   - a doctor sees a notification only while doctor_patient_access()
 *     still admits them to that patient (a referral may have ended);
 *   - test names and patient names, never result values or clinical text.
 */

type Staff = StaffContext & { clinicId: string };

export type StaffNotification = {
  id: string;
  type: string;
  title: string;
  detail: string | null;
  href: string;
  createdAt: string;
  read: boolean;
};

const TITLES: Record<string, string> = {
  lab_order_created: "Yangi laboratoriya buyurtmasi",
  lab_sample_collected: "Namuna olindi — qabul qiling",
  lab_result_entered: "Natija tekshiruvga yuborildi",
  lab_result_verified: "Laboratoriya natijasi tasdiqlandi",
  lab_result_corrected: "Laboratoriya natijasi tuzatildi",
  lab_order_cancelled: "Laboratoriya buyurtmasi bekor qilindi",
};

const PAGE = 50;

export async function listStaffNotifications(staff: Staff): Promise<{ notifications: StaffNotification[]; unread: number }> {
  const db = createAdminClient();
  const [{ data, error }, { count, error: countError }] = await Promise.all([
    db
      .from("notification_jobs")
      .select("id, type, lab_order_id, lab_result_id, created_at, read_at")
      .eq("clinic_id", staff.clinicId)
      .eq("channel", "in_app")
      .eq("recipient_profile_id", staff.profileId)
      .order("created_at", { ascending: false })
      .limit(PAGE),
    db
      .from("notification_jobs")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", staff.clinicId)
      .eq("channel", "in_app")
      .eq("recipient_profile_id", staff.profileId)
      .is("read_at", null),
  ]);
  if (error || countError) {
    logger.error("staff inbox: load failed", { code: (error ?? countError)?.code });
    throw new ApiError(500, "Bildirishnomalarni yuklab bo‘lmadi", "load_failed");
  }
  const rows = data ?? [];

  // What the rows point at: orders (patient, tests) and results (test).
  const orderIds = [...new Set(rows.map((r) => r.lab_order_id).filter((v): v is string => Boolean(v)))];
  const orders = new Map<string, { patientId: string; patientName: string | null; tests: string[] }>();
  if (orderIds.length) {
    const { data: os } = await db
      .from("lab_orders")
      .select("id, patient_id, patients!lab_orders_patient_fkey(full_name), lab_order_items!lab_order_items_order_fkey(test_name_snapshot)")
      .eq("clinic_id", staff.clinicId)
      .in("id", orderIds);
    for (const o of (os ?? []) as unknown as Array<{ id: string; patient_id: string; patients: { full_name: string | null } | null; lab_order_items: Array<{ test_name_snapshot: string }> }>) {
      orders.set(o.id, { patientId: o.patient_id, patientName: o.patients?.full_name ?? null, tests: o.lab_order_items.map((i) => i.test_name_snapshot) });
    }
  }
  const resultIds = [...new Set(rows.map((r) => r.lab_result_id).filter((v): v is string => Boolean(v)))];
  const resultTest = new Map<string, { test: string; patientId: string }>();
  if (resultIds.length) {
    const { data: rs } = await db
      .from("lab_results")
      .select("id, patient_id, lab_order_items!lab_results_item_fkey(test_name_snapshot)")
      .eq("clinic_id", staff.clinicId)
      .in("id", resultIds);
    for (const r of (rs ?? []) as unknown as Array<{ id: string; patient_id: string; lab_order_items: { test_name_snapshot: string } | null }>) {
      resultTest.set(r.id, { test: r.lab_order_items?.test_name_snapshot ?? "Tahlil", patientId: r.patient_id });
    }
  }

  // Doctors: only patients they may still see.
  const isDoctorOnly = hasAnyRole(staff.roles, ["doctor"]) && !hasAnyRole(staff.roles, ["owner", "admin", "manager", "receptionist", "lab"]);
  let doctorId: string | null = null;
  const allowed = new Map<string, boolean>();
  if (isDoctorOnly) {
    const { data: doctor } = await db.from("doctors").select("id").eq("clinic_id", staff.clinicId).eq("profile_id", staff.profileId).eq("active", true).maybeSingle();
    doctorId = doctor?.id ?? null;
  }
  const mayDoctorSee = async (patientId: string) => {
    if (!isDoctorOnly) return true;
    if (!doctorId) return false;
    if (!allowed.has(patientId)) {
      const access = await canDoctorAccessPatientClinicalData(doctorId, patientId);
      allowed.set(patientId, access.allowed);
    }
    return allowed.get(patientId)!;
  };

  const out: StaffNotification[] = [];
  for (const r of rows) {
    const order = r.lab_order_id ? orders.get(r.lab_order_id) : undefined;
    const result = r.lab_result_id ? resultTest.get(r.lab_result_id) : undefined;
    const patientId = order?.patientId ?? result?.patientId;
    if (!patientId || !(await mayDoctorSee(patientId))) continue;
    const testLine = result?.test ?? (order?.tests.length ? order.tests.join(", ") : null);
    out.push({
      id: r.id,
      type: r.type,
      title: TITLES[r.type] ?? "Bildirishnoma",
      detail: [order?.patientName, testLine].filter(Boolean).join(" · ") || null,
      href: isDoctorOnly ? `/doctor/patients/${patientId}` : hasAnyRole(staff.roles, ["lab"]) ? "/lab" : "/admin/lab-queue",
      createdAt: r.created_at,
      read: r.read_at !== null,
    });
  }
  return { notifications: out, unread: count ?? 0 };
}

/** Marks the reader's own notifications read (the given ones, or all). */
export async function markStaffNotificationsRead(staff: Staff, ids: string[] | null) {
  let q = createAdminClient()
    .from("notification_jobs")
    .update({ read_at: new Date().toISOString() })
    .eq("clinic_id", staff.clinicId)
    .eq("channel", "in_app")
    .eq("recipient_profile_id", staff.profileId)
    .is("read_at", null);
  if (ids) q = q.in("id", ids);
  const { error } = await q;
  if (error) throw new ApiError(500, "Saqlab bo‘lmadi", "save_failed");
  return { ok: true };
}

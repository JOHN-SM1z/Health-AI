import "server-only";
import { getStaffContext, hasRole, hasAnyRole, type StaffContext, type StaffRole } from "@/lib/auth/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";

/**
 * Resolves the staff session and enforces the minimum management role
 * (owner > admin == manager). UI hiding is never the only line of defense.
 * Platform admins have no clinic and are rejected here — they must use
 * platform-specific guards. Clinic staff always have a clinic, so the
 * returned context is narrowed to a non-null clinicId.
 */
export async function requireStaff(minRole: StaffRole = "admin"): Promise<StaffContext & { clinicId: string }> {
  const ctx = await getStaffContext();
  if (!ctx || ctx.platformAdmin || !ctx.clinicId) {
    throw new ApiError(401, "Avtorizatsiya talab qilinadi", "unauthorized");
  }
  if (!hasRole(ctx, minRole)) {
    throw new ApiError(403, "Bu amal uchun ruxsat yo‘q", "forbidden");
  }
  return ctx as StaffContext & { clinicId: string };
}

/** Any clinic-staff member with one of the allowed roles (owner/admin/manager/receptionist). */
export async function requireRoles(...roles: StaffRole[]): Promise<StaffContext & { clinicId: string }> {
  const ctx = await getStaffContext();
  if (!ctx || ctx.platformAdmin || !ctx.clinicId) {
    throw new ApiError(401, "Avtorizatsiya talab qilinadi", "unauthorized");
  }
  if (!hasAnyRole(ctx.roles, roles)) {
    throw new ApiError(403, "Bu amal uchun ruxsat yo‘q", "forbidden");
  }
  return ctx as StaffContext & { clinicId: string };
}

export type LinkedDoctor = StaffContext & { clinicId: string; doctorId: string; doctorName: string };

/**
 * A doctor acting as themselves: holds the doctor role itself in the
 * session's clinic (requireStaff("doctor") would also admit owner/admin/
 * manager by weight) and is linked to an active doctor record there.
 */
export async function requireLinkedDoctor(): Promise<LinkedDoctor> {
  const ctx = await requireRoles("doctor");
  const { data: doctor, error } = await createAdminClient()
    .from("doctors")
    .select("id, name")
    .eq("profile_id", ctx.profileId)
    .eq("clinic_id", ctx.clinicId)
    .eq("active", true)
    .maybeSingle();
  if (error) throw new ApiError(500, "Shifokor hisobini tekshirib bo‘lmadi");
  if (!doctor) throw new ApiError(403, "Sizning shifokor hisobingiz topilmadi", "doctor_not_linked");
  return { ...ctx, doctorId: doctor.id, doctorName: doctor.name };
}

/** Platform staff only (Health AI platform administration). */
export async function requirePlatformAdmin(): Promise<StaffContext> {
  const ctx = await getStaffContext();
  if (!ctx || !ctx.platformAdmin) {
    throw new ApiError(403, "Platforma boshqaruvi uchun ruxsat yo‘q", "forbidden");
  }
  return ctx;
}

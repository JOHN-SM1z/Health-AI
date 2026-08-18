import "server-only";
import { getStaffContext, hasRole, hasAnyRole, type StaffContext, type StaffRole } from "@/lib/auth/staff";
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

/** Platform staff only (Health AI platform administration). */
export async function requirePlatformAdmin(): Promise<StaffContext> {
  const ctx = await getStaffContext();
  if (!ctx || !ctx.platformAdmin) {
    throw new ApiError(403, "Platforma boshqaruvi uchun ruxsat yo‘q", "forbidden");
  }
  return ctx;
}

import "server-only";
import { getStaffContext, hasRole, type StaffContext, type StaffRole } from "@/lib/auth/staff";
import { ApiError } from "@/lib/api/errors";

/**
 * Resolves the staff session and enforces the minimum role.
 * Every admin mutation route calls this FIRST — UI hiding is never the
 * only line of defense.
 */
export async function requireStaff(minRole: StaffRole = "admin"): Promise<StaffContext> {
  const ctx = await getStaffContext();
  if (!ctx) {
    throw new ApiError(401, "Avtorizatsiya talab qilinadi", "unauthorized");
  }
  if (!hasRole(ctx, minRole)) {
    throw new ApiError(403, "Bu amal uchun ruxsat yo‘q", "forbidden");
  }
  return ctx;
}
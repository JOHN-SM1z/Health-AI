import "server-only";
import { createStaffClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";

export type StaffRole = Database["public"]["Enums"]["staff_role"];

export type StaffContext = {
  profileId: string;
  /** Null when the user is a platform admin (no clinic attached). */
  clinicId: string | null;
  clinicName: string;
  clinicTimezone: string;
  roles: StaffRole[];
  platformAdmin: boolean;
};

/**
 * Weighted role hierarchy for clinic staff:
 *   owner > admin == manager > doctor > receptionist
 * "doctor" and "receptionist" are below management: they cannot manage the
 * catalog, analytics or bot configuration. requireStaff("doctor") therefore
 * only passes for literal doctors (receptionist weight 0 < doctor weight 1).
 */
const ROLE_WEIGHT: Record<StaffRole, number> = {
  owner: 4,
  admin: 3,
  manager: 3,
  doctor: 1,
  receptionist: 0,
};

export function roleAtLeast(roles: StaffRole[], min: StaffRole): boolean {
  return roles.some((r) => ROLE_WEIGHT[r] >= ROLE_WEIGHT[min]);
}

export function hasAnyRole(roles: StaffRole[], allowed: StaffRole[]): boolean {
  return roles.some((r) => allowed.includes(r));
}

/**
 * Resolves the staff member's clinic context from the session.
 * Returns null when not signed in or not attached to any clinic.
 * Platform admins get a context WITHOUT a clinic (clinicId null).
 */
export async function getStaffContext(): Promise<StaffContext | null> {
  const supabase = await createStaffClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const [{ data: roles }, { data: platformAdmins }] = await Promise.all([
    supabase
      .from("staff_roles")
      .select("clinic_id, role, clinics!inner(id, name, timezone)")
      .eq("profile_id", user.id),
    supabase.from("platform_admins").select("profile_id").eq("profile_id", user.id).maybeSingle(),
  ]);

  const platformAdmin = !!platformAdmins;

  if (platformAdmin && (!roles || roles.length === 0)) {
    return {
      profileId: user.id,
      clinicId: null,
      clinicName: "Health AI Platform",
      clinicTimezone: "Asia/Tashkent",
      roles: [],
      platformAdmin: true,
    };
  }

  if (errorOrEmpty(roles)) return null;

  const first = roles![0];
  return {
    profileId: user.id,
    clinicId: first.clinic_id,
    clinicName: first.clinics?.name ?? "",
    clinicTimezone: first.clinics?.timezone ?? "Asia/Tashkent",
    roles: roles!.map((r) => r.role),
    platformAdmin,
  };
}

function errorOrEmpty(roles: Array<{ clinic_id: string; role: StaffRole }> | null): boolean {
  return !roles || roles.length === 0;
}

/** Convenience: true when the context has at least the given role. */
export function hasRole(ctx: StaffContext | null, min: StaffRole): boolean {
  if (!ctx) return false;
  if (ctx.platformAdmin) return true;
  return roleAtLeast(ctx.roles, min);
}

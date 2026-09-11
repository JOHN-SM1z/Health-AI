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
 * Payment amounts, outstanding balances, and revenue trends are financial
 * data. Managers retain the rest of the clinic workspace, but this view is
 * reserved for the clinic owner and full administrator roles.
 */
export function canViewPaymentDynamics(ctx: StaffContext | null): boolean {
  return !!ctx && hasAnyRole(ctx.roles, ["owner", "admin"]);
}

/** Manager and receptionist work from the shared operational workspace. */
export function isCallCenterStaff(ctx: StaffContext | null): boolean {
  return !!ctx && hasAnyRole(ctx.roles, ["manager", "receptionist"]);
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
      .eq("profile_id", user.id)
      .order("created_at", { ascending: true }),
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

  // A profile may hold staff_roles rows at more than one clinic (the schema
  // allows it: unique(clinic_id, profile_id), not unique(profile_id)). The
  // session is scoped to a single clinic — the earliest membership, for
  // determinism — so roles from a DIFFERENT clinic must never leak in here.
  // Merging roles across clinics would let e.g. a receptionist at Clinic A
  // who is also owner at Clinic B act with owner privileges inside Clinic A.
  const first = roles![0];
  const sameClinicRoles = roles!.filter((r) => r.clinic_id === first.clinic_id).map((r) => r.role);
  return {
    profileId: user.id,
    clinicId: first.clinic_id,
    clinicName: first.clinics?.name ?? "",
    clinicTimezone: first.clinics?.timezone ?? "Asia/Tashkent",
    roles: sameClinicRoles,
    platformAdmin,
  };
}

function errorOrEmpty(roles: Array<{ clinic_id: string; role: StaffRole }> | null): boolean {
  return !roles || roles.length === 0;
}

/**
 * Convenience: true when the context has at least the given clinic staff
 * role. Platform admins hold no clinic staff role at all (by design — see
 * the "platform admin has zero clinic powers" tests in
 * role-authorization.test.ts) and must never satisfy this, even implicitly:
 * a caller checking "is this at least an admin" is asking about clinic
 * authority specifically, and a platform-admin identity answering that
 * unconditionally true would contradict every other authorization check in
 * this codebase (requireStaff/requireRoles reject platformAdmin outright
 * before ever reaching a role-weight check).
 */
export function hasRole(ctx: StaffContext | null, min: StaffRole): boolean {
  if (!ctx) return false;
  return roleAtLeast(ctx.roles, min);
}

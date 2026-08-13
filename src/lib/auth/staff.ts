import "server-only";
import { createStaffClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";

export type StaffRole = Database["public"]["Enums"]["staff_role"];

export type StaffContext = {
  profileId: string;
  clinicId: string;
  clinicName: string;
  clinicTimezone: string;
  roles: StaffRole[];
};

const ROLE_WEIGHT: Record<StaffRole, number> = { owner: 3, admin: 2, doctor: 1 };

export function roleAtLeast(roles: StaffRole[], min: StaffRole): boolean {
  return roles.some((r) => ROLE_WEIGHT[r] >= ROLE_WEIGHT[min]);
}

/**
 * Resolves the staff member's clinic context from the session.
 * Returns null when not signed in or not attached to any clinic.
 */
export async function getStaffContext(): Promise<StaffContext | null> {
  const supabase = await createStaffClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: roles, error } = await supabase
    .from("staff_roles")
    .select("clinic_id, role, clinics!inner(id, name, timezone)")
    .eq("profile_id", user.id);

  if (error || !roles || roles.length === 0) return null;

  const first = roles[0];
  return {
    profileId: user.id,
    clinicId: first.clinic_id,
    clinicName: first.clinics?.name ?? "",
    clinicTimezone: first.clinics?.timezone ?? "Asia/Tashkent",
    roles: roles.map((r) => r.role),
  };
}

/** Convenience: true when the context has at least the given role. */
export function hasRole(ctx: StaffContext | null, min: StaffRole): boolean {
  if (!ctx) return false;
  return roleAtLeast(ctx.roles, min);
}
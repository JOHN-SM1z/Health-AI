import type { StaffRole } from "@/lib/auth/staff";

/**
 * Frontend feature-access model: what each clinic-staff role can DO, for
 * driving navigation and dashboard composition. This is deliberately NOT an
 * authorization boundary — every API route keeps its own requireRoles()/
 * requireStaff() check (src/lib/auth/guards.ts) and every table keeps its
 * own RLS policy, both independent of this file. Each permission below is
 * always a subset of what the corresponding backend check already allows,
 * so nothing here can make the UI more permissive than the server.
 *
 * No "server-only": both server components (layouts) and client pages
 * (dashboard widgets) need this, unlike staff.ts which resolves the session.
 */
export type Permission =
  | "appointments:manage"
  | "calendar:view"
  | "conversations:manage"
  | "patients:manage"
  | "catalog:manage"
  | "content:manage"
  | "analytics:view"
  | "finance:view"
  | "payments:manage"
  | "settings:manage"
  | "doctor:workspace";

const OPERATIONS: Permission[] = ["appointments:manage", "calendar:view", "conversations:manage", "patients:manage"];

// Catalog (doctors/services/specialties), FAQs, analytics and settings have
// always shared one gate (isManagement === hasRole(ctx, "admin")) — named
// separately anyway so each stays independently adjustable as its own
// feature instead of one opaque "isManagement" flag.
const MANAGEMENT: Permission[] = [...OPERATIONS, "catalog:manage", "content:manage", "analytics:view", "settings:manage"];

// Reserved for owner/admin only — see canViewPaymentDynamics() in staff.ts.
const FINANCE: Permission[] = ["finance:view", "payments:manage"];

/**
 * owner and admin are intentionally identical: every requireRoles()/RLS
 * check in the codebase today lists them together, and the role-weight
 * hierarchy (staff.ts) never distinguishes them either — admin is a second,
 * equally-trusted full-access role, not a lesser one.
 */
const ROLE_PERMISSIONS: Record<StaffRole, Permission[]> = {
  owner: [...MANAGEMENT, ...FINANCE],
  admin: [...MANAGEMENT, ...FINANCE],
  manager: MANAGEMENT,
  receptionist: OPERATIONS,
  doctor: ["doctor:workspace"],
};

/** Union of permissions across every role the context holds. */
export function getPermissions(roles: StaffRole[]): Set<Permission> {
  const set = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role] ?? []) set.add(permission);
  }
  return set;
}

export function hasPermission(roles: StaffRole[], permission: Permission): boolean {
  return getPermissions(roles).has(permission);
}

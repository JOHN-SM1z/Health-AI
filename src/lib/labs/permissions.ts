import type { Database } from "@/lib/supabase/database.types";

type StaffRole = Database["public"]["Enums"]["staff_role"];

/**
 * Laboratory permission model (docs/labs/PHASE_1_DOMAIN_MODEL.md §5, AGENTS.md
 * "minimum necessary access by role and purpose").
 *
 * Capabilities are grouped by purpose so a role never gains one kind of access
 * through another:
 *   CONFIGURATION — the catalog, prices, reference ranges, lab settings
 *   OPERATIONAL   — ordering, cancelling, the work queue, samples (status only)
 *   CLINICAL      — entering, verifying and reading result values
 *   FINANCIAL     — amounts and revenue
 *
 * This is the server's decision table. UI may import it to hide what a role
 * cannot do, but every route still enforces it (requireLabCapability) and the
 * database still enforces tenancy, provenance and second-person verification.
 *
 * Doctors' CLINICAL read access is not role-wide: it is decided per patient by
 * doctor_patient_access() (own patient or active referral) — see
 * resolveLabResultAccess(). The roles listed for result.read here are those
 * that can EVER read results; the per-patient check still applies.
 */

export const LAB_CAPABILITY_GROUPS = {
  configuration: ["catalog.configure", "settings.configure"],
  operational: ["catalog.read", "order.create", "order.cancel", "order.status.read", "queue.read", "sample.collect", "sample.process"],
  clinical: ["result.enter", "result.verify", "result.read", "document.upload", "import.manage"],
  financial: ["finance.view"],
} as const;

export type LabCapability = (typeof LAB_CAPABILITY_GROUPS)[keyof typeof LAB_CAPABILITY_GROUPS][number];

const EVERY_CLINIC_ROLE: readonly StaffRole[] = ["owner", "manager", "admin", "receptionist", "doctor", "lab"];

export const LAB_CAPABILITIES: Record<LabCapability, readonly StaffRole[]> = {
  // Configuration: clinic management only.
  "catalog.configure": ["owner", "admin", "manager"],
  "settings.configure": ["owner", "admin", "manager"],

  // Operational. Ordering is open to every staff member of the clinic
  // (owner decision 2026-10-05): no per-role or per-test restriction.
  "catalog.read": EVERY_CLINIC_ROLE,
  "order.create": EVERY_CLINIC_ROLE,
  "order.cancel": EVERY_CLINIC_ROLE,
  // Work status (ordered → collected → processing → verified), never values.
  // Doctors see status only for patients they may access (per patient).
  "order.status.read": ["owner", "manager", "admin", "receptionist", "lab", "doctor"],
  // The clinic-wide work queue (every active order, status only). Doctors
  // are left out: they never get clinic-wide patient lists.
  "queue.read": ["owner", "manager", "admin", "receptionist", "lab"],
  // Collecting a sample is front-desk or lab work; receiving / rejecting /
  // processing specimens is lab work.
  "sample.collect": ["lab", "receptionist"],
  "sample.process": ["lab"],

  // Clinical: result values. Lab staff for the lab work; doctors (per
  // patient). Verification is by a second person (enforced in the database).
  // Owner / manager / admin / receptionist never see values (O5).
  "result.enter": ["lab", "doctor"],
  "result.verify": ["lab", "doctor"],
  "result.read": ["lab", "doctor"],
  // Attaching report / scan / image files to a result is lab work (Phase 11).
  "document.upload": ["lab"],
  // Historical result import (Phase 13): the file holds result values and
  // patient identifiers, so it is lab work, and a second lab staff member
  // confirms what one prepared (enforced in the database).
  "import.manage": ["lab"],

  // Financial: the existing rule (canViewPaymentDynamics) — owner and admin.
  "finance.view": ["owner", "admin"],
};

/** True when any of `roles` holds `capability`. */
export function labCan(roles: readonly StaffRole[], capability: LabCapability): boolean {
  const allowed = LAB_CAPABILITIES[capability];
  return roles.some((role) => allowed.includes(role));
}

/** The capability group a capability belongs to. */
export function labCapabilityGroup(capability: LabCapability): keyof typeof LAB_CAPABILITY_GROUPS {
  for (const [group, caps] of Object.entries(LAB_CAPABILITY_GROUPS) as Array<[keyof typeof LAB_CAPABILITY_GROUPS, readonly string[]]>) {
    if (caps.includes(capability)) return group;
  }
  throw new Error(`unknown lab capability ${capability}`);
}

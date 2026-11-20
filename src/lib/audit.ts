import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";

export type AuditActor = {
  actorId?: string | null;
  actorType: "staff" | "system" | "patient" | "telegram";
};

export type AuditEvent = {
  clinicId: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  actor?: AuditActor;
  /** The patient the event concerns; the database checks it belongs to clinicId. */
  patientId?: string | null;
  /** The referral the event concerns; the database checks it belongs to clinicId (and patientId). */
  referralId?: string | null;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
};

const toRow = (e: AuditEvent) => ({
  clinic_id: e.clinicId,
  actor_id: e.actor?.actorId ?? null,
  actor_type: e.actor?.actorType ?? "system",
  action: e.action,
  entity_type: e.entityType,
  entity_id: e.entityId ?? null,
  patient_id: e.patientId ?? null,
  referral_id: e.referralId ?? null,
  old_values: (e.oldValues ?? null) as never,
  new_values: (e.newValues ?? null) as never,
  metadata: (e.metadata ?? {}) as never,
});

async function insertAudit(events: AuditEvent[], strict: boolean | undefined): Promise<void> {
  if (events.length === 0) return;
  let failed = false;
  try {
    const { error } = await createAdminClient().from("audit_events").insert(events.map(toRow));
    if (error) {
      failed = true;
      logger.error("audit insert failed", { action: events[0].action, count: events.length, code: error.code });
    }
  } catch (e) {
    failed = true;
    logger.error("audit insert threw", { action: events[0].action, error: String(e) });
  }
  if (failed && strict) {
    throw new ApiError(503, "Kirish jurnaliga yozib bo‘lmadi, keyinroq urinib ko‘ring", "audit_unavailable");
  }
}

/**
 * Records an explicit audit event. The database triggers additionally record
 * row-level changes on appointments, payments, staff roles, time blocks,
 * conversations, referrals and clinical records — use this for actions that
 * do not modify those tables (views, access decisions, login contexts…).
 *
 * The audit trail is append-only and tenant-bound: the database stamps the
 * time and refuses a patient or referral of another clinic.
 *
 * Best-effort by default: a failed write is logged and the caller carries on.
 * With `strict`, a failed write throws instead — for access logs that must
 * exist before the data they record is released (e.g. viewing a referral).
 */
export async function recordAudit(opts: AuditEvent & { strict?: boolean }) {
  await insertAudit([opts], opts.strict);
}

/** Several events in one write (e.g. every referral a list shows) — all or none. */
export async function recordAudits(events: AuditEvent[], opts: { strict?: boolean } = {}) {
  await insertAudit(events, opts.strict);
}

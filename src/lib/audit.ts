import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";

export type AuditActor = {
  actorId?: string | null;
  actorType: "staff" | "system" | "patient" | "telegram";
};

/**
 * Records an explicit audit event. The database triggers additionally record
 * row-level changes on appointments, payments, staff roles, time blocks and
 * conversations — use this for actions that do not modify those tables
 * directly (e.g. login contexts, manual payment confirmation metadata).
 *
 * Best-effort by default: a failed write is logged and the caller carries on.
 * With `strict`, a failed write throws instead — for access logs that must
 * exist before the data they record is released (e.g. viewing a referral).
 */
export async function recordAudit(opts: {
  clinicId: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  actor?: AuditActor;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  strict?: boolean;
}) {
  let failed = false;
  try {
    const supabase = createAdminClient();
    const { error } = await supabase.from("audit_events").insert({
      clinic_id: opts.clinicId,
      actor_id: opts.actor?.actorId ?? null,
      actor_type: opts.actor?.actorType ?? "system",
      action: opts.action,
      entity_type: opts.entityType,
      entity_id: opts.entityId ?? null,
      old_values: (opts.oldValues ?? null) as never,
      new_values: (opts.newValues ?? null) as never,
      metadata: (opts.metadata ?? {}) as never,
    });
    if (error) {
      failed = true;
      logger.error("audit insert failed", { action: opts.action, error: error.message });
    }
  } catch (e) {
    failed = true;
    logger.error("audit insert threw", { action: opts.action, error: String(e) });
  }
  if (failed && opts.strict) {
    throw new ApiError(503, "Kirish jurnaliga yozib bo‘lmadi, keyinroq urinib ko‘ring", "audit_unavailable");
  }
}

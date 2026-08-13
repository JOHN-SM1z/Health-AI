import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
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
}) {
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
      logger.error("audit insert failed", { action: opts.action, error: error.message });
    }
  } catch (e) {
    logger.error("audit insert threw", { action: opts.action, error: String(e) });
  }
}
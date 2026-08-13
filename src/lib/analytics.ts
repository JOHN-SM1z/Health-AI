import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";

/**
 * Server/database-backed analytics event tracking.
 * Events are written through the service-role client by server code only —
 * the browser never writes analytics_events directly.
 */
export async function trackAnalytics(opts: {
  clinicId: string;
  eventType: string;
  patientId?: string | null;
  payload?: Record<string, unknown>;
}) {
  try {
    const supabase = createAdminClient();
    const { error } = await supabase.from("analytics_events").insert({
      clinic_id: opts.clinicId,
      patient_id: opts.patientId ?? null,
      event_type: opts.eventType,
      payload: (opts.payload ?? {}) as never,
    });
    if (error) {
      logger.warn("analytics insert failed", { eventType: opts.eventType, error: error.message });
    }
  } catch (e) {
    logger.warn("analytics insert threw", { eventType: opts.eventType, error: String(e) });
  }
}
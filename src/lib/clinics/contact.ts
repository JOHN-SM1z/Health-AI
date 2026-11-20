import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";

export type ClinicContact = { phone: string | null; address: string | null; openingHours: string | null };

/**
 * The clinic's contact details as the patient should see them. The owner
 * edits them under Sozlamalar (app_settings: phone, address, opening_hours);
 * the clinic record's own columns are the fallback. Every bot reply that
 * shows a phone or address reads it from here, so one edit updates them all.
 */
export async function getClinicContact(clinic: { id: string; phone?: string | null; address?: string | null }): Promise<ClinicContact> {
  let data: Array<{ key: string; value: unknown }> | null = null;
  try {
    const res = await createAdminClient()
      .from("app_settings")
      .select("key, value")
      .eq("clinic_id", clinic.id)
      .in("key", ["phone", "address", "opening_hours"]);
    if (res.error) logger.warn("clinic contact: settings read failed", { code: res.error.code });
    data = res.data;
  } catch {
    // Fall back to the clinic record below.
  }
  const text = (key: string): string | null => {
    const row = (data ?? []).find((r) => r.key === key);
    const v = row?.value as { text?: unknown } | string | null | undefined;
    const s = typeof v === "string" ? v : typeof v?.text === "string" ? v.text : null;
    return s && s.trim() ? s.trim() : null;
  };
  return {
    phone: text("phone") ?? (clinic.phone?.trim() || null),
    address: text("address") ?? (clinic.address?.trim() || null),
    openingHours: text("opening_hours"),
  };
}

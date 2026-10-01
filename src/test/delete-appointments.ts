import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Test fixtures only. Payments keep their own retention: deleting an
 * appointment is refused while a payment row references it
 * (20261001000003_independent_retention.sql), so a fixture's appointments are
 * removed together with their payment rows, which the booking engine creates.
 */
export async function deleteAppointments(
  admin: SupabaseClient,
  filter: (query: ReturnType<ReturnType<SupabaseClient["from"]>["select"]>) => unknown,
): Promise<void> {
  const { data } = (await filter(admin.from("appointments").select("id"))) as { data: { id: string }[] | null };
  const ids = (data ?? []).map((row) => row.id);
  if (!ids.length) return;
  await admin.from("payments").delete().in("appointment_id", ids);
  await admin.from("appointments").delete().in("id", ids);
}

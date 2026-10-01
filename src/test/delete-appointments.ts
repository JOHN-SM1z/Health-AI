import type { SupabaseClient } from "@supabase/supabase-js";

const CHUNK = 100; // ids travel in the request URL

/**
 * Test fixtures only. Payments keep their own retention: deleting an
 * appointment is refused while a payment row references it
 * (20261001000003_independent_retention.sql), so a fixture's appointments are
 * removed together with their payment rows, which the booking engine creates.
 * Any error fails the caller loudly — a refused delete (a record or referral
 * still pointing at the appointment) must not pass as a clean-up.
 */
export async function deleteAppointments(
  admin: SupabaseClient,
  filter: (query: ReturnType<ReturnType<SupabaseClient["from"]>["select"]>) => unknown,
): Promise<void> {
  const { data, error } = (await filter(admin.from("appointments").select("id"))) as {
    data: { id: string }[] | null;
    error: { message: string } | null;
  };
  if (error) throw new Error(`deleteAppointments: lookup failed: ${error.message}`);
  const ids = (data ?? []).map((row) => row.id);
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const payments = await admin.from("payments").delete().in("appointment_id", chunk);
    if (payments.error) throw new Error(`deleteAppointments: payments: ${payments.error.message}`);
    const appointments = await admin.from("appointments").delete().in("id", chunk);
    if (appointments.error) throw new Error(`deleteAppointments: appointments: ${appointments.error.message}`);
  }
}

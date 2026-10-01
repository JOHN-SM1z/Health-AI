import postgres from "postgres";

export const FIXTURE_RETENTION_TABLES = [
  // Laboratory (children first; they hang on orders, patients and appointments).
  "lab_result_attachments", "lab_result_values", "lab_result_versions", "lab_results", "lab_sample_items",
  "lab_samples", "lab_order_items", "lab_orders", "lab_panel_tests", "lab_panels", "lab_reference_ranges",
  "lab_test_parameters", "lab_tests", "lab_categories",
  "messages", "voice_messages", "conversations", "clinical_records", "referrals",
  "payments", "notification_jobs", "appointments", "audit_events", "retention_policies",
] as const;

/** Test fixtures only. Production retention now blocks parent cascades, so the
 * local database owner removes each explicitly named fixture domain in order. */
export async function cleanupTestClinics(ids: string[]): Promise<void> {
  const clinicIds = ids.filter(Boolean);
  if (!clinicIds.length) return;
  if (clinicIds.some((id) => !/^[0-9a-f-]{36}$/i.test(id) || id === "11111111-1111-4111-8111-111111111111")) {
    throw new Error("Cleanup requires explicit non-seed fixture clinic IDs");
  }
  const url = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) {
    throw new Error("Fixture cleanup only supports a local test database");
  }
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql.begin(async (tx) => {
      // No trigger disabling or cross-domain CASCADE. Supplied IDs are parameters.
      for (const table of FIXTURE_RETENTION_TABLES) {
        await tx`delete from ${tx(`public.${table}`)} where clinic_id in ${tx(clinicIds)}`;
      }
      await tx`delete from public.clinics where id in ${tx(clinicIds)}`;
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

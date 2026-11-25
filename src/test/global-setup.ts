import { createClient } from "@supabase/supabase-js";
import type { TestProject } from "vitest/node";
import { loadTestEnvironment } from "./environment";

/**
 * Probes the local Supabase stack once, before any test worker starts.
 * Passes the result to this Vitest project's workers for test collection.
 *
 * If the stack is down, half-migrated or unseeded, integration suites skip
 * with a visible warning instead of failing misleadingly.
 */

const SEED_CLINIC_ID = "11111111-1111-4111-8111-111111111111";

export default async function globalSetup(project: TestProject): Promise<void> {
  // Refuse remote targets before even probing. CI-injected values win over files.
  loadTestEnvironment();

  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

  let available = false;
  let reason = "";

  if (!url || !serviceKey || !anonKey || serviceKey.startsWith("test-") || anonKey.startsWith("test-")) {
    reason = "placeholder/empty Supabase keys — configure .env.test with local keys (npx supabase status)";
  } else {
    try {
      const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
      const { data, error } = await admin
        .from("clinics")
        .select("id")
        .eq("id", SEED_CLINIC_ID)
        .maybeSingle();
      if (error) {
        reason = `Supabase query failed — ${error.message} (is the local stack running?)`;
      } else if (data) {
        available = true;
      } else {
        reason = "seed clinic not found — run `npm run db:reset-local` (applies migrations + seed)";
      }
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
    }
  }

  if (!available) {
    if (process.env.REQUIRE_TEST_DATABASE === "true") {
      throw new Error(`Required local test database unavailable: ${reason}`);
    }
    console.warn(`\n⚠️  local Supabase unavailable — integration suites will be SKIPPED (${reason})\n`);
  }
  project.provide("localDbAvailable", available);
}

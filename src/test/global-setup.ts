import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

/**
 * Probes the local Supabase stack once, before any test worker starts.
 * Writes a marker file that `local-db.ts` reads synchronously.
 *
 * If the stack is down, half-migrated or unseeded, integration suites skip
 * with a visible warning instead of failing misleadingly.
 */

const MARKER = join(tmpdir(), "health-ai-local-db.json");
const SEED_CLINIC_ID = "11111111-1111-4111-8111-111111111111";

export default async function globalSetup(): Promise<void> {
  const envFile = resolveEnvFile();
  if (envFile) process.loadEnvFile(envFile);

  const url = process.env.SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const anonKey = process.env.SUPABASE_ANON_KEY ?? "";

  let available = false;
  let reason = "";

  if (!url || serviceKey.startsWith("test-") || anonKey.startsWith("test-")) {
    reason = "placeholder/empty Supabase keys — configure .env with local keys (npx supabase status)";
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

  writeFileSync(MARKER, JSON.stringify({ available, reason }));
  if (!available) {
    console.warn(`\n⚠️  local Supabase unavailable — integration suites will be SKIPPED (${reason})\n`);
  }
}

function resolveEnvFile(): string | null {
  const candidates = [".env", ".env.test.example"];
  for (const name of candidates) {
    const path = join(process.cwd(), name);
    if (existsSync(path)) return path;
  }
  return null;
}
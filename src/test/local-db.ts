import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MARKER = join(tmpdir(), "health-ai-local-db.json");

let cached: boolean | null = null;

/**
 * True when the local Supabase stack is up, migrated and seeded.
 *
 * `global-setup.ts` probes the database before the workers start and writes
 * a marker file; suites call this synchronously at collection time
 * (`describe.skipIf` cannot await). A missing marker or failed probe means
 * the integration suites SKIP with a clear warning instead of producing a
 * misleading failed run from a half-configured database.
 */
export function localDbAvailable(): boolean {
  if (cached !== null) return cached;
  try {
    if (!existsSync(MARKER)) return false;
    const state = JSON.parse(readFileSync(MARKER, "utf8")) as { available: boolean };
    cached = state.available === true;
  } catch {
    cached = false;
  }
  return cached;
}
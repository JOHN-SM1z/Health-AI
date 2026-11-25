import { inject } from "vitest";

declare module "vitest" {
  interface ProvidedContext {
    localDbAvailable: boolean;
  }
}

/**
 * True when the local Supabase stack is up, migrated and seeded.
 *
 * Vitest passes the probe result from global setup to each worker, where
 * suites read it synchronously at collection time (`describe.skipIf`).
 */
export function localDbAvailable(): boolean {
  const available = inject("localDbAvailable");
  if (typeof available !== "boolean") {
    throw new Error("Vitest global setup did not provide local database readiness.");
  }
  return available;
}

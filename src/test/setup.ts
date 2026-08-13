import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Loads .env.test.example for unit tests, then the real .env when present
 * (values already set in the environment keep precedence, so CI-injected
 * variables win). Server-only modules (supabase clients, env validation)
 * need real-ish values even when never called.
 */
const envFile = resolve(process.cwd(), ".env");
const fallbackFile = resolve(process.cwd(), ".env.test.example");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
} else if (existsSync(fallbackFile)) {
  process.loadEnvFile(fallbackFile);
}
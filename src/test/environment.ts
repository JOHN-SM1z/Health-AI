import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Integration suites delete fixtures. Never point them at a hosted database. */
export function loadTestEnvironment() {
  const file = resolve(process.cwd(), existsSync(".env.test") ? ".env.test" : ".env.test.example");
  if (existsSync(file)) process.loadEnvFile(file);
  for (const key of ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"]) {
    const value = process.env[key];
    if (!value) continue;
    let hostname = "";
    try { hostname = new URL(value).hostname; } catch { /* rejected below */ }
    if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname)) {
      throw new Error(`Refusing tests: ${key} must use a loopback host. Configure a disposable local stack in .env.test.`);
    }
  }
}

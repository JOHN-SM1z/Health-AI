import { existsSync } from "node:fs";
import { resolve } from "node:path";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Validate before opening clients: fixture tests can delete and rewrite data. */
export function assertLocalTestEnvironment(environment: Record<string, string | undefined> = process.env) {
  for (const key of ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_DB_URL"]) {
    const value = environment[key];
    if (!value) continue;
    let target: URL;
    try {
      target = new URL(value);
    } catch {
      throw new Error(`Refusing tests: ${key} must use a loopback host. Configure a disposable local stack in .env.test.`);
    }
    const protocols = key === "SUPABASE_DB_URL" ? ["postgres:", "postgresql:"] : ["http:", "https:"];
    if (!LOCAL_HOSTS.has(target.hostname) || !protocols.includes(target.protocol) || (key === "SUPABASE_DB_URL" && target.search)) {
      // Never include a connection string: it may contain real credentials.
      throw new Error(`Refusing tests: ${key} must use a loopback host. Configure a disposable local stack in .env.test.`);
    }
  }
}

/** Integration suites delete fixtures. Never point them at a hosted database. */
export function loadTestEnvironment() {
  const file = resolve(process.cwd(), existsSync(".env.test") ? ".env.test" : ".env.test.example");
  if (existsSync(file)) process.loadEnvFile(file);
  assertLocalTestEnvironment();
}

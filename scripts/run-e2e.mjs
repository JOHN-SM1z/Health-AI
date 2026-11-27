import { spawnSync } from "node:child_process";
import { loadTestEnvironment } from "../src/test/environment.ts";

// Fixture scripts must never load real application environment files.
loadTestEnvironment();
if (!process.env.SUPABASE_DB_URL || !process.env.SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY.startsWith("test-")) {
  throw new Error("Configure explicit disposable local Supabase credentials in .env.test before running E2E fixtures.");
}
const scripts = process.argv.includes("--seed") ? ["seed-demo"] : [
  "referral-workflow", "booking-channels", "my-appointments", "online-identity", "online-payment",
  "sms-fallback", "staff-and-safety", "lab-configuration", "lab-ordering", "lab-collection",
  "lab-results", "lab-verification", "lab-history", "lab-documents", "lab-patient-results", "lab-import",
  "patient-merge", "lab-external", "lab-notifications", "lab-dashboards", "lab-ai-summary",
  "outpatient-journey", "lab-walk-in", "saas-onboarding", "redteam-http",
];
for (const script of scripts) {
  const result = spawnSync(process.execPath, [`e2e/${script}.mjs`], { env: process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

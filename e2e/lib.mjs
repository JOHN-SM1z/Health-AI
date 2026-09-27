// Shared helpers for the end-to-end scripts in e2e/. They drive the BUILT app
// (`npm run build && npm start`) with real logins against a LOCAL Supabase
// stack seeded by e2e/seed-demo.mjs — never against a hosted project: every
// URL they are given must point at this machine.
import postgres from "postgres";

export const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
export const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
export const PASSWORD = "DemoPassword123!";
// The E2E demo clinic (e2e/seed-demo.mjs). Its names differ from the seed
// clinic's (supabase/seed.sql), which the vitest suites look up by name.
export const DEMO = {
  referrer: "dr.aliyev@e2e.local",
  receiver: "dr.nazarova@e2e.local",
  reception: "reception@e2e.local",
  manager: "manager@e2e.local",
};
export const DEMO_NAMES = {
  referrer: "Aliyev Jasur",
  receiver: "Nazarova Malika",
  generalService: "Terapevt ko‘rigi (E2E)",
  cardiologyService: "Kardiolog ko‘rigi (E2E)",
};

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Refuses to run unless the app, the API and the database are all on this machine. */
export function assertLocalOnly() {
  const urls = { E2E_BASE_URL: BASE, SUPABASE_DB_URL: DB_URL, SUPABASE_URL: process.env.SUPABASE_URL };
  for (const [name, value] of Object.entries(urls)) {
    if (!value) continue;
    let host = "";
    try {
      host = new URL(value).hostname;
    } catch {
      /* reported below */
    }
    if (!LOCAL_HOSTS.has(host)) {
      console.error(`${name} must point at a local stack (127.0.0.1 / localhost); refusing to run against ${host || "an invalid URL"}.`);
      process.exit(2);
    }
  }
}

export function connect() {
  return postgres(DB_URL, { max: 4, onnotice: () => {} });
}

/** A run-unique suffix and a date far in the past no other run uses, for fixture visits (whole days, 10:00 Tashkent). */
export function runFixture() {
  const suffix = Date.now().toString(36);
  const firstDay = Date.UTC(2000, 0, 1) + Math.floor(Math.random() * 18_000) * 86_400_000;
  let n = 0;
  const nextSlot = (minutes = 20) => {
    const start = new Date(firstDay + n++ * 86_400_000 + 5 * 3_600_000);
    return { start, end: new Date(start.getTime() + minutes * 60_000) };
  };
  return { suffix, nextSlot };
}

export function createReport(title) {
  const checks = [];
  const problems = [];
  const check = (ok, label) => {
    checks.push(`${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) problems.push(`check failed: ${label}`);
  };
  const finish = () => {
    console.log(checks.join("\n"));
    console.log(problems.length ? `\nPROBLEMS:\n${problems.join("\n")}` : "\nno failed checks, page errors or 5xx responses");
    console.log(`${title}: ${checks.filter((c) => c.startsWith("PASS")).length}/${checks.length} checks passed`);
    return problems.length ? 1 : 0;
  };
  const abort = (e) => {
    console.log(checks.join("\n"));
    console.error(`${title} ABORTED:`, String(e?.message ?? e).split("\n").slice(0, 8).join("\n"));
    if (problems.length) console.error(problems.join("\n"));
    return 2;
  };
  return { check, problems, finish, abort };
}

export const VIEWPORTS = {
  desktop: { width: 1360, height: 900 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 390, height: 844 },
};

/** Signs in through the real login page; page errors and 5xx responses are reported as problems. */
export async function signIn(browser, report, email, viewport = "desktop", { expectDenials = false } = {}) {
  const context = await browser.newContext({ viewport: VIEWPORTS[viewport], hasTouch: viewport !== "desktop", isMobile: viewport === "phone" });
  const page = await context.newPage();
  // Where a step deliberately opens forbidden pages, the browser's own
  // "Failed to load resource: 404/410" lines for those responses are expected.
  const expected = (text) => expectDenials && /Failed to load resource: .* (404|410)/.test(text);
  page.on("console", (m) => m.type() === "error" && !expected(m.text()) && report.problems.push(`[${email}] console: ${m.text()}`));
  page.on("pageerror", (e) => report.problems.push(`[${email}] pageerror: ${e.message}`));
  page.on("response", (r) => r.status() >= 500 && report.problems.push(`[${email}] HTTP ${r.status()} ${r.url()}`));
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Parol").fill(PASSWORD);
  await page.getByRole("button", { name: "Kirish" }).click();
  await page.waitForURL(/\/(admin|doctor)/, { timeout: 15_000 });
  await page.waitForLoadState("networkidle");
  return { context, page };
}

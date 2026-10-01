// End-to-end, in the BUILT app, through the real screens — laboratory configuration (phase 3):
//
//   The owner opens Laboratoriya, adds a section, a test with a parameter and a reference range, a panel,
//   and changes the workflow settings (which persist across a reload).
//   A receptionist sees no Laboratoriya and is refused by the API.
//   A laboratory technician signs in, lands in the laboratory workspace, reads the catalog — and cannot
//   configure it, nor reach patients, bookings or any other workspace.
//
// Needs the local stack, `node e2e/seed-demo.mjs`, and the app running (`npm run build && npm start`). Rerunnable.
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { BASE, DEMO, PASSWORD, VIEWPORTS, assertLocalOnly, connect, createReport, signIn } from "./lib.mjs";

assertLocalOnly();
const SHOTS = process.env.E2E_ARTIFACTS_DIR ?? "test-results/e2e";
mkdirSync(SHOTS, { recursive: true });
const report = createReport("laboratory configuration E2E");
const { check } = report;
const db = connect();
const suffix = Date.now().toString(36);
const CLINIC = "e2e00000-0000-4000-8000-000000000001";
const CODE = `E2E-${suffix}`.toUpperCase().slice(0, 30);
const TEST_NAME = `Umumiy qon tahlili ${suffix}`;

async function loginLab(browser) {
  const context = await browser.newContext({ viewport: VIEWPORTS.desktop });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.problems.push(`[lab] pageerror: ${e.message}`));
  page.on("response", (r) => r.status() >= 500 && report.problems.push(`[lab] HTTP ${r.status()} ${r.url()}`));
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(DEMO.lab);
  await page.getByLabel("Parol").fill(PASSWORD);
  await page.getByRole("button", { name: "Kirish" }).click();
  await page.waitForURL(/\/lab(\/|$|\?)/, { timeout: 20_000 });
  await page.waitForLoadState("networkidle");
  return { context, page };
}

async function run() {
  const browser = await chromium.launch();
  try {
    // ---------- The owner configures the laboratory ----------
    const { context: ownerContext, page: owner } = await signIn(browser, report, DEMO.owner, "desktop", { expectDenials: true });
    const navLink = owner.getByRole("link", { name: "Laboratoriya", exact: true });
    check(await navLink.isVisible(), "the owner has a Laboratoriya section");
    await navLink.click();
    await owner.getByRole("button", { name: "Yangi tahlil" }).waitFor();

    await owner.getByLabel("Yangi bo‘lim nomi").fill(`Qon ${suffix}`);
    await owner.getByRole("button", { name: "Qo‘shish" }).click();
    check(await owner.getByText(`Qon ${suffix}`, { exact: true }).waitFor({ timeout: 10_000 }).then(() => true, () => false), "a new section is listed");

    await owner.getByRole("button", { name: "Yangi tahlil" }).click();
    await owner.getByLabel("Kod", { exact: true }).fill(CODE);
    await owner.getByLabel("Nomi", { exact: true }).fill(TEST_NAME);
    await owner.getByLabel("Narx", { exact: true }).fill("85000");
    await owner.getByLabel("Namuna turi").fill("qon");
    await owner.getByLabel("Bajarilish muddati").fill("120");
    await owner.getByLabel("Bo‘lim", { exact: true }).selectOption({ label: `Qon ${suffix}` });
    await owner.getByRole("button", { name: "Saqlash" }).click();
    check(await owner.getByRole("status").filter({ hasText: "Saqlandi" }).waitFor({ timeout: 10_000 }).then(() => true, () => false), "the test is saved");
    check(await owner.getByText("Parametrlar va me‘yorlar").isVisible(), "parameters can be added once the test exists");

    await owner.getByLabel("Parametr kodi").fill("HGB");
    await owner.getByLabel("Parametr nomi").fill("Gemoglobin");
    await owner.getByLabel("Birlik", { exact: true }).fill("g/L");
    await owner.getByRole("button", { name: "Parametr qo‘shish" }).click();
    check(await owner.getByText("Gemoglobin").first().waitFor({ timeout: 10_000 }).then(() => true, () => false), "the parameter is listed");

    await owner.getByRole("button", { name: "+ Me‘yor qo‘shish" }).click();
    await owner.getByLabel("Pastki chegara").fill("120");
    await owner.getByLabel("Yuqori chegara").fill("160");
    await owner.getByLabel("Kritik past").fill("70");
    await owner.getByRole("button", { name: "Me‘yorni saqlash" }).click();
    check(await owner.getByText(/120 – 160/).first().waitFor({ timeout: 10_000 }).then(() => true, () => false), "the reference range is listed");
    await owner.screenshot({ path: `${SHOTS}/lab-test-editor.png`, fullPage: true });

    // An impossible range is refused with a message, nothing is saved.
    await owner.getByRole("button", { name: "+ Me‘yor qo‘shish" }).click();
    await owner.getByLabel("Pastki chegara").fill("10");
    await owner.getByLabel("Yuqori chegara").fill("5");
    await owner.getByRole("button", { name: "Me‘yorni saqlash" }).click();
    check(await owner.getByText(/noto‘g‘ri/i).first().waitFor({ timeout: 10_000 }).then(() => true, () => false), "an inverted range is refused with a message");
    await owner.getByRole("button", { name: "Bekor qilish" }).first().click();
    await owner.getByRole("button", { name: "Yopish" }).first().click();
    check(await owner.getByText(CODE).first().isVisible(), "the test is in the list");

    // Panel
    await owner.getByRole("button", { name: "Paketlar" }).click();
    await owner.getByRole("button", { name: "Yangi paket" }).click();
    await owner.getByLabel("Paket kodi").fill(`P-${suffix}`.slice(0, 30));
    await owner.getByLabel("Paket nomi").fill(`Asosiy paket ${suffix}`);
    await owner.getByRole("checkbox", { name: new RegExp(TEST_NAME) }).check();
    await owner.getByRole("button", { name: "Saqlash" }).click();
    check(await owner.getByText(`Asosiy paket ${suffix}`).waitFor({ timeout: 10_000 }).then(() => true, () => false), "the panel is listed");

    // Workflow settings persist
    await owner.getByRole("button", { name: "Ish tartibi" }).click();
    const separate = owner.getByRole("checkbox", { name: /boshqa bo‘lsin/ });
    await separate.waitFor();
    if (!(await separate.isChecked())) await separate.check();
    await owner.getByRole("button", { name: "Saqlash" }).click();
    check(await owner.getByRole("status").filter({ hasText: "Saqlandi" }).waitFor({ timeout: 10_000 }).then(() => true, () => false), "the settings are saved");
    await owner.reload();
    await owner.getByRole("button", { name: "Ish tartibi" }).click();
    check(await owner.getByRole("checkbox", { name: /boshqa bo‘lsin/ }).isChecked(), "the settings persist across a reload");
    await owner.screenshot({ path: `${SHOTS}/lab-settings.png`, fullPage: true });

    const [row] = await db`select clinic_id, updated_by, price::text from public.lab_tests where code = ${CODE}`;
    check(row?.clinic_id === CLINIC && row.updated_by !== null && row.price === "85000.00", "the stored test belongs to the owner's clinic and records its author");
    await ownerContext.close();

    // ---------- A receptionist has no laboratory configuration ----------
    const { context: recContext, page: reception } = await signIn(browser, report, DEMO.reception, "desktop", { expectDenials: true });
    check((await reception.getByRole("link", { name: "Laboratoriya", exact: true }).count()) === 0, "a receptionist sees no Laboratoriya link");
    const denied = await reception.request.get(`${BASE}/api/admin/lab/tests`);
    check(denied.status() === 403, "a receptionist is refused by the laboratory API");
    check((await reception.request.post(`${BASE}/api/admin/lab/tests`, { data: { code: "NO", name: "no", price: 1 } })).status() === 403, "a receptionist cannot create a test");
    await recContext.close();

    // ---------- The technician works from the laboratory workspace ----------
    const { context: labContext, page: lab } = await loginLab(browser);
    check(new URL(lab.url()).pathname === "/lab", "a technician lands in the laboratory workspace");
    await lab.goto(`${BASE}/lab/catalog`);
    check(await lab.getByText(TEST_NAME).waitFor({ timeout: 10_000 }).then(() => true, () => false), "the technician sees the clinic's tests");
    check((await lab.getByRole("button", { name: "Yangi tahlil" }).count()) === 0, "…without any way to configure them");
    await lab.getByRole("row", { name: new RegExp(CODE) }).getByRole("button", { name: "Ko‘rish" }).click();
    check(await lab.getByText("Gemoglobin").first().waitFor({ timeout: 10_000 }).then(() => true, () => false), "the parameters are shown");
    check(await lab.getByText(/120 – 160/).first().isVisible(), "…with the reference range");
    await lab.screenshot({ path: `${SHOTS}/lab-workspace.png`, fullPage: true });
    // Other workspaces send the technician back; the APIs refuse.
    await lab.goto(`${BASE}/admin`);
    await lab.waitForURL(/\/lab/, { timeout: 15_000 });
    check(new URL(lab.url()).pathname === "/lab", "/admin sends a technician back to the laboratory workspace");
    await lab.goto(`${BASE}/doctor`);
    await lab.waitForURL(/\/lab/, { timeout: 15_000 });
    check(new URL(lab.url()).pathname === "/lab", "/doctor does too");
    for (const path of ["/api/admin/patients", "/api/admin/appointments/referral-warnings", "/api/admin/dashboard", "/api/admin/staff/members"]) {
      const res = await lab.request.get(`${BASE}${path}`);
      check(res.status() === 403, `the technician is refused by ${path}`);
    }
    check((await lab.request.post(`${BASE}/api/admin/lab/tests`, { data: { code: "NO2", name: "no", price: 1 } })).status() === 403, "the technician cannot create a test");
    await labContext.close();
  } finally {
    await browser.close();
  }
}

try {
  await run();
  process.exitCode = report.finish();
} catch (e) {
  process.exitCode = report.abort(e);
} finally {
  await db.end({ timeout: 5 });
}

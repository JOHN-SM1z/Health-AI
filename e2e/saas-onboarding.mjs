// End-to-end, in the BUILT app, through the real screens (owner decision 2026-10-10):
//
//   Landing page — the product, the plans from the database, sign-up links; a Telegram launch at "/" goes to the
//   patient menu.
//   Sign-up — a new clinic signs itself up and its owner lands in the panel with the setup checklist.
//   One web app — the owner adds an employee by login in a department; the employee signs in on the same login page,
//   must replace the temporary password first, then lands on their own panel.
//   Billing — the owner sees the trial and the invoice; only a platform admin confirms the transfer, which activates
//   the subscription.
//
// Needs the local stack, `node e2e/seed-demo.mjs`, and the app running. Rerunnable.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { BASE, VIEWPORTS, assertLocalOnly, connect, createReport } from "./lib.mjs";

assertLocalOnly();
const SHOTS = process.env.E2E_ARTIFACTS_DIR ?? "test-results/e2e";
mkdirSync(SHOTS, { recursive: true });
const report = createReport("clinic sign-up E2E");
const { check } = report;
const db = connect();
const suffix = Date.now().toString(36);
const ownerLogin = `egasi.${suffix}`;
const ownerPassword = `Owner-${randomUUID().slice(0, 12)}`;
const staffLogin = `qabul.${suffix}`;
const platformLogin = `platform.${suffix}`;
const platformPassword = `Platform-${randomUUID().slice(0, 12)}`;
let clinicId = null;

function watch(page, who) {
  page.on("pageerror", (e) => report.problems.push(`[${who}] pageerror: ${e.message}`));
  page.on("response", (r) => r.status() >= 500 && report.problems.push(`[${who}] HTTP ${r.status()} ${r.url()}`));
}

async function signInAs(browser, login, password, viewport = "desktop") {
  const context = await browser.newContext({ viewport: VIEWPORTS[viewport], isMobile: viewport === "phone", hasTouch: viewport !== "desktop" });
  const page = await context.newPage();
  watch(page, login);
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Login").fill(login);
  await page.getByLabel("Parol").fill(password);
  await page.getByRole("button", { name: "Kirish" }).click();
  return { context, page };
}

async function run() {
  const browser = await chromium.launch();
  try {
    // ---------- Landing page ----------
    const visitor = await browser.newContext({ viewport: VIEWPORTS.phone, isMobile: true, hasTouch: true });
    const v = await visitor.newPage();
    watch(v, "visitor");
    await v.goto(`${BASE}/`);
    await v.getByRole("heading", { level: 1 }).waitFor();
    check((await v.getByRole("heading", { level: 1 }).textContent())?.includes("Telegram"), "the landing page leads with the product");
    const [plan] = await db`select name, monthly_price_uzs from public.subscription_plans where is_public order by sort_order limit 1`;
    check(await v.getByText(plan.name, { exact: true }).first().isVisible(), "plans come from the database");
    const overflow = await v.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 1, "no sideways scrolling on a phone");
    await v.screenshot({ path: `${SHOTS}/landing-phone.png`, fullPage: true });
    await visitor.close();
    // A Telegram Mini App that opens the bare domain belongs on the patient menu (a fresh load, as Telegram does).
    const launch = await browser.newContext({ viewport: VIEWPORTS.phone, isMobile: true, hasTouch: true });
    const t = await launch.newPage();
    await t.goto(`${BASE}/#tgWebAppData=query_id%3Dx&tgWebAppVersion=8.0&tgWebAppPlatform=ios`);
    await t.waitForURL(/\/home/, { timeout: 15_000 });
    check(true, "a Telegram launch at / is forwarded to the patient menu");
    await launch.close();

    // ---------- Sign-up ----------
    const signupContext = await browser.newContext({ viewport: VIEWPORTS.desktop });
    const s = await signupContext.newPage();
    watch(s, "signup");
    await s.goto(`${BASE}/signup?plan=start`);
    await s.getByPlaceholder("Masalan: Shifo Nur").fill(`E2E Klinika ${suffix}`);
    await s.getByPlaceholder("Toshkent").fill("Samarqand");
    await s.getByPlaceholder("+998 71 200 00 00").fill("+998 66 200 00 00");
    await s.getByPlaceholder("Aziza Rahimova").fill("Egasi Sinov");
    await s.getByPlaceholder("+998 90 123 45 67").fill("+998 90 000 00 01");
    await s.getByPlaceholder("aziza.rahimova").fill(ownerLogin);
    await s.locator('input[type="password"]').nth(0).fill(ownerPassword);
    await s.locator('input[type="password"]').nth(1).fill(ownerPassword);
    await s.getByRole("checkbox").check();
    await s.screenshot({ path: `${SHOTS}/signup.png`, fullPage: true });
    await s.getByRole("button", { name: "Klinikani ro‘yxatdan o‘tkazish" }).click();
    await s.waitForURL(/\/admin/, { timeout: 20_000 });
    check(true, "the new owner is signed in straight after sign-up");
    const [clinic] = await db`select c.id, s.status from public.clinics c join public.clinic_subscriptions s on s.clinic_id = c.id
                              where c.name = ${`E2E Klinika ${suffix}`}`;
    clinicId = clinic?.id ?? null;
    check(clinic?.status === "trialing", "the clinic starts on a trial");
    await s.getByText("Klinikani ishga tushirish").waitFor({ timeout: 15_000 });
    check(true, "the owner sees the setup checklist");
    await s.screenshot({ path: `${SHOTS}/owner-checklist.png`, fullPage: true });

    // ---------- The owner adds an employee by login, in a department ----------
    await s.goto(`${BASE}/admin/staff`);
    await s.getByLabel("Xodimning to‘liq ismi").fill("Dilnoza Qabul");
    await s.getByLabel("Xodimning logini").fill(staffLogin);
    await s.getByLabel("Yangi xodim roli").selectOption("receptionist");
    await s.getByLabel("Yangi xodim bo‘limi").selectOption({ label: "Qabulxona" });
    await s.getByRole("button", { name: "Xodim qo‘shish" }).click();
    const temporary = (await s.getByTestId("temporary-password").textContent())?.trim() ?? "";
    check(temporary.length >= 12 && (await s.getByTestId("handover-login").textContent())?.trim() === staffLogin, "the login and a one-time password are shown once");
    const [member] = await db`select r.role, d.name as department, p.must_change_password from public.staff_roles r
                              join public.profiles p on p.id = r.profile_id left join public.departments d on d.id = r.department_id
                              where p.login = ${staffLogin}`;
    check(member?.role === "receptionist" && member?.department === "Qabulxona" && member?.must_change_password === true, "stored with role, department and a pending password");

    // ---------- The employee: same login page, own password first, then their panel ----------
    const { context: staffContext, page: e } = await signInAs(browser, staffLogin, temporary, "phone");
    await e.waitForURL(/\/account\/password/, { timeout: 15_000 });
    check(true, "a temporary password opens the password change first");
    const own = `Own-${randomUUID().slice(0, 14)}`;
    await e.getByLabel("Joriy parol").fill(temporary);
    await e.getByLabel("Yangi parol", { exact: true }).fill(own);
    await e.getByLabel("Yangi parol takrori").fill(own);
    await e.getByRole("button", { name: "Parolni o‘zgartirish" }).click();
    await e.waitForURL(/\/admin/, { timeout: 15_000 });
    check((await e.getByRole("link", { name: "Obuna" }).count()) === 0, "the receptionist lands on their panel without billing");
    await staffContext.close();

    // ---------- Billing: invoice for the owner, confirmation only by the platform ----------
    await s.goto(`${BASE}/admin/billing`);
    await s.getByText("Sinov davri", { exact: false }).first().waitFor();
    const [invoice] = await db`select id, number from public.subscription_invoices where clinic_id = ${clinicId} and status = 'issued'`;
    check(await s.getByText(invoice.number).first().isVisible(), "the owner sees the open invoice");
    const forged = await s.evaluate(async (id) => (await fetch("/api/platform/invoices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ invoiceId: id, reference: "FAKE-1" }) })).status, invoice.id);
    check(forged === 403, "an owner cannot confirm their own payment (403)");
    await s.screenshot({ path: `${SHOTS}/owner-billing.png`, fullPage: true });
    await signupContext.close();

    // A platform admin (created for this run) confirms the transfer.
    const authUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const createdRes = await fetch(`${authUrl}/auth/v1/admin/users`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
      body: JSON.stringify({ email: `${platformLogin}@staff.health-ai.invalid`, password: platformPassword, email_confirm: true }),
    });
    const platform = await createdRes.json();
    if (!createdRes.ok || !platform.id) throw new Error(`platform admin account: HTTP ${createdRes.status}`);
    await db`insert into public.profiles (id, full_name, login) values (${platform.id}, 'Platform E2E', ${platformLogin})`;
    await db`insert into public.platform_admins (profile_id) values (${platform.id})`;
    const { context: pContext, page: p } = await signInAs(browser, platformLogin, platformPassword);
    await p.waitForURL(/\/platform/, { timeout: 15_000 });
    await p.getByRole("button", { name: /To‘lovlar/ }).click();
    await p.getByLabel(`${invoice.number} to‘lov raqami`).fill(`PP-${suffix}`);
    await p.locator("tr", { hasText: invoice.number }).getByRole("button", { name: "Pul tushdi" }).click();
    await p.locator("tr", { hasText: invoice.number }).getByText(`№ PP-${suffix}`).waitFor({ timeout: 15_000 });
    const [after] = await db`select s.status, s.current_period_end > now() + interval '1 month' as extended, i.status as invoice
                             from public.clinic_subscriptions s join public.subscription_invoices i on i.clinic_id = s.clinic_id
                             where s.clinic_id = ${clinicId} and i.id = ${invoice.id}`;
    check(after?.status === "active" && after?.extended && after?.invoice === "paid", "the confirmed transfer activates the subscription");
    await p.screenshot({ path: `${SHOTS}/platform-invoices.png`, fullPage: true });
    await pContext.close();
  } finally {
    await browser.close();
  }
}

let code;
try {
  await run();
  code = report.finish();
} catch (e) {
  code = report.abort(e);
} finally {
  // Rerunnable and tidy: the run's clinic, its accounts and the platform admin go away.
  if (clinicId) {
    const owners = await db`select profile_id from public.staff_roles where clinic_id = ${clinicId}`.catch(() => []);
    await db`delete from public.clinics where id = ${clinicId}`.catch(() => {});
    for (const o of owners) await db`delete from auth.users where id = ${o.profile_id}`.catch(() => {});
  }
  await db`delete from public.platform_admins where profile_id in (select id from public.profiles where login = ${platformLogin})`.catch(() => {});
  await db`delete from auth.users where email = ${`${platformLogin}@staff.health-ai.invalid`}`.catch(() => {});
  await db.end({ timeout: 5 });
}
process.exit(code);

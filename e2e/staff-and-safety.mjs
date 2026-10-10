// End-to-end, in the BUILT app, through the real screens:
//
//   Staff management — the owner adds a receptionist; the one-time password
//   signs in; the receptionist changes it; the new one works and the
//   receptionist sees no staff management; the owner removes them and their
//   open session loses the panel on its next page.
//   Urgent escalation — a conversation flagged urgent is shown first and
//   flagged to reception, and counted on the dashboard.
//   Referral badge — the receiving doctor sees how many referrals await them.
//
// Needs the local stack, `node e2e/seed-demo.mjs`, and the app running
// (`npm run build && npm start`). Rerunnable.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { BASE, DEMO, VIEWPORTS, assertLocalOnly, connect, createReport, runFixture, signIn } from "./lib.mjs";

assertLocalOnly();
const SHOTS = process.env.E2E_ARTIFACTS_DIR ?? "test-results/e2e";
mkdirSync(SHOTS, { recursive: true });
const report = createReport("staff and safety E2E");
const { check } = report;
const db = connect();
const suffix = Date.now().toString(36);
const CLINIC = "e2e00000-0000-4000-8000-000000000001";

async function login(browser, email, password, viewport = "desktop") {
  const context = await browser.newContext({ viewport: VIEWPORTS[viewport], isMobile: viewport === "phone", hasTouch: viewport !== "desktop" });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.problems.push(`[${email}] pageerror: ${e.message}`));
  page.on("response", (r) => r.status() >= 500 && report.problems.push(`[${email}] HTTP ${r.status()} ${r.url()}`));
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Login").fill(email);
  await page.getByLabel("Parol").fill(password);
  await page.getByRole("button", { name: "Kirish" }).click();
  return { context, page };
}

async function run() {
  const browser = await chromium.launch();
  try {
    // ---------- The owner adds a receptionist ----------
    const { context: ownerContext, page: owner } = await signIn(browser, report, DEMO.owner, "desktop");
    check(await owner.getByRole("link", { name: "Xodimlar" }).first().isVisible(), "the owner has a Xodimlar section");
    await owner.getByRole("link", { name: "Xodimlar" }).first().click();
    await owner.getByLabel("Xodimning to‘liq ismi").waitFor();
    // Employees sign in with a login, not an email (owner decision 2026-10-10).
    const email = `qabul.${suffix}`.toLowerCase();
    await owner.getByLabel("Xodimning to‘liq ismi").fill(`Yangi Qabulxona ${suffix}`);
    await owner.getByLabel("Xodimning logini").fill(email);
    await owner.getByLabel("Yangi xodim roli").selectOption("receptionist");
    await owner.getByRole("button", { name: "Xodim qo‘shish" }).click();
    const temporary = (await owner.getByTestId("temporary-password").textContent())?.trim() ?? "";
    check(temporary.length >= 12, "the one-time password is shown to the owner once");
    await owner.screenshot({ path: `${SHOTS}/staff-added.png`, fullPage: true });
    // The list reloads after the add: wait for the row instead of sampling the page once.
    const listed = await owner.getByText(email, { exact: true }).waitFor({ timeout: 15_000 }).then(() => true, () => false);
    check(listed, "the new receptionist is listed with their login");

    // ---------- The receptionist signs in and changes the password (phone) ----------
    const { context: newContext, page: newcomer } = await login(browser, email, temporary, "phone");
    // A temporary password opens no panel: first stop is setting their own password, and the API refuses meanwhile.
    await newcomer.waitForURL(/\/account\/password/, { timeout: 15_000 });
    check(true, "the one-time password signs in, straight to the password change");
    const pending = await newcomer.evaluate(async () => (await fetch("/api/admin/appointments")).json().then((j) => j.code));
    check(pending === "password_change_required", "the API refuses an account still on its temporary password");
    await newcomer.goto(`${BASE}/admin`);
    await newcomer.waitForURL(/\/account\/password/, { timeout: 15_000 });
    check(true, "the panel sends a temporary-password account back to the password change");
    const newPassword = `Qabul-${randomUUID()}`;
    await newcomer.getByLabel("Joriy parol").fill(temporary);
    await newcomer.getByLabel("Yangi parol", { exact: true }).fill(newPassword);
    await newcomer.getByLabel("Yangi parol takrori").fill(newPassword);
    await newcomer.getByRole("button", { name: "Parolni o‘zgartirish" }).click();
    await newcomer.waitForURL(/\/admin/, { timeout: 15_000 });
    check(true, "the receptionist replaces the one-time password and lands on their panel");
    check((await newcomer.getByRole("link", { name: "Xodimlar" }).count()) === 0, "a receptionist has no staff management");
    const denied = await newcomer.evaluate(async () => (await fetch("/api/admin/staff/members")).status);
    check(denied === 403, "the staff API refuses a receptionist (403)");
    await newcomer.screenshot({ path: `${SHOTS}/password-changed-phone.png`, fullPage: true });

    const { context: againContext, page: again } = await login(browser, email, newPassword);
    await again.waitForURL(/\/admin/, { timeout: 15_000 });
    check(true, "the new password signs in");
    await againContext.close();
    const { context: oldContext, page: old } = await login(browser, email, temporary);
    await old.getByText("Kirish amalga oshmadi").waitFor();
    check(true, "the one-time password no longer works");
    await oldContext.close();

    // ---------- The owner removes them: the open session loses the panel ----------
    await owner.reload();
    const row = owner.locator("tr", { hasText: email });
    await row.getByRole("button", { name: "Olib tashlash" }).click();
    await row.getByRole("button", { name: "Ha, olib tashlash" }).click();
    await row.waitFor({ state: "detached" });
    check(true, "the owner removes the receptionist");
    await newcomer.goto(`${BASE}/admin`);
    await newcomer.waitForURL(/\/login/, { timeout: 15_000 });
    check(true, "the removed receptionist's open session is sent to the login page");
    await newContext.close();
    await ownerContext.close();

    // ---------- Urgent wording reaches reception ----------
    const [patient] = await db`
      insert into public.patients (clinic_id, full_name, telegram_user_id)
      values (${CLINIC}, ${`Shoshilinch Bemor ${suffix}`}, ${800_000_000 + Math.floor(Math.random() * 90_000_000)}) returning id`;
    await db`insert into public.conversations (clinic_id, patient_id, channel, status, ai_enabled, urgent_at)
             values (${CLINIC}, ${patient.id}, 'telegram', 'open', false, now())`;
    const { context: receptionContext, page: reception } = await signIn(browser, report, DEMO.reception, "desktop");
    await reception.getByText("Shoshilinch suhbatlar").waitFor();
    const urgentTile = await reception.locator("a", { hasText: "Shoshilinch suhbatlar" }).textContent();
    check(/[1-9]/.test(urgentTile ?? ""), "the dashboard counts the urgent conversation");
    await reception.goto(`${BASE}/admin/conversations`);
    const firstRow = reception.locator("tbody tr").first();
    await firstRow.waitFor();
    check((await firstRow.textContent())?.includes("Shoshilinch") ?? false, "the urgent conversation is listed first, flagged");
    await reception.screenshot({ path: `${SHOTS}/urgent-conversation.png` });
    await receptionContext.close();

    // ---------- The receiving doctor's referral badge ----------
    // A referral waiting for Dr Nazarova, from a completed visit with Dr Aliyev.
    const [referrer] = await db`select d.id, d.profile_id from public.doctors d join auth.users u on u.id = d.profile_id where u.email = ${DEMO.referrer}`;
    const [receiver] = await db`select d.id from public.doctors d join auth.users u on u.id = d.profile_id where u.email = ${DEMO.receiver}`;
    const [service] = await db`select id from public.services where clinic_id = ${CLINIC} order by created_at limit 1`;
    const [referred] = await db`insert into public.patients (clinic_id, full_name) values (${CLINIC}, ${`Yo‘llanma Bemor ${suffix}`}) returning id`;
    // A day far in the past that no other run uses, so the visit never overlaps another.
    const slot = runFixture().nextSlot(20);
    const [visit] = await db`
      insert into public.appointments (clinic_id, patient_id, doctor_id, service_id, start_at, end_at, status, source)
      values (${CLINIC}, ${referred.id}, ${referrer.id}, ${service.id}, ${slot.start}, ${slot.end}, 'completed', 'walk_in')
      returning id`;
    await db`insert into public.referrals ${db({
      clinic_id: CLINIC,
      patient_id: referred.id,
      referring_doctor_id: referrer.id,
      referred_to_doctor_id: receiver.id,
      originating_appointment_id: visit.id,
      reason: `Badge check (${suffix})`,
      priority: "routine",
      created_by: referrer.profile_id,
    })}`;
    const [{ pending }] = await db`
      select count(*)::int as pending from public.referrals r
        join public.doctors d on d.id = r.referred_to_doctor_id
        join auth.users u on u.id = d.profile_id
       where u.email = ${DEMO.receiver} and r.status = 'pending' and r.expires_at > now()`;
    const { context: doctorContext, page: doctor } = await signIn(browser, report, DEMO.receiver, "desktop");
    const badge = doctor.getByLabel(/ta yangi yo‘llanma/);
    if (pending > 0) {
      await badge.first().waitFor();
      check((await badge.first().textContent()) === String(pending), `the badge shows the ${pending} referral(s) awaiting the doctor`);
    } else {
      await doctor.waitForTimeout(1500);
      check((await badge.count()) === 0, "no badge when nothing awaits the doctor");
    }
    await doctorContext.close();

    // Rerunnable: the badge referral and the urgent conversation are closed again.
    await db`update public.referrals set status = 'revoked', revoked_by = ${referrer.profile_id}, revoked_reason = 'E2E badge check'
             where originating_appointment_id = ${visit.id}`;
    await db`update public.conversations set status = 'closed' where patient_id = ${patient.id}`;
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
  await db.end({ timeout: 5 });
}
process.exit(code);

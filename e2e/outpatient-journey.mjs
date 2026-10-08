// The outpatient pilot journey in real browsers against the built app and a
// LOCAL Supabase stack (e2e/seed-demo.mjs), with real logins:
//   reception identifies (new patient, then the returning one with identity
//   confirmation), registers, and cannot take money →
//   the cashier takes a split cash/terminal payment and the queue number
//   appears (no paper: the waiting-room screen and the patient's Telegram) →
//   the doctor calls, starts and completes from their live queue →
//   a partial refund is refused for the cashier until the manager grants it,
//   and the ledger records who authorized and who executed it.
// Rerunnable: run-unique patient identity.
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { BASE, DEMO, DEMO_NAMES, assertLocalOnly, connect, createReport, runFixture, signIn } from "./lib.mjs";

assertLocalOnly();
const report = createReport("outpatient journey E2E");
const { check } = report;
const db = connect();
const { suffix } = runFixture();

const PATIENT = `Yo‘lchiyev Sardor ${suffix}`;
const DOC = `AD${String(Date.now()).slice(-7)}`;

async function run() {
  const [reception] = await db`select sr.clinic_id from auth.users u join public.staff_roles sr on sr.profile_id = u.id where u.email = ${DEMO.reception}`;
  const [cashierRole] = await db`select sr.profile_id from auth.users u join public.staff_roles sr on sr.profile_id = u.id where u.email = ${DEMO.cashier}`;
  const [managerRole] = await db`select sr.profile_id from auth.users u join public.staff_roles sr on sr.profile_id = u.id where u.email = ${DEMO.manager}`;
  if (!reception || !cashierRole || !managerRole) throw new Error("demo staff missing — run node e2e/seed-demo.mjs");
  const clinic = reception.clinic_id;
  // A fresh run starts with no refund permission for the demo cashier.
  await db`update public.refund_grants set revoked_by = ${managerRole.profile_id}, revoked_at = now(), revoke_reason = 'E2E: fresh run'
           where clinic_id = ${clinic} and profile_id = ${cashierRole.profile_id} and revoked_at is null`;
  // The demo doctor must be free now: other scripts book them "now", and an
  // earlier run (before 20261007000003) left completed walk-ins holding their
  // full booked slot. Local E2E database only (assertLocalOnly).
  const [doctor] = await db`select id from public.doctors where clinic_id = ${clinic} and name = ${DEMO_NAMES.referrer}`;
  await db`update public.appointments set status = 'cancelled', cancelled_at = now(), cancelled_reason = 'E2E: an earlier run'
           where doctor_id = ${doctor.id} and status not in ('cancelled', 'no_show', 'completed')
             and tstzrange(start_at, end_at) && tstzrange(now() - interval '3 hours', now() + interval '3 hours')`;
  await db`update public.appointments set end_at = greatest(start_at + interval '1 minute', now())
           where doctor_id = ${doctor.id} and status = 'completed' and end_at > now() and start_at < now()`;
  await db`update public.visits set status = 'cancelled', cancelled_at = now(), cancel_reason = 'E2E: an earlier run'
           where doctor_id = ${doctor.id} and status in ('awaiting_payment', 'waiting', 'called')
             and not exists (select 1 from public.visit_transactions t where t.visit_id = visits.id)`;

  const browser = await chromium.launch();
  let visitId = "";
  let queueNumber = 0;
  try {
    // ---------- Reception: new patient, registration, no money ----------
    {
      const { context, page } = await signIn(browser, report, DEMO.reception, "desktop", { expectDenials: true });
      await page.getByRole("link", { name: "Qabulxona" }).first().click();
      await page.waitForURL(/\/admin\/reception$/);
      await page.getByLabel("Bemorni qidirish").fill(DOC);
      await page.getByRole("button", { name: "Qidirish" }).click();
      await page.getByText("Topilmadi.").waitFor();
      check(true, "reception searches by passport number first — not found");

      await page.getByRole("button", { name: "Yangi bemor" }).click();
      await page.getByLabel("F.I.Sh.").fill(PATIENT);
      await page.getByLabel("Tug‘ilgan sana", { exact: true }).fill("1991-04-12");
      await page.getByLabel("Pasport / ID raqami").fill(DOC);
      await page.getByLabel("Telefon").fill("+998 90 555 66 77");
      await page.getByLabel("Shifokor").selectOption({ label: `${DEMO_NAMES.referrer} — Terapevt` });
      await page.getByRole("group", { name: "Xizmatlar" }).getByText(DEMO_NAMES.generalService).click();
      await page.getByRole("button", { name: "Ro‘yxatga olish" }).click();
      await page.getByText(/ro‘yxatga olindi\. Bemorni kassaga yo‘naltiring/).waitFor();
      check(true, "a new patient is registered in one step and sent to the kassa");

      const [visit] = await db`select v.id, v.status, v.queue_number, p.patient_number from public.visits v join public.patients p on p.id = v.patient_id
                               where v.clinic_id = ${clinic} and p.document_number = ${DOC}`;
      visitId = visit.id;
      check(visit.status === "awaiting_payment" && visit.queue_number === null, "no queue number before payment");
      const queueRow = page.getByRole("row", { name: new RegExp(PATIENT) });
      await queueRow.waitFor();
      check(await queueRow.getByText("Kassada to‘lov kutilmoqda").isVisible(), "the live queue shows the patient waiting for the kassa");

      // Returning patient: found by passport, selected only after confirming identity.
      await page.getByLabel("Bemorni qidirish").fill(DOC.toLowerCase());
      await page.getByRole("button", { name: "Qidirish" }).click();
      await page.getByRole("button", { name: "Tanlash" }).first().click();
      const dialog = page.getByRole("dialog", { name: "Shaxsini tasdiqlang" });
      const select = dialog.getByRole("button", { name: "Tanlash" });
      check(await select.isDisabled(), "selecting a found patient needs the identity confirmation first");
      await dialog.getByRole("checkbox").check();
      await select.click();
      await page.getByText(`Karta № ${visit.patient_number} · 1991-04-12`).waitFor();
      await page.getByLabel("Shifokor").selectOption({ label: `${DEMO_NAMES.referrer} — Terapevt` });
      await page.getByRole("group", { name: "Xizmatlar" }).getByText(DEMO_NAMES.generalService).click();
      await page.getByRole("button", { name: "Ro‘yxatga olish" }).click();
      await page.getByText("Bemor bu shifokorga allaqachon ro‘yxatdan o‘tgan").waitFor();
      check(true, "a duplicate registration with the same doctor is refused");

      // Reception cannot take money, even by calling the API directly.
      // (context.request shares the session cookies; deliberate refusals stay out of the page console.)
      const forbidden = (
        await context.request.post(`${BASE}/api/operations/kassa/${visitId}/pay`, {
          data: { key: randomUUID(), expectedOutstanding: 150000, lines: [{ method: "cash", amount: 150000 }] },
        })
      ).status();
      check(forbidden === 403, "reception's direct payment request is refused (403)");
      await context.close();
    }

    // ---------- Cashier: split payment → queue number ----------
    {
      const { context, page } = await signIn(browser, report, DEMO.cashier, "desktop", { expectForbidden: true });
      await page.waitForURL(/\/kassa$/);
      check(true, "a cashier signs in straight to the kassa workspace");
      const card = page.getByRole("region", { name: "To‘lov kutilmoqda" }).locator("div.rounded-2xl", { hasText: PATIENT });
      await card.waitFor();
      check(await card.getByText("150 000").first().isVisible().catch(() => false) || (await card.textContent()).includes("150"), "the itemized bill shows the server price");
      check((await card.getByRole("button", { name: "Qaytarish" }).count()) === 0, "no refund button without a manager's permission");

      // A forged field in the body is refused.
      const forged = (
        await context.request.post(`${BASE}/api/operations/kassa/${visitId}/pay`, {
          data: { key: randomUUID(), expectedOutstanding: 150000, lines: [{ method: "cash", amount: 150000 }], clinicId: "00000000-0000-0000-0000-000000000000" },
        })
      ).status();
      check(forged === 400, "a forged clinicId in the payment body is refused (400)");
      const cannotRegister = (await context.request.post(`${BASE}/api/operations/arrivals`, { data: {} })).status();
      check(cannotRegister === 403, "the cashier cannot register arrivals (403)");

      await card.getByRole("button", { name: "To‘lov qabul qilish" }).click();
      const modal = page.getByRole("dialog", { name: "To‘lov qabul qilish" });
      await modal.getByLabel("Naqd summa").fill("50000");
      check(await modal.getByRole("button", { name: "Qabul qilish" }).isDisabled(), "an amount that does not settle the bill cannot be submitted");
      await modal.getByLabel("Terminal summa").fill("100000");
      await modal.getByRole("button", { name: "Qabul qilish" }).click();
      const notice = page.getByText(/Navbat raqami: (\d+)/);
      await notice.waitFor();
      queueNumber = Number((await notice.textContent()).match(/Navbat raqami: (\d+)/)[1]);
      const rows = await db`select kind, method, amount from public.visit_transactions where visit_id = ${visitId} order by method`;
      check(rows.length === 2 && Number(rows[0].amount) === 50000 && rows[0].method === "cash" && Number(rows[1].amount) === 100000, "one ledger row per method — recorded once");
      const [v] = await db`select status, queue_number from public.visits where id = ${visitId}`;
      check(v.status === "waiting" && v.queue_number === queueNumber, "the queue number is issued on full payment");
      await context.close();
    }

    // ---------- Waiting-room screen: numbers only ----------
    {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      await page.goto(`${BASE}/queue/${clinic}`);
      const panel = page.getByRole("region", { name: DEMO_NAMES.referrer });
      await panel.waitFor();
      check((await panel.textContent()).includes(String(queueNumber)), "the waiting-room screen shows the queue number");
      check(!(await page.content()).includes(PATIENT), "the waiting-room screen never shows a patient's name");
      await context.close();
    }

    // ---------- Doctor: own live queue ----------
    {
      const { context, page } = await signIn(browser, report, DEMO.referrer, "desktop");
      const live = page.getByRole("list", { name: "Jonli navbat" });
      const item = live.locator("li", { hasText: PATIENT });
      await item.waitFor();
      check((await item.textContent()).includes(String(queueNumber)), "the doctor sees the patient in their live queue by number");
      await item.getByRole("button", { name: "Chaqirish" }).click();
      await item.getByText("Chaqirildi").waitFor();
      check(true, "the doctor calls the patient");
      const nearMidnight = (() => {
        const local = new Date(Date.now() + 5 * 3_600_000);
        return 24 * 60 - (local.getUTCHours() * 60 + local.getUTCMinutes()) < 8;
      })();
      if (!nearMidnight) {
        await item.getByRole("button", { name: "Qabulni boshlash" }).click();
        await page.waitForURL(/\/doctor\/patients\/[0-9a-f-]{36}$/);
        await page.getByText(PATIENT).first().waitFor();
        check(true, "starting the consultation opens the patient's workspace");
        const payments = await db`select p.id from public.payments p join public.visits v on v.appointment_id = p.appointment_id where v.id = ${visitId}`;
        check(payments.length === 0, "the consultation adds no second bill");
        await page.goto(`${BASE}/doctor`);
        const again = page.getByRole("list", { name: "Jonli navbat" }).locator("li", { hasText: PATIENT });
        await again.getByRole("button", { name: "Yakunlash" }).click();
        await page.waitForTimeout(500);
        const [done] = await db`select status from public.visits where id = ${visitId}`;
        check(done.status === "completed", "the doctor completes the visit");
      }
      await context.close();
    }

    // ---------- Refunds: manager grants, cashier executes ----------
    {
      const manager = await signIn(browser, report, DEMO.manager, "desktop");
      await manager.page.goto(`${BASE}/kassa`);
      const grants = manager.page.getByRole("region", { name: "Qaytarish ruxsatlari" });
      await grants.waitFor();
      await grants.locator("div", { hasText: "Kassir" }).getByRole("button", { name: "Ruxsat berish" }).last().click();
      await grants.getByText("Ruxsat bor").first().waitFor();
      check(true, "the manager grants refund permission to the cashier");
      await manager.context.close();

      const { context, page } = await signIn(browser, report, DEMO.cashier, "desktop");
      const card = page.locator("div.rounded-2xl", { hasText: PATIENT }).first();
      await card.getByRole("button", { name: "Qaytarish" }).click();
      const modal = page.getByRole("dialog", { name: "Pulni qaytarish" });
      await modal.getByLabel("Qaytarish usuli").selectOption("cash");
      await modal.getByLabel("Qaytarish summasi").fill("20000");
      await modal.getByLabel("Qaytarish sababi").fill("EKG ko‘rsatilmadi (E2E)");
      await modal.getByRole("button", { name: "Qaytarishni qayd etish" }).click();
      await page.getByText("Qaytarish qayd etildi").waitFor();
      const [r] = await db`select executed_by, authorized_by, amount from public.visit_transactions where visit_id = ${visitId} and kind = 'refund'`;
      check(r && r.executed_by === cashierRole.profile_id && r.authorized_by === managerRole.profile_id && Number(r.amount) === 20000, "the partial refund records the cashier who executed and the manager who authorized");
      const totals = page.getByRole("region", { name: "Kassa hisoboti" });
      check((await totals.textContent()).includes("foyda emas"), "kassa totals are labelled as collected money, not profit");
      await context.close();
    }
    void doctor;
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

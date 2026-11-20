// Pay online, get the queue number online (Slice C) — a real browser against the built app and a LOCAL Supabase
// stack, with the signed TEST payment provider (ONLINE_PAYMENT_PROVIDER=test_online, local only) standing in for
// Rahmat:
//   * the patient books in the Mini App, taps "Onlayn to‘lash va navbat olish", pays on the provider's page;
//   * back in the Mini App the number appears — only after the provider's signed webhook settled the payment;
//   * the visit is 'booked' for the slot's day; reception marks "Keldi" and the patient joins the doctor's queue;
//   * the kassa's cash and terminal figures do not include the online money.
// Rerunnable: run-unique patient, document and Telegram id.
import { createHmac } from "node:crypto";
import { chromium } from "playwright";
import { BASE, DEMO, DEMO_NAMES, assertLocalOnly, connect, createReport, pickSlot, runFixture, signIn } from "./lib.mjs";

assertLocalOnly();
const report = createReport("online payment E2E");
const { check } = report;
const db = connect();
const { suffix } = runFixture();
let insertedIntegration = null;

function signInitData(botToken, telegramUserId) {
  const user = JSON.stringify({ id: telegramUserId, first_name: "Bemor" });
  const fields = [["auth_date", String(Math.floor(Date.now() / 1000))], ["query_id", "AAHdF6IQAAAAAN0XohDhrOrc"], ["user", user]];
  const c = fields.map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  return `${fields.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}&hash=${createHmac("sha256", secret).update(c).digest("hex")}`;
}
const launch = (initData) => `#tgWebAppData=${encodeURIComponent(initData)}&tgWebAppVersion=7.0&tgWebAppPlatform=web`;

async function run() {
  if (process.env.ONLINE_PAYMENT_PROVIDER !== "test_online") throw new Error("set ONLINE_PAYMENT_PROVIDER=test_online (and the test secret) for this run");
  const [reception] = await db`select u.id, sr.clinic_id from auth.users u join public.staff_roles sr on sr.profile_id = u.id where u.email = ${DEMO.reception}`;
  if (!reception) throw new Error("demo staff missing — run node e2e/seed-demo.mjs");
  const clinic = reception.clinic_id;
  let [bot] = await db`select telegram_bot_token from public.clinic_telegram_integrations where clinic_id = ${clinic} and enabled and status = 'active'`;
  if (!bot) {
    const token = `${Date.now() % 1_000_000}:E2E${suffix}${"t".repeat(24)}`;
    await db`insert into public.clinic_telegram_integrations ${db({ clinic_id: clinic, telegram_bot_token: token, telegram_bot_id: Date.now() % 1_000_000_000, telegram_username: `e2e_${suffix}_bot`, telegram_bot_name: "E2E", status: "active", enabled: true, validated_at: new Date() })}
             on conflict (clinic_id) do nothing`;
    insertedIntegration = clinic;
    [bot] = await db`select telegram_bot_token from public.clinic_telegram_integrations where clinic_id = ${clinic}`;
  }
  const n = Date.now() % 10_000_000;
  const tg = 980_500_000 + (n % 1_000_000);
  const name = `Onlayn Tolov ${suffix}`;
  const [patient] = await db`insert into public.patients ${db({ clinic_id: clinic, full_name: name, phone: `+998 94 ${String(n).padStart(7, "0")}`, telegram_user_id: tg, document_number: `P${String.fromCharCode(65 + (n % 26))}${String(n).padStart(7, "0")}`, date_of_birth: "1992-02-02", consent_given: true, consent_given_at: new Date() })} returning id`;
  const [{ cash_before, terminal_before }] = await db`
    select coalesce(sum(amount) filter (where method = 'cash'), 0)::float8 as cash_before, coalesce(sum(amount) filter (where method = 'terminal'), 0)::float8 as terminal_before
      from public.visit_transactions where clinic_id = ${clinic}`;

  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => report.problems.push(`[patient] pageerror: ${e.message}`));
    page.on("response", (r) => r.status() >= 500 && report.problems.push(`[patient] HTTP ${r.status()} ${r.url()}`));
    await page.goto(`${BASE}/book?clinic=${clinic}${launch(signInitData(bot.telegram_bot_token, tg))}`);
    await page.getByRole("button", { name: "Ha, davom etish" }).click(); // identity already complete
    await page.getByRole("button", { name: "O‘tkazib yuborish" }).click(); // no concern typed
    await page.getByRole("button", { name: /Kerakli xizmatni bilaman/ }).click();
    await page.getByRole("button", { name: new RegExp(DEMO_NAMES.generalService.replace(/[()]/g, "\\$&")) }).click();
    const slotsResponse = page.waitForResponse((r) => r.url().includes("/api/availability"));
    await page.getByRole("button", { name: new RegExp(DEMO_NAMES.referrer) }).click();
    const shown = (await (await slotsResponse).json()).data.slots;
    const target = shown.find((s) => new Date(s.start).getTime() > Date.now() + 2 * 3_600_000) ?? shown[shown.length - 1];
    await pickSlot(page, shown, target);
    await page.getByRole("button", { name: /^Davom etish: / }).click();
    const created = page.waitForResponse((r) => r.url().includes("/api/bookings") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Tasdiqlash va yozilish" }).click();
    const appointmentId = (await (await created).json()).data.appointment.id;

    // Pay on the provider's page (opens in a new tab), then come back.
    const payButton = page.getByRole("button", { name: /Onlayn to‘lash va navbat olish/ });
    await payButton.waitFor();
    check(true, "after booking the patient is offered to pay online and get the number");
    const [provider] = await Promise.all([ctx.waitForEvent("page"), payButton.click()]);
    await provider.waitForLoadState();
    check(await provider.getByText("Test to‘lov tizimi").isVisible(), "the (test) payment provider's page opens");
    const [{ status: before }] = await db`select status from public.payments where appointment_id = ${appointmentId}`;
    check(before === "unpaid", "nothing is paid by opening the payment page");
    await provider.getByRole("button", { name: "To‘lash" }).click();
    await provider.getByText(/To‘landi/).waitFor();
    await provider.close();

    const ticket = page.getByTestId("online-queue-number");
    await ticket.waitFor({ timeout: 30_000 });
    const [visit] = await db`select id, status, source, queue_number, queue_date::text from public.visits where appointment_id = ${appointmentId}`;
    check(visit?.status === "booked" && visit.source === "online", "the paid booking has a 'booked' online visit");
    check((await ticket.textContent()).includes(String(visit.queue_number)), `the Mini App shows the server-issued number (${visit.queue_number})`);
    const [{ status: after, provider: via }] = await db`select status, provider from public.payments where appointment_id = ${appointmentId}`;
    check(after === "paid" && via === "test_online", "the payment is paid through the provider's signed webhook");
    const jobs = await db`select type from public.notification_jobs where visit_id = ${visit.id}`;
    check(jobs.some((j) => j.type === "queue_ticket"), "the Telegram ticket is queued");
    await ctx.close();

    // Reception marks the patient arrived (when the booking is for today in the clinic).
    const [{ today }] = await db`select (now() at time zone timezone)::date::text as today from public.clinics where id = ${clinic}`;
    if (visit.queue_date === today) {
      const { context: rc, page: r } = await signIn(browser, report, DEMO.reception);
      await r.goto(`${BASE}/admin/reception`);
      const row = r.getByRole("row", { name: new RegExp(name) }).filter({ has: r.getByRole("button", { name: "Keldi" }) });
      await row.waitFor();
      check(true, "reception sees the online payer in 'Bugun onlayn to‘laganlar'");
      await row.getByRole("button", { name: "Keldi" }).click();
      await r.getByRole("row", { name: new RegExp(`${name}.*Navbatda`) }).waitFor();
      const [arrived] = await db`select status, arrived_at from public.visits where id = ${visit.id}`;
      check(arrived.status === "waiting" && arrived.arrived_at !== null, "after 'Keldi' the patient is in the doctor's queue");
      await rc.close();
    } else {
      check(true, `the booking is for ${visit.queue_date}; arrival is marked on that day`);
    }

    const [{ cash_after, terminal_after }] = await db`
      select coalesce(sum(amount) filter (where method = 'cash'), 0)::float8 as cash_after, coalesce(sum(amount) filter (where method = 'terminal'), 0)::float8 as terminal_after
        from public.visit_transactions where clinic_id = ${clinic}`;
    check(cash_after === cash_before && terminal_after === terminal_before, "the kassa's cash and terminal figures do not include online money");
    void patient;
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
  if (insertedIntegration) await db`delete from public.clinic_telegram_integrations where clinic_id = ${insertedIntegration}`.catch(() => {});
  await db.end({ timeout: 5 });
}
process.exit(code);

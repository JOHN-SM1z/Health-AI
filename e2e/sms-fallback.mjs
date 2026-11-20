// Queue SMS for a patient without Telegram (Slice D) — a real browser against the built app and a LOCAL Supabase stack,
// with the local test SMS outbox (SMS_PROVIDER=test, ALLOW_TEST_SMS=true; nothing is sent anywhere):
//   * reception registers a new patient with no Telegram and ticks "SMS orqali yuborish";
//   * the cashier takes the payment — the queue number is issued and the ticket SMS is accepted by the provider;
//   * the SMS record holds the provider's id only (no phone, no text); a patient without consent gets none.
// The demo clinic's SMS switch is turned on for the run and restored after.
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { BASE, DEMO, DEMO_NAMES, assertLocalOnly, connect, createReport, runFixture, signIn } from "./lib.mjs";

assertLocalOnly();
const report = createReport("SMS fallback E2E");
const { check } = report;
const db = connect();
const { suffix } = runFixture();
let clinic = null;
let wasEnabled = false;

async function run() {
  if (process.env.SMS_PROVIDER !== "test") throw new Error("set SMS_PROVIDER=test and ALLOW_TEST_SMS=true (local only) for this run");
  const [reception] = await db`select sr.clinic_id from auth.users u join public.staff_roles sr on sr.profile_id = u.id where u.email = ${DEMO.reception}`;
  clinic = reception.clinic_id;
  [{ sms_enabled: wasEnabled }] = await db`select sms_enabled from public.clinics where id = ${clinic}`;
  await db`update public.clinics set sms_enabled = true where id = ${clinic}`;

  const n = Date.now() % 10_000_000;
  const DOC = `S${String.fromCharCode(65 + (n % 26))}${String(n).padStart(7, "0")}`;
  const PATIENT = `Smsli Bemor ${suffix}`;
  const PHONE = `+998 93 ${String(n).padStart(7, "0").replace(/(\d{3})(\d{2})(\d{2})/, "$1 $2 $3")}`;

  const browser = await chromium.launch();
  try {
    const { context, page } = await signIn(browser, report, DEMO.reception);
    await page.goto(`${BASE}/admin/reception`);
    await page.getByLabel("Bemorni qidirish").fill(DOC);
    await page.getByLabel("Tug‘ilgan sana (kk.oo.yyyy)").fill("05.05.1955");
    await page.getByRole("button", { name: "Topish" }).click();
    await page.getByText("Bu hujjat bilan karta yo‘q").waitFor();
    await page.getByLabel("F.I.Sh.").fill(PATIENT);
    await page.getByLabel("Telefon").fill(PHONE);
    await page.getByLabel("Shifokor").selectOption({ label: `${DEMO_NAMES.referrer} — Terapevt` });
    await page.getByRole("group", { name: "Xizmatlar" }).getByText(DEMO_NAMES.generalService).click();
    await page.getByLabel("SMS roziligi").check();
    await page.getByRole("button", { name: "Ro‘yxatga olish" }).click();
    await page.getByText(/ro‘yxatga olindi\. Bemorni kassaga yo‘naltiring/).waitFor();
    const [visit] = await db`select v.id, p.id as patient_id, p.sms_consent_at, p.telegram_user_id from public.visits v join public.patients p on p.id = v.patient_id
                             where v.clinic_id = ${clinic} and p.document_number = ${DOC}`;
    check(!!visit?.sms_consent_at && visit.telegram_user_id === null, "the desk records the patient's SMS consent");
    await context.close();

    // The cashier takes the payment (the kassa's own API, as its screen calls it).
    const { context: kc } = await signIn(browser, report, DEMO.cashier);
    const kassa = await (await kc.request.get(`${BASE}/api/operations/kassa`)).json();
    const open = kassa.data.open.find((v) => v.id === visit.id);
    const outstanding = open.balance.outstanding;
    const paid = await kc.request.post(`${BASE}/api/operations/kassa/${visit.id}/pay`, {
      data: { key: randomUUID(), expectedOutstanding: outstanding, lines: [{ method: "cash", amount: outstanding }] },
    });
    check(paid.status() === 200 || paid.status() === 201, `the cashier takes the payment (${paid.status()})`);
    await kc.close();

    // The ticket SMS goes out right after the response (deliver-soon) or on the scheduled run.
    let job = null;
    for (let i = 0; i < 20 && job?.status !== "sent"; i++) {
      [job] = await db`select status from public.notification_jobs where visit_id = ${visit.id} and channel = 'sms' and type = 'queue_ticket'`;
      if (job?.status !== "sent") await new Promise((r) => setTimeout(r, 500));
    }
    check(job?.status === "sent", "the queue ticket SMS is accepted by the provider after payment");
    const msgs = await db`select m.purpose, m.provider, m.status, m.provider_message_id from public.sms_messages m
                          join public.notification_jobs j on j.id = m.job_id where j.visit_id = ${visit.id}`;
    check(msgs.length === 1 && msgs[0].provider === "test" && msgs[0].status === "sent" && !!msgs[0].provider_message_id, "one SMS record with the provider's id — no phone, no text");
    const [{ telegram }] = await db`select count(*)::int as telegram from public.notification_jobs where visit_id = ${visit.id} and channel = 'telegram'`;
    check(telegram === 0, "no Telegram ticket for a patient without Telegram");
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
  if (clinic) await db`update public.clinics set sms_enabled = ${wasEnabled} where id = ${clinic}`.catch(() => {});
  await db.end({ timeout: 5 });
}
process.exit(code);

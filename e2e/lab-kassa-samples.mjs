// End-to-end, in the BUILT app, through the real screens — laboratory Kassa and sample collection (phase 5):
//
//   The clinic requires payment before collection. A technician opens the worklist: the order is there, the
//   samples can be prepared, but collection is held back ("payment not received").
//   A receptionist records the payment at Laboratoriya kassa (how it was paid; the amount is the server's),
//   opens the payment confirmation (labelled "not a fiscal receipt") — and has no refund action.
//   The technician now collects the sample and takes it into processing.
//   The owner refunds the payment: the payment shows refunded, the collected sample stays as it was.
//   The APIs refuse the wrong roles; the audit trail holds ids only.
//
// Needs the local stack, `node e2e/seed-demo.mjs`, and the app running (`npm run build && npm start`). Rerunnable.
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { BASE, DEMO, DEMO_NAMES, PASSWORD, VIEWPORTS, assertLocalOnly, connect, createReport, runFixture, signIn } from "./lib.mjs";

assertLocalOnly();
const SHOTS = process.env.E2E_ARTIFACTS_DIR ?? "test-results/e2e";
mkdirSync(SHOTS, { recursive: true });
const report = createReport("laboratory Kassa and samples E2E");
const { check } = report;
const db = connect();
const { suffix } = runFixture();
const PATIENT = `E2E Bemor ${suffix}`;
const NOTE = `Och qoringa (${suffix})`;
const shown = (locator) => locator.waitFor({ timeout: 8_000 }).then(() => true, () => false);

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
  const [doctor] = await db`select d.id, d.profile_id, d.clinic_id from public.doctors d join auth.users u on u.id = d.profile_id where u.email = ${DEMO.referrer}`;
  if (!doctor) throw new Error("run node e2e/seed-demo.mjs first");
  const clinic = doctor.clinic_id;
  const [service] = await db`select id from public.services where clinic_id = ${clinic} and name = ${DEMO_NAMES.generalService}`;

  // This clinic requires payment before a sample is collected.
  await db`insert into public.app_settings (clinic_id, key, value) values (${clinic}, 'lab', ${db.json({ verification: { required: true, separateVerifier: false }, collection: { requiresPayment: true }, ordering: { recentTestWindowDays: 30 } })})
           on conflict (clinic_id, key) do update set value = excluded.value`;

  await db`update public.appointments a set status = 'cancelled', cancelled_at = now(), cancelled_reason = 'E2E: an earlier run'
             from public.patients p
            where p.id = a.patient_id and a.clinic_id = ${clinic} and a.doctor_id = ${doctor.id}
              and a.status not in ('cancelled', 'no_show')
              and tstzrange(a.start_at, a.end_at) && tstzrange(now() - interval '3 hours', now() + interval '3 hours')`;
  const [t1] = await db`insert into public.lab_tests (clinic_id, code, name, price, sample_type) values (${clinic}, ${`E2E-K1-${suffix}`.toUpperCase()}, ${`Qon ${suffix}`}, 85000, 'qon') returning id`;
  const [t2] = await db`insert into public.lab_tests (clinic_id, code, name, price, sample_type) values (${clinic}, ${`E2E-K2-${suffix}`.toUpperCase()}, ${`Siydik ${suffix}`}, 25000, 'siydik') returning id`;
  const [patient] = await db`insert into public.patients (clinic_id, full_name) values (${clinic}, ${PATIENT}) returning id`;
  const start = new Date(Math.floor((Date.now() - 20 * 60_000) / 60_000) * 60_000);
  const [consult] = await db`insert into public.appointments ${db({
    clinic_id: clinic, patient_id: patient.id, doctor_id: doctor.id, service_id: service.id, start_at: start,
    end_at: new Date(start.getTime() + 20 * 60_000), status: "in_progress", source: "admin",
  })} returning id`;
  const [{ r }] = await db`select public.lab_create_order(${clinic}, ${doctor.profile_id}, ${patient.id}, ${doctor.id}, ${consult.id}, null, 'routine', ${NOTE}, ${crypto.randomUUID()}, ${db.json([{ test_id: t1.id }, { test_id: t2.id }])}) as r`;
  const orderId = r.order_id;

  const browser = await chromium.launch();
  try {
    // ---------- The technician: the order is on the worklist, collection waits for payment ----------
    const { context: labCtx, page: lab } = await loginLab(browser);
    const card = lab.locator("li", { hasText: PATIENT });
    check(await shown(card.getByText(PATIENT)), "the order is on the technician's worklist");
    check(await shown(card.getByText("To‘lanmagan")), "…with its payment status");
    check(await shown(card.getByText(/to‘lovni talab qiladi/)), "…and why collection is held back");
    check((await card.getByText(/\d[\d\s ]*so‘m/).count()) === 0, "…without any amount");
    check((await card.getByText(NOTE).count()) === 0, "…and without the doctor's note");
    await card.getByRole("button", { name: "Namunalarni tayyorlash" }).click();
    check(await shown(card.getByText("Olinishi kutilmoqda").first()), "samples are prepared (one per sample type)");
    check((await card.getByText("Olinishi kutilmoqda").count()) === 2, "…two of them: blood and urine");
    check(await card.getByRole("button", { name: "Namuna olindi" }).first().isDisabled(), "collection is disabled while payment is missing");
    await lab.screenshot({ path: `${SHOTS}/lab-worklist-awaiting-payment.png`, fullPage: true });
    // The server refuses it too, whatever the screen shows.
    const [sample] = await db`select id from public.lab_samples where order_id = ${orderId} limit 1`;
    const direct = await lab.request.post(`${BASE}/api/lab/samples/${sample.id}`, { data: { action: "collect" } });
    check(direct.status() === 409 && (await direct.json()).code === "payment_required", "the API refuses collection before payment (409 payment_required)");
    check((await lab.request.get(`${BASE}/api/admin/lab/kassa`)).status() === 403, "the technician has no access to the Kassa API");

    // ---------- The receptionist records the payment ----------
    const { context: recCtx, page: rec } = await signIn(browser, report, DEMO.reception, "desktop", { expectDenials: true });
    await rec.getByRole("link", { name: "Laboratoriya kassa" }).first().click();
    const row = rec.locator("li", { hasText: PATIENT });
    check(await shown(row.getByText(/110[\s,.]?000/).first()), "the Kassa shows the server's amount (85 000 + 25 000)");
    check((await row.getByRole("button", { name: "Qaytarish" }).count()) === 0, "a receptionist has no refund action");
    await row.getByRole("button", { name: "To‘lovni qabul qilish" }).click();
    await rec.getByLabel("To‘lov usuli").selectOption({ label: "Karta" });
    await rec.screenshot({ path: `${SHOTS}/lab-kassa-confirm.png`, fullPage: true });
    await rec.getByRole("button", { name: "Tasdiqlash" }).click();
    await rec.getByRole("button", { name: "To‘langan" }).click();
    check(await shown(rec.locator("li", { hasText: PATIENT }).getByText("To‘langan", { exact: true })), "the payment is recorded and shown as paid");
    const [paid] = await db`select status, amount::text, metadata from public.payments where lab_order_id = ${orderId}`;
    check(paid.status === "paid" && paid.amount === "110000.00" && paid.metadata.method === "card", "the stored payment is paid, 110000, by card");
    const [popup] = await Promise.all([rec.context().waitForEvent("page"), rec.locator("li", { hasText: PATIENT }).getByRole("link", { name: "Hujjat" }).click()]);
    await popup.waitForLoadState("networkidle");
    check(await shown(popup.getByText(/Fiskal chek emas/)), "the confirmation says it is not a fiscal receipt");
    check(await shown(popup.getByText(`Qon ${suffix}`)), "…lists what was bought");
    check((await popup.getByText(NOTE).count()) === 0, "…and never the doctor's note");
    await popup.screenshot({ path: `${SHOTS}/lab-receipt.png`, fullPage: true });
    await popup.close();
    check((await rec.request.get(`${BASE}/api/lab/worklist`)).status() === 403, "a receptionist has no access to the bench's API");
    await recCtx.close();

    // ---------- The technician collects and processes ----------
    await lab.reload();
    const card2 = lab.locator("li", { hasText: PATIENT });
    check(await shown(card2.getByText("To‘langan", { exact: true })), "the worklist shows the order as paid");
    check((await card2.getByText(/to‘lovni talab qiladi/).count()) === 0, "…and no longer holds collection back");
    await card2.getByRole("button", { name: "Namuna olindi" }).first().click();
    check(await shown(card2.getByText("Olindi", { exact: true })), "a sample is collected");
    await card2.getByRole("button", { name: "Ishlovga olish" }).click();
    check(await shown(card2.getByText("Ishlovda", { exact: true })), "…and taken into processing");
    await lab.screenshot({ path: `${SHOTS}/lab-worklist-processing.png`, fullPage: true });
    const states = await db`select status from public.lab_samples where order_id = ${orderId} order by sample_type`;
    check(states.map((s) => s.status).sort().join() === "awaiting_collection,processing", "the database agrees: one in processing, one still waiting");
    await labCtx.close();

    // ---------- The owner refunds: money moves, the clinical record does not ----------
    const { context: ownCtx, page: owner } = await signIn(browser, report, DEMO.owner, "desktop", { expectDenials: true });
    await owner.goto(`${BASE}/admin/lab-kassa`);
    await owner.getByRole("button", { name: "To‘langan" }).click();
    const orow = owner.locator("li", { hasText: PATIENT });
    await orow.getByRole("button", { name: "Qaytarish" }).click();
    await owner.getByRole("button", { name: "Qaytarish" }).last().click();
    check(await shown(owner.locator("li", { hasText: PATIENT }).getByText("Qaytarilgan", { exact: true })), "the refund is recorded and shown");
    const after = await db`select status from public.lab_samples where order_id = ${orderId} order by sample_type`;
    check(after.map((s) => s.status).sort().join() === "awaiting_collection,processing", "the samples are untouched by the refund");
    const [ord] = await db`select status from public.lab_orders where id = ${orderId}`;
    check(ord.status === "in_progress", "…and so is the order");
    await ownCtx.close();

    // ---------- The trail: ids only ----------
    const audit = await db`select action, new_values, metadata from public.audit_events where patient_id = ${patient.id} and (action like 'lab_payment%' or action like 'lab_sample%')`;
    const actions = new Set(audit.map((a) => a.action));
    check(["lab_payment_confirmed", "lab_payment_refunded", "lab_sample_created", "lab_sample_collected"].every((a) => actions.has(a)), "payments and samples are all in the audit trail");
    check(!JSON.stringify(audit).includes(NOTE) && !JSON.stringify(audit).includes("110000"), "…without the note or the amount");
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

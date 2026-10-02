// End-to-end, in the BUILT app, through the real screens — a doctor orders laboratory tests (phase 4):
//
//   Dr A opens their patient (consultation under way) → Laboratoriya → Tahlil buyurish → searches the
//   catalog → selects a test and a panel → reviews → sends. The order is listed with its status.
//   Ordering the same test again shows the advisory "recently ordered" notice — and still goes through.
//   Dr B (no relationship with the patient) gets the "not available" state and a 404 from the API.
//   A receptionist and a technician are refused by the doctor ordering API.
//   The stored order belongs to the clinic, to Dr A and to their consultation; the audit holds ids only.
//
// Needs the local stack, `node e2e/seed-demo.mjs`, and the app running (`npm run build && npm start`). Rerunnable.
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { BASE, DEMO, DEMO_NAMES, PASSWORD, assertLocalOnly, connect, createReport, runFixture, signIn } from "./lib.mjs";

assertLocalOnly();
const SHOTS = process.env.E2E_ARTIFACTS_DIR ?? "test-results/e2e";
mkdirSync(SHOTS, { recursive: true });
const report = createReport("laboratory ordering E2E");
const { check } = report;
const db = connect();
const { suffix } = runFixture();
const PATIENT = `E2E Bemor ${suffix}`;
const NOTE = `Och qoringa topshirilsin (${suffix})`;
const TEST_NAME = `Qon tahlili ${suffix}`;
const GLU_NAME = `Glyukoza ${suffix}`;
const PANEL_NAME = `Asosiy paket ${suffix}`;

const shown = (locator) => locator.waitFor({ timeout: 8_000 }).then(() => true, () => false);
const openTab = (page, name) => page.getByRole("navigation", { name: "Bemor kartasi bo‘limlari" }).getByRole("button", { name, exact: true }).click();

async function linkedDoctor(email) {
  const [row] = await db`select d.id, d.profile_id, d.clinic_id from public.doctors d join auth.users u on u.id = d.profile_id where u.email = ${email}`;
  if (!row) throw new Error(`${email} is not linked to a doctor — run node e2e/seed-demo.mjs`);
  return row;
}

async function run() {
  const A = await linkedDoctor(DEMO.referrer);
  const B = await linkedDoctor(DEMO.receiver);
  const clinic = A.clinic_id;
  const [service] = await db`select id from public.services where clinic_id = ${clinic} and name = ${DEMO_NAMES.generalService}`;

  // Earlier runs' consultations happening now would overlap this run's.
  await db`
    update public.appointments a set status = 'cancelled', cancelled_at = now(), cancelled_reason = 'E2E: an earlier run'
      from public.patients p
     where p.id = a.patient_id and a.clinic_id = ${clinic} and a.doctor_id in (${A.id}, ${B.id})
       and a.status not in ('cancelled', 'no_show')
       and tstzrange(a.start_at, a.end_at) && tstzrange(now() - interval '3 hours', now() + interval '3 hours')`;

  // A catalog of this run's own: two tests and a panel.
  const [t1] = await db`insert into public.lab_tests (clinic_id, code, name, price, sample_type, preparation_text, turnaround_minutes)
    values (${clinic}, ${`E2E-CBC-${suffix}`.toUpperCase()}, ${TEST_NAME}, 85000, 'qon', 'Tayyorgarlik shart emas', 120) returning id`;
  const [t2] = await db`insert into public.lab_tests (clinic_id, code, name, price, sample_type, preparation_text, turnaround_minutes)
    values (${clinic}, ${`E2E-GLU-${suffix}`.toUpperCase()}, ${GLU_NAME}, 25000, 'qon', '8 soat och qorin', 60) returning id`;
  const [panel] = await db`insert into public.lab_panels (clinic_id, code, name) values (${clinic}, ${`E2E-PAN-${suffix}`.toUpperCase()}, ${PANEL_NAME}) returning id`;
  await db`insert into public.lab_panel_tests (panel_id, test_id, clinic_id, sort_order) values (${panel.id}, ${t1.id}, ${clinic}, 0), (${panel.id}, ${t2.id}, ${clinic}, 1)`;

  const [patient] = await db`insert into public.patients (clinic_id, full_name) values (${clinic}, ${PATIENT}) returning id`;
  const start = new Date(Math.floor((Date.now() - 20 * 60_000) / 60_000) * 60_000);
  const [consult] = await db`insert into public.appointments ${db({
    clinic_id: clinic, patient_id: patient.id, doctor_id: A.id, service_id: service.id, start_at: start,
    end_at: new Date(start.getTime() + 20 * 60_000), status: "in_progress", source: "admin",
  })} returning id`;

  const browser = await chromium.launch();
  try {
    // ---------- Doctor A orders ----------
    const { context: ctxA, page: a } = await signIn(browser, report, DEMO.referrer, "desktop", { expectDenials: true });
    await a.goto(`${BASE}/doctor/patients/${patient.id}`);
    await a.getByRole("heading", { name: PATIENT }).waitFor({ timeout: 15_000 });
    await openTab(a, "Laboratoriya");
    check(await shown(a.getByText("Bu bemorga tahlil buyurilmagan.")), "the Laboratoriya tab starts empty");
    await a.getByRole("button", { name: "Tahlil buyurish" }).first().click();

    // Search narrows the catalog.
    await a.getByLabel("Qidirish").fill(`E2E-GLU-${suffix}`.toUpperCase());
    check(await shown(a.getByText(GLU_NAME)), "searching by code finds the test");
    check((await a.getByText(TEST_NAME).count()) === 0, "…and hides the others");
    await a.getByLabel("Qidirish").fill(suffix);
    check(await shown(a.getByText(PANEL_NAME)), "the panel is listed with its tests");
    check(await shown(a.getByText("8 soat och qorin")), "preparation is shown");

    // Select the panel and the CBC directly: the CBC is one item.
    // Listed panels first, then tests in code order: the panel, then the CBC.
    await a.getByRole("checkbox").nth(0).check();
    await a.getByRole("checkbox").nth(1).check();
    await a.getByRole("button", { name: /Ko‘rib chiqish/ }).click();
    check(await shown(a.getByText("Buyurtmani tekshiring")), "the review step is shown");
    check((await a.getByText(/Yaqinda xuddi shu tahlil/).count()) === 0, "no similar-test notice for a first order");
    await a.getByLabel("Izoh").fill(NOTE);
    await a.screenshot({ path: `${SHOTS}/lab-order-review.png`, fullPage: true });
    // Double click sends once.
    const send = a.getByRole("button", { name: "Buyurtmani yuborish" });
    await send.dblclick();
    check(await shown(a.getByRole("status").filter({ hasText: "Buyurtma yuborildi" })), "the order is sent");
    check(await shown(a.getByText("Buyurtma berildi").first()), "…and listed with its status");
    check(await shown(a.getByText(NOTE)), "…with the doctor's own note");
    const orders = await db`select id, ordering_doctor_id, created_by, appointment_id, clinic_id, status from public.lab_orders where patient_id = ${patient.id}`;
    check(orders.length === 1, "exactly one order was stored despite the double click");
    check(orders[0]?.clinic_id === clinic && orders[0].ordering_doctor_id === A.id && orders[0].created_by === A.profile_id && orders[0].appointment_id === consult.id,
      "it belongs to the clinic, to Dr A and to their consultation");
    const items = await db`select test_code, price_snapshot::text from public.lab_order_items where order_id = ${orders[0].id}`;
    check(items.length === 2, "the panel and the test expand into two items, the shared test once");
    await a.screenshot({ path: `${SHOTS}/lab-order-list.png`, fullPage: true });

    // The same test again: the notice appears, and it does not block.
    await a.getByRole("button", { name: "Tahlil buyurish" }).first().click();
    await a.getByLabel("Qidirish").fill(`E2E-GLU-${suffix}`.toUpperCase());
    await a.getByRole("checkbox").first().check();
    await a.getByRole("button", { name: /Ko‘rib chiqish/ }).click();
    check(await shown(a.getByText(/Yaqinda xuddi shu tahlil/)), "ordering the same test again shows the advisory notice");
    check(await shown(a.getByText(/Bu faqat eslatma/)), "…which says it is only a reminder");
    await a.getByRole("button", { name: "Buyurtmani yuborish" }).click();
    check(await shown(a.getByRole("status").filter({ hasText: "Buyurtma yuborildi" })), "…and the order still goes through");
    await a.screenshot({ path: `${SHOTS}/lab-order-notice.png`, fullPage: true });

    // The trail: ids only.
    const audit = await db`select action, new_values, metadata from public.audit_events where patient_id = ${patient.id} and action like 'lab_order%'`;
    check(audit.some((r) => r.action === "lab_order_created"), "the creation is in the audit trail");
    check(!JSON.stringify(audit).includes(NOTE) && !JSON.stringify(audit).includes("85000"), "…without the note or the prices");
    await ctxA.close();

    // ---------- Doctor B has no relationship with this patient ----------
    const { context: ctxB, page: b } = await signIn(browser, report, DEMO.receiver, "desktop", { expectDenials: true });
    const apiB = await b.request.get(`${BASE}/api/doctor/patients/${patient.id}/lab`);
    check(apiB.status() === 404, "an unrelated doctor gets a 404 for the patient's orders");
    const orderB = await b.request.post(`${BASE}/api/doctor/lab/orders`, { data: { idempotencyKey: crypto.randomUUID(), patientId: patient.id, testIds: [t1.id] } });
    check(orderB.status() === 404, "…and cannot order for them");
    await ctxB.close();

    // ---------- Other roles ----------
    for (const [email, label] of [[DEMO.reception, "a receptionist"], [DEMO.lab, "a technician"], [DEMO.owner, "the owner"]]) {
      let context;
      let page;
      if (email === DEMO.lab) {
        // The technician's workspace is /lab: sign in through the same screen and accept that redirect.
        context = await browser.newContext();
        page = await context.newPage();
        await page.goto(`${BASE}/login`);
        await page.getByLabel("Email").fill(email);
        await page.getByLabel("Parol").fill(PASSWORD);
        await page.getByRole("button", { name: "Kirish" }).click();
        await page.waitForURL(/\/lab(\/|$|\?)/, { timeout: 20_000 });
      } else {
        ({ context, page } = await signIn(browser, report, email, "desktop", { expectDenials: true }));
      }
      const res = await page.request.post(`${BASE}/api/doctor/lab/orders`, { data: { idempotencyKey: crypto.randomUUID(), patientId: patient.id, testIds: [t1.id] } });
      check(res.status() === 403, `${label} is refused by the ordering API`);
      check((await page.request.get(`${BASE}/api/doctor/lab/catalog`)).status() === 403, `…and by the doctor catalog search`);
      await context.close();
    }
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

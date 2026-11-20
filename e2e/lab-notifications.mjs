// Lab notifications in a real browser against the built app and a LOCAL
// Supabase stack (Phase 16):
//   * a doctor's lab order notifies the lab: the technician's bell shows it
//     (patient and test, no values) and leads to the work queue;
//   * after a second technician verifies the result, the ordering doctor's
//     bell (phone-sized screen) says the result is verified — no values — and
//     opens the patient;
//   * "mark all read" clears the count;
//   * the owner switches staff notifications off in the lab settings and a
//     new order notifies nobody;
//   * no session: the inbox API gives nothing.
// Rerunnable: run-unique test, patient and slot.
import { chromium } from "playwright";
import { BASE, DEMO, DEMO_NAMES, assertLocalOnly, connect, createReport, runFixture, signIn } from "./lib.mjs";

assertLocalOnly();
const report = createReport("lab notifications E2E");
const { check } = report;
const db = connect();
const { suffix, nextSlot } = runFixture();

async function run() {
  const [reception] = await db`select u.id, sr.clinic_id from auth.users u join public.staff_roles sr on sr.profile_id = u.id where u.email = ${DEMO.reception}`;
  const [lab] = await db`select id from auth.users where email = ${DEMO.lab}`;
  const [lab2] = await db`select id from auth.users where email = ${DEMO.lab2}`;
  const [dr] = await db`select d.id, d.profile_id from public.doctors d join auth.users u on u.id = d.profile_id where u.email = ${DEMO.referrer}`;
  if (!reception || !lab || !lab2 || !dr) throw new Error("demo staff missing — run node e2e/seed-demo.mjs");
  const clinic = reception.clinic_id;
  const [service] = await db`select id from public.services where clinic_id = ${clinic} and name = ${DEMO_NAMES.generalService}`;
  await db`insert into public.app_settings ${db({ clinic_id: clinic, key: "lab", value: db.json({}) })} on conflict (clinic_id, key) do update set value = excluded.value`;

  const testName = `E2E xabar testi ${suffix}`;
  const [test] = await db`insert into public.lab_tests ${db({ clinic_id: clinic, code: `E2ENTF${suffix}`.slice(0, 32).toUpperCase(), name: testName, sample_type: "Qon", price: 10000 })} returning id`;
  const [param] = await db`insert into public.lab_test_parameters ${db({ clinic_id: clinic, test_id: test.id, code: "HGB", name: "Gemoglobin", value_type: "numeric", unit: "g/L" })} returning id`;
  const patientName = `E2E Xabar bemor ${suffix}`;
  const [patient] = await db`insert into public.patients ${db({ clinic_id: clinic, full_name: patientName, date_of_birth: "1982-02-02" })} returning id`;
  const slot = nextSlot();
  const [visit] = await db`insert into public.appointments ${db({ clinic_id: clinic, patient_id: patient.id, doctor_id: dr.id, service_id: service.id, start_at: slot.start, end_at: slot.end, status: "completed", source: "admin" })} returning id`;
  const [order] = await db`select * from public.create_lab_order(${clinic}, ${patient.id}, ${dr.profile_id}, 'consultation', ${[test.id]}::uuid[], '{}'::uuid[], null, ${dr.id}, ${visit.id})`;
  const [item] = await db`select id from public.lab_order_items where order_id = ${order.lab_order_id}`;

  const browser = await chromium.launch();
  try {
    const anon = await browser.newContext();
    check((await anon.request.get(`${BASE}/api/staff/notifications`)).status() === 401, "no session: inbox API → 401");
    await anon.close();

    // ---------- the lab is told about the new order ----------
    const { context: lc, page: l } = await signIn(browser, report, DEMO.lab);
    const bell = l.getByRole("button", { name: /Bildirishnomalar: \d+ ta o‘qilmagan/ });
    await bell.waitFor();
    await bell.click();
    const panel = l.getByRole("dialog", { name: "Bildirishnomalar" });
    const entry = panel.getByRole("link").filter({ hasText: "Yangi laboratoriya buyurtmasi" }).filter({ hasText: patientName });
    await entry.waitFor();
    check((await entry.innerText()).includes(testName), "lab: the bell names the new order's patient and test");
    await panel.getByRole("button", { name: "Hammasini o‘qilgan deb belgilash" }).click();
    await l.getByRole("button", { name: "Bildirishnomalar", exact: true }).waitFor();
    check(true, "lab: mark all read clears the count");
    await lc.close();

    // ---------- the result is entered and verified ----------
    const [sample] = await db`select * from public.collect_lab_sample(${clinic}, ${order.lab_order_id}, ${[item.id]}::uuid[], ${reception.id})`;
    await db`select public.receive_lab_sample(${clinic}, ${sample.lab_sample_id}, ${lab.id})`;
    const [draft] = await db`select * from public.save_lab_result_draft(${clinic}, ${item.id}, ${lab.id}, ${db.json([{ parameter_id: param.id, value_numeric: 137 }])}::jsonb, null, null)`;
    await db`select public.submit_lab_result(${clinic}, ${draft.lab_result_id}, ${lab.id})`;
    await db`select public.verify_lab_result(${clinic}, ${draft.lab_result_id}, ${lab2.id})`;
    const toDoctor = await db`select type from public.notification_jobs where lab_result_id = ${draft.lab_result_id} and recipient_profile_id = ${dr.profile_id} order by created_at`;
    check(toDoctor.map((j) => j.type).join() === "lab_result_entered,lab_result_verified", "doctor: told the result awaits verification, then that it is verified");

    // ---------- the ordering doctor sees it on a phone ----------
    const { context: dc, page: d } = await signIn(browser, report, DEMO.referrer, "phone");
    await d.getByRole("button", { name: /Bildirishnomalar: \d+ ta o‘qilmagan/ }).click();
    const dpanel = d.getByRole("dialog", { name: "Bildirishnomalar" });
    const verified = dpanel.getByRole("link").filter({ hasText: "Laboratoriya natijasi tasdiqlandi" }).filter({ hasText: patientName });
    await verified.waitFor();
    const text = await verified.innerText();
    check(text.includes(testName) && !/\b137\b|g\/L|Gemoglobin/.test(text), "doctor: the bell names patient and test, never the value");
    await verified.click();
    await d.waitForURL(new RegExp(`/doctor/patients/${patient.id}$`));
    check(true, "doctor: the notification opens the patient");
    await dc.close();

    // ---------- the owner turns staff notifications off ----------
    const { context: oc, page: o } = await signIn(browser, report, DEMO.owner);
    await o.goto(`${BASE}/admin/lab`);
    await o.getByRole("tab", { name: "Sozlamalar" }).click();
    const toggle = o.getByLabel(/Xodimlarga ilova ichida bildirishnoma/);
    await toggle.uncheck();
    await o.getByRole("button", { name: "Saqlash" }).click();
    await o.getByText(/Saqlandi/).waitFor();
    const [order2] = await db`select * from public.create_lab_order(${clinic}, ${patient.id}, ${reception.id}, 'walk_in', ${[test.id]}::uuid[], '{}'::uuid[])`;
    const [{ n }] = await db`select count(*)::int as n from public.notification_jobs where lab_order_id = ${order2.lab_order_id}`;
    check(n === 0, "owner: with staff notifications off, a new order notifies nobody");
    await toggle.check();
    await o.getByRole("button", { name: "Saqlash" }).click();
    await oc.close();
  } finally {
    await db`update public.app_settings set value = '{}'::jsonb where clinic_id = ${clinic} and key = 'lab'`;
    await browser.close();
  }
}

let exitCode;
try {
  await run();
  exitCode = report.finish();
} catch (e) {
  exitCode = report.abort(e);
} finally {
  await db.end({ timeout: 5 });
}
process.exit(exitCode);

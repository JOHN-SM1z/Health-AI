// Laboratory dashboards in a real browser against the built app and a LOCAL
// Supabase stack (Phase 17):
//   * lab staff see the work by stage — and no patient names;
//   * the ordering doctor (phone-sized screen) sees their patient's value
//     outside the configured range and opens the patient from it;
//   * the manager sees volume and workload, and the money section is closed;
//   * the owner sees laboratory revenue (by test and department) from the payment records;
//   * a receptionist reaching the page by its address gets the permission state;
//   * no session: the APIs give nothing.
// Rerunnable: run-unique test, patient and slot.
import { chromium } from "playwright";
import { BASE, DEMO, DEMO_NAMES, assertLocalOnly, connect, createReport, runFixture, signIn } from "./lib.mjs";

assertLocalOnly();
const report = createReport("lab dashboards E2E");
const { check } = report;
const db = connect();
const { suffix, nextSlot } = runFixture();

async function run() {
  const [reception] = await db`select u.id, sr.clinic_id from auth.users u join public.staff_roles sr on sr.profile_id = u.id where u.email = ${DEMO.reception}`;
  const [lab] = await db`select id from auth.users where email = ${DEMO.lab}`;
  const [lab2] = await db`select id from auth.users where email = ${DEMO.lab2}`;
  const [owner] = await db`select id from auth.users where email = ${DEMO.owner}`;
  const [dr] = await db`select d.id, d.profile_id from public.doctors d join auth.users u on u.id = d.profile_id where u.email = ${DEMO.referrer}`;
  if (!reception || !lab || !lab2 || !owner || !dr) throw new Error("demo staff missing — run node e2e/seed-demo.mjs");
  const clinic = reception.clinic_id;
  const [service] = await db`select id from public.services where clinic_id = ${clinic} and name = ${DEMO_NAMES.generalService}`;

  const testName = `E2E panel testi ${suffix}`;
  const [category] = await db`insert into public.lab_test_categories ${db({ clinic_id: clinic, name: `E2E bo‘lim ${suffix}` })} returning id`;
  const [test] = await db`insert into public.lab_tests ${db({ clinic_id: clinic, category_id: category.id, code: `E2EDSH${suffix}`.slice(0, 32).toUpperCase(), name: testName, sample_type: "Qon", price: 12345, turnaround_hours: 24 })} returning id`;
  const [param] = await db`insert into public.lab_test_parameters ${db({ clinic_id: clinic, test_id: test.id, code: "HGB", name: "Gemoglobin", value_type: "numeric", unit: "g/L" })} returning id`;
  await db`insert into public.lab_reference_ranges ${db({ clinic_id: clinic, parameter_id: param.id, low: 120, high: 160 })}`;
  const patientName = `E2E Panel bemor ${suffix}`;
  const [patient] = await db`insert into public.patients ${db({ clinic_id: clinic, full_name: patientName, date_of_birth: "1979-03-03" })} returning id`;
  const slot = nextSlot();
  const [visit] = await db`insert into public.appointments ${db({ clinic_id: clinic, patient_id: patient.id, doctor_id: dr.id, service_id: service.id, start_at: slot.start, end_at: slot.end, status: "completed", source: "admin" })} returning id`;
  const [order] = await db`select * from public.create_lab_order(${clinic}, ${patient.id}, ${dr.profile_id}, 'consultation', ${[test.id]}::uuid[], '{}'::uuid[], null, ${dr.id}, ${visit.id})`;
  const [item] = await db`select id from public.lab_order_items where order_id = ${order.lab_order_id}`;
  // Paid at the desk (the bill's stored amount), then collected, entered and verified by two technicians.
  await db`update public.payments set status = 'paid', paid_at = now(), paid_by = ${owner.id} where lab_order_id = ${order.lab_order_id}`;
  const [sample] = await db`select * from public.collect_lab_sample(${clinic}, ${order.lab_order_id}, ${[item.id]}::uuid[], ${reception.id})`;
  await db`select public.receive_lab_sample(${clinic}, ${sample.lab_sample_id}, ${lab.id})`;
  const [draft] = await db`select * from public.save_lab_result_draft(${clinic}, ${item.id}, ${lab.id}, ${db.json([{ parameter_id: param.id, value_numeric: 95 }])}::jsonb, null, null)`;
  await db`select public.submit_lab_result(${clinic}, ${draft.lab_result_id}, ${lab.id})`;
  await db`select public.verify_lab_result(${clinic}, ${draft.lab_result_id}, ${lab2.id})`;

  const browser = await chromium.launch();
  try {
    const anon = await browser.newContext();
    const statuses = await Promise.all(["/api/lab/dashboard", "/api/doctor/lab/dashboard", "/api/admin/analytics/lab"].map(async (p) => (await anon.request.get(`${BASE}${p}`)).status()));
    check(statuses.every((s) => s === 401), "no session: every dashboard API → 401");
    await anon.close();

    // ---------- lab staff ----------
    const { context: lc, page: l } = await signIn(browser, report, DEMO.lab);
    await l.getByRole("link", { name: "Ko‘rsatkichlar" }).first().click();
    await l.waitForURL(/\/lab\/dashboard$/);
    const stages = l.getByRole("list", { name: "Bosqichlar bo‘yicha ish" });
    await stages.waitFor();
    check((await stages.getByRole("listitem").count()) === 6, "lab: the work by stage (five stages and the completed count)");
    const labText = await l.locator("main, body").first().innerText();
    check(!labText.includes(patientName) && !labText.includes("Gemoglobin"), "lab: no patient names or result values on the dashboard");
    await lc.close();

    // ---------- the ordering doctor, on a phone ----------
    const { context: dc, page: d } = await signIn(browser, report, DEMO.referrer, "phone");
    await d.goto(`${BASE}/doctor/lab`);
    const abnormal = d.getByRole("list", { name: "Me’yordan tashqari qiymatlar" }).getByRole("listitem").filter({ hasText: patientName });
    await abnormal.waitFor();
    const row = await abnormal.innerText();
    check(row.includes("95") && row.includes("Me’yordan past") && row.includes(testName), "doctor: the value outside the configured range, with the placement only");
    await abnormal.getByRole("link", { name: patientName }).click();
    await d.waitForURL(new RegExp(`/doctor/patients/${patient.id}$`));
    check(true, "doctor: the entry opens the patient");
    await dc.close();

    // ---------- manager: no money ----------
    const { context: mc, page: m } = await signIn(browser, report, DEMO.manager);
    await m.getByRole("link", { name: "Laboratoriya tahlili" }).first().click();
    await m.waitForURL(/\/admin\/lab-analytics$/);
    await m.getByText("Tahlillar soni").first().waitFor();
    await m.getByText("Moliyaviy ko‘rsatkichlar yopiq").waitFor();
    check((await m.getByRole("region", { name: "Laboratoriya daromadi" }).count()) === 0, "manager: volume and workload shown, the money section closed");
    await mc.close();

    // ---------- owner: revenue by test ----------
    const { context: oc, page: o } = await signIn(browser, report, DEMO.owner);
    await o.goto(`${BASE}/admin/lab-analytics?x=${suffix}`);
    const revenue = o.getByRole("region", { name: "Laboratoriya daromadi" });
    await revenue.waitFor();
    const revenueText = await revenue.innerText();
    const categoryRow = revenue.locator("div", { hasText: `E2E bo‘lim ${suffix}` }).last();
    check(revenueText.includes("Tahlillar bo‘yicha daromad") && /12[\s\u00a0.,]?345/.test(await categoryRow.innerText()), "owner: revenue by department from the payment record");
    check(!(await o.locator("body").innerText()).includes(patientName), "owner: no patient names in the analytics");
    await oc.close();

    // ---------- receptionist reaching the page by address ----------
    const { context: rc, page: r } = await signIn(browser, report, DEMO.reception, "desktop", { expectForbidden: true });
    check((await r.getByRole("link", { name: "Laboratoriya tahlili" }).count()) === 0, "receptionist: no analytics link");
    await r.goto(`${BASE}/admin/lab-analytics`);
    await r.getByText("Bu sahifani ko‘rish uchun ruxsat yo‘q").waitFor();
    check(true, "receptionist: the permission state, no figures");
    await rc.close();
  } finally {
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

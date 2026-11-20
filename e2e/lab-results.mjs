// Structured result entry in a real browser against the built app and a
// LOCAL Supabase stack (Phase 8):
//   * a received CBC sample shows "Natija kiritish" in the lab work queue;
//   * the technician types values (decimal comma accepted); an invalid value
//     is flagged on screen and cannot be saved;
//   * after saving, each value shows where it sits against the clinic's
//     configured range for this patient (the database's flag), with the
//     "not a diagnosis" note;
//   * submitting sends the complete result for verification: the database
//     holds a submitted result with the typed values, the test is "resulted",
//     and the result is read-only afterwards;
//   * reception gets no access to result values.
// Rerunnable: run-unique test codes and patient.
import { chromium } from "playwright";
import { BASE, DEMO, assertLocalOnly, connect, createReport, runFixture, signIn } from "./lib.mjs";

assertLocalOnly();
const report = createReport("lab result entry E2E");
const { check } = report;
const db = connect();
const { suffix } = runFixture();

async function run() {
  const [reception] = await db`select u.id, sr.clinic_id from auth.users u join public.staff_roles sr on sr.profile_id = u.id where u.email = ${DEMO.reception}`;
  const [lab] = await db`select id from auth.users where email = ${DEMO.lab}`;
  if (!reception || !lab) throw new Error("demo staff missing — run node e2e/seed-demo.mjs");
  const clinic = reception.clinic_id;

  const testName = `E2E CBC natija ${suffix}`;
  const [test] = await db`insert into public.lab_tests ${db({ clinic_id: clinic, code: `E2ERES${suffix}`.slice(0, 32), name: testName, sample_type: "Vena qoni", price: 80000 })} returning id`;
  const params = await db`insert into public.lab_test_parameters ${db([
    { clinic_id: clinic, test_id: test.id, code: "HGB", name: "Gemoglobin", value_type: "numeric", unit: "g/L", decimals: 0, choices: null, sort_order: 1 },
    { clinic_id: clinic, test_id: test.id, code: "WBC", name: "Leykotsitlar", value_type: "numeric", unit: "×10⁹/L", decimals: 1, choices: null, sort_order: 2 },
    { clinic_id: clinic, test_id: test.id, code: "COLOR", name: "Rangi", value_type: "choice", unit: null, decimals: null, choices: ["Sariq", "Qizil"], sort_order: 3 },
  ])} returning id, code`;
  const pid = Object.fromEntries(params.map((p) => [p.code, p.id]));
  await db`insert into public.lab_reference_ranges ${db([
    { clinic_id: clinic, parameter_id: pid.HGB, sex: "female", low: 120, high: 150 },
    { clinic_id: clinic, parameter_id: pid.WBC, sex: null, low: 4, high: 9 },
  ])}`;

  const patientName = `E2E Natija bemor ${suffix}`;
  const [patient] = await db`insert into public.patients ${db({ clinic_id: clinic, full_name: patientName, date_of_birth: "1985-05-05", sex: "female" })} returning id`;
  const [order] = await db`select * from public.create_lab_order(${clinic}, ${patient.id}, ${reception.id}, 'walk_in', ${[test.id]}::uuid[], '{}'::uuid[])`;
  const [item] = await db`select id from public.lab_order_items where order_id = ${order.lab_order_id}`;
  const [sample] = await db`select * from public.collect_lab_sample(${clinic}, ${order.lab_order_id}, ${[item.id]}::uuid[], ${reception.id})`;
  await db`select public.receive_lab_sample(${clinic}, ${sample.lab_sample_id}, ${lab.id})`;

  const browser = await chromium.launch();
  try {
    // ---------- reception: no result values ----------
    const { context: rc, page: r } = await signIn(browser, report, DEMO.reception);
    check((await r.request.get(`${BASE}/api/lab/items/${item.id}/result`)).status() === 403, "reception: result entry API → 403");
    await r.goto(`${BASE}/admin/lab-queue`);
    await r.getByRole("button", { name: "Barchasi", exact: true }).click();
    await r.getByRole("region", { name: `${patientName} buyurtmasi` }).waitFor();
    check((await r.getByRole("button", { name: "Natija kiritish" }).count()) === 0, "reception: no result entry button");
    await rc.close();

    // ---------- lab: enter, save, submit ----------
    const { context: lc, page: l } = await signIn(browser, report, DEMO.lab);
    await l.getByRole("button", { name: "Jarayonda", exact: true }).click();
    const card = l.getByRole("region", { name: `${patientName} buyurtmasi` });
    await card.getByRole("button", { name: "Natija kiritish" }).click();
    const dialog = l.getByRole("dialog", { name: `${testName} — natija` });
    await dialog.getByText("Me’yor: 120–150 g/L").waitFor();
    check(true, "lab: the entry form shows the patient's configured range (women 120–150)");

    await dialog.getByLabel("Gemoglobin qiymati").fill("11a");
    await dialog.getByText("Son kiriting (masalan: 7,2)").waitFor();
    check(await dialog.getByRole("button", { name: "Qoralamani saqlash" }).isDisabled(), "lab: an invalid number is flagged and cannot be saved");

    await dialog.getByLabel("Gemoglobin qiymati").fill("118");
    await dialog.getByLabel("Leykotsitlar qiymati").fill("7,2");
    await dialog.getByRole("button", { name: "Qoralamani saqlash" }).click();
    await dialog.getByText("Me’yordan past").waitFor();
    check(await dialog.getByText("Me’yor oralig‘ida").isVisible(), "lab: saved values show the database's flags (118 low, 7,2 within range)");
    check(await dialog.getByText(/bu tashxis emas/).isVisible(), "lab: the form says the flag is not a diagnosis");
    check(await dialog.getByRole("button", { name: "Saqlash va tekshiruvga yuborish" }).isDisabled(), "lab: an incomplete result cannot be submitted");

    await dialog.getByLabel("Rangi qiymati").selectOption("Sariq");
    await dialog.getByRole("button", { name: "Saqlash va tekshiruvga yuborish" }).click();
    await l.getByText(`${testName}: natija tekshiruvga yuborildi`).waitFor();

    const [stored] = await db`select r.id, r.status, r.entered_by, r.submitted_by, i.status as item_status from public.lab_results r
      join public.lab_order_items i on i.id = r.order_item_id where r.order_item_id = ${item.id}`;
    const vals = await db`select p.code, v.value_numeric::text as n, v.value_text as t, v.flag from public.lab_result_values v
      join public.lab_test_parameters p on p.id = v.parameter_id where v.result_id = ${stored.id} order by p.sort_order`;
    check(
      stored.status === "submitted" && stored.entered_by === lab.id && stored.submitted_by === lab.id && stored.item_status === "resulted",
      "lab: the result is submitted for verification and the test is resulted",
    );
    check(
      JSON.stringify(vals.map((v) => [v.code, v.n ?? v.t, v.flag])) === JSON.stringify([["HGB", "118", "low"], ["WBC", "7.2", "normal"], ["COLOR", "Sariq", "not_evaluated"]]),
      "lab: the database holds exactly the typed values with flags from configuration",
    );

    await l.getByRole("button", { name: "Tekshiruvda", exact: true }).click();
    await card.getByRole("button", { name: "Ko‘rib chiqish" }).click();
    const view = l.getByRole("dialog", { name: `${testName} — natija` });
    await view.getByText(/Tekshiruvga yuborilgan/).waitFor();
    check((await view.getByLabel("Gemoglobin qiymati").count()) === 0 && (await view.getByText("118 g/L").isVisible()), "lab: a submitted result is read-only");
    const [{ viewed }] = await db`select count(*)::int as viewed from public.audit_events where action = 'lab_result_viewed' and entity_id = ${stored.id} and actor_id = ${lab.id}`;
    check(viewed >= 1, "audit: reading the entered values is audited");
    await lc.close();
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

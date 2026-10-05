// Doctor lab ordering in a real browser against the built app and a LOCAL
// Supabase stack (Phase 5):
//   * Dr Aliyev opens their patient, searches the catalog, picks a test, sees
//     its preparation and price on review, and orders it; the database holds
//     the order with the doctor, the patient and the catalog price;
//   * ordering the same test again shows the recent-similar-test warning,
//     which does not block: continuing places the second order;
//   * once the lab has verified a result, "Natijani ko‘rish" shows the value
//     against the clinic's configured range (no interpretation).
// Rerunnable: run-unique test code and patient.
import { chromium } from "playwright";
import { BASE, DEMO, DEMO_NAMES, assertLocalOnly, connect, createReport, runFixture, signIn } from "./lib.mjs";

assertLocalOnly();
const report = createReport("lab ordering E2E");
const { check } = report;
const db = connect();
const { suffix, nextSlot } = runFixture();

async function run() {
  const [doctor] = await db`select d.id, d.profile_id, d.clinic_id from public.doctors d join auth.users u on u.id = d.profile_id where u.email = ${DEMO.referrer}`;
  if (!doctor) throw new Error("demo doctor missing — run node e2e/seed-demo.mjs");
  const clinic = doctor.clinic_id;
  const [service] = await db`select id from public.services where clinic_id = ${clinic} and name = ${DEMO_NAMES.generalService}`;
  const [reception] = await db`select id from auth.users where email = ${DEMO.reception}`;
  const [manager] = await db`select id from auth.users where email = ${DEMO.manager}`;

  // Catalog: a run-unique CBC with one parameter and a configured range.
  const code = `E2ECBC${suffix}`.slice(0, 32);
  const [test] = await db`insert into public.lab_tests ${db({
    clinic_id: clinic, code, name: `E2E qon tahlili ${suffix}`, sample_type: "Vena qoni", price: 95000,
    preparation_text: "Ertalab och qoringa topshiriladi",
  })} returning id`;
  const [parameter] = await db`insert into public.lab_test_parameters ${db({ clinic_id: clinic, test_id: test.id, code: "HGB", name: "Gemoglobin", value_type: "numeric", unit: "g/L" })} returning id`;
  await db`insert into public.lab_reference_ranges ${db({ clinic_id: clinic, parameter_id: parameter.id, low: 120, high: 160 })}`;

  // Dr Aliyev's patient (a completed visit), with a date of birth.
  const [patient] = await db`insert into public.patients ${db({ clinic_id: clinic, full_name: `E2E Lab bemor ${suffix}`, date_of_birth: "1980-01-01", sex: "female" })} returning id`;
  const slot = nextSlot();
  await db`insert into public.appointments ${db({
    clinic_id: clinic, patient_id: patient.id, doctor_id: doctor.id, service_id: service.id,
    start_at: slot.start, end_at: slot.end, status: "completed", source: "admin",
  })}`;

  const browser = await chromium.launch();
  try {
    const { page } = await signIn(browser, report, DEMO.referrer);
    await page.goto(`${BASE}/doctor/patients/${patient.id}`);
    await page.waitForLoadState("networkidle");
    const lab = page.getByRole("region", { name: "Laboratoriya" });
    check(await lab.isVisible(), "the patient workspace has a Laboratoriya section");

    async function order(expectWarning) {
      await lab.getByRole("button", { name: "Tahlil buyurtma qilish" }).click();
      const dialog = page.getByRole("dialog", { name: "Tahlil buyurtma qilish" });
      await dialog.getByLabel("Tahlil qidirish").fill(code);
      await dialog.getByText(`E2E qon tahlili ${suffix}`).click();
      await dialog.getByRole("button", { name: "Ko‘rib chiqish" }).click();
      const review = page.getByRole("dialog", { name: "Buyurtmani tekshiring" });
      await review.getByText("Ertalab och qoringa topshiriladi").waitFor();
      check(await review.getByText("95").first().isVisible(), "review shows the preparation and the catalog price");
      const warning = review.getByText("Shunga o‘xshash tahlil topildi:");
      if (expectWarning) {
        await warning.waitFor();
        check(await review.getByText(/E2E qon tahlili .* — bugun/).isVisible(), "a recent order of the same test is shown with its date");
        await review.getByRole("button", { name: "Buyurtmani davom ettirish" }).click();
      } else {
        check((await warning.count()) === 0, "no warning without an earlier order");
      }
      await review.getByRole("button", { name: "Buyurtma berish" }).click();
      await lab.getByText("1 ta tahlil buyurtma qilindi.").waitFor();
    }

    await order(false);
    const orders = await db`select o.source, o.ordered_by, o.ordering_doctor_id, i.price_snapshot, i.status
      from public.lab_orders o join public.lab_order_items i on i.order_id = o.id where o.patient_id = ${patient.id}`;
    check(
      orders.length === 1 && orders[0].ordered_by === doctor.profile_id && orders[0].ordering_doctor_id === doctor.id && Number(orders[0].price_snapshot) === 95000,
      "the order is stored for this doctor and patient at the catalog price",
    );
    check(orders[0]?.status === "ready_for_collection", "the test is ready for sample collection (payment is not required first)");

    await order(true);
    const [{ n }] = await db`select count(*)::int as n from public.lab_orders where patient_id = ${patient.id}`;
    check(n === 2, "the warning did not block: the second order was placed");

    // The lab verifies the first order's result (two different people).
    const [first] = await db`select i.id, i.order_id from public.lab_order_items i join public.lab_orders o on o.id = i.order_id
      where o.patient_id = ${patient.id} order by o.created_at limit 1`;
    await db.begin(async (tx) => {
      const [sample] = await tx`insert into public.lab_samples ${tx({ clinic_id: clinic, patient_id: patient.id, order_id: first.order_id, sample_code: `E2E-${suffix}`, sample_type: "Qon", collected_by: reception.id })} returning id`;
      await tx`insert into public.lab_sample_items ${tx({ sample_id: sample.id, order_item_id: first.id, clinic_id: clinic })}`;
      await tx`update public.lab_order_items set status = 'collected', status_changed_by = ${reception.id} where id = ${first.id}`;
      const [result] = await tx`insert into public.lab_results ${tx({ clinic_id: clinic, patient_id: patient.id, order_item_id: first.id, entered_by: reception.id })} returning id`;
      await tx`insert into public.lab_result_values ${tx({ clinic_id: clinic, result_id: result.id, parameter_id: parameter.id, value_numeric: 112 })}`;
      await tx`update public.lab_results set status = 'submitted', submitted_by = ${reception.id} where id = ${result.id}`;
      await tx`update public.lab_results set status = 'verified', verified_by = ${manager.id} where id = ${result.id}`;
    });

    await page.reload();
    await page.waitForLoadState("networkidle");
    await lab.getByRole("button", { name: "Natijani ko‘rish" }).first().click();
    const resultDialog = page.getByRole("dialog", { name: `E2E qon tahlili ${suffix}` });
    await resultDialog.getByText("Me’yordan past").waitFor();
    check(await resultDialog.getByText("112 g/L").isVisible(), "the verified value is shown with its unit");
    check(await resultDialog.getByText("120–160").isVisible(), "the configured range is shown");
    check(await resultDialog.getByText("bu tashxis emas").isVisible(), "the result view says it is not a diagnosis");
    const [{ viewed }] = await db`select count(*)::int as viewed from public.audit_events where action = 'lab_result_viewed' and patient_id = ${patient.id} and actor_id = ${doctor.profile_id}`;
    check(viewed === 1, "viewing the result is audited with the doctor as actor");
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

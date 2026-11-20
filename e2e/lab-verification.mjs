// Result verification and correction in a real browser against the built app
// and a LOCAL Supabase stack (Phase 9):
//   * a submitted result is reviewed by a second lab staff member, who
//     returns it for rework; its author fixes and resubmits it;
//   * the author has no "Tasdiqlash" for their own result; the second person
//     verifies it and the order completes;
//   * the verified result is corrected as version 2 (reason required), which
//     another person verifies; version 1 is preserved (superseded) and shown
//     in the history; the doctor sees the corrected result with its reason;
//   * every step is audited with ids and the acting person only.
// Rerunnable: run-unique test codes and patient.
import { chromium } from "playwright";
import { BASE, DEMO, DEMO_NAMES, assertLocalOnly, connect, createReport, runFixture, signIn } from "./lib.mjs";

assertLocalOnly();
const report = createReport("lab result verification E2E");
const { check } = report;
const db = connect();
const { suffix, nextSlot } = runFixture();

async function run() {
  const [reception] = await db`select u.id, sr.clinic_id from auth.users u join public.staff_roles sr on sr.profile_id = u.id where u.email = ${DEMO.reception}`;
  const [lab] = await db`select id from auth.users where email = ${DEMO.lab}`;
  const [lab2] = await db`select id from auth.users where email = ${DEMO.lab2}`;
  const [doctor] = await db`select d.id, d.profile_id from public.doctors d join auth.users u on u.id = d.profile_id where u.email = ${DEMO.referrer}`;
  if (!reception || !lab || !lab2 || !doctor) throw new Error("demo staff missing — run node e2e/seed-demo.mjs");
  const clinic = reception.clinic_id;
  const [service] = await db`select id from public.services where clinic_id = ${clinic} and name = ${DEMO_NAMES.generalService}`;

  const testName = `E2E tasdiq HB ${suffix}`;
  const [test] = await db`insert into public.lab_tests ${db({ clinic_id: clinic, code: `E2EVER${suffix}`.slice(0, 32), name: testName, sample_type: "Vena qoni", price: 50000 })} returning id`;
  const [param] = await db`insert into public.lab_test_parameters ${db({ clinic_id: clinic, test_id: test.id, code: "HGB", name: "Gemoglobin", value_type: "numeric", unit: "g/L", decimals: 0 })} returning id`;
  await db`insert into public.lab_reference_ranges ${db({ clinic_id: clinic, parameter_id: param.id, low: 120, high: 160 })}`;

  const patientName = `E2E Tasdiq bemor ${suffix}`;
  const [patient] = await db`insert into public.patients ${db({ clinic_id: clinic, full_name: patientName, date_of_birth: "1970-07-07" })} returning id`;
  const slot = nextSlot();
  await db`insert into public.appointments ${db({ clinic_id: clinic, patient_id: patient.id, doctor_id: doctor.id, service_id: service.id, start_at: slot.start, end_at: slot.end, status: "completed", source: "admin" })}`;
  const [order] = await db`select * from public.create_lab_order(${clinic}, ${patient.id}, ${reception.id}, 'walk_in', ${[test.id]}::uuid[], '{}'::uuid[])`;
  const [item] = await db`select id from public.lab_order_items where order_id = ${order.lab_order_id}`;
  const [sample] = await db`select * from public.collect_lab_sample(${clinic}, ${order.lab_order_id}, ${[item.id]}::uuid[], ${reception.id})`;
  await db`select public.receive_lab_sample(${clinic}, ${sample.lab_sample_id}, ${lab.id})`;
  // The first technician types 1400 by mistake and submits.
  const enter = async (value) => {
    const [r] = await db`select * from public.save_lab_result_draft(${clinic}, ${item.id}, ${lab.id}, ${db.json([{ parameter_id: param.id, value_numeric: value }])}::jsonb, null, null)`;
    return r.lab_result_id;
  };
  const v1 = await enter(1400);
  await db`select public.submit_lab_result(${clinic}, ${v1}, ${lab.id})`;

  const browser = await chromium.launch();
  const openResult = async (page, view, button) => {
    await page.goto(`${BASE}/lab`);
    await page.getByRole("button", { name: view, exact: true }).click();
    await page.getByRole("region", { name: `${patientName} buyurtmasi` }).getByRole("button", { name: button }).click();
    return page.getByRole("dialog", { name: `${testName} — natija` });
  };
  try {
    // ---------- second person returns it ----------
    const { context: c2, page: p2 } = await signIn(browser, report, DEMO.lab2);
    let dialog = await openResult(p2, "Tekshiruvda", "Ko‘rib chiqish");
    await dialog.getByText("1400 g/L").waitFor();
    check(await dialog.getByRole("button", { name: "Tasdiqlash" }).isVisible(), "reviewer: a submitted result can be verified by a second person");
    await dialog.getByRole("button", { name: "Qayta ishlashga qaytarish" }).click();
    await p2.getByText(`${testName}: natija qayta ishlashga qaytarildi`).waitFor();
    const [returned] = await db`select status from public.lab_results where id = ${v1}`;
    check(returned.status === "draft", "reviewer: the result went back to its author as a draft");

    // The author fixes and resubmits.
    await enter(140);
    await db`select public.submit_lab_result(${clinic}, ${v1}, ${lab.id})`;

    // ---------- the author cannot verify their own result ----------
    const { context: c1, page: p1 } = await signIn(browser, report, DEMO.lab);
    dialog = await openResult(p1, "Tekshiruvda", "Ko‘rib chiqish");
    await dialog.getByText("140 g/L").waitFor();
    check((await dialog.getByRole("button", { name: "Tasdiqlash" }).count()) === 0, "author: no verify button for their own result");
    check(
      (await p1.request.post(`${BASE}/api/lab/results/${v1}`, { data: { action: "verify" } })).status() === 409,
      "author: verifying their own result through the API → 409",
    );
    await dialog.getByRole("button", { name: "Yopish" }).click();

    // ---------- the second person verifies ----------
    dialog = await openResult(p2, "Tekshiruvda", "Ko‘rib chiqish");
    await dialog.getByRole("button", { name: "Tasdiqlash" }).click();
    await p2.getByText(`${testName}: natija tasdiqlandi`).waitFor();
    const [verified] = await db`select r.status, r.verified_by, o.status as order_status from public.lab_results r
      join public.lab_order_items i on i.id = r.order_item_id join public.lab_orders o on o.id = i.order_id where r.id = ${v1}`;
    check(verified.status === "verified" && verified.verified_by === lab2.id && verified.order_status === "completed", "reviewer: verified by the second person; the order completed");

    // ---------- correction as version 2 ----------
    dialog = await openResult(p2, "Tasdiqlangan", "Natija");
    await dialog.getByText(/Tasdiqlangan natija o‘zgartirilmaydi/).waitFor();
    await dialog.getByRole("button", { name: "Tuzatish" }).click();
    check(await dialog.getByRole("button", { name: "Tuzatishni boshlash" }).isDisabled(), "correction: a reason is required");
    await dialog.getByLabel("Tuzatish sababi").fill("Analizator kalibrovkasi xato edi");
    await dialog.getByRole("button", { name: "Tuzatishni boshlash" }).click();
    await dialog.getByText(/2-versiya \(tuzatish\)/).waitFor();
    check((await dialog.getByLabel("Gemoglobin qiymati").inputValue()) === "140", "correction: version 2 starts from the verified values");
    await dialog.getByLabel("Gemoglobin qiymati").fill("152");
    await dialog.getByRole("button", { name: "Saqlash va tekshiruvga yuborish" }).click();
    await p2.getByText(`${testName}: natija tekshiruvga yuborildi`).waitFor();
    await c2.close();

    // The first technician (not the author of version 2) finds it awaiting review and verifies it.
    await p1.goto(`${BASE}/lab`);
    await p1.getByRole("button", { name: "Tekshiruvda", exact: true }).click();
    const reviewCard = p1.getByRole("region", { name: `${patientName} buyurtmasi` });
    await reviewCard.getByText("Tuzatish tekshiruvda").waitFor();
    check(true, "queue: the submitted correction is listed for review");
    await reviewCard.getByRole("button", { name: "Ko‘rib chiqish" }).click();
    dialog = p1.getByRole("dialog", { name: `${testName} — natija` });
    await dialog.getByRole("button", { name: "Tasdiqlash" }).click();
    await p1.getByText(`${testName}: natija tasdiqlandi`).waitFor();
    const versions = await db`select version, status, entered_by, verified_by, correction_reason, (select value_numeric::text from public.lab_result_values v where v.result_id = r.id) as hgb
      from public.lab_results r where order_item_id = ${item.id} order by version`;
    check(
      versions.length === 2 &&
        versions[0].status === "superseded" && versions[0].hgb === "140" && versions[0].verified_by === lab2.id &&
        versions[1].status === "verified" && versions[1].hgb === "152" && versions[1].entered_by === lab2.id && versions[1].verified_by === lab.id &&
        versions[1].correction_reason === "Analizator kalibrovkasi xato edi",
      "correction: version 1 is preserved (superseded, 140); version 2 is verified (152) by another person",
    );
    dialog = await openResult(p1, "Tasdiqlangan", "Natija");
    await dialog.getByRole("button", { name: /Oldingi versiyalar \(1\)/ }).click();
    check(await dialog.getByText(/Gemoglobin: 140 g\/L/).isVisible(), "history: the superseded version is shown read-only");
    await c1.close();

    // ---------- the doctor sees the corrected result ----------
    const { context: dc, page: d } = await signIn(browser, report, DEMO.referrer);
    const res = await d.request.get(`${BASE}/api/doctor/patients/${patient.id}/lab-results/${item.id}`);
    const body = await res.json();
    check(res.status() === 200 && body.data.result.version === 2 && body.data.result.correctionReason === "Analizator kalibrovkasi xato edi", "doctor: the current verified result is the correction, with its reason");
    const [v2] = await db`select id from public.lab_results where order_item_id = ${item.id} and version = 2`;
    check(
      (await d.request.post(`${BASE}/api/lab/results/${v2.id}`, { data: { action: "correct", reason: "x" } })).status() === 403,
      "doctor: cannot correct a result someone else entered",
    );
    await dc.close();

    const audit = await db`select action, actor_id, new_values::text as v from public.audit_events where entity_type = 'lab_results' and new_values->>'order_item_id' = ${item.id} order by created_at, id`;
    const actions = audit.map((a) => a.action);
    check(
      ["lab_result_entered", "lab_result_submitted", "lab_result_returned", "lab_result_verified", "lab_result_correction_started", "lab_result_superseded", "lab_result_corrected"].every((a) => actions.includes(a)) &&
        audit.every((a) => a.actor_id) && audit.every((a) => !/1400|152|kalibrovka/.test(a.v)),
      "audit: every step recorded with its actor, ids and states only",
    );
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

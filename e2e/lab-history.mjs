// Laboratory history in the longitudinal record, in a real browser against
// the built app and a LOCAL Supabase stack (Phase 10):
//   * Dr Aliyev's patient is referred to Dr Nazarova; the patient has three
//     verified haemoglobin results over time (one ordered by Dr Aliyev), one
//     result still awaiting review, and a report attached to the latest;
//   * Dr Nazarova opens the patient → Laboratoriya → "Natijalar tarixi": the
//     three verified results (never the pending one) with order, collection
//     and verification dates, source, value and configured-range position;
//     she opens the attached report through a short-lived link;
//   * "Dinamika" shows the haemoglobin trend over the three results;
//   * the reads are audited; reception has no access; once the referral is
//     revoked Dr Nazarova's access ends while Dr Aliyev's remains.
// Rerunnable: run-unique test code and patient.
import { chromium } from "playwright";
import { BASE, DEMO, DEMO_NAMES, assertLocalOnly, connect, createReport, runFixture, signIn } from "./lib.mjs";
import { createClient } from "@supabase/supabase-js";

assertLocalOnly();
const report = createReport("lab history E2E");
const { check } = report;
const db = connect();
const { suffix, nextSlot } = runFixture();
const storage = createClient(process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }).storage;

async function run() {
  const [reception] = await db`select u.id, sr.clinic_id from auth.users u join public.staff_roles sr on sr.profile_id = u.id where u.email = ${DEMO.reception}`;
  const [lab] = await db`select id from auth.users where email = ${DEMO.lab}`;
  const [lab2] = await db`select id from auth.users where email = ${DEMO.lab2}`;
  const [drA] = await db`select d.id, d.profile_id from public.doctors d join auth.users u on u.id = d.profile_id where u.email = ${DEMO.referrer}`;
  const [drB] = await db`select d.id, d.profile_id from public.doctors d join auth.users u on u.id = d.profile_id where u.email = ${DEMO.receiver}`;
  if (!reception || !lab || !lab2 || !drA || !drB) throw new Error("demo staff missing — run node e2e/seed-demo.mjs");
  const clinic = reception.clinic_id;
  const [service] = await db`select id from public.services where clinic_id = ${clinic} and name = ${DEMO_NAMES.generalService}`;

  const testName = `E2E tarix HB ${suffix}`;
  const [test] = await db`insert into public.lab_tests ${db({ clinic_id: clinic, code: `E2EHIS${suffix}`.slice(0, 32), name: testName, sample_type: "Vena qoni", price: 40000 })} returning id`;
  const [param] = await db`insert into public.lab_test_parameters ${db({ clinic_id: clinic, test_id: test.id, code: "HGB", name: "Gemoglobin", value_type: "numeric", unit: "g/L", decimals: 0 })} returning id`;
  await db`insert into public.lab_reference_ranges ${db({ clinic_id: clinic, parameter_id: param.id, low: 120, high: 160 })}`;

  const patientName = `E2E Tarix bemor ${suffix}`;
  const [patient] = await db`insert into public.patients ${db({ clinic_id: clinic, full_name: patientName, date_of_birth: "1966-06-06" })} returning id`;
  const slot = nextSlot();
  const [visit] = await db`insert into public.appointments ${db({ clinic_id: clinic, patient_id: patient.id, doctor_id: drA.id, service_id: service.id, start_at: slot.start, end_at: slot.end, status: "completed", source: "admin" })} returning id`;
  const [referral] = await db`insert into public.referrals ${db({ clinic_id: clinic, patient_id: patient.id, referring_doctor_id: drA.id, referred_to_doctor_id: drB.id, originating_appointment_id: visit.id, reason: `Kardiolog ko‘rigi ${suffix}`, created_by: drA.profile_id })} returning id`;

  async function verifiedResult(value, performedDaysAgo, opts = {}) {
    const [order] = await db`select * from public.create_lab_order(${clinic}, ${patient.id}, ${opts.byDoctor ? drA.profile_id : reception.id}, 'walk_in', ${[test.id]}::uuid[], '{}'::uuid[], null, ${opts.byDoctor ? drA.id : null})`;
    const [item] = await db`select id from public.lab_order_items where order_id = ${order.lab_order_id}`;
    const [sample] = await db`select * from public.collect_lab_sample(${clinic}, ${order.lab_order_id}, ${[item.id]}::uuid[], ${reception.id})`;
    await db`select public.receive_lab_sample(${clinic}, ${sample.lab_sample_id}, ${lab.id})`;
    const performed = new Date(Date.now() - performedDaysAgo * 86_400_000).toISOString();
    const [r] = await db`select * from public.save_lab_result_draft(${clinic}, ${item.id}, ${lab.id}, ${db.json([{ parameter_id: param.id, value_numeric: value }])}::jsonb, null, ${performed})`;
    await db`select public.submit_lab_result(${clinic}, ${r.lab_result_id}, ${lab.id})`;
    if (opts.verify !== false) await db`select public.verify_lab_result(${clinic}, ${r.lab_result_id}, ${lab2.id})`;
    return { itemId: item.id, resultId: r.lab_result_id, orderId: order.lab_order_id };
  }
  await verifiedResult(140, 60, { byDoctor: true });
  await verifiedResult(128, 30);
  const latest = await verifiedResult(115, 2);
  const pending = await verifiedResult(99, 1, { verify: false });

  const docId = crypto.randomUUID();
  const reportText = `%PDF-1.4 E2E lab report ${suffix}`;
  const { error: upErr } = await storage.from("lab-documents").upload(`${clinic}/${docId}`, new TextEncoder().encode(reportText), { contentType: "application/pdf" });
  if (upErr) throw new Error(upErr.message);
  await db`insert into public.lab_documents ${db({ id: docId, clinic_id: clinic, patient_id: patient.id, order_id: latest.orderId, result_id: latest.resultId, kind: "report", storage_path: `${clinic}/${docId}`, mime_type: "application/pdf", size_bytes: reportText.length, sha256: "b".repeat(64), uploaded_by: lab.id })}`;

  const browser = await chromium.launch();
  try {
    const { context: bc, page: b } = await signIn(browser, report, DEMO.receiver);
    await b.goto(`${BASE}/doctor/patients/${patient.id}`);
    await b.waitForLoadState("networkidle");
    const labSection = b.getByRole("region", { name: "Laboratoriya" });
    await labSection.getByRole("tab", { name: "Natijalar tarixi" }).click();
    const list = labSection.getByRole("list", { name: "Natijalar tarixi" });
    await list.waitFor();
    const items = list.locator(":scope > li");
    check((await items.count()) === 3, "referred doctor: the three verified results are listed (the pending one is not)");
    check(await items.first().getByText(/me’yordan tashqarida/).isVisible(), "referred doctor: the latest result shows a value outside the configured range");
    const first = items.first();
    check(await first.getByText(/Buyurtma: /).isVisible() && (await first.getByText(/Namuna olingan: /).isVisible()) && (await first.getByText(/Tasdiqlangan: .*Laborant Ikki/).isVisible()), "referred doctor: order, collection and verification dates with the verifier");
    check(await first.getByText("115 g/L").isVisible() && (await first.getByText("Me’yordan past").isVisible()) && (await first.getByText("Manba: Klinika laboratoriyasi").isVisible()), "referred doctor: value, configured-range position and source");
    check(await first.getByText(/bu tashxis emas/).isVisible(), "referred doctor: the history says positions are not a diagnosis");

    // Headless Chromium turns a PDF into a download, so watch the signed request rather than the page.
    const signed = bc.waitForEvent("request", { predicate: (r) => /\/storage\/v1\/object\/sign\/lab-documents\//.test(r.url()), timeout: 15_000 });
    const [popup] = await Promise.all([b.waitForEvent("popup"), first.getByRole("button", { name: /Hisobot/ }).click()]);
    const opened = (await signed).url();
    const body = await (await b.request.get(opened)).text();
    check(opened.includes("/storage/v1/object/sign/lab-documents/") && body.includes(`E2E lab report ${suffix}`), "referred doctor: the attached report opens through a signed link");
    await popup.close().catch(() => {});

    await labSection.getByRole("tab", { name: "Dinamika" }).click();
    const trend = labSection.getByRole("figure", { name: `Gemoglobin — ${testName}` });
    await trend.waitFor();
    check((await trend.locator("tbody tr").count()) === 3 && (await trend.getByText("Oxirgi: 115 g/L").isVisible()), "referred doctor: the haemoglobin trend shows the three results");

    const [{ n }] = await db`select count(*)::int as n from public.audit_events where action = 'lab_result_viewed' and actor_id = ${drB.profile_id} and patient_id = ${patient.id}`;
    const [{ d }] = await db`select count(*)::int as d from public.audit_events where action = 'lab_document_viewed' and actor_id = ${drB.profile_id} and entity_id = ${docId}`;
    check(n >= 3 && d === 1, "audit: each result read and the document link are recorded for the referred doctor");
    const pendingSeen = await db`select 1 from public.audit_events where action = 'lab_result_viewed' and entity_id = ${pending.resultId}`;
    check(pendingSeen.length === 0, "audit: the result awaiting review was never read");

    // The referral is revoked: Dr Nazarova's access ends.
    await db`update public.referrals set status = 'revoked', revoked_at = now(), revoked_by = ${drA.profile_id}, revoked_reason = 'E2E' where id = ${referral.id}`;
    check([404, 410].includes((await b.request.get(`${BASE}/api/doctor/patients/${patient.id}/lab-history`)).status()), "referred doctor: access ends when the referral is revoked");
    await bc.close();

    const { context: ac, page: a } = await signIn(browser, report, DEMO.referrer);
    check((await a.request.get(`${BASE}/api/doctor/patients/${patient.id}/lab-history`)).status() === 200, "own doctor: still sees the history");
    await ac.close();
    const { context: rc, page: r } = await signIn(browser, report, DEMO.reception);
    check((await r.request.get(`${BASE}/api/doctor/patients/${patient.id}/lab-history`)).status() === 403, "reception: no access to the doctor history API");
    await rc.close();
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

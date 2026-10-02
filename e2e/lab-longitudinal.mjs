// End-to-end, in the BUILT app, through the real screens — finalised laboratory results in the longitudinal record and result documents (phase 7):
//
//   A technician attaches a PDF to a draft result on the results screen. Until the result is verified no doctor sees it - nor the document.
//   After verification the ordering doctor opens the patient's Laboratoriya tab and Klinik tarix: the result is there, with its values,
//   the "outside the configured range" flag (no diagnosis), dates, source and the document, which opens only through the authorised route.
//   A doctor with no relationship to the patient gets a 404 for the results and the document; an anonymous request is refused (401);
//   there is no public storage URL. The result is read-only for the doctor, a correction keeps the previous version visible.
//
// Needs the local stack, `node e2e/seed-demo.mjs`, and the app running (`npm run build && npm start`). Rerunnable.
import { mkdirSync } from "node:fs";
import { chromium, request as pwRequest } from "playwright";
import { BASE, DEMO, DEMO_NAMES, PASSWORD, VIEWPORTS, assertLocalOnly, connect, createReport, runFixture, signIn } from "./lib.mjs";

assertLocalOnly();
const SHOTS = process.env.E2E_ARTIFACTS_DIR ?? "test-results/e2e";
mkdirSync(SHOTS, { recursive: true });
const report = createReport("laboratory longitudinal record and documents E2E");
const { check } = report;
const db = connect();
const { suffix } = runFixture();
const PATIENT = `E2E Bemor ${suffix}`;
const TEST = `Qon tahlili ${suffix}`;
const PDF = Buffer.from(`%PDF-1.4\n% e2e lab report ${suffix}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF`);
const shown = (locator) => locator.waitFor({ timeout: 8_000 }).then(() => true, () => false);
const openTab = (page, name) => page.getByRole("navigation", { name: "Bemor kartasi bo‘limlari" }).getByRole("button", { name, exact: true }).click();

async function loginLab(browser, email) {
  const context = await browser.newContext({ viewport: VIEWPORTS.desktop });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.problems.push(`[${email}] pageerror: ${e.message}`));
  page.on("response", (r) => r.status() >= 500 && report.problems.push(`[${email}] HTTP ${r.status()} ${r.url()}`));
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Parol").fill(PASSWORD);
  await page.getByRole("button", { name: "Kirish" }).click();
  await page.waitForURL(/\/lab(\/|$|\?)/, { timeout: 20_000 });
  await page.waitForLoadState("networkidle");
  return { context, page };
}

async function run() {
  const [doctor] = await db`select d.id, d.profile_id, d.clinic_id from public.doctors d join auth.users u on u.id = d.profile_id where u.email = ${DEMO.referrer}`;
  if (!doctor) throw new Error("run node e2e/seed-demo.mjs first");
  const [lab1] = await db`select id from auth.users where email = ${DEMO.lab}`;
  const [lab2] = await db`select id from auth.users where email = ${DEMO.lab2}`;
  const clinic = doctor.clinic_id;
  const [service] = await db`select id from public.services where clinic_id = ${clinic} and name = ${DEMO_NAMES.generalService}`;

  await db`insert into public.app_settings (clinic_id, key, value) values (${clinic}, 'lab', ${db.json({ verification: { required: true, separateVerifier: false }, collection: { requiresPayment: false }, ordering: { recentTestWindowDays: 30 } })})
           on conflict (clinic_id, key) do update set value = excluded.value`;
  await db`update public.appointments a set status = 'cancelled', cancelled_at = now(), cancelled_reason = 'E2E: an earlier run'
             from public.patients p
            where p.id = a.patient_id and a.clinic_id = ${clinic} and a.doctor_id = ${doctor.id}
              and a.status not in ('cancelled', 'no_show')
              and tstzrange(a.start_at, a.end_at) && tstzrange(now() - interval '3 hours', now() + interval '3 hours')`;
  const [test] = await db`insert into public.lab_tests (clinic_id, code, name, price, sample_type) values (${clinic}, ${`E2E-L-${suffix}`.toUpperCase()}, ${TEST}, 85000, 'qon') returning id`;
  const [hgb] = await db`insert into public.lab_test_parameters (clinic_id, test_id, code, name, unit, data_type) values (${clinic}, ${test.id}, 'HGB', 'Gemoglobin', 'g/L', 'numeric') returning id`;
  await db`insert into public.lab_reference_ranges (clinic_id, parameter_id, low, high, critical_low, critical_high) values (${clinic}, ${hgb.id}, 120, 160, 70, 200)`;
  const [patient] = await db`insert into public.patients (clinic_id, full_name) values (${clinic}, ${PATIENT}) returning id`;
  const start = new Date(Math.floor((Date.now() - 20 * 60_000) / 60_000) * 60_000);
  const [consult] = await db`insert into public.appointments ${db({
    clinic_id: clinic, patient_id: patient.id, doctor_id: doctor.id, service_id: service.id, start_at: start,
    end_at: new Date(start.getTime() + 20 * 60_000), status: "in_progress", source: "admin",
  })} returning id`;
  const [{ r }] = await db`select public.lab_create_order(${clinic}, ${doctor.profile_id}, ${patient.id}, ${doctor.id}, ${consult.id}, null, 'routine', 'Doctor note', ${crypto.randomUUID()}, ${db.json([{ test_id: test.id }])}) as r`;
  await db`select public.lab_create_samples(${clinic}, ${lab1.id}, ${r.order_id})`;
  const [sample] = await db`select id from public.lab_samples where order_id = ${r.order_id}`;
  await db`select public.lab_sample_transition(${clinic}, ${lab1.id}, ${sample.id}, 'collected', null)`;
  const [item] = await db`select id from public.lab_order_items where order_id = ${r.order_id}`;
  const [{ r: saved }] = await db`select public.lab_result_save(${clinic}, ${lab1.id}, ${item.id}, ${db.json([{ parameter_id: hgb.id, value_numeric: 118.5 }])}) as r`;

  const browser = await chromium.launch();
  try {
    // ---------- The technician attaches a PDF to the draft ----------
    const { context: labCtx, page: lab } = await loginLab(browser, DEMO.lab);
    await lab.goto(`${BASE}/lab/results/${item.id}`);
    await lab.getByLabel("Hujjat fayli").setInputFiles({ name: "Ali Valiyev natija.pdf", mimeType: "application/pdf", buffer: PDF });
    await lab.getByRole("button", { name: "Yuklash" }).click();
    check(await shown(lab.getByText("Hujjat qo‘shildi.")), "the technician attaches a PDF to the draft result");
    const [att] = await db`select id, content_type, size_bytes, storage_path from public.lab_result_attachments where result_id = ${saved.result_id}`;
    check(att?.content_type === "application/pdf" && Number(att.size_bytes) === PDF.length, "it is stored as a PDF of the same size");
    check(!att.storage_path.includes("Valiyev") && att.storage_path.startsWith(`${clinic}/${patient.id}/`), "…under the clinic and patient folders, without the file name");
    const own = await lab.request.get(`${BASE}/api/lab/documents/${att.id}`);
    check(own.status() === 200 && (await own.body()).equals(PDF), "the technician can open it (the exact bytes)");
    // A text file renamed .pdf is refused.
    const bad = await lab.request.post(`${BASE}/api/lab/results/${item.id}/documents`, { multipart: { kind: "report", file: { name: "x.pdf", mimeType: "application/pdf", buffer: Buffer.from("not a pdf") } } });
    check(bad.status() === 415, "a text file renamed .pdf is refused (415)");

    // ---------- Nothing is visible to doctors until verified ----------
    const { context: docCtx, page: a } = await signIn(browser, report, DEMO.referrer, "desktop", { expectDenials: true });
    const before = await a.request.get(`${BASE}/api/doctor/patients/${patient.id}/lab/results`);
    check(before.status() === 200 && (await before.json()).data.results.every((x) => x.itemId !== item.id), "a draft result is not in the doctor's record");
    check((await a.request.get(`${BASE}/api/doctor/patients/${patient.id}/lab/documents/${att.id}`)).status() === 404, "…and its document is not reachable by the doctor");

    // ---------- Verified: the record shows it ----------
    await db`select public.lab_result_submit(${clinic}, ${lab1.id}, ${saved.version_id})`;
    await db`select public.lab_result_verify(${clinic}, ${lab2.id}, ${saved.version_id})`;
    await a.goto(`${BASE}/doctor/patients/${patient.id}`);
    await a.getByRole("heading", { name: PATIENT }).waitFor({ timeout: 15_000 });
    await openTab(a, "Laboratoriya");
    check(await shown(a.getByText("Laboratoriya tasdiqlagan natijalar", { exact: true })), "the Laboratoriya tab has a section of finalised results");
    check(await shown(a.getByText(/1 ta qiymat me‘yordan tashqarida/)), "…with the count of values outside the configured range");
    await a.getByRole("button", { name: "Ko‘rish" }).first().click();
    check(await shown(a.getByText("Me‘yordan past")), "the result opens with its flag worded as 'outside the range' (low), nothing more");
    check(await shown(a.getByText(/118\.5/)), "…and its value");
    check(await shown(a.getByText(/bu tashxis emas/)), "…and says a flag is not a diagnosis");
    check((await a.getByText(/anemiya|kamqonlik|kasal/i).count()) === 0, "…and no disease conclusion appears");
    check(await shown(a.getByText(/tasdiqlagan: Laborant 2/)), "…the source: who entered and who verified");
    check(await shown(a.getByRole("link", { name: "Ochish" })), "…and the document is listed");
    await a.screenshot({ path: `${SHOTS}/lab-result-doctor-view.png`, fullPage: true });
    check((await a.getByRole("button", { name: /Saqlash|Tasdiqlash|Tuzatish|Yuklash/ }).count()) === 0, "the doctor has no way to change a result");
    const viaLink = await a.request.get(`${BASE}/api/doctor/patients/${patient.id}/lab/documents/${att.id}`);
    check(viaLink.status() === 200 && (await viaLink.body()).equals(PDF) && viaLink.headers()["cache-control"] === "private, no-store", "the document opens through the authorised route (private, no-store)");
    await a.keyboard.press("Escape");
    await a.getByRole("button", { name: "Yopish" }).click().catch(() => undefined);
    await openTab(a, "Klinik tarix");
    check(await shown(a.getByText(TEST).first()), "the finalised result is also in the patient's Klinik tarix timeline");

    // ---------- A correction keeps the previous version ----------
    const [{ r: corr }] = await db`select public.lab_result_correct(${clinic}, ${lab1.id}, ${saved.result_id}, 1, 'Typing mistake') as r`;
    await db`select public.lab_result_save(${clinic}, ${lab1.id}, ${item.id}, ${db.json([{ parameter_id: hgb.id, value_numeric: 131 }])})`;
    const during = await a.request.get(`${BASE}/api/doctor/patients/${patient.id}/lab/results/${item.id}`);
    check((await during.json()).data.result.version === 1, "while a correction is a draft the doctor still sees the finalised version");
    await db`select public.lab_result_submit(${clinic}, ${lab1.id}, ${corr.version_id})`;
    await db`select public.lab_result_verify(${clinic}, ${lab2.id}, ${corr.version_id})`;
    const after = (await (await a.request.get(`${BASE}/api/doctor/patients/${patient.id}/lab/results/${item.id}`)).json()).data.result;
    check(after.version === 2 && after.previous.length === 1 && after.previous[0].values[0].value === 118.5 && after.current.values[0].value === 131, "after the corrected version is verified the old one is kept as a previous version");
    await docCtx.close();

    // ---------- Others ----------
    const { context: bCtx, page: b } = await signIn(browser, report, DEMO.receiver, "desktop", { expectDenials: true });
    check((await b.request.get(`${BASE}/api/doctor/patients/${patient.id}/lab/results`)).status() === 404, "a doctor with no relationship gets a 404 for the results");
    check((await b.request.get(`${BASE}/api/doctor/patients/${patient.id}/lab/documents/${att.id}`)).status() === 404, "…and for the document");
    check((await b.request.get(`${BASE}/api/lab/documents/${att.id}`)).status() === 403, "…and the laboratory route refuses a doctor");
    await bCtx.close();
    const anon = await pwRequest.newContext();
    check((await anon.get(`${BASE}/api/doctor/patients/${patient.id}/lab/documents/${att.id}`)).status() === 401, "an anonymous request is refused (401)");
    check((await anon.get(`${BASE}/api/lab/documents/${att.id}`)).status() === 401, "…on the laboratory route too");
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
    if (supabaseUrl) {
      const pub = await anon.get(`${supabaseUrl}/storage/v1/object/public/lab-documents/${att.storage_path}`);
      check(pub.status() !== 200, "there is no public storage URL for the document");
    }
    await anon.dispose();
    const { context: recCtx, page: rec } = await signIn(browser, report, DEMO.reception, "desktop", { expectDenials: true });
    check((await rec.request.get(`${BASE}/api/lab/documents/${att.id}`)).status() === 403, "reception cannot open a laboratory document");
    await recCtx.close();
    await labCtx.close();

    const audit = await db`select action, new_values, metadata from public.audit_events where patient_id = ${patient.id} and (action in ('lab_document_downloaded', 'lab_attachment_added') or (action = 'lab_result_viewed'))`;
    check(["lab_document_downloaded", "lab_attachment_added", "lab_result_viewed"].every((x) => audit.some((e) => e.action === x)), "uploads, downloads and result views are in the audit trail");
    check(!JSON.stringify(audit).includes("118.5") && !JSON.stringify(audit).includes("Valiyev"), "…without values or file names");
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

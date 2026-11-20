// Lab result documents in a real browser against the built app and a LOCAL
// Supabase stack (Phase 11):
//   * the technician attaches a PDF report to the result being entered (from
//     the result dialog); a renamed non-PDF is refused on screen; a wrong
//     file is withdrawn with a reason (kept, no longer offered);
//   * files open only through a short-lived signed link;
//   * after verification the referring doctor sees the report in the
//     patient's lab history;
//   * direct HTTP attacks against the running app and the storage endpoint
//     (no session, public URL, guessed ids) get nothing.
// Rerunnable: run-unique test code and patient.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { BASE, DEMO, DEMO_NAMES, assertLocalOnly, connect, createReport, runFixture, signIn } from "./lib.mjs";

assertLocalOnly();
const report = createReport("lab documents E2E");
const { check } = report;
const db = connect();
const { suffix, nextSlot } = runFixture();
// Fixture files: a real (tiny) PDF and a non-PDF renamed to .pdf.
const SCRATCH = mkdtempSync(join(tmpdir(), "lab-docs-"));
writeFileSync(join(SCRATCH, "report.pdf"), "%PDF-1.4\n% E2E lab document\n%%EOF\n");
writeFileSync(join(SCRATCH, "fake.pdf"), "MZ fake executable named pdf");
const SUPABASE = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;

async function run() {
  const [reception] = await db`select u.id, sr.clinic_id from auth.users u join public.staff_roles sr on sr.profile_id = u.id where u.email = ${DEMO.reception}`;
  const [lab] = await db`select id from auth.users where email = ${DEMO.lab}`;
  const [lab2] = await db`select id from auth.users where email = ${DEMO.lab2}`;
  const [drA] = await db`select d.id, d.profile_id from public.doctors d join auth.users u on u.id = d.profile_id where u.email = ${DEMO.referrer}`;
  if (!reception || !lab || !lab2 || !drA) throw new Error("demo staff missing — run node e2e/seed-demo.mjs");
  const clinic = reception.clinic_id;
  const [service] = await db`select id from public.services where clinic_id = ${clinic} and name = ${DEMO_NAMES.generalService}`;

  const testName = `E2E hujjat HB ${suffix}`;
  const [test] = await db`insert into public.lab_tests ${db({ clinic_id: clinic, code: `E2EDOC${suffix}`.slice(0, 32), name: testName, sample_type: "Vena qoni", price: 40000 })} returning id`;
  const [param] = await db`insert into public.lab_test_parameters ${db({ clinic_id: clinic, test_id: test.id, code: "HGB", name: "Gemoglobin", value_type: "numeric", unit: "g/L" })} returning id`;
  const patientName = `E2E Hujjat bemor ${suffix}`;
  const [patient] = await db`insert into public.patients ${db({ clinic_id: clinic, full_name: patientName, date_of_birth: "1977-07-07" })} returning id`;
  const slot = nextSlot();
  await db`insert into public.appointments ${db({ clinic_id: clinic, patient_id: patient.id, doctor_id: drA.id, service_id: service.id, start_at: slot.start, end_at: slot.end, status: "completed", source: "admin" })}`;
  const [order] = await db`select * from public.create_lab_order(${clinic}, ${patient.id}, ${drA.profile_id}, 'walk_in', ${[test.id]}::uuid[], '{}'::uuid[], null, ${drA.id})`;
  const [item] = await db`select id from public.lab_order_items where order_id = ${order.lab_order_id}`;
  const [sample] = await db`select * from public.collect_lab_sample(${clinic}, ${order.lab_order_id}, ${[item.id]}::uuid[], ${reception.id})`;
  await db`select public.receive_lab_sample(${clinic}, ${sample.lab_sample_id}, ${lab.id})`;
  const [draft] = await db`select * from public.save_lab_result_draft(${clinic}, ${item.id}, ${lab.id}, ${db.json([{ parameter_id: param.id, value_numeric: 131 }])}::jsonb, null, null)`;

  const browser = await chromium.launch();
  try {
    // ---------- no session: nothing ----------
    const anon = await browser.newContext();
    check((await anon.request.get(`${BASE}/api/lab/orders/${order.lab_order_id}/documents`)).status() === 401, "no session: document list API → 401");
    check(
      (await anon.request.post(`${BASE}/api/lab/orders/${order.lab_order_id}/documents`, { multipart: { kind: "report", file: { name: "r.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") } } })).status() === 401,
      "no session: upload API → 401",
    );

    // ---------- the technician attaches files ----------
    const { context: lc, page: l } = await signIn(browser, report, DEMO.lab, "desktop", { expectDenials: true });
    await l.getByRole("button", { name: "Jarayonda", exact: true }).click();
    await l.getByRole("region", { name: `${patientName} buyurtmasi` }).getByRole("button", { name: "Natija kiritish" }).click();
    const dialog = l.getByRole("dialog", { name: `${testName} — natija` });
    const files = dialog.getByRole("group", { name: "Ilovalar" });
    await files.getByText("Hali fayl biriktirilmagan.").waitFor();

    await files.getByLabel("Fayl tanlash").setInputFiles(`${SCRATCH}/fake.pdf`);
    await files.getByText("Faqat PDF, JPEG, PNG yoki WebP fayl yuklanadi").waitFor();
    check(true, "lab: a renamed non-PDF is refused on screen");

    await files.getByLabel("Fayl tanlash").setInputFiles(`${SCRATCH}/report.pdf`);
    await files.getByText(/Hisobot \(PDF\) · 1 KB/).first().waitFor();
    await files.getByLabel("Fayl tanlash").setInputFiles(`${SCRATCH}/report.pdf`);
    await l.waitForTimeout(500);
    const docs = await db`select id, result_id, mime_type, uploaded_by from public.lab_documents where order_id = ${order.lab_order_id} order by created_at`;
    check(docs.length === 2 && docs.every((d) => d.result_id === draft.lab_result_id && d.mime_type === "application/pdf" && d.uploaded_by === lab.id), "lab: two PDFs attached to the draft result with provenance");

    const signed = lc.waitForEvent("request", { predicate: (r) => /\/storage\/v1\/object\/sign\/lab-documents\//.test(r.url()), timeout: 15_000 });
    await files.getByRole("button", { name: "Ochish" }).first().click();
    const signedUrl = (await signed).url();
    check((await l.request.get(signedUrl)).status() === 200, "lab: a file opens through a signed link");

    await files.getByRole("button", { name: "Olib tashlash" }).nth(1).click();
    await files.getByLabel("Olib tashlash sababi").fill("Ikki marta yuklangan");
    await files.getByRole("button", { name: "Olib tashlash" }).last().click();
    await files.getByText("Olib tashlangan: Ikki marta yuklangan").waitFor();
    const [withdrawn] = await db`select withdrawn_by, withdraw_reason from public.lab_documents where id = ${docs[1].id}`;
    check(withdrawn.withdrawn_by === lab.id && withdrawn.withdraw_reason === "Ikki marta yuklangan", "lab: the duplicate is withdrawn with a reason (kept)");
    check((await l.request.get(`${BASE}/api/lab/documents/${docs[1].id}`)).status() === 404, "lab: a withdrawn file is no longer offered");

    await dialog.getByRole("button", { name: "Saqlash va tekshiruvga yuborish" }).click();
    await l.getByText(`${testName}: natija tekshiruvga yuborildi`).waitFor();
    await lc.close();
    await db`select public.verify_lab_result(${clinic}, ${draft.lab_result_id}, ${lab2.id})`;

    // ---------- the doctor sees the report ----------
    const { context: dc, page: d } = await signIn(browser, report, DEMO.referrer);
    const history = await (await d.request.get(`${BASE}/api/doctor/patients/${patient.id}/lab-history`)).json();
    const shown = history.data.results.find((r) => r.itemId === item.id);
    check(shown && shown.documents.length === 1 && shown.documents[0].id === docs[0].id, "doctor: the verified result shows the report (not the withdrawn copy)");
    check((await d.request.get(`${BASE}/api/lab/documents/${docs[0].id}`)).status() === 403, "doctor: the lab document API is lab-only");
    await dc.close();

    // ---------- direct storage attacks ----------
    const path = `${clinic}/${docs[0].id}`;
    check((await anon.request.get(`${SUPABASE}/storage/v1/object/public/lab-documents/${path}`)).status() >= 400, "storage: the public URL of the file serves nothing");
    check((await anon.request.get(`${SUPABASE}/storage/v1/object/lab-documents/${path}`)).status() >= 400, "storage: the object URL without a token serves nothing");
    check(
      (await anon.request.get(signedUrl.replace(/token=[^&]+/, "token=forged"))).status() >= 400,
      "storage: a forged signature serves nothing",
    );
    await anon.close();
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

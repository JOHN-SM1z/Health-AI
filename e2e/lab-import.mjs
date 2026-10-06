// Historical lab import in a real browser against the built app and a LOCAL
// Supabase stack (Phase 13):
//   * a lab technician uploads a CSV exported from the previous system,
//     keeps the suggested column mapping and analyses it: valid rows are
//     ready, an unknown patient is reported, a weak (phone + birth date)
//     match waits until the technician confirms the suggested patient;
//   * the technician cannot confirm their own import;
//   * a second technician (phone-sized screen) runs a dry run, confirms,
//     and the results are imported with their historical date, source
//     "import", entered by the first and verified by the second person;
//   * the report downloads without values; other roles and no session get nothing.
// Rerunnable: run-unique test code, patients and file.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { BASE, DEMO, assertLocalOnly, connect, createReport, runFixture, signIn } from "./lib.mjs";

assertLocalOnly();
const report = createReport("lab import E2E");
const { check } = report;
const db = connect();
const { suffix } = runFixture();
const SCRATCH = mkdtempSync(join(tmpdir(), "lab-import-"));

async function run() {
  const [reception] = await db`select u.id, sr.clinic_id from auth.users u join public.staff_roles sr on sr.profile_id = u.id where u.email = ${DEMO.reception}`;
  const [lab] = await db`select id from auth.users where email = ${DEMO.lab}`;
  const [lab2] = await db`select id from auth.users where email = ${DEMO.lab2}`;
  if (!reception || !lab || !lab2) throw new Error("demo staff missing — run node e2e/seed-demo.mjs");
  const clinic = reception.clinic_id;

  const code = `E2EIMP${suffix}`.slice(0, 32).toUpperCase();
  const testName = `E2E import glyukoza ${suffix}`;
  const [test] = await db`insert into public.lab_tests ${db({ clinic_id: clinic, code, name: testName, sample_type: "Qon", price: 20000 })} returning id`;
  await db`insert into public.lab_test_parameters ${db({ clinic_id: clinic, test_id: test.id, code: "GLU", name: "Glyukoza", value_type: "numeric", unit: "mmol/L", decimals: 1 })}`;
  const digits = String(Date.now()).slice(-11);
  const pinfl = `5${digits}01`.slice(0, 14);
  const phone = `+99890${digits.slice(-7)}`;
  const strongName = `E2E Import Aniq ${suffix}`;
  const weakName = `E2E Import Ehtimol ${suffix}`;
  const [strong] = await db`insert into public.patients ${db({ clinic_id: clinic, full_name: strongName, pinfl, date_of_birth: "1980-02-02" })} returning id`;
  const [weak] = await db`insert into public.patients ${db({ clinic_id: clinic, full_name: weakName, phone, date_of_birth: "1975-03-03" })} returning id`;

  const csv =
    "JShShIR;Telefon;Tug'ilgan sana;F.I.Sh.;Tahlil;Natija;Birlik;Sana;Buyurtma\n" +
    `${pinfl};;02.02.1980;${strongName};${code};5,6;mmol/L;12.01.2023;MP-${suffix}-1\n` +
    `;${phone};03.03.1975;${weakName};${code};6.3;mmol/L;13.01.2023;MP-${suffix}-2\n` +
    `99999999999999;;;Noma'lum;${code};4.9;;14.01.2023;MP-${suffix}-3\n`;
  const file = join(SCRATCH, `medplus-${suffix}.csv`);
  writeFileSync(file, csv);

  const browser = await chromium.launch();
  try {
    const anon = await browser.newContext();
    check((await anon.request.get(`${BASE}/api/lab/imports`)).status() === 401, "no session: import API → 401");
    await anon.close();

    // ---------- the preparer ----------
    const { context: pc, page: p } = await signIn(browser, report, DEMO.lab, "desktop", { expectDenials: true });
    await p.getByRole("link", { name: "Import" }).first().click();
    await p.getByRole("heading", { name: "Tarixiy natijalar importi" }).waitFor();
    await p.getByLabel("Manba tizimi").fill("MedPlus");
    await p.getByLabel("CSV fayl").setInputFiles(file);
    await p.getByRole("button", { name: "Yuklash" }).click();
    await p.waitForURL(/\/lab\/imports\/[0-9a-f-]{36}$/);
    const batchId = p.url().split("/").pop();
    const [uploaded] = await db`select status, row_count, created_by, mapping from public.lab_import_batches where id = ${batchId}`;
    check(uploaded.status === "uploaded" && uploaded.row_count === 3 && uploaded.created_by === lab.id, "lab: the file is uploaded (3 rows), nothing imported yet");
    check(uploaded.mapping.pinfl === 0 && uploaded.mapping.test_code === 4 && uploaded.mapping.performed_at === 7, "lab: the column mapping is suggested from the headers");

    await p.getByRole("button", { name: "Tahlil qilish" }).click();
    await p.getByText("Fayl tahlil qilindi").waitFor();
    const rows = () => db`select row_number, status, errors from public.lab_import_rows where batch_id = ${batchId} order by row_number`;
    let r = await rows();
    check(
      r[0].status === "ready" && r[1].status === "possible_match" && r[2].status === "unmatched" && r[2].errors.includes("no_candidate"),
      "lab: exact PINFL match ready, phone + birth date waits for confirmation, unknown PINFL unmatched",
    );
    const table = p.getByRole("region", { name: "Qatorlar" });
    await table.locator('tr[data-row="3"]').getByText("Klinikada bunday bemor yo‘q").waitFor();
    check(true, "lab: the unmatched row shows its reason");
    check((await p.getByRole("button", { name: /Tasdiqlash va import qilish/ }).count()) === 0, "lab: the preparer is not offered the confirmation");
    await p.getByText("Importni boshqa laboratoriya xodimi tasdiqlashi kerak").waitFor();

    await p.getByRole("button", { name: "Tasdiqlash kerak" }).click();
    await table.locator('tr[data-row="2"]').getByText(weakName).waitFor();
    await table.locator('tr[data-row="2"]').getByRole("button", { name: "Shu bemor" }).click();
    await p.getByText("Bemor tasdiqlandi").waitFor();
    r = await rows();
    const [confirmedRow] = await db`select patient_id, match_kind, match_confirmed_by from public.lab_import_rows where batch_id = ${batchId} and row_number = 2`;
    check(r[1].status === "ready" && confirmedRow.patient_id === weak.id && confirmedRow.match_kind === "staff_confirmed" && confirmedRow.match_confirmed_by === lab.id, "lab: the suggested patient is confirmed by the preparer (recorded)");
    const own = await p.request.post(`${BASE}/api/lab/imports/${batchId}`, { data: { action: "confirm" } });
    check(own.status() === 409 && (await own.json()).code === "second_person_required", "lab: the preparer cannot confirm their own import (API)");
    await pc.close();

    // ---------- the second person ----------
    const { context: rc, page: q } = await signIn(browser, report, DEMO.lab2, "phone");
    await q.goto(`${BASE}/lab/imports/${batchId}`);
    await q.getByRole("button", { name: "Sinov importi" }).click();
    await q.getByText("Sinov importi tugadi").waitFor();
    await q.getByLabel("Sinov natijasi").getByText(/2 natija import bo‘ladi, 0 bo‘lmaydi/).waitFor();
    const [{ n: before }] = await db`select count(*)::int as n from public.lab_orders where clinic_id = ${clinic} and source = 'external_import' and patient_id in (${strong.id}, ${weak.id})`;
    check(before === 0, "lab2: the dry run writes nothing");

    await q.getByRole("button", { name: "Tasdiqlash va import qilish (2 natija)" }).click();
    await q.getByText("Import qilindi: 2 natija").waitFor();
    const results = await db`
      select r.patient_id, r.source, r.status, r.entered_by, r.verified_by, r.performed_at, o.source as order_source, o.status as order_status
      from public.lab_results r join public.lab_order_items i on i.id = r.order_item_id join public.lab_orders o on o.id = i.order_id
      where r.clinic_id = ${clinic} and i.test_id = ${test.id} order by r.performed_at`;
    check(results.length === 2, "lab2: two results imported (the unmatched row is not)");
    check(
      results.every((x) => x.source === "import" && x.status === "verified" && x.entered_by === lab.id && x.verified_by === lab2.id && x.order_source === "external_import" && x.order_status === "completed"),
      "lab2: imported as verified, entered by the preparer, verified by the confirmer",
    );
    check(results[0].patient_id === strong.id && results[0].performed_at.toISOString() === "2023-01-12T07:00:00.000Z", "lab2: the historical date is kept");
    const [batch] = await db`select status, confirmed_by from public.lab_import_batches where id = ${batchId}`;
    check(batch.status === "completed" && batch.confirmed_by === lab2.id, "lab2: the import is completed and records who confirmed it");
    const [{ n: jobs }] = await db`select count(*)::int as n from public.notification_jobs where lab_result_id in (select r.id from public.lab_results r join public.lab_order_items i on i.id = r.order_item_id where i.test_id = ${test.id})`;
    check(jobs === 0, "lab2: historical results notify nobody");

    const csvReport = await q.request.get(`${BASE}/api/lab/imports/${batchId}/report`);
    const body = await csvReport.text();
    check(csvReport.status() === 200 && body.includes("3;Bemor topilmadi") && !body.includes(pinfl) && !body.includes("5,6"), "lab2: the report lists row outcomes without identifiers or values");
    const queue = await (await q.request.get(`${BASE}/api/lab/queue`)).json();
    check(!queue.data.orders.some((o) => o.source === "external_import"), "lab2: imported orders are not in the work queue");
    await rc.close();

    // ---------- other roles ----------
    const { context: ec, page: e } = await signIn(browser, report, DEMO.reception, "desktop", { expectDenials: true });
    check((await e.request.get(`${BASE}/api/lab/imports/${batchId}`)).status() === 403, "reception: the import API → 403");
    check((await e.request.get(`${BASE}/api/lab/imports/${batchId}/rows`)).status() === 403, "reception: import rows → 403");
    await ec.close();
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

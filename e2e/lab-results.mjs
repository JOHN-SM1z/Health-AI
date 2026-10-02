// End-to-end, in the BUILT app, through the real screens — laboratory results (phase 6):
//
//   The clinic requires a SEPARATE verifier. Technician 1 opens a test whose sample was collected, enters the
//   configured parameters (the flag shown is the comparison with the configured range — "outside" wording,
//   never a diagnosis), saves, submits. They cannot verify their own result; technician 2 can.
//   A verified result is corrected: the old version stays, the new one is a draft by technician 2, verified by
//   technician 1 — the history keeps who entered and who verified each version.
//   Reception and the owner have no access to results; the audit trail holds ids only.
//
// Needs the local stack, `node e2e/seed-demo.mjs`, and the app running (`npm run build && npm start`). Rerunnable.
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { BASE, DEMO, DEMO_NAMES, PASSWORD, VIEWPORTS, assertLocalOnly, connect, createReport, runFixture, signIn } from "./lib.mjs";

assertLocalOnly();
const SHOTS = process.env.E2E_ARTIFACTS_DIR ?? "test-results/e2e";
mkdirSync(SHOTS, { recursive: true });
const report = createReport("laboratory results E2E");
const { check } = report;
const db = connect();
const { suffix } = runFixture();
const PATIENT = `E2E Bemor ${suffix}`;
const TEST = `Qon tahlili ${suffix}`;
const REASON = `Notogri kiritilgan ${suffix}`;
const shown = (locator) => locator.waitFor({ timeout: 8_000 }).then(() => true, () => false);

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
  const [lab1] = await db`select u.id from auth.users u where u.email = ${DEMO.lab}`;
  const [lab2] = await db`select u.id from auth.users u where u.email = ${DEMO.lab2}`;
  if (!lab2) throw new Error("run node e2e/seed-demo.mjs first (the second technician is new)");
  const clinic = doctor.clinic_id;
  const [service] = await db`select id from public.services where clinic_id = ${clinic} and name = ${DEMO_NAMES.generalService}`;

  await db`insert into public.app_settings (clinic_id, key, value) values (${clinic}, 'lab', ${db.json({ verification: { required: true, separateVerifier: true }, collection: { requiresPayment: false }, ordering: { recentTestWindowDays: 30 } })})
           on conflict (clinic_id, key) do update set value = excluded.value`;
  await db`update public.appointments a set status = 'cancelled', cancelled_at = now(), cancelled_reason = 'E2E: an earlier run'
             from public.patients p
            where p.id = a.patient_id and a.clinic_id = ${clinic} and a.doctor_id = ${doctor.id}
              and a.status not in ('cancelled', 'no_show')
              and tstzrange(a.start_at, a.end_at) && tstzrange(now() - interval '3 hours', now() + interval '3 hours')`;

  const [test] = await db`insert into public.lab_tests (clinic_id, code, name, price, sample_type) values (${clinic}, ${`E2E-R-${suffix}`.toUpperCase()}, ${TEST}, 85000, 'qon') returning id`;
  const [hgb] = await db`insert into public.lab_test_parameters (clinic_id, test_id, code, name, unit, data_type, display_order) values (${clinic}, ${test.id}, 'HGB', 'Gemoglobin', 'g/L', 'numeric', 1) returning id`;
  await db`insert into public.lab_test_parameters (clinic_id, test_id, code, name, data_type, choices, display_order) values (${clinic}, ${test.id}, 'KIND', 'Tur', 'choice', ${["musbat", "manfiy"]}, 2) returning id`;
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

  const browser = await chromium.launch();
  try {
    // ---------- Technician 1 enters and submits ----------
    const { context: ctx1, page: t1 } = await loginLab(browser, DEMO.lab);
    await t1.getByRole("link", { name: "Natijalar", exact: true }).click();
    const row = t1.locator("li", { hasText: PATIENT });
    await t1.screenshot({ path: `${SHOTS}/lab-results-list.png`, fullPage: true });
    check(await shown(row.getByText(TEST)), "the collected test is on the results list");
    check(await shown(row.getByText("Natija kiritilmagan")), "…with no result yet");
    await row.getByRole("link", { name: "Ochish" }).click();
    check(await shown(t1.getByText(/Me‘yor: 120 – 160/)), "the configured range is shown beside the field");
    check(await shown(t1.getByText(/tashxis emas/)), "…and the screen says a flag is not a diagnosis");
    await t1.getByLabel("Gemoglobin").fill("118,5");
    await t1.getByLabel("Tur").selectOption({ label: "manfiy" });
    await t1.getByRole("button", { name: "Qoralamani saqlash" }).click();
    check(await shown(t1.getByText("Me‘yordan past")), "a value below the configured range is flagged 'outside' (low), nothing more");
    check((await t1.getByText(/anemiya|kamqonlik|kasal/i).count()) === 0, "…and no disease conclusion appears anywhere");
    await t1.screenshot({ path: `${SHOTS}/lab-result-entry.png`, fullPage: true });
    await t1.getByRole("button", { name: "Tekshiruvga yuborish" }).click();
    check(await shown(t1.getByRole("button", { name: "Tasdiqlash" })), "the result is submitted for verification");
    check(await t1.getByRole("button", { name: "Tasdiqlash" }).isDisabled(), "the author cannot verify their own result (separate verifier required)");
    check(await shown(t1.getByText(/boshqa xodim tasdiqlashi kerak/)), "…and the screen says why");
    const direct = await t1.request.post(`${BASE}/api/lab/results/versions/${(await db`select v.id from public.lab_result_versions v join public.lab_results r on r.id = v.result_id where r.order_item_id = ${item.id}`)[0].id}`, { data: { action: "verify" } });
    check(direct.status() === 403 && (await direct.json()).code === "separate_verifier_required", "the API refuses it too (403 separate_verifier_required)");
    await ctx1.close();

    // ---------- Technician 2 verifies ----------
    const { context: ctx2, page: t2 } = await loginLab(browser, DEMO.lab2);
    await t2.goto(`${BASE}/lab/results/${item.id}`);
    await t2.getByRole("button", { name: "Tasdiqlash" }).waitFor();
    check(await t2.getByRole("button", { name: "Tasdiqlash" }).isEnabled(), "a second technician can verify");
    await t2.getByRole("button", { name: "Tasdiqlash" }).click();
    check(await shown(t2.getByText(/Tasdiqlangan natija · versiya 1/).first()), "the result is verified");
    const [ver] = await db`select v.entered_by, v.verified_by, v.status from public.lab_result_versions v join public.lab_results r on r.id = v.result_id where r.order_item_id = ${item.id}`;
    check(ver.status === "verified" && ver.entered_by === lab1.id && ver.verified_by === lab2.id, "the database records who entered and who verified");
    const [order] = await db`select status from public.lab_orders where id = ${r.order_id}`;
    check(order.status === "completed", "the order is completed once its only test is verified");

    // ---------- Correction by technician 2, verification by technician 1 ----------
    await t2.getByRole("button", { name: "Tuzatish kiritish" }).click();
    await t2.getByLabel("Tuzatish sababi").fill(REASON);
    await t2.getByRole("button", { name: "Tuzatishni boshlash" }).click();
    check(await shown(t2.getByText(/Versiya 2 · Qoralama/).first()), "a correction is a new draft version");
    check(await shown(t2.getByText(/Tasdiqlangan natija · versiya 1/).first()), "…and the verified version stays visible and unchanged");
    await t2.getByLabel("Gemoglobin").fill("128");
    await t2.getByRole("button", { name: "Qoralamani saqlash" }).click();
    await t2.getByRole("button", { name: "Tekshiruvga yuborish" }).click();
    check(await shown(t2.getByRole("button", { name: "Tasdiqlash" })), "the correction is submitted");
    await t2.screenshot({ path: `${SHOTS}/lab-result-correction.png`, fullPage: true });
    await ctx2.close();
    const { context: ctx1b, page: t1b } = await loginLab(browser, DEMO.lab);
    await t1b.goto(`${BASE}/lab/results/${item.id}`);
    await t1b.getByRole("button", { name: "Tasdiqlash" }).click();
    check(await shown(t1b.getByText(/Tasdiqlangan natija · versiya 2/)), "technician 1 verifies the correction");
    check(await shown(t1b.getByText(/Versiyalar tarixi/)), "the version history is shown");
    check(await shown(t1b.getByText(/Almashtirilgan/)), "…with the first version superseded, not erased");
    await t1b.screenshot({ path: `${SHOTS}/lab-result-history.png`, fullPage: true });
    const versions = await db`select v.version, v.status, v.entered_by, v.verified_by from public.lab_result_versions v join public.lab_results r on r.id = v.result_id where r.order_item_id = ${item.id} order by v.version`;
    check(
      versions.length === 2 && versions[0].status === "superseded" && versions[0].entered_by === lab1.id && versions[0].verified_by === lab2.id && versions[1].entered_by === lab2.id && versions[1].verified_by === lab1.id,
      "each version keeps its own author and verifier",
    );
    await ctx1b.close();

    // ---------- Nobody else reaches results ----------
    const { context: recCtx, page: rec } = await signIn(browser, report, DEMO.reception, "desktop", { expectDenials: true });
    check((await rec.request.get(`${BASE}/api/lab/results`)).status() === 403, "a receptionist has no access to results");
    check((await rec.request.get(`${BASE}/api/lab/results/${item.id}`)).status() === 403, "…nor to one result");
    await recCtx.close();
    const { context: ownCtx, page: owner } = await signIn(browser, report, DEMO.owner, "desktop", { expectDenials: true });
    check((await owner.request.get(`${BASE}/api/lab/results/${item.id}`)).status() === 403, "the owner has no access to results either (clinical text)");
    await ownCtx.close();
    const { context: docCtx, page: doc } = await signIn(browser, report, DEMO.referrer, "desktop", { expectDenials: true });
    check((await doc.request.put(`${BASE}/api/lab/results/${item.id}`, { data: { values: [{ parameterId: hgb.id, value: 1 }] } })).status() === 403, "a doctor cannot write a laboratory result");
    await docCtx.close();

    // ---------- The trail: ids only ----------
    const audit = await db`select action, new_values, metadata from public.audit_events where patient_id = ${patient.id} and action like 'lab_result%'`;
    const actions = new Set(audit.map((a) => a.action));
    check(["lab_result_entered", "lab_result_submitted", "lab_result_verified", "lab_result_version_created", "lab_result_version_superseded", "lab_result_viewed"].every((a) => actions.has(a)), "every step is in the audit trail");
    const text = JSON.stringify(audit);
    check(!text.includes("118") && !text.includes("128") && !text.includes(REASON) && !text.includes("manfiy"), "…without values, the reason or any text");
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

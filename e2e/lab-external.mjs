// External laboratory integration in a real browser against the built app and
// a LOCAL Supabase stack, with the mock provider (Phase 15):
//   * the owner adds an external laboratory (mock adapter) and its codes on
//     the lab configuration screen — no secret is ever shown;
//   * a technician sends a received test out from the work queue; manual
//     entry is no longer offered for it;
//   * the scheduler endpoint (CRON_SECRET) polls the provider; the result
//     arrives as an external result awaiting a second person's verification;
//   * a second technician verifies it; the requester could not;
//   * unsigned webhooks and the worker without its secret get nothing.
// Rerunnable: run-unique test code, patient and provider.
import { chromium } from "playwright";
import { BASE, DEMO, assertLocalOnly, connect, createReport, runFixture, signIn } from "./lib.mjs";

assertLocalOnly();
const report = createReport("lab external E2E");
const { check } = report;
const db = connect();
const { suffix } = runFixture();
const CRON = process.env.CRON_SECRET;

async function run() {
  if (!CRON) throw new Error("CRON_SECRET missing from the environment");
  const [owner] = await db`select u.id, sr.clinic_id from auth.users u join public.staff_roles sr on sr.profile_id = u.id where u.email = ${DEMO.owner}`;
  const [reception] = await db`select id from auth.users where email = ${DEMO.reception}`;
  const [lab] = await db`select id from auth.users where email = ${DEMO.lab}`;
  const [lab2] = await db`select id from auth.users where email = ${DEMO.lab2}`;
  if (!owner || !lab || !lab2) throw new Error("demo staff missing — run node e2e/seed-demo.mjs");
  const clinic = owner.clinic_id;

  const testName = `E2E tashqi TSH ${suffix}`;
  const [test] = await db`insert into public.lab_tests ${db({ clinic_id: clinic, code: `E2EEXT${suffix}`.slice(0, 32).toUpperCase(), name: testName, sample_type: "Qon", price: 50000 })} returning id`;
  const [param] = await db`insert into public.lab_test_parameters ${db({ clinic_id: clinic, test_id: test.id, code: "TSH", name: "TTG", value_type: "numeric", unit: "mIU/L", decimals: 2 })} returning id`;
  const patientName = `E2E Tashqi bemor ${suffix}`;
  const [patient] = await db`insert into public.patients ${db({ clinic_id: clinic, full_name: patientName, date_of_birth: "1979-09-09" })} returning id`;
  const [order] = await db`select * from public.create_lab_order(${clinic}, ${patient.id}, ${reception.id}, 'walk_in', ${[test.id]}::uuid[], '{}'::uuid[])`;
  const [item] = await db`select id from public.lab_order_items where order_id = ${order.lab_order_id}`;
  const [sample] = await db`select * from public.collect_lab_sample(${clinic}, ${order.lab_order_id}, ${[item.id]}::uuid[], ${reception.id})`;
  await db`select public.receive_lab_sample(${clinic}, ${sample.lab_sample_id}, ${lab.id})`;

  const browser = await chromium.launch();
  try {
    // ---------- the owner configures the laboratory ----------
    const { context: oc, page: o } = await signIn(browser, report, DEMO.owner);
    await o.goto(`${BASE}/admin/lab`);
    await o.getByRole("tab", { name: "Tashqi laboratoriyalar" }).click();
    const providerName = `Mock referens ${suffix}`;
    await o.getByLabel("Kod", { exact: true }).fill(`ref-${suffix}`.slice(0, 40));
    await o.getByLabel("Nomi", { exact: true }).fill(providerName);
    await o.getByLabel("Sozlamalar (JSON)").fill(JSON.stringify({ pollSeconds: 0, results: { "TSH-EXT": [{ code: "TSH-1", value: 2.15, unit: "mIU/L" }] } }));
    await o.getByRole("button", { name: "Qo‘shish" }).click();
    await o.getByText("Laboratoriya qo‘shildi").waitFor();
    const card = o.getByRole("region", { name: "Tashqi laboratoriyalar" }).locator("div").filter({ hasText: providerName }).first();
    await card.getByRole("button", { name: "Kodlar" }).click();
    await o.getByLabel(`${testName}: laboratoriya kodi`).fill("TSH-EXT");
    await o.getByLabel(`${testName} · TTG: laboratoriya kodi`).fill("TSH-1");
    await o.getByRole("button", { name: "Kodlarni saqlash" }).click();
    await o.getByText("Kodlar saqlandi").waitFor();
    const [provider] = await db`select id, adapter, credential_ref from public.lab_providers where clinic_id = ${clinic} and name = ${providerName}`;
    const codes = await db`select kind, external_code from public.lab_provider_codes where provider_id = ${provider.id} order by kind`;
    check(provider.adapter === "mock" && codes.map((c) => c.external_code).join() === "TSH-1,TSH-EXT", "owner: the laboratory and its codes are configured");
    await oc.close();

    // ---------- the technician sends the test out ----------
    const { context: lc, page: l } = await signIn(browser, report, DEMO.lab, "desktop", { expectDenials: true });
    await l.getByRole("button", { name: "Jarayonda", exact: true }).click();
    const orderCard = l.getByRole("region", { name: `${patientName} buyurtmasi` });
    await orderCard.getByRole("button", { name: "Tashqi laboratoriyaga" }).click();
    await orderCard.getByRole("group", { name: `${testName}: tashqi laboratoriya` }).getByLabel("Tashqi laboratoriya").selectOption({ label: providerName });
    await orderCard.getByRole("button", { name: "Yuborish" }).click();
    await l.getByText("Tahlil tashqi laboratoriyaga yuborildi").waitFor();
    await orderCard.getByText(`Tashqi lab · ${providerName}: yuborilgan`).waitFor();
    check((await orderCard.getByRole("button", { name: "Natija kiritish" }).count()) === 0, "lab: a test out at a laboratory offers no manual entry");
    const [req] = await db`select id, status, external_order_id, requested_by from public.lab_external_requests where order_item_id = ${item.id}`;
    check(req.status === "sent" && /^MOCK-/.test(req.external_order_id) && req.requested_by === lab.id, "lab: the send-out is recorded and accepted by the provider");

    // ---------- the scheduler polls ----------
    check((await l.request.post(`${BASE}/api/lab/providers/process`)).status() === 401, "worker: refused without the scheduler secret");
    const run1 = await l.request.post(`${BASE}/api/lab/providers/process`, { headers: { authorization: `Bearer ${CRON}` } });
    check(run1.status() === 200, "worker: runs with the scheduler secret");
    const [after] = await db`select status, result_id from public.lab_external_requests where id = ${req.id}`;
    const [result] = await db`select source, status, entered_by, submitted_by from public.lab_results where id = ${after.result_id}`;
    check(after.status === "resulted" && result.source === "external" && result.status === "submitted" && result.entered_by === lab.id, "worker: the provider's result is recorded and awaits verification");
    const [value] = await db`select value_numeric, unit_snapshot from public.lab_result_values where result_id = ${after.result_id} and parameter_id = ${param.id}`;
    check(Number(value.value_numeric) === 2.15 && value.unit_snapshot === "mIU/L", "worker: the value is mapped to the clinic's parameter");
    await l.reload();
    await l.getByRole("button", { name: "Tekshiruvda", exact: true }).click();
    await l.getByRole("region", { name: `${patientName} buyurtmasi` }).getByText(`Tashqi lab · ${providerName}: natija keldi`).waitFor();
    check(true, "lab: the queue shows the result arrived");
    const self = await l.request.post(`${BASE}/api/lab/results/${after.result_id}`, { data: { action: "verify" } });
    check(self.status() === 409, "lab: the requester cannot verify the external result");
    await lc.close();

    // ---------- the second person verifies ----------
    const { context: vc, page: v } = await signIn(browser, report, DEMO.lab2);
    const verify = await v.request.post(`${BASE}/api/lab/results/${after.result_id}`, { data: { action: "verify" } });
    const [final] = await db`select status, verified_by from public.lab_results where id = ${after.result_id}`;
    check(verify.status() === 200 && final.status === "verified" && final.verified_by === lab2.id, "lab2: a second person verifies the external result");
    await vc.close();

    // ---------- attacks ----------
    const anon = await browser.newContext();
    const hook = await anon.request.post(`${BASE}/api/lab/providers/${provider.id}/webhook`, { data: { events: [{ type: "status", externalOrderId: req.external_order_id, status: "cancelled" }] } });
    check(hook.status() === 401, "webhook: an unsigned push is refused");
    check((await anon.request.post(`${BASE}/api/lab/items/${item.id}/send-out`, { data: { providerId: provider.id } })).status() === 401, "no session: send-out API → 401");
    await anon.close();
    const audits = await db`select action from public.audit_events where entity_id = ${req.id} order by created_at`;
    check(audits.map((a) => a.action).join() === "lab_external_requested,lab_external_sent,lab_external_resulted", "audit: requested, sent, resulted");
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

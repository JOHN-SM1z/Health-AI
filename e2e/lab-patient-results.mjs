// Patient lab results in the Mini App, in a real browser against the built
// app and a LOCAL Supabase stack (Phase 12). The Mini App is opened exactly
// as Telegram opens it — with initData signed by the clinic's bot in the
// launch parameters (#tgWebAppData=…):
//   * verifying a result queues one "result ready" notification job for the
//     patient's Telegram identity (the worker itself is covered by vitest);
//   * the deep link (startapp=lab_<item>) opens the result; the patient sees
//     test, date, value, unit, the configured range and the position against
//     it, the not-a-diagnosis note, and downloads the report through a
//     signed link; the list shows only their verified results;
//   * another patient, a forged signature and a missing identity see nothing.
// Rerunnable: run-unique test code, patients and Telegram ids.
import { createHmac } from "node:crypto";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { BASE, DEMO, assertLocalOnly, connect, createReport, runFixture } from "./lib.mjs";

assertLocalOnly();
const report = createReport("lab patient results E2E");
const { check } = report;
const db = connect();
const { suffix } = runFixture();
const storage = createClient(process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }).storage;
let insertedIntegration = null;

function signInitData(botToken, telegramUserId) {
  const user = JSON.stringify({ id: telegramUserId, first_name: "Bemor" });
  const fields = [["auth_date", String(Math.floor(Date.now() / 1000))], ["query_id", "AAHdF6IQAAAAAN0XohDhrOrc"], ["user", user]];
  const check = fields.map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return `${fields.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}&hash=${hash}`;
}
const launch = (initData) => `#tgWebAppData=${encodeURIComponent(initData)}&tgWebAppVersion=7.0&tgWebAppPlatform=web`;

async function run() {
  const [reception] = await db`select u.id, sr.clinic_id from auth.users u join public.staff_roles sr on sr.profile_id = u.id where u.email = ${DEMO.reception}`;
  const [lab] = await db`select id from auth.users where email = ${DEMO.lab}`;
  const [lab2] = await db`select id from auth.users where email = ${DEMO.lab2}`;
  if (!reception || !lab || !lab2) throw new Error("demo staff missing — run node e2e/seed-demo.mjs");
  const clinic = reception.clinic_id;

  // The clinic's bot: use the configured one, or register a test bot for this run.
  let [bot] = await db`select telegram_bot_token from public.clinic_telegram_integrations where clinic_id = ${clinic} and enabled and status = 'active'`;
  if (!bot) {
    const token = `${Date.now() % 1_000_000}:E2E${suffix}${"t".repeat(24)}`;
    await db`insert into public.clinic_telegram_integrations ${db({ clinic_id: clinic, telegram_bot_token: token, telegram_bot_id: Date.now() % 1_000_000_000, telegram_username: `e2e_${suffix}_bot`, telegram_bot_name: "E2E", status: "active", enabled: true, validated_at: new Date() })}
             on conflict (clinic_id) do nothing`;
    insertedIntegration = clinic;
    [bot] = await db`select telegram_bot_token from public.clinic_telegram_integrations where clinic_id = ${clinic}`;
  }

  const testName = `E2E bemor HB ${suffix}`;
  const [test] = await db`insert into public.lab_tests ${db({ clinic_id: clinic, code: `E2EPAT${suffix}`.slice(0, 32), name: testName, sample_type: "Vena qoni", price: 40000 })} returning id`;
  const [param] = await db`insert into public.lab_test_parameters ${db({ clinic_id: clinic, test_id: test.id, code: "HGB", name: "Gemoglobin", value_type: "numeric", unit: "g/L" })} returning id`;
  await db`insert into public.lab_reference_ranges ${db({ clinic_id: clinic, parameter_id: param.id, low: 120, high: 160 })}`;
  const tgAlice = 950_000_000 + (Date.now() % 1_000_000);
  const tgBob = tgAlice + 1;
  const [alice] = await db`insert into public.patients ${db({ clinic_id: clinic, full_name: `E2E Alisa ${suffix}`, date_of_birth: "1990-02-02", telegram_user_id: tgAlice })} returning id`;
  await db`insert into public.patients ${db({ clinic_id: clinic, full_name: `E2E Bobur ${suffix}`, date_of_birth: "1991-03-03", telegram_user_id: tgBob })}`;

  const [order] = await db`select * from public.create_lab_order(${clinic}, ${alice.id}, ${reception.id}, 'walk_in', ${[test.id]}::uuid[], '{}'::uuid[])`;
  const [item] = await db`select id from public.lab_order_items where order_id = ${order.lab_order_id}`;
  const [sample] = await db`select * from public.collect_lab_sample(${clinic}, ${order.lab_order_id}, ${[item.id]}::uuid[], ${reception.id})`;
  await db`select public.receive_lab_sample(${clinic}, ${sample.lab_sample_id}, ${lab.id})`;
  const [r] = await db`select * from public.save_lab_result_draft(${clinic}, ${item.id}, ${lab.id}, ${db.json([{ parameter_id: param.id, value_numeric: 115 }])}::jsonb, null, null)`;
  await db`select public.submit_lab_result(${clinic}, ${r.lab_result_id}, ${lab.id})`;
  const docId = crypto.randomUUID();
  const pdf = `%PDF-1.4 E2E patient report ${suffix}`;
  const { error: upErr } = await storage.from("lab-documents").upload(`${clinic}/${docId}`, new TextEncoder().encode(pdf), { contentType: "application/pdf" });
  if (upErr) throw new Error(upErr.message);
  await db`insert into public.lab_documents ${db({ id: docId, clinic_id: clinic, patient_id: alice.id, order_id: order.lab_order_id, result_id: r.lab_result_id, kind: "report", storage_path: `${clinic}/${docId}`, mime_type: "application/pdf", size_bytes: pdf.length, sha256: "d".repeat(64), uploaded_by: lab.id })}`;
  await db`select public.verify_lab_result(${clinic}, ${r.lab_result_id}, ${lab2.id})`;

  const jobs = await db`select type, status, patient_telegram_user_id from public.notification_jobs where lab_result_id = ${r.lab_result_id} and channel = 'telegram'`;
  check(jobs.length === 1 && jobs[0].type === "lab_result_ready" && Number(jobs[0].patient_telegram_user_id) === tgAlice, "verification queues one 'result ready' notification for the patient's Telegram");

  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => report.problems.push(`[patient] pageerror: ${e.message}`));
    const aliceData = signInitData(bot.telegram_bot_token, tgAlice);

    // Deep link (t.me form) → the result page.
    await page.goto(`${BASE}/?clinic=${clinic}&startapp=lab_${item.id}${launch(aliceData)}`);
    await page.waitForURL(new RegExp(`/lab-results/${item.id}`), { timeout: 15_000 });
    await page.getByRole("heading", { name: testName }).or(page.getByText(testName).first()).first().waitFor();
    check(true, "deep link: startapp=lab_<item> opens the result page");
    check(await page.getByText("115 g/L").isVisible() && (await page.getByText("Me’yordan past").isVisible()) && (await page.getByText("Me’yor: 120–160 g/L").isVisible()), "patient: value, unit, configured range and position");
    check(await page.getByText(/bu tashxis emas/).isVisible(), "patient: the not-a-diagnosis note is shown");

    const signed = ctx.waitForEvent("request", { predicate: (q) => /\/storage\/v1\/object\/sign\/lab-documents\//.test(q.url()), timeout: 15_000 });
    await page.getByRole("button", { name: /Hisobot/ }).click();
    const url = (await signed).url();
    check((await page.request.get(url)).status() === 200 && url.includes("download"), "patient: the report downloads through a signed link");

    await page.goto(`${BASE}/lab-results?clinic=${clinic}${launch(aliceData)}`);
    const card = page.getByRole("link", { name: `${testName} natijasi` });
    await card.waitFor();
    check((await page.getByRole("link", { name: /natijasi$/ }).count()) === 1 && (await card.getByText("1 ta ko‘rsatkich me’yordan tashqarida").isVisible()), "patient: the list shows their one verified result");

    const [{ n }] = await db`select count(*)::int as n from public.audit_events where action = 'lab_result_viewed' and actor_type = 'patient' and patient_id = ${alice.id}`;
    const [{ d }] = await db`select count(*)::int as d from public.audit_events where action = 'lab_document_viewed' and actor_type = 'patient' and entity_id = ${docId}`;
    check(n >= 1 && d === 1, "audit: the patient's reads are recorded");

    // Another patient of the same clinic, with a valid identity, guessing the URL.
    const other = await browser.newContext();
    const bobPage = await other.newPage();
    await bobPage.goto(`${BASE}/lab-results/${item.id}?clinic=${clinic}${launch(signInitData(bot.telegram_bot_token, tgBob))}`);
    await bobPage.getByText("Natija topilmadi").waitFor();
    check((await bobPage.getByText("115 g/L").count()) === 0, "another patient: the guessed result URL shows nothing");
    const forged = await other.request.post(`${BASE}/api/me/lab-results/${item.id}?clinic=${clinic}`, { data: { initData: aliceData.replace(/hash=[0-9a-f]+/, "hash=" + "0".repeat(64)) } });
    check(forged.status() === 401, "forged signature: the API refuses");
    const anonymous = await other.request.post(`${BASE}/api/me/lab-results?clinic=${clinic}`, { data: {} });
    check(anonymous.status() === 401, "no identity: the API refuses");
    await other.close();
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
  if (insertedIntegration) await db`delete from public.clinic_telegram_integrations where clinic_id = ${insertedIntegration}`.catch(() => {});
  await db.end({ timeout: 5 });
}
process.exit(code);

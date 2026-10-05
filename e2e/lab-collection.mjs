// Sample collection and the lab work queue in a real browser against the
// built app and a LOCAL Supabase stack (Phase 7):
//   * reception takes a walk-in order at the desk (patient search → tests),
//     then collects one tube for the two blood tests: the database holds one
//     sample with both tests, collected by reception, with a generated code;
//   * reception cannot receive a sample (no button; the API refuses);
//   * the lab receives the tube (tests → processing), collects the urine
//     sample, rejects it with a reason, and the urine test returns for a new
//     sample;
//   * doctors get no clinic-wide queue.
// Rerunnable: run-unique test codes and patient.
import { chromium } from "playwright";
import { BASE, DEMO, assertLocalOnly, connect, createReport, runFixture, signIn } from "./lib.mjs";

assertLocalOnly();
const report = createReport("lab sample collection E2E");
const { check } = report;
const db = connect();
const { suffix } = runFixture();

async function run() {
  const [reception] = await db`select u.id, sr.clinic_id from auth.users u join public.staff_roles sr on sr.profile_id = u.id where u.email = ${DEMO.reception}`;
  const [lab] = await db`select id from auth.users where email = ${DEMO.lab}`;
  if (!reception || !lab) throw new Error("demo staff missing — run node e2e/seed-demo.mjs");
  const clinic = reception.clinic_id;

  const tests = await db`insert into public.lab_tests ${db([
    { clinic_id: clinic, code: `E2EGLU${suffix}`.slice(0, 32), name: `E2E glyukoza ${suffix}`, sample_type: "Vena qoni", price: 40000, preparation_text: "8 soat och qoringa" },
    { clinic_id: clinic, code: `E2EALT${suffix}`.slice(0, 32), name: `E2E ALT ${suffix}`, sample_type: "Vena qoni", price: 45000, preparation_text: null },
    { clinic_id: clinic, code: `E2EURI${suffix}`.slice(0, 32), name: `E2E siydik ${suffix}`, sample_type: "Siydik", price: 30000, preparation_text: null },
  ])} returning id, name, sample_type`;
  const patientName = `E2E Namuna bemor ${suffix}`;
  const [patient] = await db`insert into public.patients ${db({ clinic_id: clinic, full_name: patientName, date_of_birth: "1979-03-14", phone: `+99890${String(Date.now()).slice(-7)}` })} returning id`;

  const browser = await chromium.launch();
  try {
    // ---------- reception: walk-in order and collection ----------
    const { context: rc, page: r } = await signIn(browser, report, DEMO.reception);
    await r.goto(`${BASE}/admin/lab-queue`);
    await r.waitForLoadState("networkidle");
    check(await r.getByRole("heading", { name: "Ish navbati" }).isVisible(), "reception: the lab work queue opens at the desk");

    await r.getByRole("button", { name: "Yangi buyurtma" }).click();
    const picker = r.getByRole("dialog", { name: "Bemorni tanlang" });
    await picker.getByLabel("Bemor qidirish (ism yoki telefon)").fill(`Namuna bemor ${suffix}`);
    await picker.getByText(patientName).click();
    const dialog = r.getByRole("dialog", { name: "Tahlil buyurtma qilish" });
    await dialog.getByLabel("Tahlil qidirish").fill(suffix);
    for (const t of tests) await dialog.getByText(t.name).click();
    await dialog.getByRole("button", { name: "Ko‘rib chiqish" }).click();
    const review = r.getByRole("dialog", { name: "Buyurtmani tekshiring" });
    await review.getByRole("button", { name: "Buyurtma berish" }).click();
    await r.getByText(`${patientName} uchun 3 ta tahlil buyurtma qilindi`).waitFor();
    const [order] = await db`select id, source, ordered_by from public.lab_orders where patient_id = ${patient.id}`;
    check(order?.source === "walk_in" && order?.ordered_by === reception.id, "reception: the walk-in order is stored with reception as orderer");

    const card = r.getByRole("region", { name: `${patientName} buyurtmasi` });
    await card.waitFor();
    check(await card.getByText("14.03.1979").isVisible(), "reception: the queue shows the patient's date of birth for identification");
    await card.getByRole("button", { name: "Vena qoni namunasini olish (2)" }).click();
    const collect = r.getByRole("dialog", { name: "Vena qoni namunasini olish" });
    check(await collect.getByText("8 soat och qoringa").isVisible(), "reception: preparation is shown when collecting");
    await collect.getByRole("button", { name: "Namuna olindi" }).click();
    const notice = r.getByText(/Namuna olindi: \d{6}-[0-9A-F]{6}/);
    await notice.waitFor();
    const code = (await notice.textContent()).match(/\d{6}-[0-9A-F]{6}/)[0];
    const samples = await db`select s.id, s.sample_code, s.sample_type, s.status, s.collected_by, count(si.*)::int as items
      from public.lab_samples s join public.lab_sample_items si on si.sample_id = s.id where s.order_id = ${order.id} group by s.id`;
    check(
      samples.length === 1 && samples[0].sample_code === code && samples[0].items === 2 && samples[0].collected_by === reception.id && samples[0].sample_type === "Vena qoni",
      "reception: one tube holds both blood tests, with the code shown on screen",
    );
    check((await r.getByRole("button", { name: "Qabul qilish" }).count()) === 0, "reception: no receive button (processing is lab work)");
    check((await r.request.post(`${BASE}/api/lab/samples/${samples[0].id}`, { data: { action: "receive" } })).status() === 403, "reception: receive API → 403");
    await rc.close();

    // ---------- lab: receive, collect urine, reject ----------
    const { context: lc, page: l } = await signIn(browser, report, DEMO.lab);
    check(new URL(l.url()).pathname === "/lab", "lab: lands on the lab work queue");
    const lcard = l.getByRole("region", { name: `${patientName} buyurtmasi` });
    await lcard.waitFor();
    const row = lcard.locator("li").filter({ hasText: code });
    await row.getByRole("button", { name: "Qabul qilish" }).click();
    await l.getByText(`${code} qabul qilindi`).waitFor();
    const blood = await db`select status from public.lab_order_items where order_id = ${order.id} and test_name_snapshot not like 'E2E siydik%'`;
    check(blood.length === 2 && blood.every((b) => b.status === "processing"), "lab: receiving the tube moves both blood tests to processing");

    await l.getByRole("button", { name: "Namuna olish", exact: true }).click();
    await lcard.getByRole("button", { name: "Siydik namunasini olish (1)" }).click();
    await l.getByRole("dialog", { name: "Siydik namunasini olish" }).getByRole("button", { name: "Namuna olindi" }).click();
    const urineNotice = l.getByText(/Namuna olindi: \d{6}-[0-9A-F]{6}/);
    await urineNotice.waitFor();
    const urineCode = (await urineNotice.textContent()).match(/\d{6}-[0-9A-F]{6}/)[0];

    await l.getByRole("button", { name: "Barchasi", exact: true }).click();
    await lcard.locator("li").filter({ hasText: urineCode }).getByRole("button", { name: "Rad etish" }).click();
    const reject = l.getByRole("dialog", { name: `${urineCode} namunasini rad etish` });
    await reject.getByLabel("Rad etish sababi").fill("Hajmi yetarli emas");
    await reject.getByRole("button", { name: "Rad etish" }).click();
    await l.getByText(`${urineCode} rad etildi`).waitFor();
    const [urine] = await db`select i.status, s.status as sample_status, s.reject_reason, s.rejected_by from public.lab_order_items i
      join public.lab_sample_items si on si.order_item_id = i.id join public.lab_samples s on s.id = si.sample_id
      where i.order_id = ${order.id} and s.sample_code = ${urineCode}`;
    check(
      urine?.status === "ready_for_collection" && urine?.sample_status === "rejected" && urine?.reject_reason === "Hajmi yetarli emas" && urine?.rejected_by === lab.id,
      "lab: the rejected urine sample sends its test back for a new sample",
    );
    const audit = await db`select action, new_values::text as v from public.audit_events where entity_type = 'lab_samples' and new_values->>'order_id' = ${order.id}`;
    check(audit.length === 4 && audit.every((a) => !a.v.includes("Hajmi")), "audit: collected / received / rejected recorded with ids and states only");
    await lc.close();

    // ---------- doctors: no clinic-wide queue ----------
    const { context: dc, page: d } = await signIn(browser, report, DEMO.referrer);
    check((await d.request.get(`${BASE}/api/lab/queue`)).status() === 403, "doctor: lab work queue API → 403");
    await dc.close();
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

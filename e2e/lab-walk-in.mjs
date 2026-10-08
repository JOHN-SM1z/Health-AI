// The laboratory walk-in in real browsers (Phase 3) against the built app and
// a LOCAL Supabase stack, with real logins:
//   reception registers a new patient for the laboratory with two tests →
//   the kassa shows one bill of the tests and takes it (no separate lab bill)
//   → the lab queue number appears; the tests become collectable only then
//   (clinic setting "before_collection", the owner's rule) → lab staff call
//   the number, take the sample in the work queue as before, and complete.
// The demo clinic's lab setting is restored afterwards. Rerunnable.
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { BASE, DEMO, assertLocalOnly, connect, createReport, runFixture, signIn } from "./lib.mjs";

assertLocalOnly();
const report = createReport("lab walk-in E2E");
const { check } = report;
const db = connect();
const { suffix } = runFixture();

const PATIENT = `Labchi Dilnoza ${suffix}`;
const SAMPLE = `Kapillyar qon ${suffix}`;
let clinic = null;
let previousSetting = null;

async function run() {
  const [reception] = await db`select sr.clinic_id from auth.users u join public.staff_roles sr on sr.profile_id = u.id where u.email = ${DEMO.reception}`;
  if (!reception) throw new Error("demo staff missing — run node e2e/seed-demo.mjs");
  clinic = reception.clinic_id;
  const [setting] = await db`select value from public.app_settings where clinic_id = ${clinic} and key = 'lab'`;
  previousSetting = setting ? setting.value : null;
  await db`insert into public.app_settings ${db({ clinic_id: clinic, key: "lab", value: db.json({ ...(previousSetting ?? {}), paymentPolicy: "before_collection" }) })}
           on conflict (clinic_id, key) do update set value = excluded.value`;
  const testA = { id: randomUUID(), name: `Gemoglobin ${suffix}`, price: 30000 };
  const testB = { id: randomUUID(), name: `Leykotsitlar ${suffix}`, price: 35000 };
  await db`insert into public.lab_tests ${db([testA, testB].map((t) => ({ id: t.id, clinic_id: clinic, code: `W${t.id.slice(0, 8)}`, name: t.name, sample_type: SAMPLE, price: t.price })))}`;

  const browser = await chromium.launch();
  let visitId = "";
  let number = 0;
  try {
    // ---------- Reception ----------
    {
      const { context, page } = await signIn(browser, report, DEMO.reception, "desktop");
      await page.goto(`${BASE}/admin/reception`);
      await page.getByRole("button", { name: "Yangi bemor" }).click();
      await page.getByLabel("F.I.Sh.").fill(PATIENT);
      await page.getByLabel("Tug‘ilgan sana", { exact: true }).fill("21.09.1988");
      await page.getByLabel("Shifokor").selectOption({ label: "Laboratoriya — tahlil topshirish" });
      const tests = page.getByRole("group", { name: "Tahlillar" });
      await tests.getByText(testA.name).click();
      await tests.getByText(testB.name).click();
      await page.getByRole("button", { name: "Ro‘yxatga olish" }).click();
      await page.getByText(/ro‘yxatga olindi\. Bemorni kassaga yo‘naltiring/).waitFor();
      const [v] = await db`select v.id, v.kind, v.status, v.lab_order_id from public.visits v join public.patients p on p.id = v.patient_id where p.full_name = ${PATIENT}`;
      visitId = v.id;
      check(v.kind === "lab" && v.status === "awaiting_payment", "reception registers a laboratory walk-in; it waits for the kassa");
      const [{ n }] = await db`select count(*)::int as n from public.payments where lab_order_id = ${v.lab_order_id}`;
      check(n === 0, "no separate lab bill — the tests are on the visit's bill");
      const held = await db`select status from public.lab_order_items where order_id = ${v.lab_order_id}`;
      check(held.every((i) => i.status === "ordered"), "the tests cannot be collected before payment");
      await context.close();
    }

    // ---------- Kassa ----------
    {
      const { context, page } = await signIn(browser, report, DEMO.cashier, "desktop");
      const card = page.getByRole("region", { name: "To‘lov kutilmoqda" }).locator("div.rounded-2xl", { hasText: PATIENT });
      await card.waitFor();
      const text = await card.textContent();
      check(text.includes(testA.name) && text.includes(testB.name) && text.includes("Laboratoriya"), "the kassa shows the lab tests as lines of one bill");
      check((await card.getByRole("button", { name: "Olib tashlash" }).count()) === 0, "a lab test cannot be removed at the kassa (it is cancelled in the lab)");
      await card.getByRole("button", { name: "To‘lov qabul qilish" }).click();
      await page.getByRole("dialog", { name: "To‘lov qabul qilish" }).getByRole("button", { name: "Qabul qilish" }).click();
      const notice = page.getByText(/Navbat raqami: (\d+)/);
      await notice.waitFor();
      number = Number((await notice.textContent()).match(/Navbat raqami: (\d+)/)[1]);
      const [v] = await db`select lab_order_id from public.visits where id = ${visitId}`;
      const ready = await db`select status from public.lab_order_items where order_id = ${v.lab_order_id}`;
      check(ready.every((i) => i.status === "ready_for_collection"), "payment releases the tests for collection");
      await context.close();
    }

    // ---------- Laboratory ----------
    {
      const { context, page } = await signIn(browser, report, DEMO.lab, "desktop");
      const item = page.getByRole("list", { name: "Laboratoriya navbati" }).locator("li", { hasText: PATIENT });
      await item.waitFor();
      check((await item.textContent()).includes(String(number)), "the lab sees the patient in its queue by number, with the tests");
      await item.getByRole("button", { name: "Chaqirish" }).click();
      await item.getByText("Chaqirildi").waitFor();
      await item.getByRole("button", { name: "Namuna olishni boshlash" }).click();
      await item.getByText("Namuna olinmoqda").waitFor();
      check(true, "lab staff call the number and start collection");

      const order = page.getByRole("region", { name: `${PATIENT} buyurtmasi` });
      await order.getByRole("button", { name: `${SAMPLE} namunasini olish (2)` }).click();
      await page.getByRole("dialog", { name: `${SAMPLE} namunasini olish` }).getByRole("button", { name: "Namuna olindi" }).click();
      await page.getByText(/Namuna olindi: \d{6}-[0-9A-F]{6}/).waitFor();
      check(true, "the sample is taken in the work queue, as before");

      await item.getByRole("button", { name: "Yakunlash" }).click();
      await page.waitForTimeout(500);
      const [v] = await db`select status from public.visits where id = ${visitId}`;
      check(v.status === "completed", "lab staff complete the lab visit");
      await context.close();
    }
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
  if (clinic) {
    if (previousSetting === null) await db`delete from public.app_settings where clinic_id = ${clinic} and key = 'lab'`.catch(() => {});
    else await db`update public.app_settings set value = ${db.json(previousSetting)} where clinic_id = ${clinic} and key = 'lab'`.catch(() => {});
  }
  await db.end({ timeout: 5 });
}
process.exit(code);

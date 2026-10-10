// Laboratory configuration and the lab role, in a real browser against the
// built app and a LOCAL Supabase stack (Phases 3–4):
//   * a manager configures a category, a test, a parameter and a sex/age
//     reference range on /admin/lab; an overlapping range is refused with a
//     plain message shown in the open dialog;
//   * the owner adds a lab staff member; that person lands on /lab, is sent
//     away from the admin desk, may read the lab catalog and may neither
//     configure it nor read the patient list.
// Rerunnable: codes are run-unique and the lab staff member's role is removed
// at the end.
import { chromium } from "playwright";
import { BASE, DEMO, assertLocalOnly, connect, createReport, runFixture, signIn } from "./lib.mjs";

assertLocalOnly();
const report = createReport("lab configuration E2E");
const { check } = report;
const db = connect();
const { suffix } = runFixture();
let labEmail = null;

async function run() {
  const browser = await chromium.launch();
  try {
    // ---------- manager configures the lab ----------
    const { context: managerContext, page: m } = await signIn(browser, report, DEMO.manager, "desktop", { expectDenials: true });
    await m.goto(`${BASE}/admin/lab`);
    await m.waitForLoadState("networkidle");
    check(await m.getByRole("link", { name: "Laboratoriya" }).first().isVisible(), "manager: Laboratoriya in the navigation");

    await m.getByRole("button", { name: "+ Bo‘lim" }).click();
    await m.getByLabel("Bo‘lim nomi").fill(`Qon tahlili ${suffix}`);
    await m.getByRole("button", { name: "Saqlash" }).click();
    await m.getByText(`Qon tahlili ${suffix}`).waitFor();

    await m.getByRole("button", { name: "+ Tahlil" }).click();
    await m.getByLabel("Tahlil kodi").fill(`CBC${suffix}`);
    await m.getByLabel("Tahlil nomi").fill(`Umumiy qon tahlili ${suffix}`);
    await m.getByLabel("Bo‘lim", { exact: true }).selectOption({ label: `Qon tahlili ${suffix}` });
    await m.getByLabel("Namuna turi").fill("Vena qoni");
    await m.getByLabel("Narx").fill("100000");
    await m.getByRole("button", { name: "Saqlash" }).click();
    await m.getByText(`Umumiy qon tahlili ${suffix}`).waitFor();
    check(true, "manager: test created in its category");

    await m.getByRole("row", { name: new RegExp(`CBC${suffix}`) }).getByRole("button", { name: "Ko‘rsatkichlar" }).click();
    await m.getByRole("button", { name: "+ Ko‘rsatkich qo‘shish" }).click();
    await m.getByLabel("Ko‘rsatkich kodi").fill("HGB");
    await m.getByLabel("Ko‘rsatkich nomi").fill("Gemoglobin");
    await m.getByLabel("O‘lchov birligi").fill("g/L");
    await m.getByRole("button", { name: "Qo‘shish", exact: true }).click();
    await m.getByText("Gemoglobin").waitFor();

    await m.getByRole("button", { name: "+ Me’yor" }).click();
    await m.getByLabel("Jins").selectOption("female");
    await m.getByLabel("Yoshdan, yil").fill("18");
    await m.getByLabel("Me’yor pastki chegarasi").fill("120");
    await m.getByLabel("Me’yor yuqori chegarasi").fill("150");
    await m.getByRole("button", { name: "Qo‘shish", exact: true }).click();
    await m.getByText("120–150 g/L").waitFor();
    check(true, "manager: parameter and a female 18+ range configured");

    await m.getByRole("button", { name: "+ Me’yor" }).click();
    await m.getByLabel("Jins").selectOption("female");
    await m.getByLabel("Yoshdan, yil").fill("30");
    await m.getByLabel("Me’yor pastki chegarasi").fill("100");
    await m.getByLabel("Me’yor yuqori chegarasi").fill("140");
    await m.getByRole("button", { name: "Qo‘shish", exact: true }).click();
    await m.getByRole("dialog").getByText("Shu jins va yosh oralig‘i uchun faol me’yor allaqachon bor").waitFor();
    check(true, "manager: an overlapping range is refused, with the reason shown in the dialog");
    await managerContext.close();

    const [stored] = await db`select t.price, count(r.id)::int as ranges from public.lab_tests t
      join public.lab_test_parameters p on p.test_id = t.id left join public.lab_reference_ranges r on r.parameter_id = p.id
      where t.code = ${`CBC${suffix}`} group by t.price`;
    check(Number(stored?.price) === 100000 && stored?.ranges === 1, "the database holds the test, its price and exactly one range");

    // ---------- owner adds a lab staff member ----------
    const { context: ownerContext, page: o } = await signIn(browser, report, DEMO.owner);
    await o.goto(`${BASE}/admin/staff`);
    labEmail = `lab.${suffix}`.toLowerCase();
    await o.getByLabel("Xodimning to‘liq ismi").fill("Laborant E2E");
    await o.getByLabel("Xodimning logini").fill(labEmail);
    await o.getByLabel("Yangi xodim roli").selectOption("lab");
    await o.getByRole("button", { name: /qo‘shish/i }).click();
    const password = (await o.getByTestId("temporary-password").textContent())?.trim();
    check(Boolean(password), "owner: a lab staff member is added with a one-time password");
    await ownerContext.close();

    // ---------- the lab staff member ----------
    const labContext = await browser.newContext();
    const l = await labContext.newPage();
    l.on("pageerror", (e) => report.problems.push(`[lab] pageerror: ${e.message}`));
    await l.goto(`${BASE}/login`);
    await l.getByLabel("Login").fill(labEmail);
    await l.getByLabel("Parol").fill(password ?? "");
    await l.getByRole("button", { name: "Kirish" }).click();
    // First sign-in: the temporary password is replaced before any panel opens.
    await l.waitForURL(/\/account\/password/, { timeout: 15_000 });
    const ownPassword = `Lab-own-${suffix}-password`;
    await l.getByLabel("Joriy parol").fill(password ?? "");
    await l.getByLabel("Yangi parol", { exact: true }).fill(ownPassword);
    await l.getByLabel("Yangi parol takrori").fill(ownPassword);
    await l.getByRole("button", { name: "Parolni o‘zgartirish" }).click();
    await l.waitForURL(/\/lab/, { timeout: 15_000 });
    check(new URL(l.url()).pathname === "/lab", "lab staff land on the lab workspace");
    await l.goto(`${BASE}/admin/patients`);
    await l.waitForURL(/\/lab/, { timeout: 15_000 });
    check(new URL(l.url()).pathname === "/lab", "lab staff are sent away from the admin desk");
    check((await l.request.get(`${BASE}/api/admin/patients`)).status() === 403, "lab staff: patient list API → 403");
    check(
      (await l.request.post(`${BASE}/api/admin/lab/tests`, { data: { code: "LABX", name: "x", sampleType: "x", price: 1 } })).status() === 403,
      "lab staff: catalog configuration API → 403",
    );
    check((await l.request.get(`${BASE}/api/admin/lab/catalog`)).status() === 200, "lab staff: catalog read API → 200");
    await labContext.close();
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
  if (labEmail) {
    await db`delete from public.staff_roles where profile_id in (select id from public.profiles where login = ${labEmail})`.catch(() => {});
  }
  await db.end({ timeout: 5 });
}
process.exit(code);

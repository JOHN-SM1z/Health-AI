// Patient merge in a real browser against the built app and a LOCAL Supabase
// stack (Phase 14):
//   * the owner sees a desk record and a Telegram record of the same person
//     suggested as possible duplicates, opens the full preview (counts,
//     identity plan, doctors whose access extends), and cannot merge without
//     a reason and the same-person confirmation;
//   * merging links the records: nothing recorded moves, the Telegram
//     identity moves to the canonical record, the doctor sees one record;
//   * a contradiction (different birth dates) blocks a merge on screen;
//   * the merge is undone from the log, with the identity restored;
//   * reception has no merge screen and gets 403 from the API.
// Rerunnable: run-unique names and Telegram ids.
import { chromium } from "playwright";
import { BASE, DEMO, DEMO_NAMES, assertLocalOnly, connect, createReport, runFixture, signIn } from "./lib.mjs";

assertLocalOnly();
const report = createReport("patient merge E2E");
const { check } = report;
const db = connect();
const { suffix, nextSlot } = runFixture();

async function run() {
  const [owner] = await db`select u.id, sr.clinic_id from auth.users u join public.staff_roles sr on sr.profile_id = u.id where u.email = ${DEMO.owner}`;
  const [drA] = await db`select d.id from public.doctors d join auth.users u on u.id = d.profile_id where u.email = ${DEMO.referrer}`;
  if (!owner || !drA) throw new Error("demo staff missing — run node e2e/seed-demo.mjs");
  const clinic = owner.clinic_id;
  const [service] = await db`select id from public.services where clinic_id = ${clinic} and name = ${DEMO_NAMES.generalService}`;

  const surname = `Birlashtirov${suffix}`;
  const telegram = 700_000_000 + Math.floor(Math.random() * 1e8);
  const [desk] = await db`insert into public.patients ${db({ clinic_id: clinic, full_name: `${surname} Aziz`, date_of_birth: "1988-08-08", phone: `+998 9${String(telegram).slice(-8)}` })} returning id`;
  const [bot] = await db`insert into public.patients ${db({ clinic_id: clinic, full_name: `Aziz ${surname}`, date_of_birth: "1988-08-08", telegram_user_id: telegram })} returning id`;
  const slot = nextSlot();
  const [visit] = await db`insert into public.appointments ${db({ clinic_id: clinic, patient_id: bot.id, doctor_id: drA.id, service_id: service.id, start_at: slot.start, end_at: slot.end, status: "completed", source: "telegram_mini_app" })} returning id`;
  const [other] = await db`insert into public.patients ${db({ clinic_id: clinic, full_name: `${surname} Aziz`, date_of_birth: "1999-09-09" })} returning id`;

  const browser = await chromium.launch();
  try {
    const { context: oc, page: o } = await signIn(browser, report, DEMO.owner, "desktop", { expectDenials: true });
    await o.getByRole("link", { name: "Kartalarni birlashtirish" }).first().click();
    await o.getByRole("heading", { name: "Bemor kartalarini birlashtirish" }).waitFor();

    const suggestions = o.getByRole("list", { name: "Ehtimoliy takror kartalar" });
    const pair = suggestions.getByRole("listitem").filter({ hasText: `${surname} Aziz` }).filter({ hasText: `Aziz ${surname}` });
    await pair.getByText("Ism va tug‘ilgan sana bir xil").waitFor();
    check(true, "owner: the desk and Telegram records are suggested as possible duplicates");
    await pair.getByRole("button", { name: "Ko‘rib chiqish" }).click();

    const pv = o.getByRole("region", { name: "Birlashtirish oldidan ko‘rib chiqish" });
    await pv.getByText("Takror karta", { exact: true }).waitFor();
    const rows = await pv.locator("tr").allInnerTexts();
    check(rows.some((r) => /Qabullar\s+0\s+1/.test(r)), "owner: the preview counts each record's visits (canonical 0, duplicate 1)");
    check(rows.some((r) => /Telegram hisobi.*ko‘chiriladi/.test(r)), "owner: the preview says the Telegram identity moves");
    await o.getByLabel("Ogohlantirishlar").getByText("birlashtirilgan kartani ko‘radi").waitFor();
    check(true, "owner: the preview warns whose access extends");
    const mergeButton = pv.getByRole("button", { name: "Birlashtirish" });
    check(await mergeButton.isDisabled(), "owner: merging needs a reason and the same-person confirmation");
    await pv.getByLabel("Birlashtirish sababi").fill("Qabulxona va Telegram kartalari; pasport bilan tekshirildi");
    await pv.getByRole("checkbox").check();
    await mergeButton.click();
    await o.getByText("Kartalar birlashtirildi").waitFor();

    const after = await db`select id, merged_into_patient_id, telegram_user_id from public.patients where id in (${desk.id}, ${bot.id})`;
    const d = after.find((r) => r.id === bot.id);
    const c = after.find((r) => r.id === desk.id);
    check(d.merged_into_patient_id === desk.id && d.telegram_user_id === null && String(c.telegram_user_id) === String(telegram), "owner: the records are linked and the Telegram identity is on the canonical record");
    const [appt] = await db`select patient_id from public.appointments where id = ${visit.id}`;
    check(appt.patient_id === bot.id, "owner: the visit still belongs to the record it was booked on (nothing moved)");

    // A contradiction blocks the merge on screen. The merged record is no
    // longer in the directory: the search offers only the two live records.
    const canonPicker = o.getByRole("group", { name: "Asosiy karta (qoladi)" });
    await canonPicker.getByLabel("Asosiy karta (qoladi): qidirish").fill(surname);
    const canonOptions = canonPicker.getByRole("button", { name: new RegExp(surname) });
    await canonOptions.nth(1).waitFor();
    await o.waitForTimeout(400);
    check((await canonOptions.count()) === 2, "owner: the merged record is no longer offered in the patient search");
    await canonPicker.getByRole("button", { name: /\+998/ }).click(); // the desk record (with a phone)
    const dupPicker = o.getByRole("group", { name: "Takror karta (asosiyga bog‘lanadi)" });
    await dupPicker.getByLabel("Takror karta (asosiyga bog‘lanadi): qidirish").fill(surname);
    await dupPicker.getByRole("button", { name: new RegExp(surname) }).nth(1).waitFor();
    await dupPicker.getByRole("button", { name: new RegExp(surname) }).filter({ hasNotText: "+998" }).click();
    await o.getByRole("button", { name: "Ko‘rib chiqish", exact: true }).last().click();
    const blocked = o.getByRole("alert", { name: "To‘siqlar" });
    await blocked.getByText("Tug‘ilgan sanalar farq qiladi").waitFor();
    check((await pv.getByRole("button", { name: "Birlashtirish" }).count()) === 0, "owner: different birth dates block the merge (no merge button)");
    check((await db`select merged_into_patient_id from public.patients where id = ${other.id}`)[0].merged_into_patient_id === null, "owner: nothing was merged");

    // Undo from the log.
    const log = o.getByRole("list", { name: "Birlashtirishlar jurnali" });
    const entry = log.getByRole("listitem").filter({ hasText: `Aziz ${surname}` }).first();
    await entry.getByRole("button", { name: "Bekor qilish" }).click();
    await entry.getByLabel("Bekor qilish sababi").fill("Tekshiruv uchun bekor qilindi");
    await entry.getByRole("button", { name: "Bekor qilishni tasdiqlash" }).click();
    await o.getByText("Birlashtirish bekor qilindi").waitFor();
    const undone = await db`select id, merged_into_patient_id, telegram_user_id from public.patients where id in (${desk.id}, ${bot.id})`;
    check(
      undone.every((r) => r.merged_into_patient_id === null) && String(undone.find((r) => r.id === bot.id).telegram_user_id) === String(telegram),
      "owner: the unmerge restores the link and the Telegram identity",
    );
    const audits = await db`select action, new_values from public.audit_events where clinic_id = ${clinic} and action in ('patient_merged', 'patient_unmerged') and patient_id in (${desk.id}, ${bot.id})`;
    check(audits.length === 4 && !JSON.stringify(audits).includes(String(telegram)), "owner: merge and unmerge are audited on both records, without identity values");
    await oc.close();

    // Reception: no screen, no API.
    const { context: rc, page: r } = await signIn(browser, report, DEMO.reception, "desktop", { expectDenials: true });
    check((await r.getByRole("link", { name: "Kartalarni birlashtirish" }).count()) === 0, "reception: no merge screen in the menu");
    check((await r.request.get(`${BASE}/api/admin/patients/merge?canonical=${desk.id}&duplicate=${bot.id}`)).status() === 403, "reception: the merge API → 403");
    await rc.close();
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

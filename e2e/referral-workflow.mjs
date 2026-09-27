// End-to-end: the complete doctor-to-doctor referral workflow in the BUILT
// app, with real logins, as clinicians do it — and the same screens checked
// at phone and tablet widths.
//
//   Dr A (desktop): opens their patient → documents history, diagnosis, lab
//     result → Yo‘llanma → picks Dr B → reason + handoff → review → submit
//   Dr B (tablet): sees the pending referral → accepts → opens the patient →
//     reviews Dr A's diagnoses / labs / history (attributed) → starts a
//     consultation → writes new records → completes the referral
//   Dr A (phone): sees the outcome, attributed to Dr B; own records unchanged
//   Dr B: revoked, expired, declined and unrelated patients show a clear
//     state and never the data; a pending referral is accepted in place
//   Reception and manager (phone): the admin sections, and no clinical text
//   The audit trail: every step with its actor, ids only.
//
// Needs the local stack, `node e2e/seed-demo.mjs`, and the app running
// (`npm run build && npm start`). Rerunnable: every run uses its own patients.
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { BASE, DEMO, DEMO_NAMES, VIEWPORTS, assertLocalOnly, connect, createReport, runFixture, signIn } from "./lib.mjs";

assertLocalOnly();
const SHOTS = process.env.E2E_ARTIFACTS_DIR ?? "test-results/e2e";
mkdirSync(SHOTS, { recursive: true });
const report = createReport("referral workflow E2E");
const { check } = report;
const db = connect();
const { suffix, nextSlot } = runFixture();
const REASON = `Yurak urishi notekis, EKGda o‘zgarishlar — kardiolog ko‘rigi kerak (${suffix})`;
const NOTE = `Qandli diabet fonida; HbA1c yuqori — dori tanlashda hisobga oling (${suffix})`;
const PATIENT = `E2E Bemor ${suffix}`;

/** No page-level horizontal scroll, and nothing cut off at the right edge (except inside scrollable strips/tables). */
async function fitsWidth(page, label) {
  const result = await page.evaluate(() => {
    const w = window.innerWidth;
    const scrollable = (el) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX;
        if (o === "auto" || o === "scroll") return true;
      }
      return false;
    };
    const clipped = [...document.body.querySelectorAll("*")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.right > w + 1 && getComputedStyle(el).position !== "fixed" && !scrollable(el);
      })
      .slice(0, 3)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 50)}`);
    return { pageScroll: document.documentElement.scrollWidth > w + 1, clipped };
  });
  check(
    !result.pageScroll && result.clipped.length === 0,
    `${label}: fits the screen${result.clipped.length ? ` (clipped: ${result.clipped.join(", ")})` : ""}${result.pageScroll ? " (page scrolls sideways)" : ""}`,
  );
}

/** A control is on screen and at least 28px tall — tappable. */
async function tappable(locator, label) {
  const box = await locator.boundingBox();
  const vw = locator.page().viewportSize().width;
  check(!!box && box.x >= 0 && box.x + box.width <= vw + 1 && box.height >= 28, `${label}: reachable and tappable${box ? ` (${Math.round(box.width)}×${Math.round(box.height)})` : " (missing)"}`);
}

async function writeRecord(page, type, summary, code) {
  await page.getByLabel("Yozuv turi").selectOption({ label: type });
  await page.getByLabel("Qisqacha mazmun").fill(summary);
  if (code) await page.getByLabel("Kod").fill(code);
  await page.getByRole("button", { name: "Yozuvni saqlash" }).click();
  await page.getByRole("list", { name: "Joriy qabul yozuvlari" }).getByText(summary).waitFor();
}

async function linkedDoctor(email) {
  const [row] = await db`select d.id, d.profile_id, d.clinic_id from public.doctors d join auth.users u on u.id = d.profile_id where u.email = ${email}`;
  if (!row) throw new Error(`${email} is not linked to a doctor — run node e2e/seed-demo.mjs`);
  return row;
}

async function run() {
  const A = await linkedDoctor(DEMO.referrer);
  const B = await linkedDoctor(DEMO.receiver);
  const clinic = A.clinic_id;
  const [service] = await db`select id from public.services where clinic_id = ${clinic} and name = ${DEMO_NAMES.generalService}`;

  // Earlier runs' consultations happening now would overlap this run's.
  await db`
    update public.appointments a set status = 'cancelled', cancelled_at = now(), cancelled_reason = 'E2E: an earlier run'
      from public.patients p
     where p.id = a.patient_id and p.full_name like 'E2E %' and a.doctor_id in (${A.id}, ${B.id})
       and a.status not in ('cancelled', 'no_show')
       and tstzrange(a.start_at, a.end_at) && tstzrange(now() - interval '3 hours', now() + interval '3 hours')`;

  // Dr A's patient, in consultation with them now.
  const [patient] = await db`insert into public.patients (clinic_id, full_name) values (${clinic}, ${PATIENT}) returning id`;
  const start = new Date(Math.floor((Date.now() - 20 * 60_000) / 60_000) * 60_000);
  await db`insert into public.appointments ${db({
    clinic_id: clinic,
    patient_id: patient.id,
    doctor_id: A.id,
    service_id: service.id,
    start_at: start,
    end_at: new Date(start.getTime() + 20 * 60_000),
    status: "in_progress",
    source: "admin",
  })}`;

  const browser = await chromium.launch();
  let referralId = "";
  try {
    // ---------- Doctor A: opens the authorized patient, documents, refers ----------
    {
      const { context, page } = await signIn(browser, report, DEMO.referrer, "desktop");
      await page.getByRole("link", { name: "Bemorlarim" }).click();
      await page.getByLabel("Bemorni qidirish").fill(suffix);
      await page.getByRole("link", { name: PATIENT }).click();
      await page.waitForURL(/\/doctor\/patients\/[0-9a-f-]{36}$/);
      check(page.url().endsWith(patient.id), "A opens their authorized patient from Bemorlarim");
      await page.getByText("Mening bemorim").waitFor();

      await writeRecord(page, "Anamnez", `Qandli diabet 2-tip, 2015 yildan (${suffix})`);
      await writeRecord(page, "Yangi tashxis", `Arterial gipertenziya (${suffix})`, "I10");
      await writeRecord(page, "Tahlil natijasi", `HbA1c 7.9% (${suffix})`);
      check((await page.getByRole("list", { name: "Joriy qabul yozuvlari" }).getByText("Siz yozgansiz").count()) === 3, "A's history, diagnosis and lab result are recorded as A's");

      await page.getByRole("button", { name: "Yo‘llanma", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Yo‘llanma berish" });
      await dialog.getByLabel("Qabul qiluvchi shifokor").waitFor();
      const options = await dialog.getByLabel("Qabul qiluvchi shifokor").locator("option").allTextContents();
      check(!options.some((o) => o.includes(DEMO_NAMES.referrer)), "A cannot pick themselves");
      await dialog.getByLabel("Qabul qiluvchi shifokor").selectOption({ label: options.find((o) => o.includes(DEMO_NAMES.receiver)) });
      await dialog.getByRole("button", { name: "Shoshilinch" }).click();
      await dialog.getByLabel("Yo‘llanma sababi").fill(REASON);
      await dialog.getByLabel("Shifokor uchun izoh").fill(NOTE);
      check((await dialog.getByRole("button", { name: "Yo‘llanma yuborish" }).count()) === 0, "no submit before review");
      await dialog.getByRole("button", { name: "Ko‘rib chiqish" }).click();
      const review = page.getByRole("dialog", { name: "Yo‘llanmani tekshiring" });
      await review.waitFor();
      check(
        (await review.getByText(REASON).isVisible()) && (await review.getByText(NOTE).isVisible()) && (await review.getByText(DEMO_NAMES.receiver, { exact: false }).isVisible()),
        "A reviews recipient, reason and handoff before sending",
      );
      await page.screenshot({ path: `${SHOTS}/a1-review.png` });
      await review.getByRole("button", { name: "Yo‘llanma yuborish" }).click();
      await page.getByText("Yo‘llanma yuborildi.").waitFor();
      const [referral] = await db`select id, status, created_by, priority from public.referrals where patient_id = ${patient.id} and referred_to_doctor_id = ${B.id}`;
      referralId = referral.id;
      check(referral.status === "pending" && referral.created_by === A.profile_id && referral.priority === "urgent", "the referral is stored pending, created by A, urgent");
      await context.close();
    }

    // ---------- Doctor B (tablet): pending → accept → review history → consult → records → complete ----------
    {
      const { context, page } = await signIn(browser, report, DEMO.receiver, "tablet");
      await page.getByText(/Sizga kelgan yo‘llanmalar \(\d+\)/).waitFor();
      check(true, "B sees pending referrals on the dashboard");
      await fitsWidth(page, "tablet: doctor dashboard");
      // Tablets (≥ 768px) get the sidebar; phones the navigation strip (checked below).
      await page.getByRole("link", { name: /^Yo‘llanmalar/ }).first().click();
      await page.getByText(REASON).waitFor();
      check(true, "B's referral list shows A's referral");
      await fitsWidth(page, "tablet: referrals list");
      await page.goto(`${BASE}/doctor/referrals/${referralId}`);
      await page.getByRole("button", { name: "Qabul qilish" }).waitFor();
      check(await page.getByText("Tarix yo‘llanmani qabul qilganingizdan keyin ko‘rinadi.").isVisible(), "before accepting, A's history is withheld");
      await tappable(page.getByRole("button", { name: "Qabul qilish" }), "tablet: accept button");
      await page.getByRole("button", { name: "Qabul qilish" }).click();
      await page.getByText("Yo‘llanma qabul qilindi").waitFor();
      const [accepted] = await db`select status, accepted_by from public.referrals where id = ${referralId}`;
      check(accepted.status === "accepted" && accepted.accepted_by === B.profile_id, "accepted by B");
      await fitsWidth(page, "tablet: referral detail");

      await page.getByRole("link", { name: "Bemor kartasini ochish" }).click();
      await page.waitForURL(/\/doctor\/patients\/[0-9a-f-]{36}$/);
      await page.getByText("Yo‘llanma bo‘yicha", { exact: true }).waitFor();
      const summary = (name) => page.getByRole("list", { name });
      check(await summary("Tashxislar").getByText(`Arterial gipertenziya (${suffix})`).isVisible(), "B reviews A's previous diagnosis");
      check(await summary("Tahlil natijalari").getByText(`HbA1c 7.9% (${suffix})`).isVisible(), "B reviews A's lab result");
      check(await summary("Anamnez").getByText(`Qandli diabet 2-tip, 2015 yildan (${suffix})`).isVisible(), "B reviews A's medical history");
      check((await page.getByLabel("Oldingi yozuvlar").getByText(`Muallif: ${DEMO_NAMES.referrer}`, { exact: false }).count()) >= 3, "each historical record names Dr A as its author");
      check(
        await page.getByLabel("Oldingi yozuvlar").locator("li", { hasText: `Arterial gipertenziya (${suffix})` }).getByText("Oldingi tashxis").isVisible(),
        "A's diagnosis is labelled a historical diagnosis",
      );
      check((await page.getByText("Siz yozgansiz").count()) === 0, "nothing is attributed to B yet");
      await fitsWidth(page, "tablet: patient workspace (history)");
      await page.screenshot({ path: `${SHOTS}/b1-history-tablet.png`, fullPage: true });

      // Start B's own consultation.
      const services = await page.getByLabel("Xizmat").locator("option").allTextContents();
      await page.getByLabel("Xizmat").selectOption({ label: services.find((o) => o.includes(DEMO_NAMES.cardiologyService)) ?? services[1] });
      await tappable(page.getByRole("button", { name: "Hozir qabulni boshlash" }), "tablet: start consultation");
      await page.getByRole("button", { name: "Hozir qabulni boshlash" }).click();
      await page.getByRole("button", { name: "Qabulni yakunlash" }).waitFor();
      const [started] = await db`select status, started_by, follow_up_appointment_id from public.referrals where id = ${referralId}`;
      check(started.status === "in_progress" && started.started_by === B.profile_id, "starting the consultation moves the referral in progress (by B)");
      const [startAudit] = await db`
        select count(*)::int as n from public.audit_events
         where action = 'consultation_started' and entity_id = ${started.follow_up_appointment_id} and referral_id = ${referralId} and actor_id = ${B.profile_id}`;
      check(startAudit.n === 1, "the consultation start is audited once, with the referral and B as actor");

      // New records — B's own, next to A's.
      await writeRecord(page, "Joriy baho", `EKG: qorincha ekstrasistoliyasi, Holter kerak (${suffix})`);
      await writeRecord(page, "Yangi tashxis", `Paroksizmal taxikardiya (${suffix})`, "I47.9");
      await writeRecord(page, "Retsept", `Bisoprolol 2.5 mg kuniga 1 marta (${suffix})`);
      await writeRecord(page, "Tahlilga yo‘llanma", `Holter monitoring 24 soat, exokardiografiya (${suffix})`);
      await writeRecord(page, "Keyingi qadam / yo‘llanma", `2 haftadan keyin natijalar bilan nazorat qabuli (${suffix})`);
      const current = page.getByRole("list", { name: "Joriy qabul yozuvlari" });
      check((await current.getByText("Siz yozgansiz").count()) === 5, "all five new records are authored by B");
      for (const [label, text] of [
        ["Joriy baho", "Holter kerak"],
        ["Yangi tashxis", "Paroksizmal taxikardiya"],
        ["Retsept", "Bisoprolol"],
        ["Tahlilga yo‘llanma", "exokardiografiya"],
        ["Keyingi qadam / yo‘llanma", "nazorat qabuli"],
      ]) {
        check(await current.locator("li", { hasText: text }).getByText(label, { exact: true }).isVisible(), `B's record is labelled "${label}"`);
      }
      const [aRecords] = await db`
        select count(*)::int as n from public.clinical_records
         where author_doctor_id = ${A.id} and patient_id = ${patient.id} and created_by = ${A.profile_id}`;
      check(aRecords.n === 3, "A's records are unchanged in the database");
      const [bRecords] = await db`
        select count(*)::int as n from public.clinical_records
         where author_doctor_id = ${B.id} and created_by = ${B.profile_id} and patient_id = ${patient.id}`;
      check(bRecords.n === 5, "B's records carry B as author and creator");
      await fitsWidth(page, "tablet: patient workspace (consultation + record form)");

      // Complete the referral.
      await page.getByRole("button", { name: "Yo‘llanmani yakunlash" }).click();
      await tappable(page.getByRole("button", { name: "Ha, yakunlash" }), "tablet: confirm completion");
      await page.getByRole("button", { name: "Ha, yakunlash" }).click();
      await page.getByRole("list", { name: "Yo‘llanma bosqichlari" }).locator('[aria-current="step"]', { hasText: "Yakunlandi" }).waitFor();
      const [completed] = await db`select status, completed_by from public.referrals where id = ${referralId}`;
      check(completed.status === "completed" && completed.completed_by === B.profile_id, "B completes the referral");
      await page.screenshot({ path: `${SHOTS}/b2-completed-tablet.png`, fullPage: true });

      // The same screens on a phone.
      await page.setViewportSize(VIEWPORTS.phone);
      await page.reload();
      await page.getByRole("list", { name: "Joriy qabul yozuvlari" }).waitFor();
      await fitsWidth(page, "phone: patient workspace");
      await tappable(page.getByRole("button", { name: "Yozuvni saqlash" }), "phone: save record");
      await page.screenshot({ path: `${SHOTS}/b3-workspace-phone.png`, fullPage: true });
      const nav = page.getByRole("navigation", { name: "Shifokor bo‘limlari" });
      check(await nav.isVisible(), "phone: doctor sections reachable from the navigation strip");
      for (const [link, path] of [["Yo‘llanmalar", "/doctor/referrals"], ["Bemorlarim", "/doctor/patients"], ["Bugungi navbat", "/doctor"]]) {
        await nav.getByRole("link", { name: link }).click();
        await page.waitForURL((u) => u.pathname === path);
        await page.waitForLoadState("networkidle");
        await fitsWidth(page, `phone: ${path}`);
      }
      await page.goto(`${BASE}/doctor/referrals/${referralId}`);
      await page.getByText(REASON).waitFor();
      await fitsWidth(page, "phone: referral detail");
      await page.screenshot({ path: `${SHOTS}/b4-referral-phone.png`, fullPage: true });
      await context.close();
    }

    // ---------- Doctor A (phone): the outcome, attributed to B ----------
    {
      const { context, page } = await signIn(browser, report, DEMO.referrer, "phone");
      await page.getByRole("navigation", { name: "Shifokor bo‘limlari" }).getByRole("link", { name: "Bemorlarim" }).click();
      await page.getByLabel("Bemorni qidirish").fill(suffix);
      await page.getByRole("link", { name: PATIENT }).click();
      await page.waitForURL((u) => u.pathname === `/doctor/patients/${patient.id}`);
      const history = page.getByLabel("Oldingi yozuvlar");
      await history.locator("li", { hasText: `Paroksizmal taxikardiya (${suffix})` }).waitFor();
      check(
        await history.locator("li", { hasText: `Paroksizmal taxikardiya (${suffix})` }).getByText(`Muallif: ${DEMO_NAMES.receiver}`, { exact: false }).isVisible(),
        "A sees B's new diagnosis, attributed to B",
      );
      check((await page.getByRole("list", { name: "Joriy qabul yozuvlari" }).getByText("Siz yozgansiz").count()) === 3, "A's own records are still A's");
      check(await page.getByText("Yakunlandi", { exact: true }).first().isVisible(), "A sees the referral completed");
      await fitsWidth(page, "phone: referring doctor's patient page");
      await tappable(page.getByRole("button", { name: "Yo‘llanma", exact: true }), "phone: refer button");
      await page.getByRole("button", { name: "Yo‘llanma", exact: true }).click();
      await page.getByRole("dialog", { name: "Yo‘llanma berish" }).waitFor();
      await fitsWidth(page, "phone: referral dialog");
      await tappable(page.getByRole("button", { name: "Ko‘rib chiqish" }), "phone: review button");
      await page.screenshot({ path: `${SHOTS}/a2-dialog-phone.png` });
      await context.close();
    }

    // ---------- Doctor B: pending, declined, revoked, expired and unrelated patients ----------
    {
      async function referredPatient(name, { accept = true, validFor = "30 days" } = {}) {
        const [p] = await db`insert into public.patients (clinic_id, full_name) values (${clinic}, ${`${name} ${suffix}`}) returning id`;
        const slot = nextSlot();
        const [visit] = await db`insert into public.appointments ${db({
          clinic_id: clinic, patient_id: p.id, doctor_id: A.id, service_id: service.id,
          start_at: slot.start, end_at: slot.end, status: "completed", source: "walk_in",
        })} returning id`;
        const [r] = await db`
          insert into public.referrals (clinic_id, patient_id, referring_doctor_id, referred_to_doctor_id, originating_appointment_id, reason, created_by, expires_at)
          values (${clinic}, ${p.id}, ${A.id}, ${B.id}, ${visit.id}, ${`E2E referral (${suffix})`}, ${A.profile_id}, now() + ${validFor}::interval)
          returning id`;
        if (accept) await db`update public.referrals set status = 'accepted', accepted_by = ${B.profile_id} where id = ${r.id}`;
        return { patient: p.id, referral: r.id, name: `${name} ${suffix}` };
      }
      const revoked = await referredPatient("E2E Bekor");
      await db`update public.referrals set status = 'revoked', revoked_by = ${A.profile_id}, revoked_reason = 'E2E' where id = ${revoked.referral}`;
      const expired = await referredPatient("E2E Muddati", { validFor: "2 seconds" });
      const pending = await referredPatient("E2E Kutilayotgan", { accept: false });
      const toDecline = await referredPatient("E2E Rad", { accept: false });
      const [unrelated] = await db`insert into public.patients (clinic_id, full_name) values (${clinic}, ${`E2E Begona ${suffix}`}) returning id`;
      await new Promise((r) => setTimeout(r, 2_500));

      const { context, page } = await signIn(browser, report, DEMO.receiver, "desktop", { expectDenials: true });
      await page.getByRole("link", { name: "Bemorlarim" }).click();
      await page.getByLabel("Bemorni qidirish").fill(suffix);
      await page.getByRole("link", { name: pending.name }).waitFor();
      const listed = await page.getByRole("table").getByRole("link").allTextContents();
      check(listed.includes(PATIENT) && listed.includes(pending.name), "B's patient list has the referred patients");
      check(![revoked.name, expired.name, `E2E Begona ${suffix}`].some((n) => listed.includes(n)), "B's patient list leaves out revoked, expired and unrelated patients");

      // A pending referral is accepted in place; completing waits for the consultation.
      await page.getByRole("link", { name: pending.name }).click();
      await page.getByRole("button", { name: "Yo‘llanmani qabul qilish" }).waitFor();
      check((await page.getByRole("button", { name: "Hozir qabulni boshlash" }).count()) === 0, "no consultation before the referral is accepted");
      await page.getByRole("button", { name: "Yo‘llanmani qabul qilish" }).click();
      await page.getByRole("button", { name: "Hozir qabulni boshlash" }).waitFor();
      check((await db`select status from public.referrals where id = ${pending.referral}`)[0].status === "accepted", "the pending referral is accepted from the workspace");
      check((await page.getByRole("button", { name: "Yo‘llanmani yakunlash" }).count()) === 0, "no completing before the consultation");

      // Declining from the workspace, with a reason that stays out of the audit trail.
      await page.goto(`${BASE}/doctor/patients/${toDecline.patient}`);
      await page.getByRole("button", { name: "Rad etish" }).click();
      await page.getByLabel("Rad etish sababi").fill(`Nefrolog ko‘rigi ma‘qulroq (${suffix})`);
      await page.getByRole("button", { name: "Yo‘llanmani rad etish" }).click();
      await page.getByText("Yo‘llanma rad etilgan").waitFor();
      check(!(await page.content()).includes(toDecline.name), "after declining, the page shows the closed state without patient data");
      const [declined] = await db`
        select count(*)::int as n from public.audit_events
         where action = 'referral_declined' and referral_id = ${toDecline.referral} and (coalesce(old_values::text, '') || coalesce(new_values::text, '') || metadata::text) not like '%Nefrolog%'`;
      check(declined.n === 1, "declining is audited without the reason text");

      for (const [id, title, label, name] of [
        [revoked.patient, "Yo‘llanma bekor qilingan", "revoked", revoked.name],
        [expired.patient, "Yo‘llanma muddati tugagan", "expired", expired.name],
        [unrelated.id, "Bemor topilmadi", "unrelated", `E2E Begona ${suffix}`],
      ]) {
        await page.goto(`${BASE}/doctor/patients/${id}`);
        await page.getByText(title).waitFor();
        check(!(await page.content()).includes(name), `${label} patient: a clear state, no patient data`);
      }
      await page.setViewportSize(VIEWPORTS.phone);
      await fitsWidth(page, "phone: not-found state");
      await context.close();
    }

    // ---------- Reception and manager (phone): admin sections, no clinical text ----------
    for (const [email, label] of [[DEMO.reception, "reception"], [DEMO.manager, "manager"]]) {
      const { context, page } = await signIn(browser, report, email, "phone");
      const nav = page.getByRole("navigation", { name: "Boshqaruv bo‘limlari" });
      check(await nav.isVisible(), `${label} (phone): admin sections reachable from the navigation strip`);
      check((await nav.getByRole("link", { name: "Bugun" }).getAttribute("aria-current")) === "page", `${label} (phone): the current section is marked`);
      await fitsWidth(page, `${label} (phone): dashboard`);
      await nav.getByRole("link", { name: "Bemorlar" }).click();
      await page.waitForURL((u) => u.pathname === "/admin/patients");
      await page.waitForLoadState("networkidle");
      check((await nav.getByRole("link", { name: "Bugun" }).getAttribute("aria-current")) === null, `${label} (phone): only the open section is marked current`);
      await fitsWidth(page, `${label} (phone): patients`);
      await page.reload();
      await page.waitForLoadState("networkidle");
      const current = await nav.getByRole("link", { name: "Bemorlar" }).boundingBox();
      check(!!current && current.x >= 0 && current.x + current.width <= VIEWPORTS.phone.width + 1, `${label} (phone): the current section is in view in the strip on arrival`);
      await page.getByLabel("Bemorlarni qidirish").fill(suffix);
      await page.getByRole("row", { name: new RegExp(PATIENT) }).getByText(PATIENT).click();
      await page.getByText(/Yo‘llanmalar \(1\)/).waitFor();
      check(true, `${label}: the patient's referral is listed on the reception panel`);
      await fitsWidth(page, `${label} (phone): patient detail with its referral`);
      const html = await page.content();
      check(!html.includes(REASON) && !html.includes(NOTE) && !html.includes(`Arterial gipertenziya (${suffix})`), `${label}: no clinical text on the patient screens`);
      await page.screenshot({ path: `${SHOTS}/${label}-phone.png`, fullPage: true });
      await context.close();
    }
  } finally {
    await browser.close();
  }

  // ---------- Audit trail ----------
  const lifecycle = await db`
    select action, actor_id from public.audit_events
     where referral_id = ${referralId} and action in ('referral_created', 'referral_accepted', 'referral_in_progress', 'referral_completed')
     order by created_at, action`;
  check(
    JSON.stringify(lifecycle.map((r) => [r.action, r.actor_id])) ===
      JSON.stringify([
        ["referral_created", A.profile_id],
        ["referral_accepted", B.profile_id],
        ["referral_in_progress", B.profile_id],
        ["referral_completed", B.profile_id],
      ]),
    "lifecycle audited in order with the right actors",
  );
  const count = async (q) => (await q)[0].n;
  check((await count(db`select count(*)::int as n from public.audit_events where referral_id = ${referralId} and action = 'referral_viewed'`)) >= 2, "referral views audited");
  check((await count(db`select count(*)::int as n from public.audit_events where action = 'clinical_record_created' and referral_id = ${referralId}`)) === 5, "B's five records audited against the referral");
  check(
    (await count(db`
      select count(*)::int as n from public.audit_events
       where action = 'patient_clinical_record_viewed' and patient_id = ${patient.id} and actor_id = ${B.profile_id}
         and jsonb_array_length(metadata->'shared_record_ids') >= 3`)) >= 1,
    "B's access to A's records audited with the record ids",
  );
  check(
    (await count(db`
      select count(*)::int as n from public.audit_events
       where patient_id = ${patient.id}
         and (coalesce(old_values::text, '') || coalesce(new_values::text, '') || metadata::text) ~ ${`(${suffix}\\))`}`)) === 0,
    "no clinical text in any audit row",
  );
  check(
    (await count(db`
      select count(*)::int as n from public.audit_events
       where patient_id = ${patient.id} and clinic_id <> (select clinic_id from public.patients where id = ${patient.id})`)) === 0,
    "every audit row belongs to the patient's clinic",
  );
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

// Passport-first online booking in the Mini App (Slice B, owner decision 2026-10-08), in a real browser against the
// built app and a LOCAL Supabase stack. The Mini App is opened as Telegram opens it (initData signed by the clinic's
// bot in #tgWebAppData). Sharing a phone happens in Telegram itself, so the run records the patient's verified phone
// the way the bot's webhook does after receiving their own contact.
//   * A returning desk patient: passport + date of birth, their phone → their card's details appear, the card is
//     linked to their Telegram, and the booking skips the name/phone form and lands on that card.
//   * A new patient: the same answers, then a short form; their record gets the passport and date of birth.
//   * Before the phone is shared, the patient is asked to share it — nothing about the card is shown.
// Rerunnable: run-unique documents, phones and Telegram ids.
import { createHmac } from "node:crypto";
import { chromium } from "playwright";
import { BASE, DEMO, DEMO_NAMES, assertLocalOnly, connect, createReport, pickSlot, runFixture } from "./lib.mjs";

assertLocalOnly();
const report = createReport("online identity E2E");
const { check } = report;
const db = connect();
const { suffix } = runFixture();
let insertedIntegration = null;

function signInitData(botToken, telegramUserId) {
  const user = JSON.stringify({ id: telegramUserId, first_name: "Bemor" });
  const fields = [["auth_date", String(Math.floor(Date.now() / 1000))], ["query_id", "AAHdF6IQAAAAAN0XohDhrOrc"], ["user", user]];
  const c = fields.map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(c).digest("hex");
  return `${fields.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}&hash=${hash}`;
}
const launch = (initData) => `#tgWebAppData=${encodeURIComponent(initData)}&tgWebAppVersion=7.0&tgWebAppPlatform=web`;

async function run() {
  const [reception] = await db`select u.id, sr.clinic_id from auth.users u join public.staff_roles sr on sr.profile_id = u.id where u.email = ${DEMO.reception}`;
  if (!reception) throw new Error("demo staff missing — run node e2e/seed-demo.mjs");
  const clinic = reception.clinic_id;

  let [bot] = await db`select telegram_bot_token from public.clinic_telegram_integrations where clinic_id = ${clinic} and enabled and status = 'active'`;
  if (!bot) {
    const token = `${Date.now() % 1_000_000}:E2E${suffix}${"t".repeat(24)}`;
    await db`insert into public.clinic_telegram_integrations ${db({ clinic_id: clinic, telegram_bot_token: token, telegram_bot_id: Date.now() % 1_000_000_000, telegram_username: `e2e_${suffix}_bot`, telegram_bot_name: "E2E", status: "active", enabled: true, validated_at: new Date() })}
             on conflict (clinic_id) do nothing`;
    insertedIntegration = clinic;
    [bot] = await db`select telegram_bot_token from public.clinic_telegram_integrations where clinic_id = ${clinic}`;
  }

  const n = Date.now() % 10_000_000;
  const tg = { returning: 960_000_000 + (n % 1_000_000) * 3, fresh: 960_000_001 + (n % 1_000_000) * 3, waiting: 960_000_002 + (n % 1_000_000) * 3 };
  const deskDoc = `E${String.fromCharCode(65 + (n % 26))}${String(n).padStart(7, "0")}`;
  const newDoc = `N${String.fromCharCode(65 + (n % 26))}${String(n).padStart(7, "0")}`;
  const deskPhoneKey = `93${String(n).padStart(7, "0")}`;
  const deskName = `Onlayn Qaytgan ${suffix}`;
  const [desk] = await db`insert into public.patients ${db({ clinic_id: clinic, full_name: deskName, document_number: deskDoc, date_of_birth: "1984-05-17", phone: `+998 ${deskPhoneKey}`, home_address: `Mirobod ${suffix}` })} returning id`;
  // The bot received each patient's OWN contact (webhook: contact.user_id = sender).
  const verified = (telegramUserId, key) =>
    db`insert into public.telegram_verified_phones ${db({ clinic_id: clinic, telegram_user_id: telegramUserId, phone_key: key })}
       on conflict (clinic_id, telegram_user_id) do update set phone_key = excluded.phone_key, verified_at = now()`;

  const browser = await chromium.launch();
  try {
    const open = async (telegramUserId, label) => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const page = await ctx.newPage();
      page.on("pageerror", (e) => report.problems.push(`[${label}] pageerror: ${e.message}`));
      page.on("response", (r) => r.status() >= 500 && report.problems.push(`[${label}] HTTP ${r.status()} ${r.url()}`));
      await page.goto(`${BASE}/book?clinic=${clinic}${launch(signInitData(bot.telegram_bot_token, telegramUserId))}`);
      await page.getByRole("heading", { name: "Shaxsingizni kiriting" }).or(page.getByText("Shaxsingizni kiriting")).first().waitFor();
      return { ctx, page };
    };
    const identify = async (page, document, dob) => {
      await page.getByLabel("Pasport / ID karta yoki JSHSHIR").fill(document);
      await page.getByLabel("Tug‘ilgan sana").fill(dob);
      await page.getByLabel("Shaxsiy ma’lumotlarga rozilik").check();
      await page.getByRole("button", { name: "Davom etish" }).click();
    };

    // ---------- Returning desk patient ----------
    {
      await verified(tg.returning, deskPhoneKey);
      const { ctx, page } = await open(tg.returning, "returning");
      check(true, "the very first screen asks for passport/ID or JSHSHIR and date of birth (with consent)");
      await identify(page, deskDoc.toLowerCase(), "17.05.1984");
      await page.getByText(deskName).waitFor();
      check(await page.getByText("17.05.1984").isVisible() && await page.getByText(`Mirobod ${suffix}`).isVisible(), "the card's details appear for its proven owner");
      check(!(await page.content()).includes(deskDoc), "the document number itself is never shown back");
      const [linked] = await db`select telegram_user_id, telegram_link_method from public.patients where id = ${desk.id}`;
      check(Number(linked.telegram_user_id) === tg.returning && linked.telegram_link_method === "contact_phone", "the desk card is linked to the patient's Telegram");

      await page.getByRole("button", { name: "Ha, davom etish" }).click();
      // The concern, in the patient's words; the clinic has no matching direction, so the patient chooses.
      const concernText = `Qon bosimim ko‘tariladi ${suffix}`;
      await page.getByLabel("Shikoyatingiz").fill(concernText);
      await page.getByRole("button", { name: "Davom etish" }).click();
      await page.getByRole("button", { name: "Yo‘nalishni o‘zim tanlayman" }).click();
      check(true, "after identity the patient describes the concern and confirms or picks the direction");
      await page.getByRole("button", { name: /Kerakli xizmatni bilaman/ }).click();
      await page.getByRole("button", { name: new RegExp(DEMO_NAMES.generalService.replace(/[()]/g, "\\$&")) }).click();
      const slotsResponse = page.waitForResponse((r) => r.url().includes("/api/availability"));
      await page.getByRole("button", { name: new RegExp(DEMO_NAMES.referrer) }).click();
      const shown = (await (await slotsResponse).json()).data.slots;
      const target = shown.find((s) => new Date(s.start).getTime() > Date.now() + 3 * 3_600_000) ?? shown[shown.length - 1];
      await page.getByTestId("slot-day").waitFor();
      check((await page.getByTestId("slot-day").count()) === 1, "times are shown one day at a time");
      await pickSlot(page, shown, target);
      await page.getByRole("button", { name: /^Davom etish: / }).click();
      await page.getByRole("button", { name: "Tasdiqlash va yozilish" }).waitFor();
      check((await page.locator("#patient-name").count()) === 0, "no name/phone form: the proven card's details are used");
      const created = page.waitForResponse((r) => r.url().includes("/api/bookings") && r.request().method() === "POST");
      await page.getByRole("button", { name: "Tasdiqlash va yozilish" }).click();
      const res = await created;
      check(res.status() === 201, `the booking is created (${res.status()})`);
      const [appt] = await db`select patient_id, notes from public.appointments where id = ${(await res.json()).data.appointment.id}`;
      check(appt?.patient_id === desk.id, "the appointment is on the patient's own desk card");
      check(appt?.notes === concernText, "the concern travels with the booking as its note");
      await ctx.close();
    }

    // ---------- New patient ----------
    {
      await verified(tg.fresh, `97${String(n).padStart(7, "0")}`);
      const { ctx, page } = await open(tg.fresh, "fresh");
      await identify(page, newDoc, "02.03.2001");
      await page.getByLabel("F.I.Sh.").waitFor();
      check(await page.getByText(`+99897${String(n).padStart(7, "0")}`).isVisible(), "a new patient sees their Telegram-verified phone, not a typed one");
      await page.getByLabel("F.I.Sh.").fill(`Yangi Onlayn ${suffix}`);
      await page.getByRole("button", { name: "Saqlash va davom etish" }).click();
      await page.getByRole("button", { name: "Ha, davom etish" }).waitFor();
      const [row] = await db`select document_number, date_of_birth::text as dob, full_name from public.patients where clinic_id = ${clinic} and telegram_user_id = ${tg.fresh}`;
      check(row?.document_number === newDoc && row?.dob === "2001-03-02" && row?.full_name === `Yangi Onlayn ${suffix}`, "the new patient's own record holds their passport and date of birth");

      // Urgent wording ends the booking with the approved message; staff are alerted.
      await page.getByRole("button", { name: "Ha, davom etish" }).click();
      await page.getByLabel("Shikoyatingiz").fill("Nafas ololmayapman, ko‘kragim qattiq og‘riyapti");
      await page.getByRole("button", { name: "Davom etish" }).click();
      await page.getByText("Shoshilinch yordam").first().waitFor();
      check((await page.getByRole("button", { name: /Kerakli xizmatni bilaman/ }).count()) === 0, "urgent wording: no booking is offered");
      const [conv] = await db`select c.urgent_at, c.ai_enabled from public.conversations c join public.patients p on p.id = c.patient_id
                              where p.clinic_id = ${clinic} and p.telegram_user_id = ${tg.fresh}`;
      check(!!conv?.urgent_at && conv.ai_enabled === false, "urgent wording flags the patient's conversation for staff");
      await ctx.close();
    }

    // ---------- Not yet shared: asked to share, nothing shown ----------
    {
      const { ctx, page } = await open(tg.waiting, "waiting");
      await identify(page, deskDoc, "17.05.1984");
      await page.getByRole("button", { name: /Raqamni ulashish/ }).waitFor();
      check(!(await page.content()).includes(deskName), "before the phone is proven, nothing about the card is shown");
      await ctx.close();
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
  if (insertedIntegration) await db`delete from public.clinic_telegram_integrations where clinic_id = ${insertedIntegration}`.catch(() => {});
  await db.end({ timeout: 5 });
}
process.exit(code);

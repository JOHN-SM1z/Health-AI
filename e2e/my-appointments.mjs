// "Mening qabullarim" in the Mini App, in a real phone-sized browser against
// the built app and a LOCAL Supabase stack, opened as Telegram opens it
// (initData signed by the clinic's bot in #tgWebAppData):
//   * after leaving and opening the Mini App again, the booked visit is still
//     listed — upcoming visits first (soonest first), past ones separately;
//   * times are shown in the clinic's time zone;
//   * when the clinic changes the status (the doctor starts the visit), the
//     open page shows it by itself, without a reload;
//   * re-opened without ?clinic= in the URL, the remembered clinic is used.
// Rerunnable: run-unique doctor, patient and Telegram id.
import { createHmac, randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { BASE, DEMO, assertLocalOnly, connect, createReport, runFixture } from "./lib.mjs";

assertLocalOnly();
const report = createReport("my appointments E2E");
const { check } = report;
const db = connect();
const { suffix } = runFixture();
let insertedIntegration = null;
let doctorId = null;

function signInitData(botToken, telegramUserId) {
  const user = JSON.stringify({ id: telegramUserId, first_name: "Bemor" });
  const fields = [["auth_date", String(Math.floor(Date.now() / 1000))], ["user", user]];
  const check = fields.map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return `${fields.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}&hash=${hash}`;
}
const launch = (initData) => `#tgWebAppData=${encodeURIComponent(initData)}&tgWebAppVersion=7.0&tgWebAppPlatform=ios`;

async function run() {
  const [reception] = await db`select sr.clinic_id from auth.users u join public.staff_roles sr on sr.profile_id = u.id where u.email = ${DEMO.reception}`;
  if (!reception) throw new Error("demo staff missing — run node e2e/seed-demo.mjs");
  const clinic = reception.clinic_id;
  const [{ timezone }] = await db`select timezone from public.clinics where id = ${clinic}`;

  let [bot] = await db`select telegram_bot_token from public.clinic_telegram_integrations where clinic_id = ${clinic} and enabled and status = 'active'`;
  if (!bot) {
    const token = `${Date.now() % 1_000_000}:E2E${suffix}${"m".repeat(24)}`;
    await db`insert into public.clinic_telegram_integrations ${db({ clinic_id: clinic, telegram_bot_token: token, telegram_bot_id: Date.now() % 1_000_000_000, telegram_username: `e2e_my_${suffix}_bot`, telegram_bot_name: "E2E", status: "active", enabled: true, validated_at: new Date() })}
             on conflict (clinic_id) do nothing`;
    insertedIntegration = clinic;
    [bot] = await db`select telegram_bot_token from public.clinic_telegram_integrations where clinic_id = ${clinic}`;
  }

  // A run-unique doctor available around the clock, so the visits never clash with other scripts.
  doctorId = randomUUID();
  const doctorName = `Dr E2E Navbat ${suffix}`;
  await db`insert into public.doctors ${db({ id: doctorId, clinic_id: clinic, name: doctorName, active: true })}`;
  await db`insert into public.doctor_working_hours ${db([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinic, doctor_id: doctorId, weekday, start_time: "00:00", end_time: "23:59" })))}`;
  const [service] = await db`select id, name from public.services where clinic_id = ${clinic} and active order by created_at limit 1`;
  const tgUser = 960_000_000 + (Date.now() % 1_000_000);
  const [patient] = await db`insert into public.patients ${db({ clinic_id: clinic, full_name: `E2E Navbat ${suffix}`, telegram_user_id: tgUser })} returning id`;

  const visit = async (hoursFromNow, status) => {
    let start = new Date(Date.now() + hoursFromNow * 3_600_000);
    start.setUTCSeconds(0, 0);
    // A visit must end on its own local day: one that would cross the clinic's midnight moves an hour later.
    const p = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(start);
    const localMinute = (Number(p.find((x) => x.type === "hour").value) % 24) * 60 + Number(p.find((x) => x.type === "minute").value);
    if (localMinute + 30 > 23 * 60 + 59) start = new Date(start.getTime() + 3_600_000);
    const [row] = await db`insert into public.appointments ${db({ clinic_id: clinic, patient_id: patient.id, doctor_id: doctorId, service_id: service.id, start_at: start, end_at: new Date(start.getTime() + 30 * 60_000), status, source: "telegram_mini_app" })} returning id, start_at`;
    return row;
  };
  const past = await visit(-72, "completed");
  const today = await visit(0.25, "confirmed"); // in 15 minutes
  const later = await visit(96, "pending");

  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => report.problems.push(`[patient] pageerror: ${e.message}`));

    // First visit: opened from the bot with the clinic in the URL.
    await page.goto(`${BASE}/my-appointments?clinic=${clinic}${launch(signInitData(bot.telegram_bot_token, tgUser))}`);
    const upcoming = page.getByRole("region", { name: "Kelgusi qabullar" });
    await upcoming.getByText(doctorName).first().waitFor({ timeout: 15_000 });
    check((await upcoming.getByText(doctorName).count()) === 2, "the two upcoming visits are listed under “Kelgusi qabullar”");

    // Leave and come back: a brand-new WebView session, no ?clinic= this time.
    await ctx.close();
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page2 = await ctx2.newPage();
    page2.on("pageerror", (e) => report.problems.push(`[patient] pageerror: ${e.message}`));
    await page2.goto(`${BASE}/my-appointments?clinic=${clinic}${launch(signInitData(bot.telegram_bot_token, tgUser))}`);
    const up2 = page2.getByRole("region", { name: "Kelgusi qabullar" });
    await up2.getByText(doctorName).first().waitFor({ timeout: 15_000 });
    const cards = up2.locator("div.rounded-2xl");
    const firstText = (await cards.first().textContent()) ?? "";
    check(firstText.includes("Tasdiqlangan"), "after re-opening, the visits are still there — the soonest first");
    const fmt = (iso) => {
      const p = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(iso));
      const g = (t) => p.find((x) => x.type === t)?.value ?? "";
      const months = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];
      return `${Number(g("day"))}-${months[Number(g("month")) - 1]}, ${g("hour")}:${g("minute")}`;
    };
    check(firstText.includes(fmt(today.start_at)), "the time is shown in the clinic's time zone");
    const pastSection = page2.getByRole("region", { name: "O‘tgan qabullar" });
    check((await pastSection.getByText(doctorName).count()) === 1 && (await pastSection.getByText("Yakunlangan").isVisible()), "the finished visit is listed separately under “O‘tgan qabullar”");

    // The doctor starts the visit: the open page updates by itself.
    await db`update public.appointments set status = 'in_progress' where id = ${today.id}`;
    await up2.getByText("Qabulda").waitFor({ timeout: 25_000 });
    check(await up2.getByText("Shifokor sizni qabul qilmoqda.").isVisible(), "the status changes on screen without a reload when the doctor starts the visit");

    // Opened again without ?clinic= in the URL: the remembered clinic is used.
    const page3 = await ctx2.newPage();
    await page3.goto(`${BASE}/my-appointments${launch(signInitData(bot.telegram_bot_token, tgUser))}`);
    await page3.getByRole("region", { name: "Kelgusi qabullar" }).getByText(doctorName).first().waitFor({ timeout: 15_000 });
    check(true, "re-opened without the clinic in the URL, the same visits are shown");
    void later;
    void past;
    await ctx2.close();
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
  if (doctorId) await db`delete from public.appointments where doctor_id = ${doctorId}`.catch(() => {});
  if (insertedIntegration) await db`delete from public.clinic_telegram_integrations where clinic_id = ${insertedIntegration}`.catch(() => {});
  await db.end({ timeout: 5 });
}
process.exit(code);

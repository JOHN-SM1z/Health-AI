// Screenshots of the passport-first Mini App identity screens (for review, not a test). Local stack only.
import { createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { BASE, DEMO, assertLocalOnly, connect, runFixture } from "./lib.mjs";

assertLocalOnly();
const db = connect();
const { suffix } = runFixture();
const OUT = "test-results/screens";
mkdirSync(OUT, { recursive: true });

function signInitData(botToken, telegramUserId) {
  const user = JSON.stringify({ id: telegramUserId, first_name: "Bemor" });
  const fields = [["auth_date", String(Math.floor(Date.now() / 1000))], ["query_id", "AAHdF6IQAAAAAN0XohDhrOrc"], ["user", user]];
  const c = fields.map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  return `${fields.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}&hash=${createHmac("sha256", secret).update(c).digest("hex")}`;
}

const [reception] = await db`select sr.clinic_id from auth.users u join public.staff_roles sr on sr.profile_id = u.id where u.email = ${DEMO.reception}`;
const clinic = reception.clinic_id;
let [bot] = await db`select telegram_bot_token from public.clinic_telegram_integrations where clinic_id = ${clinic}`;
let inserted = false;
if (!bot) {
  const token = `${Date.now() % 1_000_000}:SCR${suffix}${"s".repeat(24)}`;
  await db`insert into public.clinic_telegram_integrations ${db({ clinic_id: clinic, telegram_bot_token: token, telegram_bot_id: Date.now() % 1_000_000_000, telegram_username: `scr_${suffix}_bot`, telegram_bot_name: "Screens", status: "active", enabled: true, validated_at: new Date() })}`;
  inserted = true;
  bot = { telegram_bot_token: token };
}
const n = Date.now() % 10_000_000;
const tg = 970_000_000 + (n % 1_000_000);
const doc = `S${String.fromCharCode(65 + (n % 26))}${String(n).padStart(7, "0")}`;
const key = `90${String(n).padStart(7, "0")}`;
await db`insert into public.patients ${db({ clinic_id: clinic, full_name: "Karimova Dilnoza Rustamovna", document_number: doc, date_of_birth: "1988-04-12", phone: `+998 ${key}`, home_address: "Toshkent, Chilonzor 9-kvartal, 14-uy" })}`;

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 390, height: 760 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
await page.goto(`${BASE}/book?clinic=${clinic}#tgWebAppData=${encodeURIComponent(signInitData(bot.telegram_bot_token, tg))}&tgWebAppVersion=7.0&tgWebAppPlatform=web`);
await page.getByRole("checkbox").check();
await page.getByRole("button", { name: "Davom etish" }).click();
await page.getByLabel("Pasport / ID karta yoki JSHSHIR").fill(doc);
await page.getByLabel("Tug‘ilgan sana").fill("12.04.1988");
await page.screenshot({ path: `${OUT}/1-passport.png` });
await page.getByRole("button", { name: "Davom etish" }).click();
await page.getByRole("button", { name: /Raqamni ulashish/ }).waitFor();
await page.screenshot({ path: `${OUT}/2-share-phone.png` });
await db`insert into public.telegram_verified_phones ${db({ clinic_id: clinic, telegram_user_id: tg, phone_key: key })}`;
await page.getByRole("button", { name: "Orqaga" }).click();
await page.getByRole("button", { name: "Davom etish" }).click();
await page.getByRole("button", { name: "Ha, davom etish" }).waitFor();
await page.screenshot({ path: `${OUT}/3-details-appear.png` });
await browser.close();
if (inserted) await db`delete from public.clinic_telegram_integrations where clinic_id = ${clinic}`;
await db.end({ timeout: 5 });
console.log(`screens in ${OUT}`);

/** Browser regression on fresh synthetic fixtures. Requires Playwright on NODE_PATH.
 * node scripts/pilot-browser.mjs /private/tmp/fixtures.json /private/tmp/screenshots
 * Start the isolated local app using pilot-local.mjs ... serve first.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const base = 'http://localhost:3105';
(async () => {
  const [fixtureFile, outputDir] = process.argv.slice(2);
  if (!fixtureFile || !outputDir) throw Error('Private fixture path and screenshot directory required');
  const f = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  let current;
  async function login(role) {
    const context = await browser.newContext();
    const page = await context.newPage(); current = page;
    page.setDefaultTimeout(20000);
    await page.goto(`${base}/login`);
    await page.locator('input[type=email]').fill(f.users[role].email);
    await page.locator('input[type=password]').fill(f.users[role].password);
    await page.getByRole('button', { name: 'Kirish', exact: true }).click();
    await page.waitForURL(role === 'doctor' ? '**/doctor' : '**/admin');
    await page.getByRole('heading', { name: role === 'doctor' ? 'Mening navbatim' : 'Registratsiya va jonli navbat', exact: true }).waitFor();
    await page.waitForLoadState('networkidle');
    return page;
  }
  try {
    const reception = await login('receptionist');
    await reception.getByRole('button', { name: 'Bemorni ro‘yxatdan o‘tkazish', exact: true }).click();
    await reception.getByRole('textbox', { name: 'Bemorni qidirish' }).fill('Synthetic Pilot');
    await reception.getByRole('button', { name: /Synthetic Pilot Patient/ }).click();
    await reception.getByLabel('Shifokor').selectOption(f.doctor.id);
    await reception.getByLabel('Xizmat').selectOption(f.service.id);
    await reception.getByRole('button', { name: 'Ro‘yxatdan o‘tkazish', exact: true }).click();
    await reception.getByRole('button', { name: 'Talonni chop etish' }).waitFor();
    await reception.getByRole('button', { name: 'Tayyor', exact: true }).click();
    console.log('PASS returning-patient registration and ticket');
    const denied = await reception.request.get(`${base}/api/doctor/laboratory`);
    if (denied.status() !== 403) throw Error('Reception clinical denial failed');
    console.log('PASS receptionist denied laboratory access');
    const cashier = await login('owner');
    await cashier.getByRole('link', { name: 'Xizmatlar kassasi', exact: true }).click();
    await cashier.getByLabel('Bemor raqami, ism yoki telefon').fill('Synthetic Pilot');
    await cashier.getByRole('button', { name: 'Qidirish', exact: true }).click();
    await cashier.getByRole('button', { name: /Synthetic Pilot Patient/ }).click();
    cashier.on('dialog', d => d.accept());
    await cashier.getByRole('button', { name: 'Pul qabul qilinganini tasdiqlash' }).click();
    await cashier.getByRole('button', { name: 'To‘liq qaytarishni qayd etish' }).waitFor();
    console.log('PASS verified manual cashier collection');
    const queue = await reception.request.get(`${base}/api/operations/visits`);
    const queueBody = await queue.json();
    if (!queueBody.data.visits.some(v => v.patient_id === f.patient.id && v.payments?.status === 'paid')) throw Error('Queue payment relationship failed');
    const doctor = await login('doctor');
    await doctor.getByRole('button', { name: 'Qabulni boshlash' }).click();
    await doctor.getByRole('button', { name: 'Yakunlash', exact: true }).waitFor();
    await doctor.getByRole('link', { name: 'Bemor tarixi', exact: true }).click();
    await doctor.getByLabel('Sarlavha', { exact: true }).fill('Synthetic pilot note');
    await doctor.getByLabel('Mazmun', { exact: true }).fill('Synthetic test record only.');
    await doctor.getByRole('button', { name: 'Qaydni saqlash' }).click();
    await doctor.getByRole('heading', { name: 'Synthetic pilot note', exact: true }).waitFor();
    console.log('PASS attributed clinician history');
    await doctor.getByRole('link', { name: 'Laboratoriya buyurtmasi', exact: true }).click();
    await doctor.getByLabel('Namuna turi', { exact: true }).fill('Synthetic sample');
    await doctor.getByLabel('Tekshiruvlar — har qatorda bittadan').fill('Synthetic test A\nSynthetic test B');
    await doctor.getByRole('button', { name: 'Buyurtmani saqlash' }).click();
    await doctor.getByRole('button', { name: 'Namuna olindi', exact: true }).click();
    await doctor.getByRole('button', { name: 'Qabul qilindi', exact: true }).click();
    await doctor.getByRole('button', { name: 'Tekshirilmoqda', exact: true }).click();
    await doctor.getByLabel('Natija', { exact: true }).first().fill('12.5');
    await doctor.getByLabel('Birlik', { exact: true }).first().fill('synthetic');
    await doctor.getByRole('button', { name: 'Qoralamani saqlash', exact: true }).first().click();
    await doctor.getByText('Oldingi versiyalar (1)', { exact: true }).waitFor();
    await doctor.screenshot({ path: path.join(outputDir, 'laboratory-desktop.png'), fullPage: true });
    await doctor.setViewportSize({ width: 390, height: 844 });
    await doctor.screenshot({ path: path.join(outputDir, 'laboratory-mobile.png'), fullPage: true });
    if (await doctor.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Mobile horizontal overflow');
    console.log('PASS laboratory order, specimen progression, draft result and mobile layout');
  } catch (e) {
    if (current) await current.screenshot({ path: path.join(outputDir, 'failure.png'), fullPage: true }).catch(() => {});
    throw e;
  } finally { await browser.close(); }
})().catch(e => { console.error(e.message); process.exit(1); });

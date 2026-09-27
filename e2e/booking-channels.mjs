// End-to-end: online and reception booking race for the same slot in the
// BUILT app, through the real screens — one booking engine decides.
//
//   Patient (phone, website / Mini App flow): picks a slot, fills details,
//     reaches the review step …
//   Reception (desktop): … meanwhile books that same time for a walk-in.
//   Patient confirms → "no longer available" → "choose another time"
//     reloads availability without the taken slot → books another → success.
//   Reception tries the patient's new time → refused inside the modal.
//   Database: every contested time holds exactly one active appointment.
//
// Needs the local stack, `node e2e/seed-demo.mjs`, and the app running
// (`npm run build && npm start`). Rerunnable.
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { BASE, DEMO, DEMO_NAMES, VIEWPORTS, assertLocalOnly, connect, createReport, signIn } from "./lib.mjs";

assertLocalOnly();
const SHOTS = process.env.E2E_ARTIFACTS_DIR ?? "test-results/e2e";
mkdirSync(SHOTS, { recursive: true });
const report = createReport("booking channels E2E");
const { check } = report;
const db = connect();
const suffix = Date.now().toString(36);
const UNAVAILABLE = "Bu vaqt endi bo‘sh emas. Iltimos, boshqa vaqtni tanlang.";

/** The slot's button: its day's grid (days render in slot order), then its time. */
function slotButton(page, slots, slot) {
  const days = [...new Set(slots.map((s) => s.dayLocal))];
  return page.locator("div.grid.grid-cols-3").nth(days.indexOf(slot.dayLocal)).getByRole("button", { name: slot.startLocal, exact: true });
}

async function run() {
  const [doctor] = await db`
    select d.id, d.clinic_id from public.doctors d join auth.users u on u.id = d.profile_id where u.email = ${DEMO.referrer}`;
  if (!doctor) throw new Error("demo doctors are not linked — run node e2e/seed-demo.mjs");
  const active = async (startIso) =>
    db`select id, source from public.appointments
        where doctor_id = ${doctor.id} and status not in ('cancelled', 'no_show')
          and tstzrange(start_at, end_at, '[)') && tstzrange(${startIso}::timestamptz, ${startIso}::timestamptz + interval '20 minutes', '[)')`;

  const browser = await chromium.launch();
  try {
    // ---------- Patient on the website (phone) ----------
    const patientContext = await browser.newContext({ viewport: VIEWPORTS.phone, isMobile: true, hasTouch: true });
    const patient = await patientContext.newPage();
    patient.on("pageerror", (e) => report.problems.push(`[patient] pageerror: ${e.message}`));
    patient.on("response", (r) => r.status() >= 500 && report.problems.push(`[patient] HTTP ${r.status()} ${r.url()}`));
    await patient.goto(`${BASE}/book?clinic=${doctor.clinic_id}`);
    await patient.getByRole("checkbox").check();
    await patient.getByRole("button", { name: "Davom etish" }).click();
    await patient.getByRole("button", { name: /Kerakli xizmatni bilaman/ }).click();
    await patient.getByRole("button", { name: new RegExp(DEMO_NAMES.generalService.replace(/[()]/g, "\\$&")) }).click();
    const firstSlots = patient.waitForResponse((r) => r.url().includes("/api/availability"));
    await patient.getByRole("button", { name: new RegExp(DEMO_NAMES.referrer) }).click();
    const shown = (await (await firstSlots).json()).data.slots;
    // A slot a few hours out, on today's list or the next day's.
    const target = shown.find((s) => new Date(s.start).getTime() > Date.now() + 2 * 3_600_000) ?? shown[shown.length - 1];
    check(!!target, `availability offers slots (${shown.length})`);
    await slotButton(patient, shown, target).click();
    await patient.getByRole("button", { name: /^Davom etish: / }).click();
    await patient.locator("#patient-name").fill(`Veb Bemor ${suffix}`);
    await patient.locator("#patient-phone").fill("+998901112233");
    await patient.getByRole("button", { name: "Davom etish" }).click();
    await patient.getByRole("button", { name: "Tasdiqlash va yozilish" }).waitFor();
    check(true, "patient reaches the review step for the chosen slot");

    // ---------- Meanwhile, reception books that same time (desktop) ----------
    // Reception is refused once on purpose (409): expected in the console.
    const { context: receptionContext, page: reception } = await signIn(browser, report, DEMO.reception, "desktop", { expectDenials: true });
    const openModal = async () => {
      await reception.getByRole("button", { name: "Tezkor yozish" }).click();
      await reception.getByLabel("Bemor ismi").waitFor();
    };
    const fillModal = async (name, slot) => {
      await reception.getByLabel("Bemor ismi").fill(name);
      await reception.getByLabel("Telefon").fill("+998907778899");
      await reception.getByLabel("Xizmat").selectOption({ label: DEMO_NAMES.generalService });
      await reception.getByLabel("Shifokor").selectOption({ label: DEMO_NAMES.referrer });
      await reception.locator("#qb-start").fill(`${slot.dayLocal}T${slot.startLocal}`);
    };
    await openModal();
    await fillModal(`Qabulxona Bemor ${suffix}`, target);
    await reception.getByRole("button", { name: "Yozish", exact: true }).click();
    await reception.getByLabel("Bemor ismi").waitFor({ state: "detached" });
    const afterReception = await active(target.start);
    check(afterReception.length === 1 && afterReception[0].source === "walk_in", "reception booked the time first (clinic wall-clock time, same engine)");

    // ---------- The patient confirms the now-taken slot ----------
    await patient.getByRole("button", { name: "Tasdiqlash va yozilish" }).click();
    await patient.getByText(UNAVAILABLE).waitFor();
    check(true, "patient is told the time is no longer available");
    await patient.screenshot({ path: `${SHOTS}/booking-slot-unavailable-phone.png`, fullPage: true });
    const refreshed = patient.waitForResponse((r) => r.url().includes("/api/availability"));
    await patient.getByRole("button", { name: "Boshqa vaqtni tanlash" }).click();
    const fresh = (await (await refreshed).json()).data.slots;
    check(!fresh.some((s) => s.start === target.start), "choosing again reloads availability — the taken slot is gone");
    check((await active(target.start)).length === 1, "the contested time still holds exactly one appointment");

    // ---------- A different time succeeds; a double tap books it once ----------
    const second = fresh.find((s) => s.dayLocal === target.dayLocal && s.start > target.start) ?? fresh.find((s) => s.start > target.start);
    await slotButton(patient, fresh, second).click();
    await patient.getByRole("button", { name: /^Davom etish: / }).click();
    await patient.getByRole("button", { name: "Davom etish" }).click();
    await patient.getByRole("button", { name: "Tasdiqlash va yozilish" }).dblclick();
    await patient.getByText("Qabul muvaffaqiyatli yaratildi!").waitFor();
    const booked = await active(second.start);
    check(booked.length === 1 && booked[0].source === "web", "the patient's second choice is booked once (double tap → one appointment)");

    // ---------- Reception tries the patient's time: refused inside the modal ----------
    await openModal();
    await fillModal(`Kech qolgan ${suffix}`, second);
    await reception.getByRole("button", { name: "Yozish", exact: true }).click();
    await reception.getByText(UNAVAILABLE).waitFor();
    check(await reception.getByLabel("Bemor ismi").isVisible(), "reception sees 'no longer available' in the open modal, to pick another time");
    await reception.screenshot({ path: `${SHOTS}/booking-reception-refused.png` });
    check((await active(second.start)).length === 1, "reception cannot override the booking engine");

    await receptionContext.close();
    await patientContext.close();
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

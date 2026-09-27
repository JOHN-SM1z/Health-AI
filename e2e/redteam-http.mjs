// HTTP-level red team against the BUILT app with REAL sessions (no mocks):
// every request carries the cookies a real login produced, so session
// resolution, the proxy and the route guards are all exercised as deployed;
// the database API (PostgREST) is attacked with the same accounts' own
// tokens. Each attempt must be refused AND leak nothing of the run's secret
// marker, which is written into every clinical text of the fixtures.
//
// Needs the local stack, `node e2e/seed-demo.mjs`, and the app running
// (`npm run build && npm start`). Rerunnable: every run uses its own fixtures.
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { BASE, DEMO, PASSWORD, assertLocalOnly, connect, createReport, runFixture } from "./lib.mjs";

assertLocalOnly();
const report = createReport("HTTP red team");
const { check } = report;
const db = connect();
const { suffix, nextSlot } = runFixture();
const SECRET = `HTTP-RT-${suffix}`;
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!ANON_KEY) {
  console.error("SUPABASE_ANON_KEY is required (the local stack's anon key, e.g. from .env).");
  process.exit(2);
}

async function session(browser, email) {
  const context = await browser.newContext();
  if (email) {
    const page = await context.newPage();
    await page.goto(`${BASE}/login`);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Parol").fill(PASSWORD);
    await page.getByRole("button", { name: "Kirish" }).click();
    await page.waitForURL(/\/(admin|doctor)/, { timeout: 15_000 });
    await page.close();
  }
  const api = async (method, path, body, headers = {}) => {
    const res = await context.request.fetch(`${BASE}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      data: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      failOnStatusCode: false,
    });
    return { status: res.status(), text: await res.text() };
  };
  return { context, api };
}

/** The account's own token against the database API, as a browser holding it could send. */
async function restAs(email) {
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`${email}: ${error.message}`);
  return client;
}

const noLeak = (r) => !r.text.includes(SECRET);
const expectStatus = (r, statuses, label) => check(statuses.includes(r.status) && noLeak(r), `${label} → ${r.status}${noLeak(r) ? "" : " (LEAK)"}`);

async function run() {
  const doctorOf = async (email) =>
    (await db`select d.id, d.profile_id, d.clinic_id from public.doctors d join auth.users u on u.id = d.profile_id where u.email = ${email}`)[0];
  const referrer = await doctorOf(DEMO.referrer);
  const receiver = await doctorOf(DEMO.receiver);
  if (!referrer || !receiver) throw new Error("demo doctors are not linked — run node e2e/seed-demo.mjs");
  const clinic = referrer.clinic_id;
  const offered = async (doctorId) =>
    (await db`select coalesce((select service_id from public.doctor_services where doctor_id = ${doctorId} limit 1),
                              (select id from public.services where clinic_id = ${clinic} and active limit 1)) as id`)[0].id;
  const service = await offered(referrer.id);
  const receiverService = await offered(receiver.id);

  const patient = async (name, clinicId = clinic) =>
    (await db`insert into public.patients (clinic_id, full_name) values (${clinicId}, ${`${name} ${SECRET}`}) returning id`)[0].id;
  const visit = async (p, doctorId, status = "completed", clinicId = clinic, svc = service) => {
    const slot = nextSlot();
    return (await db`insert into public.appointments ${db({
      clinic_id: clinicId, patient_id: p, doctor_id: doctorId, service_id: svc,
      start_at: slot.start, end_at: slot.end, status, source: "walk_in",
    })} returning id`)[0].id;
  };
  const record = async (p, doctorId, profileId, appointment, clinicId = clinic) =>
    (await db`insert into public.clinical_records ${db({
      clinic_id: clinicId, patient_id: p, author_doctor_id: doctorId, appointment_id: appointment,
      record_type: "diagnosis", summary: `${SECRET} diagnosis`, created_by: profileId,
    })} returning id`)[0].id;

  // Patient X: the referrer's, referred (pending) to the receiver. Patient Y: the referrer's only.
  const X = await patient("RT X");
  const xVisit = await visit(X, referrer.id);
  await record(X, referrer.id, referrer.profile_id, xVisit);
  const [{ id: referral }] = await db`
    insert into public.referrals (clinic_id, patient_id, referring_doctor_id, referred_to_doctor_id, originating_appointment_id, reason, created_by)
    values (${clinic}, ${X}, ${referrer.id}, ${receiver.id}, ${xVisit}, ${`${SECRET} reason`}, ${referrer.profile_id}) returning id`;
  const Y = await patient("RT Y");
  const yVisit = await visit(Y, referrer.id);
  await record(Y, referrer.id, referrer.profile_id, yVisit);

  // A second clinic with its own doctor, patient, record.
  const [{ id: clinicB }] = await db`insert into public.clinics (name, slug, timezone) values (${`RT Clinic B ${suffix}`}, ${`rt-http-b-${suffix}`}, 'Asia/Tashkent') returning id`;
  const [{ id: serviceB }] = await db`insert into public.services (clinic_id, name, duration_minutes, price, active) values (${clinicB}, 'RT B consult', 30, 100000, true) returning id`;
  const kUser = randomUUID();
  await db`insert into auth.users (id, email) values (${kUser}, ${`rt-k-${suffix}@test.local`})`;
  await db`insert into public.profiles (id, full_name) values (${kUser}, 'Dr K')`;
  await db`insert into public.staff_roles (clinic_id, profile_id, role) values (${clinicB}, ${kUser}, 'doctor')`;
  const [{ id: k }] = await db`insert into public.doctors (clinic_id, profile_id, name, active) values (${clinicB}, ${kUser}, 'Dr K RT', true) returning id`;
  await db`insert into public.doctor_working_hours ${db([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinicB, doctor_id: k, weekday, start_time: "00:00", end_time: "23:59" })))}`;
  const Z = await patient("RT Z", clinicB);
  const zVisit = await visit(Z, k, "completed", clinicB, serviceB);
  await record(Z, k, kUser, zVisit, clinicB);

  // A checked-in visit of the receiver's, for staff to try to start.
  const W = (await db`insert into public.patients (clinic_id, full_name) values (${clinic}, ${`RT W ${suffix}`}) returning id`)[0].id;
  const receiverBooked = await visit(W, receiver.id, "checked_in", clinic, receiverService);

  const browser = await chromium.launch();
  try {
    // 16. No authentication at all, and a forged session cookie.
    {
      const anon = await session(browser, null);
      for (const [m, p] of [
        ["GET", `/api/doctor/patients/${X}`],
        ["GET", "/api/doctor/patients"],
        ["GET", "/api/doctor/referrals?box=incoming"],
        ["GET", `/api/doctor/referrals/${referral}`],
        ["PATCH", `/api/doctor/referrals/${referral}`],
        ["POST", `/api/doctor/patients/${X}/records`],
        ["GET", `/api/admin/patients?id=${X}`],
        ["PATCH", `/api/admin/referrals/${referral}`],
      ]) expectStatus(await anon.api(m, p, m === "GET" ? undefined : { action: "accept" }), [401], `anonymous ${m} ${p.split("?")[0]}`);
      expectStatus(await anon.api("POST", "/api/referrals/expire"), [401], "anonymous cron job");
      expectStatus(await anon.api("POST", "/api/referrals/expire", undefined, { authorization: "Bearer change-me-in-production" }), [401], "cron job with the default secret");
      await anon.context.addCookies([{ name: "sb-127-auth-token", value: "forged", url: BASE }]);
      expectStatus(await anon.api("GET", `/api/doctor/patients/${X}`), [401], "forged session cookie");
      await anon.context.close();
    }

    // 1, 2, 3, 13, 14, 15, 20 — the receiving doctor (pending referral for X).
    {
      const b = await session(browser, DEMO.receiver);
      const ws = await b.api("GET", `/api/doctor/patients/${X}`);
      check(ws.status === 200 && !ws.text.includes(yVisit), "receiver opens the referred patient (pending: originating consultation only)");
      expectStatus(await b.api("GET", `/api/doctor/patients/${Y}`), [404], "another patient's ID");
      expectStatus(await b.api("GET", `/api/doctor/patients/${Z}`), [404], "another clinic's patient ID");
      expectStatus(await b.api("GET", `/api/doctor/patients/${Z}?clinicId=${clinicB}`, undefined, { "x-clinic-id": clinicB }), [404], "clinic override in query/header");
      expectStatus(
        await b.api("POST", `/api/doctor/patients/${X}/records`, { idempotencyKey: randomUUID(), appointmentId: xVisit, recordType: "diagnosis", summary: "into the referrer's visit" }),
        [404],
        "write into another doctor's consultation",
      );
      expectStatus(
        await b.api("POST", `/api/doctor/patients/${Y}/records`, { idempotencyKey: randomUUID(), appointmentId: yVisit, recordType: "diagnosis", summary: "x" }),
        [404],
        "write into an unrelated patient",
      );
      expectStatus(await b.api("POST", `/api/doctor/patients/${X}/consultations`, { serviceId: receiverService }), [409], "start before accepting (client state ignored)");
      expectStatus(
        await b.api("POST", "/api/doctor/referrals", { idempotencyKey: randomUUID(), appointmentId: zVisit, referredToDoctorId: k, reason: "Cross-clinic referral attempt", priority: "routine", clinicId: clinicB }),
        [404],
        "refer from another clinic's consultation",
      );
      expectStatus(await b.api("PATCH", `/api/doctor/appointments/${yVisit}`, { status: "in_progress" }), [404], "another doctor's appointment in the queue route");
      expectStatus(await b.api("GET", "/api/doctor/patients/not-a-uuid"), [404], "malformed patient id");
      const list = await b.api("GET", "/api/doctor/patients");
      check(list.status === 200 && list.text.includes(X) && !list.text.includes(Y) && !list.text.includes(Z), "patient list: referred patient in, unrelated and other-clinic out");
      // 8. A server-action request to a page: nothing is executed or returned.
      const action = await b.api("POST", `/doctor/patients/${X}`, "[]", { "next-action": "0123456789abcdef0123456789abcdef01234567", "content-type": "text/plain;charset=UTF-8" });
      check(noLeak(action) && !action.text.includes(xVisit), `server-action request to a page → ${action.status}, no data`);
      await b.context.close();
    }

    // 17. Receptionist; 18. Manager — no doctor endpoint, no clinical text.
    for (const [email, label] of [[DEMO.reception, "receptionist"], [DEMO.manager, "manager"]]) {
      const s = await session(browser, email);
      expectStatus(await s.api("GET", `/api/doctor/patients/${X}`), [403], `${label}: doctor workspace`);
      expectStatus(await s.api("GET", "/api/doctor/referrals?box=incoming"), [403], `${label}: doctor referral list`);
      expectStatus(await s.api("PATCH", `/api/doctor/referrals/${referral}`, { action: "accept" }), [403], `${label}: accept a referral`);
      expectStatus(await s.api("PATCH", `/api/doctor/appointments/${receiverBooked}`, { status: "in_progress" }), [403], `${label}: doctor queue route`);
      const panel = await s.api("GET", `/api/admin/patients?id=${X}`);
      check(panel.status === 200 && !panel.text.includes(`${SECRET} reason`) && !panel.text.includes(`${SECRET} diagnosis`), `${label}: patient panel has no clinical text`);
      await s.context.close();
    }
    check((await db`select status from public.appointments where id = ${receiverBooked}`)[0].status === "checked_in", "queue-route attempts changed nothing");

    // 21. The database API with each account's own token: clinical text is unreadable, and
    //     appointments, patients and payments cannot be written around the server.
    {
      const reception = await restAs(DEMO.reception);
      const manager = await restAs(DEMO.manager);
      const doctor = await restAs(DEMO.receiver);
      for (const [client, label] of [[reception, "receptionist"], [manager, "manager"], [doctor, "doctor"]]) {
        const records = await client.from("clinical_records").select("summary").eq("patient_id", X);
        check(records.error !== null || (records.data ?? []).length === 0, `${label}: clinical_records unreadable over REST`);
        const referrals = await client.from("referrals").select("reason").eq("id", referral);
        check(referrals.error !== null || (referrals.data ?? []).length === 0, `${label}: referral text unreadable over REST`);
      }
      const paid = await manager.from("payments").insert({ clinic_id: clinic, appointment_id: receiverBooked, patient_id: W, amount: 1000, status: "paid", provider: "manual" });
      check(paid.error !== null, `manager: inserting a payment marked paid over REST → refused (${paid.error?.code ?? "no error"})`);
      const moved = await reception.from("appointments").update({ status: "in_progress" }).eq("id", receiverBooked).select("id");
      check(moved.error !== null && (moved.data ?? []).length === 0, `receptionist: starting a visit over REST → refused (${moved.error?.code ?? "no error"})`);
      const slot = nextSlot();
      const booked = await reception.from("appointments").insert({
        clinic_id: clinic, patient_id: W, doctor_id: receiver.id, service_id: receiverService,
        start_at: slot.start.toISOString(), end_at: slot.end.toISOString(), status: "confirmed", source: "admin",
      });
      check(booked.error !== null, `receptionist: booking around the booking engine over REST → refused (${booked.error?.code ?? "no error"})`);
      const renamed = await reception.from("patients").update({ full_name: "Renamed" }).eq("id", W).select("id");
      check(renamed.error !== null && (renamed.data ?? []).length === 0, `receptionist: editing a patient over REST → refused (${renamed.error?.code ?? "no error"})`);
      // Patient communication is the server's: no forged operator reply, no redirected reminder.
      const [conversation] = await db`insert into public.conversations (clinic_id, patient_id, channel) values (${clinic}, ${W}, 'telegram') returning id`;
      const forged = await reception.from("messages").insert({ clinic_id: clinic, conversation_id: conversation.id, role: "admin", type: "text", content: "Forged reply" });
      check(forged.error !== null, `receptionist: forging an operator reply over REST → refused (${forged.error?.code ?? "no error"})`);
      const takeover = await reception.from("conversations").update({ status: "assigned" }).eq("id", conversation.id).select("id");
      check(takeover.error !== null && (takeover.data ?? []).length === 0, `receptionist: taking over a conversation over REST → refused (${takeover.error?.code ?? "no error"})`);
      const redirected = await manager.from("notification_jobs").update({ patient_telegram_user_id: 424242 }).eq("clinic_id", clinic).select("id");
      check(redirected.error !== null && (redirected.data ?? []).length === 0, `manager: redirecting reminders to another Telegram user over REST → refused (${redirected.error?.code ?? "no error"})`);
      const [{ messages }] = await db`select count(*)::int as messages from public.messages where conversation_id = ${conversation.id}`;
      check(messages === 0, "no forged message was stored");
      for (const [fn, args] of [
        ["start_consultation", { p_clinic_id: clinic, p_appointment_id: receiverBooked, p_from_status: "checked_in", p_actor: receiver.profile_id, p_via: "doctor_queue" }],
        ["consume_rate_limit", { p_key: `doctor-patient-record:${receiver.profile_id}`, p_limit: 1, p_window_seconds: 60 }],
        ["expire_due_referrals", { p_clinic_id: clinic }],
      ]) {
        const r = await doctor.rpc(fn, args);
        check(r.error !== null, `doctor: server-only function ${fn} over REST → refused (${r.error?.code ?? "no error"})`);
      }
      const [after] = await db`
        select (select status from public.appointments where id = ${receiverBooked}) as status,
               (select count(*)::int from public.payments where appointment_id = ${receiverBooked}) as payments,
               (select full_name from public.patients where id = ${W}) as name,
               (select count(*)::int from public.appointments where patient_id = ${W}) as visits`;
      check(after.status === "checked_in" && after.payments === 0 && after.name === `RT W ${suffix}` && after.visits === 1, "the REST attempts changed nothing");
      await Promise.all([reception, manager, doctor].map((c) => c.auth.signOut()));
    }

    // 5. Revocation by the referring doctor ends the receiver's access on the next request.
    {
      const a = await session(browser, DEMO.referrer);
      expectStatus(await a.api("PATCH", `/api/doctor/referrals/${referral}`, { action: "revoke", reason: "Red team" }), [200], "referring doctor revokes");
      await a.context.close();
      const b = await session(browser, DEMO.receiver);
      const after = await b.api("GET", `/api/doctor/patients/${X}`);
      check(after.status === 410 && after.text.includes("referral_revoked") && !after.text.includes(`RT X ${SECRET}`), "revoked: receiver gets 410 with the reason, no patient data");
      expectStatus(await b.api("PATCH", `/api/doctor/referrals/${referral}`, { action: "accept" }), [410], "revoked: accepting is refused");
      await b.context.close();
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
  await db.end({ timeout: 5 });
}
process.exit(code);

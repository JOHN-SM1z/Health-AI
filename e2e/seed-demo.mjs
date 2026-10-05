// Demo clinic and staff for the end-to-end scripts — LOCAL STACK ONLY (refuses
// any other host). Idempotent: run it after `npm run db:reset-local` or again
// at any time. It has a clinic of its own, so the vitest suites' fixtures in
// the seed clinic (supabase/seed.sql) are never touched.
//
//   dr.aliyev@e2e.local     doctor "Aliyev Jasur" (Terapevt) — refers
//   dr.nazarova@e2e.local   doctor "Nazarova Malika" (Kardiolog) — receives
//   reception@e2e.local     receptionist
//   manager@e2e.local       manager
//   owner@e2e.local         owner (manages staff)
//   lab@e2e.local           lab staff (sample processing)
//
// All with the password in e2e/lib.mjs. Both doctors work 00:00–23:59 every
// day, and the clinic's timezone is one where it is daytime when the seed
// runs, so a consultation can start "now" whenever the scripts run.
import { createClient } from "@supabase/supabase-js";
import { DEMO, DEMO_NAMES, PASSWORD, assertLocalOnly, connect, daytimeTimezone } from "./lib.mjs";

assertLocalOnly();
const CLINIC = "e2e00000-0000-4000-8000-000000000001";
const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (the local stack's values, e.g. from .env).");
  process.exit(2);
}

const auth = createClient(url, serviceKey, { auth: { persistSession: false } }).auth.admin;
const db = connect();

async function staff(email, fullName, role) {
  let [user] = await db`select id from auth.users where email = ${email}`;
  if (!user) {
    const { data, error } = await auth.createUser({ email, password: PASSWORD, email_confirm: true });
    if (error) throw new Error(`${email}: ${error.message}`);
    user = { id: data.user.id };
  }
  await db`insert into public.profiles (id, full_name) values (${user.id}, ${fullName}) on conflict (id) do nothing`;
  await db`insert into public.staff_roles (clinic_id, profile_id, role) values (${CLINIC}, ${user.id}, ${role}) on conflict do nothing`;
  return user.id;
}

async function service(name, minutes, price) {
  const [row] = await db`select id from public.services where clinic_id = ${CLINIC} and name = ${name}`;
  if (row) return row.id;
  return (await db`insert into public.services (clinic_id, name, duration_minutes, price, active) values (${CLINIC}, ${name}, ${minutes}, ${price}, true) returning id`)[0].id;
}

async function doctor(email, name, title) {
  const profileId = await staff(email, name, "doctor");
  let [card] = await db`select id from public.doctors where clinic_id = ${CLINIC} and name = ${name}`;
  if (!card) [card] = await db`insert into public.doctors (clinic_id, name, title, active) values (${CLINIC}, ${name}, ${title}, true) returning id`;
  await db`update public.doctors set profile_id = ${profileId}, active = true where id = ${card.id} and profile_id is distinct from ${profileId}`;
  await db`delete from public.doctor_working_hours where doctor_id = ${card.id}`;
  await db`insert into public.doctor_working_hours ${db(
    [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: CLINIC, doctor_id: card.id, weekday, start_time: "00:00", end_time: "23:59" })),
  )}`;
}

try {
  // A zone where it is daytime now, so the scripts' "start a consultation
  // now" never runs past the clinic's local midnight (see lib.mjs).
  const timezone = daytimeTimezone();
  await db`insert into public.clinics (id, name, slug, timezone, currency) values (${CLINIC}, 'E2E demo klinikasi', 'e2e-demo', ${timezone}, 'UZS')
           on conflict (id) do update set timezone = excluded.timezone`;
  await service(DEMO_NAMES.generalService, 20, 150000);
  await service(DEMO_NAMES.cardiologyService, 30, 250000);
  await doctor(DEMO.referrer, DEMO_NAMES.referrer, "Terapevt");
  await doctor(DEMO.receiver, DEMO_NAMES.receiver, "Kardiolog");
  await staff(DEMO.reception, "Qabulxona", "receptionist");
  await staff(DEMO.manager, "Menejer", "manager");
  await staff(DEMO.owner, "Klinika Egasi", "owner");
  await staff(DEMO.lab, "Laborant", "lab");
  console.log("E2E demo clinic and staff ready");
} finally {
  await db.end({ timeout: 5 });
}

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";

/**
 * The booking engine at the DATABASE layer
 * (supabase/migrations/20260930000005_unified_booking_engine.sql).
 *
 * Invariant under test: for any clinic, doctor and conflicting time interval
 * the database holds at most ONE active appointment — whichever channel wrote
 * it and however many requests race. Calls go through PostgREST with the
 * server's service-role key (as the app does), so every call in a
 * Promise.all is its own connection and transaction; the database, not the
 * test, decides the winner.
 */

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const describeDb = describe.skipIf(!localDbAvailable());

type Booked = { appointment_id: string | null; amount: number | null; error_code: string | null; replayed: boolean };
type Moved = { error_code: string | null };

async function pgError(run: () => Promise<unknown>): Promise<postgres.PostgresError> {
  try {
    await run();
  } catch (e) {
    if (e instanceof postgres.PostgresError) return e;
    throw e;
  }
  throw new Error("expected the database to reject the statement");
}

describeDb("booking engine — one authoritative booking, at most one active appointment per clinic/doctor/interval", () => {
  let admin: SupabaseClient;
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const clinicBerlin = randomUUID();
  const doctorA = randomUUID();
  const doctorA2 = randomUUID();
  const doctorB = randomUUID();
  const doctorNight = randomUUID();
  const doctorBerlin = randomUUID();
  const service30 = randomUUID();
  const service60 = randomUUID();
  const service20 = randomUUID();
  const serviceB = randomUUID();
  const serviceBerlin = randomUUID();
  const patientsA: string[] = Array.from({ length: 12 }, () => randomUUID());
  const patientB = randomUUID();
  const patientBerlin = randomUUID();

  // Each test gets its own day, far enough ahead, at 10:00 Tashkent (05:00Z).
  let dayOffset = 30 + Math.floor(Math.random() * 3000);
  function freshDay(): Date {
    const d = new Date(Date.now() + dayOffset++ * 86_400_000);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
  const at = (day: Date, hhmmUtc: string) => new Date(`${day.toISOString().slice(0, 10)}T${hhmmUtc}:00Z`).toISOString();

  async function book(opts: {
    clinic?: string;
    patient?: string;
    doctor?: string;
    service?: string;
    start: string;
    source?: string;
    key?: string;
  }): Promise<Booked> {
    return await admin
      .rpc("book_appointment", {
        p_clinic_id: opts.clinic ?? clinicA,
        p_patient_id: opts.patient ?? patientsA[0],
        p_doctor_id: opts.doctor ?? doctorA,
        p_service_id: opts.service ?? service30,
        p_start_at: opts.start,
        p_status: "pending",
        p_source: opts.source ?? "telegram_mini_app",
        p_idempotency_key: opts.key,
      })
      .then(({ data, error }) => {
        if (error) throw new Error(`book_appointment: ${error.code} ${error.message}`);
        return data as Booked;
      });
  }
  async function reschedule(appointmentId: string, start: string, clinic = clinicA): Promise<Moved> {
    return await admin
      .rpc("reschedule_appointment", { p_clinic_id: clinic, p_appointment_id: appointmentId, p_new_start_at: start })
      .then(({ data, error }) => {
        if (error) throw new Error(`reschedule_appointment: ${error.code} ${error.message}`);
        return data as Moved;
      });
  }
  /** Active appointments of a doctor overlapping [from, to). */
  async function activeOverlapping(doctor: string, from: string, to: string, clinic = clinicA) {
    const rows = await sql<{ id: string }[]>`
      select id from public.appointments
       where clinic_id = ${clinic} and doctor_id = ${doctor}
         and status not in ('cancelled', 'no_show')
         and tstzrange(start_at, end_at, '[)') && tstzrange(${from}::timestamptz, ${to}::timestamptz, '[)')`;
    return rows.map((r) => r.id);
  }
  const plus = (iso: string, minutes: number) => new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    sql = postgres(DB_URL, { max: 4, onnotice: () => {} });
    await sql`insert into public.clinics ${sql([
      { id: clinicA, name: `Engine A ${suffix}`, slug: `engine-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Engine B ${suffix}`, slug: `engine-b-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicBerlin, name: `Engine Berlin ${suffix}`, slug: `engine-berlin-${suffix}`, timezone: "Europe/Berlin" },
    ])}`;
    await sql`insert into public.doctors ${sql([
      { id: doctorA, clinic_id: clinicA, name: `Dr A ${suffix}`, active: true },
      { id: doctorA2, clinic_id: clinicA, name: `Dr A2 ${suffix}`, active: true },
      { id: doctorB, clinic_id: clinicB, name: `Dr B ${suffix}`, active: true },
      { id: doctorNight, clinic_id: clinicA, name: `Dr Night ${suffix}`, active: true },
      { id: doctorBerlin, clinic_id: clinicBerlin, name: `Dr Berlin ${suffix}`, active: true },
    ])}`;
    await sql`insert into public.services ${sql([
      { id: service30, clinic_id: clinicA, name: `30 min ${suffix}`, duration_minutes: 30, price: 100000 },
      { id: service60, clinic_id: clinicA, name: `60 min ${suffix}`, duration_minutes: 60, price: 180000 },
      { id: service20, clinic_id: clinicA, name: `20 min ${suffix}`, duration_minutes: 20, price: 80000 },
      { id: serviceB, clinic_id: clinicB, name: `B 30 min ${suffix}`, duration_minutes: 30, price: 90000 },
      { id: serviceBerlin, clinic_id: clinicBerlin, name: `Berlin 30 min ${suffix}`, duration_minutes: 30, price: 50 },
    ])}`;
    const patientRows: Array<{ id: string; clinic_id: string; full_name: string }> = [
      ...patientsA.map((id, i) => ({ id, clinic_id: clinicA, full_name: `Engine patient ${i} ${suffix}` })),
      { id: patientB, clinic_id: clinicB, full_name: `Engine patient B ${suffix}` },
      { id: patientBerlin, clinic_id: clinicBerlin, full_name: `Engine patient Berlin ${suffix}` },
    ];
    await sql`insert into public.patients ${sql(patientRows)}`;
    const week = [1, 2, 3, 4, 5, 6, 7];
    await sql`insert into public.doctor_working_hours ${sql([
      ...[doctorA, doctorA2].flatMap((d) => week.map((weekday) => ({ clinic_id: clinicA, doctor_id: d, weekday, start_time: "08:00", end_time: "20:00" }))),
      ...week.map((weekday) => ({ clinic_id: clinicB, doctor_id: doctorB, weekday, start_time: "08:00", end_time: "20:00" })),
      // Works until midnight (24:00) — for the day-boundary cases.
      ...week.map((weekday) => ({ clinic_id: clinicA, doctor_id: doctorNight, weekday, start_time: "18:00", end_time: "24:00" })),
      ...week.map((weekday) => ({ clinic_id: clinicBerlin, doctor_id: doctorBerlin, weekday, start_time: "09:00", end_time: "17:00" })),
    ])}`;
  });

  afterAll(async () => {
    if (!sql) return;
    const clinics = [clinicA, clinicB, clinicBerlin];
    await sql`delete from public.appointments where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.doctor_time_blocks where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.doctor_working_hours where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.patients where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.doctors where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.services where clinic_id in ${sql(clinics)}`;
    await sql.end({ timeout: 5 });
  });

  // ---------- The guarantee itself ----------

  it("the invariant is a database constraint on (clinic, doctor, [start, end)) over active statuses", async () => {
    const [c] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'public.appointments'::regclass and conname = 'no_overlapping_active_appointments'`;
    expect(c.def).toBe(
      "EXCLUDE USING gist (clinic_id WITH =, doctor_id WITH =, tstzrange(start_at, end_at, '[)'::text) WITH &&) WHERE ((status <> ALL (ARRAY['cancelled'::appointment_status, 'no_show'::appointment_status])))",
    );
  });

  it("the constraint decides even when two writers cannot see each other: the second waits and is refused (23P01)", async () => {
    const day = freshDay();
    const start = at(day, "05:00");
    const row = (patient: string) => ({
      clinic_id: clinicA, patient_id: patient, doctor_id: doctorA, service_id: service30,
      start_at: start, end_at: plus(start, 30), status: "pending", source: "admin",
    });
    const first = await sql.reserve();
    const second = await sql.reserve();
    try {
      await first`begin`;
      await first`insert into public.appointments ${first(row(patientsA[0]))}`; // uncommitted: invisible to the other
      await second`begin`;
      const racing = second`insert into public.appointments ${second(row(patientsA[1]))}`.then(
        () => null,
        (e: unknown) => e as postgres.PostgresError,
      );
      await new Promise((r) => setTimeout(r, 300));
      await first`commit`;
      const refusal = await racing;
      expect(refusal?.code).toBe("23P01");
      await second`rollback`;
    } finally {
      first.release();
      second.release();
    }
    expect(await activeOverlapping(doctorA, start, plus(start, 30))).toHaveLength(1);
  });

  // ---------- Basic booking ----------

  it("books online and at reception through the same operation: end and price from the service, never the caller", async () => {
    const day = freshDay();
    const online = await book({ start: at(day, "05:00"), source: "telegram_mini_app" });
    const offline = await book({ start: at(day, "06:00"), source: "admin", patient: patientsA[1] });
    for (const r of [online, offline]) expect(r).toMatchObject({ error_code: null, replayed: false, amount: 100000 });
    const rows = await sql<{ end_at: Date; source: string }[]>`
      select end_at, source from public.appointments where id in ${sql([online.appointment_id!, offline.appointment_id!])} order by start_at`;
    expect(rows.map((r) => [r.end_at.toISOString(), r.source])).toEqual([
      [plus(at(day, "05:00"), 30), "telegram_mini_app"],
      [plus(at(day, "06:00"), 30), "admin"],
    ]);
  });

  it("refuses an unknown or other clinic's doctor, patient or service, a past time, outside hours and a time block", async () => {
    const day = freshDay();
    const start = at(day, "05:00");
    expect((await book({ start, doctor: doctorB })).error_code).toBe("doctor_not_found");
    expect((await book({ start, doctor: randomUUID() })).error_code).toBe("doctor_not_found");
    expect((await book({ start, patient: patientB })).error_code).toBe("patient_not_found");
    expect((await book({ start, service: serviceB })).error_code).toBe("service_not_found");
    expect((await book({ start: new Date(Date.now() - 3_600_000).toISOString() })).error_code).toBe("past_slot");
    expect((await book({ start: at(day, "02:00") })).error_code).toBe("outside_working_hours"); // 07:00 local
    expect((await book({ start: at(day, "14:45") })).error_code).toBe("outside_working_hours"); // 19:45–20:15 local
    await sql`insert into public.doctor_time_blocks ${sql({ clinic_id: clinicA, doctor_id: doctorA, starts_at: at(day, "07:00"), ends_at: at(day, "08:00"), reason: "break" })}`;
    expect((await book({ start: at(day, "07:15") })).error_code).toBe("time_blocked");
    expect(await activeOverlapping(doctorA, at(day, "00:00"), at(day, "23:59"))).toEqual([]);
  });

  // ---------- Double booking and concurrency ----------

  for (const n of [2, 5, 10]) {
    it(`${n} simultaneous bookings of the same doctor and slot (online and reception mixed): exactly 1 succeeds, ${n - 1} get slot_taken`, async () => {
      const start = at(freshDay(), "05:00");
      const results = await Promise.all(
        Array.from({ length: n }, (_, i) => book({ start, patient: patientsA[i], source: i % 2 === 0 ? "telegram_mini_app" : "admin" })),
      );
      const won = results.filter((r) => r.error_code === null);
      expect(won).toHaveLength(1);
      expect(results.filter((r) => r.error_code === "slot_taken")).toHaveLength(n - 1);
      expect(results.every((r) => r.error_code === null || r.error_code === "slot_taken")).toBe(true);
      expect(await activeOverlapping(doctorA, start, plus(start, 30))).toEqual([won[0].appointment_id]);
    });
  }

  it("sequential double booking is refused whatever the channel order (online↔reception)", async () => {
    for (const [first, second] of [
      ["telegram_mini_app", "telegram_mini_app"],
      ["admin", "walk_in"],
      ["telegram_chat", "admin"],
      ["walk_in", "web"],
    ]) {
      const start = at(freshDay(), "05:00");
      expect((await book({ start, source: first, patient: patientsA[0] })).error_code).toBeNull();
      expect((await book({ start, source: second, patient: patientsA[1] })).error_code).toBe("slot_taken");
      expect(await activeOverlapping(doctorA, start, plus(start, 30))).toHaveLength(1);
    }
  });

  it("variable durations: overlapping intervals conflict, touching intervals do not", async () => {
    const day = freshDay();
    const t = (hhmm: string) => at(day, hhmm);
    expect((await book({ start: t("09:00") })).error_code).toBeNull(); // 14:00–14:30 local
    expect((await book({ start: t("09:15"), patient: patientsA[1] })).error_code).toBe("slot_taken"); // 14:15–14:45
    expect((await book({ start: t("08:45"), patient: patientsA[2] })).error_code).toBe("slot_taken"); // 13:45–14:15
    expect((await book({ start: t("08:30"), patient: patientsA[3], service: service60 })).error_code).toBe("slot_taken"); // 13:30–14:30
    expect((await book({ start: t("09:30"), patient: patientsA[4] })).error_code).toBeNull(); // 14:30–15:00 touches
    expect((await book({ start: t("08:30"), patient: patientsA[5] })).error_code).toBeNull(); // 13:30–14:00 touches
    // Another doctor of the same clinic is free at the same time.
    expect((await book({ start: t("09:00"), patient: patientsA[6], doctor: doctorA2 })).error_code).toBeNull();
    expect(await activeOverlapping(doctorA, t("08:30"), t("10:00"))).toHaveLength(3);
  });

  // ---------- Idempotency ----------

  it("the same idempotency key twice returns the first appointment — never a second one", async () => {
    const start = at(freshDay(), "05:00");
    const key = randomUUID();
    const first = await book({ start, key });
    const retry = await book({ start, key });
    expect(first).toMatchObject({ error_code: null, replayed: false });
    expect(retry).toMatchObject({ error_code: null, replayed: true, appointment_id: first.appointment_id, amount: 100000 });
    expect(await activeOverlapping(doctorA, start, plus(start, 30))).toEqual([first.appointment_id]);
  });

  it("five concurrent retries with one key (double click, network retry) create exactly one appointment", async () => {
    const start = at(freshDay(), "05:00");
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => book({ start, key })));
    const ids = new Set(results.map((r) => r.appointment_id));
    expect(results.every((r) => r.error_code === null)).toBe(true);
    expect(ids.size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.appointments where clinic_id = ${clinicA} and idempotency_key = ${key}`;
    expect(n).toBe(1);
  });

  it("a key reused for a different booking is refused; keys are per clinic", async () => {
    const day = freshDay();
    const key = randomUUID();
    expect((await book({ start: at(day, "05:00"), key })).error_code).toBeNull();
    const reused = await book({ start: at(day, "06:00"), key });
    expect(reused).toMatchObject({ error_code: "idempotency_key_reused", appointment_id: null, replayed: false });
    expect(await activeOverlapping(doctorA, at(day, "06:00"), at(day, "06:30"))).toEqual([]);
    // The same key in another clinic is another clinic's attempt.
    expect((await book({ clinic: clinicB, doctor: doctorB, service: serviceB, patient: patientB, start: at(day, "05:00"), key })).error_code).toBeNull();
  });

  // ---------- Cancellation ----------

  it("cancelling (or a no-show) releases the time: another patient can book it", async () => {
    for (const closing of ["cancelled", "no_show"]) {
      const start = at(freshDay(), "05:00");
      const first = await book({ start, patient: patientsA[0] });
      expect((await book({ start, patient: patientsA[1] })).error_code).toBe("slot_taken");
      await sql`update public.appointments set status = ${closing}, cancelled_at = now() where id = ${first.appointment_id!}`;
      const second = await book({ start, patient: patientsA[1] });
      expect(second.error_code).toBeNull();
      expect(await activeOverlapping(doctorA, start, plus(start, 30))).toEqual([second.appointment_id]);
      // The released appointment cannot come back over the new one.
      const back = await pgError(() => sql`update public.appointments set status = 'pending' where id = ${first.appointment_id!}`);
      expect(back.code).toBe("23P01");
    }
  });

  // ---------- Rescheduling ----------

  it("reschedules into a free time, refuses an occupied one, and never conflicts with itself", async () => {
    const day = freshDay();
    const a = await book({ start: at(day, "05:00"), patient: patientsA[0] });
    const b = await book({ start: at(day, "07:00"), patient: patientsA[1] });
    expect((await reschedule(a.appointment_id!, at(day, "07:15"))).error_code).toBe("slot_taken");
    // Moving by 15 minutes overlaps only its own old time.
    expect((await reschedule(a.appointment_id!, at(day, "05:15"))).error_code).toBeNull();
    expect((await reschedule(a.appointment_id!, at(day, "06:00"))).error_code).toBeNull();
    const [moved] = await sql<{ start_at: Date; end_at: Date; status: string }[]>`select start_at, end_at, status from public.appointments where id = ${a.appointment_id!}`;
    expect([moved.start_at.toISOString(), moved.end_at.toISOString(), moved.status]).toEqual([at(day, "06:00"), plus(at(day, "06:00"), 30), "pending"]);
    expect(b.error_code).toBeNull();
    // The freed time is bookable again.
    expect((await book({ start: at(day, "05:00"), patient: patientsA[2] })).error_code).toBeNull();
  });

  it("two concurrent reschedules into the same free time: exactly one lands", async () => {
    const day = freshDay();
    const a = await book({ start: at(day, "05:00"), patient: patientsA[0] });
    const b = await book({ start: at(day, "06:00"), patient: patientsA[1] });
    const results = await Promise.all([reschedule(a.appointment_id!, at(day, "08:00")), reschedule(b.appointment_id!, at(day, "08:00"))]);
    expect(results.filter((r) => r.error_code === null)).toHaveLength(1);
    expect(results.filter((r) => r.error_code === "slot_taken")).toHaveLength(1);
    expect(await activeOverlapping(doctorA, at(day, "08:00"), at(day, "08:30"))).toHaveLength(1);
  });

  it("a reschedule racing a new booking for the same time: exactly one wins", async () => {
    const day = freshDay();
    const a = await book({ start: at(day, "05:00"), patient: patientsA[0] });
    const [moved, fresh] = await Promise.all([
      reschedule(a.appointment_id!, at(day, "08:00")),
      book({ start: at(day, "08:00"), patient: patientsA[1], source: "admin" }),
    ]);
    expect([moved.error_code, fresh.error_code].filter((c) => c === null)).toHaveLength(1);
    expect(await activeOverlapping(doctorA, at(day, "08:00"), at(day, "08:30"))).toHaveLength(1);
  });

  it("a reschedule is clinic-scoped and refuses closed appointments", async () => {
    const day = freshDay();
    const a = await book({ start: at(day, "05:00") });
    expect((await reschedule(a.appointment_id!, at(day, "06:00"), clinicB)).error_code).toBe("appointment_not_found");
    await sql`update public.appointments set status = 'cancelled' where id = ${a.appointment_id!}`;
    expect((await reschedule(a.appointment_id!, at(day, "06:00"))).error_code).toBe("not_reschedulable");
  });

  // ---------- Multi-tenancy ----------

  it("the same time in two clinics is two appointments, not a conflict", async () => {
    const start = at(freshDay(), "05:00");
    expect((await book({ start })).error_code).toBeNull();
    expect((await book({ clinic: clinicB, doctor: doctorB, service: serviceB, patient: patientB, start })).error_code).toBeNull();
  });

  it("no row can pair a clinic with another clinic's doctor, patient or service — even written directly", async () => {
    const start = at(freshDay(), "05:00");
    const base = { clinic_id: clinicA, patient_id: patientsA[0], doctor_id: doctorA, service_id: service30, start_at: start, end_at: plus(start, 30), status: "pending", source: "admin" };
    for (const foreign of [{ doctor_id: doctorB }, { patient_id: patientB }, { service_id: serviceB }]) {
      const refusal = await pgError(() => sql`insert into public.appointments ${sql({ ...base, ...foreign })}`);
      expect(["23503", "P0001"]).toContain(refusal.code);
    }
    // With the trigger out of the way (as a migration could), the foreign keys still refuse it.
    await sql.begin(async (tx) => {
      await tx`alter table public.appointments disable trigger appointments_validate_slot`;
      const refusal = await pgError(() => tx`insert into public.appointments ${tx({ ...base, doctor_id: doctorB })}`);
      expect(refusal.code).toBe("23503");
      throw new Error("rollback");
    }).catch((e: Error) => {
      if (e.message !== "rollback") throw e;
    });
  });

  // ---------- Timezone and day boundaries ----------

  it("a slot running past the clinic's local midnight is refused; one ending exactly at midnight is not", async () => {
    const day = freshDay();
    // Dr Night works 18:00–24:00 Tashkent = 13:00–19:00Z.
    expect((await book({ doctor: doctorNight, service: service20, start: at(day, "18:40") })).error_code).toBeNull(); // 23:40–00:00
    expect((await book({ doctor: doctorNight, service: service30, patient: patientsA[1], start: at(day, "18:50") })).error_code).toBe(
      "outside_working_hours",
    ); // 23:50–00:20, into the next day
    // Directly written rows get the same rule.
    const refusal = await pgError(
      () => sql`insert into public.appointments ${sql({
        clinic_id: clinicA, patient_id: patientsA[2], doctor_id: doctorNight, service_id: service30,
        start_at: at(day, "18:50"), end_at: plus(at(day, "18:50"), 30), status: "pending", source: "admin",
      })}`,
    );
    expect(refusal.message).toMatch(/outside working hours/);
  });

  it("the working day is the clinic's local day: 20:30Z is already the next day in Tashkent", async () => {
    // 20:30Z = 01:30 local next day — before Dr Night's 18:00 start that day.
    const day = freshDay();
    expect((await book({ doctor: doctorNight, service: service30, start: at(day, "20:30") })).error_code).toBe("outside_working_hours");
    // 13:30Z = 18:30 local, same day: inside.
    expect((await book({ doctor: doctorNight, service: service30, start: at(day, "13:30") })).error_code).toBeNull();
  });

  it("applies the clinic's own timezone rules, DST included (Europe/Berlin, 25 October 2026)", async () => {
    // Before the change (CEST, UTC+2) 09:00 local = 07:00Z; after it (CET, UTC+1) 09:00 = 08:00Z.
    const base = { clinic: clinicBerlin, doctor: doctorBerlin, service: serviceBerlin, patient: patientBerlin };
    expect((await book({ ...base, start: "2026-10-24T07:00:00.000Z" })).error_code).toBeNull(); // Sat 09:00 CEST
    expect((await book({ ...base, start: "2026-10-25T07:00:00.000Z" })).error_code).toBe("outside_working_hours"); // Sun 08:00 CET
    expect((await book({ ...base, start: "2026-10-25T08:00:00.000Z" })).error_code).toBeNull(); // Sun 09:00 CET
  });
});

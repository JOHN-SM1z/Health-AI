import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import postgres from "postgres";
import { localDbAvailable } from "@/test/local-db";

/**
 * Online and offline booking through the REAL routes and the real database:
 *
 *   ONLINE   Mini App / bot deep link → POST /api/bookings ─┐
 *   OFFLINE  Reception dashboard → POST /api/admin/appointments ─┤→ createAppointment() → book_appointment() → constraint
 *
 * Mocked, and only these: the Telegram initData verification (a test
 * `tg:<patientId>` identity stands in for a signed initData — identity is not
 * under test here), the staff session (a real receptionist account of the
 * clinic), the per-IP in-memory rate limiter (it would throttle the
 * deliberate bursts) and the patient notifications. Everything else from the
 * route handler down is real.
 */

const session = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});
vi.mock("@/lib/patients/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/patients/identity")>();
  const { createAdminClient } = await import("@/lib/supabase/admin");
  return {
    ...actual,
    resolvePatientFromInitData: async (initData: string | null | undefined, clinicId: string) => {
      if (!initData?.startsWith("tg:")) return null;
      const { data } = await createAdminClient()
        .from("patients")
        .select("*")
        .eq("id", initData.slice(3))
        .eq("clinic_id", clinicId)
        .maybeSingle();
      return data ? { patient: data } : null;
    },
  };
});
vi.mock("@/lib/rate-limit", () => ({ rateLimit: () => ({ ok: true, retryAfterSeconds: 0 }), keyFromIp: () => "test" }));
// Patient notifications are not under test, and real jobs (due at once) would
// leak into the notification-processor suites that claim every due job.
vi.mock("@/lib/notifications/jobs", () => ({
  enqueueBookingNotifications: async () => {},
  enqueueCancellationNotification: async () => {},
  enqueueRescheduleNotification: async () => {},
}));

import { POST as onlineBook } from "./route";
import { POST as patientCancel } from "./[id]/cancel/route";
import { POST as receptionBook } from "@/app/api/admin/appointments/route";
import { PATCH as adminAppointment } from "@/app/api/admin/appointments/[id]/route";
import { GET as availability } from "@/app/api/availability/route";

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const describeDb = describe.skipIf(!localDbAvailable());

type Body = { ok: boolean; data?: Record<string, unknown>; error?: string; code?: string; details?: { reason?: string } };
type Res = { status: number; body: Body };

describeDb("online and offline booking share one engine — real routes, real database", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const doctorA = randomUUID();
  const doctorB = randomUUID();
  const serviceA = randomUUID();
  const serviceB = randomUUID();
  const receptionist = randomUUID();
  const receptionistB = randomUUID();
  const online: string[] = Array.from({ length: 8 }, () => randomUUID());
  const onlineB = randomUUID();
  let dayOffset = 40 + Math.floor(Math.random() * 2000);

  /** 10:00 Tashkent (05:00Z) on a day no other test uses. */
  function freshSlot(hhmmUtc = "05:00"): string {
    const d = new Date(Date.now() + dayOffset++ * 86_400_000);
    return `${d.toISOString().slice(0, 10)}T${hhmmUtc}:00.000Z`;
  }
  const read = async (res: Response): Promise<Res> => ({ status: res.status, body: (await res.json()) as Body });
  const json = (url: string, method: string, body: unknown) =>
    new NextRequest(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  function asReception(clinic = clinicA, profile = receptionist) {
    session.ctx = { profileId: profile, clinicId: clinic, clinicName: "Channels", clinicTimezone: "Asia/Tashkent", roles: ["receptionist"], platformAdmin: false };
  }
  /** The Mini App's POST /api/bookings for a Telegram patient. */
  async function bookOnline(patient: string, startAt: string, opts: { key?: string; clinic?: string; doctor?: string; service?: string } = {}) {
    return read(
      await onlineBook(
        json(`http://localhost/api/bookings?clinic=${opts.clinic ?? clinicA}`, "POST", {
          initData: `tg:${patient}`,
          doctorId: opts.doctor ?? doctorA,
          serviceId: opts.service ?? serviceA,
          startAt,
          patientName: "Onlayn Bemor",
          phone: "+998901234567",
          consent: true,
          source: "telegram_mini_app",
          ...(opts.key ? { idempotencyKey: opts.key } : {}),
        }),
      ),
    );
  }
  /** The reception dashboard's POST /api/admin/appointments (walk-in of a new patient). */
  async function bookAtReception(
    when: { startAt?: string; startLocal?: string },
    opts: { key?: string; doctor?: string; service?: string; name?: string; patientId?: string } = {},
  ) {
    asReception();
    return read(
      await receptionBook(
        json("http://localhost/api/admin/appointments", "POST", {
          patientName: opts.name ?? `Qabulxona Bemor ${suffix}`,
          phone: "+998907654321",
          doctorId: opts.doctor ?? doctorA,
          serviceId: opts.service ?? serviceA,
          source: "walk_in",
          ...when,
          ...(opts.patientId ? { patientId: opts.patientId } : {}),
          ...(opts.key ? { idempotencyKey: opts.key } : {}),
        }),
      ),
    );
  }
  async function activeAt(startAt: string, doctor = doctorA) {
    const rows = await sql<{ id: string; source: string }[]>`
      select id, source from public.appointments
       where doctor_id = ${doctor} and status not in ('cancelled', 'no_show')
         and tstzrange(start_at, end_at, '[)') && tstzrange(${startAt}::timestamptz, ${startAt}::timestamptz + interval '30 minutes', '[)')`;
    return rows;
  }
  const idOf = (r: Res) => ((r.body.data?.appointment as { id?: string } | undefined)?.id ?? (r.body.data?.appointmentId as string | undefined)) ?? null;
  const unavailable = (r: Res) => r.status === 409 && r.body.code === "SLOT_UNAVAILABLE";
  const succeeded = (r: Res) => r.status === 201 || r.status === 200;

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 4, onnotice: () => {} });
    await sql`insert into public.clinics ${sql([
      { id: clinicA, name: `Channels A ${suffix}`, slug: `channels-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Channels B ${suffix}`, slug: `channels-b-${suffix}`, timezone: "Asia/Tashkent" },
    ])}`;
    await sql`insert into auth.users ${sql([
      { id: receptionist, email: `channels-rec-${suffix}@test.local` },
      { id: receptionistB, email: `channels-rec-b-${suffix}@test.local` },
    ])}`;
    await sql`insert into public.profiles ${sql([
      { id: receptionist, full_name: "Qabulxona A" },
      { id: receptionistB, full_name: "Qabulxona B" },
    ])}`;
    await sql`insert into public.staff_roles ${sql([
      { clinic_id: clinicA, profile_id: receptionist, role: "receptionist" },
      { clinic_id: clinicB, profile_id: receptionistB, role: "receptionist" },
    ])}`;
    await sql`insert into public.doctors ${sql([
      { id: doctorA, clinic_id: clinicA, name: `Dr Channels A ${suffix}`, active: true },
      { id: doctorB, clinic_id: clinicB, name: `Dr Channels B ${suffix}`, active: true },
    ])}`;
    await sql`insert into public.services ${sql([
      { id: serviceA, clinic_id: clinicA, name: `Channels 30 ${suffix}`, duration_minutes: 30, price: 100000 },
      { id: serviceB, clinic_id: clinicB, name: `Channels B 30 ${suffix}`, duration_minutes: 30, price: 100000 },
    ])}`;
    await sql`insert into public.doctor_working_hours ${sql(
      [1, 2, 3, 4, 5, 6, 7].flatMap((weekday) => [
        { clinic_id: clinicA, doctor_id: doctorA, weekday, start_time: "08:00", end_time: "20:00" },
        { clinic_id: clinicB, doctor_id: doctorB, weekday, start_time: "08:00", end_time: "20:00" },
      ]),
    )}`;
    const patientRows: Array<{ id: string; clinic_id: string; full_name: string; telegram_user_id: number }> = [
      ...online.map((id, i) => ({ id, clinic_id: clinicA, full_name: `Onlayn ${i} ${suffix}`, telegram_user_id: 880_000_000 + Math.floor(Math.random() * 9_000_000) + i })),
      { id: onlineB, clinic_id: clinicB, full_name: `Onlayn B ${suffix}`, telegram_user_id: 890_000_000 + Math.floor(Math.random() * 9_000_000) },
    ];
    await sql`insert into public.patients ${sql(patientRows)}`;
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it("online booking: 201; a retry with the same idempotency key returns the same appointment (200, replayed)", async () => {
    const start = freshSlot();
    const key = randomUUID();
    const first = await bookOnline(online[0], start, { key });
    expect(first.status).toBe(201);
    const retry = await bookOnline(online[0], start, { key });
    expect(retry).toMatchObject({ status: 200, body: { data: { replayed: true } } });
    expect(idOf(retry)).toBe(idOf(first));
    expect(await activeAt(start)).toHaveLength(1);
  });

  it("reception double-click: two identical submissions at once → one appointment and one patient", async () => {
    const start = freshSlot();
    const key = randomUUID();
    const name = `Ikki marta ${suffix}`;
    const [a, b] = await Promise.all([bookAtReception({ startAt: start }, { key, name }), bookAtReception({ startAt: start }, { key, name })]);
    expect(succeeded(a) && succeeded(b)).toBe(true);
    expect(idOf(a)).toBe(idOf(b));
    expect(await activeAt(start)).toHaveLength(1);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.patients where clinic_id = ${clinicA} and full_name = ${name}`;
    expect(n).toBe(1);
  });

  it("sequential double booking is refused in every channel order with SLOT_UNAVAILABLE", async () => {
    const orders: Array<[string, (s: string) => Promise<Res>, (s: string) => Promise<Res>]> = [
      ["online → online", (s) => bookOnline(online[0], s), (s) => bookOnline(online[1], s)],
      ["reception → reception", (s) => bookAtReception({ startAt: s }), (s) => bookAtReception({ startAt: s })],
      ["online → reception", (s) => bookOnline(online[0], s), (s) => bookAtReception({ startAt: s })],
      ["reception → online", (s) => bookAtReception({ startAt: s }), (s) => bookOnline(online[1], s)],
    ];
    for (const [label, first, second] of orders) {
      const start = freshSlot();
      expect(succeeded(await first(start)), label).toBe(true);
      const refused = await second(start);
      expect(unavailable(refused), `${label}: ${JSON.stringify(refused.body)}`).toBe(true);
      expect(refused.body.error).toBe("Bu vaqt endi bo‘sh emas. Iltimos, boshqa vaqtni tanlang.");
      expect(await activeAt(start), label).toHaveLength(1);
    }
  });

  for (const [scenario, onlineFirst] of [
    ["Scenario A — online fires first", true],
    ["Scenario B — reception fires first", false],
  ] as const) {
    it(`${scenario}: at nearly the same moment one succeeds, the other gets SLOT_UNAVAILABLE (5 rounds)`, async () => {
      const winners: string[] = [];
      for (let round = 0; round < 5; round++) {
        const start = freshSlot();
        const calls = onlineFirst
          ? [bookOnline(online[round % online.length], start), bookAtReception({ startAt: start })]
          : [bookAtReception({ startAt: start }), bookOnline(online[round % online.length], start)];
        const results = await Promise.all(calls);
        expect(results.filter(succeeded), JSON.stringify(results.map((r) => r.body))).toHaveLength(1);
        expect(results.filter(unavailable)).toHaveLength(1);
        const rows = await activeAt(start);
        expect(rows).toHaveLength(1);
        winners.push(rows[0].source);
      }
      // No channel is privileged: whichever transaction commits first wins.
      expect(winners.every((s) => s === "telegram_mini_app" || s === "walk_in")).toBe(true);
    });
  }

  it("10 simultaneous requests for one slot (5 online, 5 reception): SUCCESS = 1, SLOT_UNAVAILABLE = 9", async () => {
    const start = freshSlot();
    const results = await Promise.all([
      ...online.slice(0, 5).map((p) => bookOnline(p, start)),
      ...Array.from({ length: 5 }, (_, i) => bookAtReception({ startAt: start }, { name: `Parallel ${i} ${suffix}` })),
    ]);
    expect(results.filter(succeeded)).toHaveLength(1);
    expect(results.filter(unavailable)).toHaveLength(9);
    expect(await activeAt(start)).toHaveLength(1);
  });

  it("availability is only a hint: a slot taken after it was shown is refused at confirmation, and disappears from availability", async () => {
    const query = `http://localhost/api/availability?clinic=${clinicA}&doctorId=${doctorA}&serviceId=${serviceA}&days=5`;
    const shown = (await read(await availability(new NextRequest(query)))).body.data!.slots as Array<{ start: string }>;
    const slot = shown.find((s) => new Date(s.start).getTime() > Date.now() + 86_400_000)!;
    expect(slot).toBeTruthy();
    // Reception takes it while the patient is still looking at the list.
    expect(succeeded(await bookAtReception({ startAt: slot.start }))).toBe(true);
    const confirm = await bookOnline(online[2], slot.start);
    expect(unavailable(confirm)).toBe(true);
    const after = (await read(await availability(new NextRequest(query)))).body.data!.slots as Array<{ start: string }>;
    expect(after.some((s) => s.start === slot.start)).toBe(false);
  });

  it("cancellation releases the slot: the patient cancels online, reception books the same time", async () => {
    const start = freshSlot();
    const booked = await bookOnline(online[3], start);
    expect(booked.status).toBe(201);
    expect(unavailable(await bookAtReception({ startAt: start }))).toBe(true);
    const cancelled = await read(
      await patientCancel(json(`http://localhost/api/bookings/${idOf(booked)}/cancel?clinic=${clinicA}`, "POST", { initData: `tg:${online[3]}` }), {
        params: Promise.resolve({ id: idOf(booked)! }),
      }),
    );
    expect(cancelled.status).toBe(200);
    expect(succeeded(await bookAtReception({ startAt: start }))).toBe(true);
    expect(await activeAt(start)).toHaveLength(1);
  });

  it("rescheduling uses the same protection: into an occupied time → SLOT_UNAVAILABLE; into a free one → moved", async () => {
    const taken = freshSlot();
    const free = freshSlot();
    await bookOnline(online[4], taken);
    const mine = await bookAtReception({ startAt: freshSlot() });
    asReception();
    const move = (to: string) =>
      adminAppointment(json(`http://localhost/api/admin/appointments/${idOf(mine)}`, "PATCH", { action: "reschedule", newStartAt: to }), {
        params: Promise.resolve({ id: idOf(mine)! }),
      }).then(read);
    expect(unavailable(await move(taken))).toBe(true);
    expect((await move(free)).status).toBe(200);
    expect((await activeAt(free)).map((r) => r.id)).toEqual([idOf(mine)]);
  });

  it("tenancy: the same time in clinic B is free; clinic A's reception cannot book clinic B's doctor or move clinic B's appointment", async () => {
    const start = freshSlot();
    expect((await bookOnline(online[5], start)).status).toBe(201);
    const inB = await bookOnline(onlineB, start, { clinic: clinicB, doctor: doctorB, service: serviceB });
    expect(inB.status).toBe(201);
    const crossDoctor = await bookAtReception({ startAt: freshSlot() }, { doctor: doctorB, service: serviceA });
    expect(crossDoctor).toMatchObject({ status: 422, body: { code: "INVALID_DOCTOR" } });
    const crossPatient = await bookAtReception({ startAt: freshSlot() }, { patientId: onlineB });
    expect(crossPatient).toMatchObject({ status: 422, body: { code: "INVALID_PATIENT" } });
    asReception();
    const moveB = await read(
      await adminAppointment(json(`http://localhost/api/admin/appointments/${idOf(inB)}`, "PATCH", { action: "reschedule", newStartAt: freshSlot() }), {
        params: Promise.resolve({ id: idOf(inB)! }),
      }),
    );
    expect(moveB.status).toBe(404);
    expect(await activeAt(start, doctorB)).toHaveLength(1);
  });

  it("reception times are the clinic's wall clock, whatever the browser's or server's timezone", async () => {
    const day = freshSlot().slice(0, 10);
    const res = await bookAtReception({ startLocal: `${day}T10:00` });
    expect(succeeded(res)).toBe(true);
    const [row] = await sql<{ start_at: Date }[]>`select start_at from public.appointments where id = ${idOf(res)!}`;
    expect(row.start_at.toISOString()).toBe(`${day}T05:00:00.000Z`); // 10:00 Tashkent (UTC+5)
    expect(await bookAtReception({ startLocal: "2026-02-30T10:00" })).toMatchObject({ status: 422, body: { code: "INVALID_TIME" } });
    // 19:45–20:15 local runs past the doctor's 20:00 end.
    expect(await bookAtReception({ startLocal: `${freshSlot().slice(0, 10)}T19:45` })).toMatchObject({
      status: 422,
      body: { code: "INVALID_TIME", details: { reason: "outside_working_hours" } },
    });
  });

  it("the error contract never exposes a database error", async () => {
    const start = freshSlot();
    const cases = [
      await bookOnline(online[6], start, { doctor: randomUUID() }),
      await bookOnline(online[6], new Date(Date.now() - 3_600_000).toISOString()),
      await bookAtReception({ startAt: start }, { patientId: randomUUID() }),
    ];
    expect(cases.map((r) => [r.status, r.body.code])).toEqual([
      [422, "INVALID_DOCTOR"],
      [422, "INVALID_TIME"],
      [422, "INVALID_PATIENT"],
    ]);
    for (const r of cases) expect(JSON.stringify(r.body)).not.toMatch(/violat|constraint|postgres|sqlstate|23P01|P0001/i);
  });
});

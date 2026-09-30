import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import postgres from "postgres";
import { localDbAvailable } from "@/test/local-db";

/**
 * One patient, one record: reception finds a returning patient instead of
 * registering them again — through the REAL routes and the real database.
 *
 *   POST /api/admin/appointments   a new patient whose (normalized) phone is
 *                                  already a patient's of the clinic → 409
 *                                  possible_duplicate with the candidates;
 *                                  confirmNewPatient / patientId resolve it
 *   GET  /api/admin/patients?q=     finds the patient however the phone is typed
 *   POST /api/bookings              the Mini App fills only an empty name/phone;
 *                                  the website reuses the visitor's own record
 *
 * Mocked: the staff session lookup (getStaffContext) and the patient
 * notifications (a Telegram booking would enqueue jobs due at once, which the
 * notification-processor suites would claim). Telegram identity is a real,
 * signed initData verified against the clinic's own bot.
 */

const session = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});
vi.mock("@/lib/notifications/jobs", () => ({
  enqueueBookingNotifications: async () => {},
  enqueueCancellationNotification: async () => {},
  enqueueRescheduleNotification: async () => {},
}));

import { POST as receptionBook } from "./route";
import { GET as searchPatients } from "@/app/api/admin/patients/route";
import { POST as onlineBook } from "@/app/api/bookings/route";

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const describeDb = describe.skipIf(!localDbAvailable());

type Candidate = { id: string; fullName: string | null; phone: string | null };
type Body = { ok: boolean; data?: Record<string, unknown>; error?: string; code?: string; details?: { candidates?: Candidate[]; reason?: string } };
type Res = { status: number; body: Body };
type PatientRow = { id: string; clinic_id: string; full_name: string | null; phone: string | null; phone_normalized: string | null; telegram_user_id: string | null; consent_given: boolean };

describeDb("reception registration finds the returning patient — real routes, real database", () => {
  let sql: postgres.Sql;
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const doctorA = randomUUID();
  const doctorB = randomUUID();
  const serviceA = randomUUID();
  const serviceB = randomUUID();
  const receptionist = randomUUID();
  const doctorUser = randomUUID();
  const BOT_TOKEN = `${700_000 + Math.floor(Math.random() * 99_999)}:REGISTRATION_TEST_BOT_${suffix}`;

  // One person's number, typed the ways reception meets it.
  const local = `9${String(Date.now()).slice(-8)}`; // 9 digits, as said aloud: "90 123 45 67"
  const PHONE = `+998 ${local.slice(0, 2)} ${local.slice(2, 5)} ${local.slice(5, 7)} ${local.slice(7)}`;
  const PHONE_LOCAL = local;
  const PHONE_DASHED = `998-${local.slice(0, 2)}-${local.slice(2, 5)}-${local.slice(5, 7)}-${local.slice(7)}`;
  const NORMALIZED = `998${local}`;
  let phoneSeq = 0;
  /** A number no other patient of either clinic has. */
  const freshPhone = () => `+99877${String(phoneSeq++).padStart(3, "0")}${local.slice(-4)}`;

  let dayOffset = 60 + Math.floor(Math.random() * 3000);
  /** 10:00 Tashkent (05:00Z) on a day of its own — the doctors are this run's, so no other suite books them. */
  const slot = () => `${new Date(Date.now() + dayOffset++ * 86_400_000).toISOString().slice(0, 10)}T05:00:00.000Z`;

  const asReception = () =>
    (session.ctx = { profileId: receptionist, clinicId: clinicA, clinicName: "Registration A", clinicTimezone: "Asia/Tashkent", roles: ["receptionist"], platformAdmin: false });
  const read = async (res: Response): Promise<Res> => ({ status: res.status, body: (await res.json()) as Body });
  const json = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    new NextRequest(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  /** The quick-booking modal's request: a walk-in, one idempotency key per attempt. */
  async function book(body: Record<string, unknown>, as: () => unknown = asReception): Promise<Res> {
    as();
    return read(
      await receptionBook(
        json("http://localhost/api/admin/appointments", {
          doctorId: doctorA,
          serviceId: serviceA,
          startAt: slot(),
          source: "walk_in",
          idempotencyKey: randomUUID(),
          ...body,
        }),
      ),
    );
  }
  async function search(q: string): Promise<string[]> {
    asReception();
    const res = await read(await searchPatients(new NextRequest(`http://localhost/api/admin/patients?q=${encodeURIComponent(q)}`)));
    expect(res.status).toBe(200);
    return (res.body.data!.patients as Array<{ id: string }>).map((p) => p.id).sort();
  }
  const appointmentIdOf = (r: Res) =>
    ((r.body.data?.appointment as { id?: string } | undefined)?.id ?? (r.body.data?.appointmentId as string | undefined)) ?? null;
  async function patientOf(r: Res): Promise<string> {
    const [row] = await sql<{ patient_id: string }[]>`select patient_id from public.appointments where id = ${appointmentIdOf(r)!}`;
    return row.patient_id;
  }
  async function patient(id: string): Promise<PatientRow> {
    const [row] = await sql<PatientRow[]>`
      select id, clinic_id, full_name, phone, phone_normalized, telegram_user_id::text, consent_given from public.patients where id = ${id}`;
    return row;
  }
  const samePhone = async (clinic = clinicA) =>
    (await sql<{ id: string }[]>`select id from public.patients where clinic_id = ${clinic} and phone_normalized = ${NORMALIZED} order by id`).map((r) => r.id);
  const counts = async () => {
    const [row] = await sql<{ patients: number; appointments: number }[]>`
      select (select count(*)::int from public.patients where clinic_id = ${clinicA}) as patients,
             (select count(*)::int from public.appointments where clinic_id = ${clinicA}) as appointments`;
    return row;
  };
  const byId = (a: Candidate, b: Candidate) => a.id.localeCompare(b.id);

  /** Telegram's own signature over the Mini App launch data, by this clinic's bot (as Telegram would produce it). */
  function signedInitData(user: { id: number; first_name: string }): string {
    const fields = new Map([
      ["auth_date", String(Math.floor(Date.now() / 1000))],
      ["query_id", `AAH${suffix}`],
      ["user", JSON.stringify(user)],
    ]);
    const checkString = [...fields.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
    const secretKey = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const hash = createHmac("sha256", secretKey).update(checkString).digest("hex");
    return `${[...fields.entries()].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}&hash=${hash}`;
  }
  /** POST /api/bookings — with a signed initData (Mini App) or without (website). Each call from its own address: the real rate limiter stays on. */
  async function bookOnline(body: Record<string, unknown>): Promise<Res> {
    const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    return read(
      await onlineBook(
        json(
          `http://localhost/api/bookings?clinic=${clinicA}`,
          { doctorId: doctorA, serviceId: serviceA, startAt: slot(), consent: true, idempotencyKey: randomUUID(), ...body },
          { "x-forwarded-for": ip },
        ),
      ),
    );
  }

  // Filled in as the journey goes.
  let first: string; // the patient registered first
  let second: string; // another person sharing the phone
  let otherClinicPatient: string;

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 4, onnotice: () => {} });
    await sql`insert into public.clinics ${sql([
      { id: clinicA, name: `Registration A ${suffix}`, slug: `registration-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Registration B ${suffix}`, slug: `registration-b-${suffix}`, timezone: "Asia/Tashkent" },
    ])}`;
    await sql`insert into auth.users ${sql([
      { id: receptionist, email: `registration-rec-${suffix}@test.local` },
      { id: doctorUser, email: `registration-dr-${suffix}@test.local` },
    ])}`;
    await sql`insert into public.profiles ${sql([
      { id: receptionist, full_name: "Qabulxona" },
      { id: doctorUser, full_name: "Shifokor" },
    ])}`;
    await sql`insert into public.staff_roles ${sql([
      { clinic_id: clinicA, profile_id: receptionist, role: "receptionist" },
      { clinic_id: clinicA, profile_id: doctorUser, role: "doctor" },
    ])}`;
    await sql`insert into public.doctors ${sql([
      { id: doctorA, clinic_id: clinicA, name: `Dr Registration A ${suffix}`, active: true },
      { id: doctorB, clinic_id: clinicB, name: `Dr Registration B ${suffix}`, active: true },
    ])}`;
    await sql`insert into public.services ${sql([
      { id: serviceA, clinic_id: clinicA, name: `Registration 30 ${suffix}`, duration_minutes: 30, price: 100000 },
      { id: serviceB, clinic_id: clinicB, name: `Registration B 30 ${suffix}`, duration_minutes: 30, price: 100000 },
    ])}`;
    await sql`insert into public.doctor_working_hours ${sql(
      [1, 2, 3, 4, 5, 6, 7].flatMap((weekday) => [
        { clinic_id: clinicA, doctor_id: doctorA, weekday, start_time: "08:00", end_time: "20:00" },
        { clinic_id: clinicB, doctor_id: doctorB, weekday, start_time: "08:00", end_time: "20:00" },
      ]),
    )}`;
    await sql`insert into public.clinic_telegram_integrations ${sql({
      clinic_id: clinicA,
      telegram_bot_token: BOT_TOKEN,
      telegram_bot_id: Number(BOT_TOKEN.split(":")[0]),
      telegram_username: `registration_bot_${suffix}`,
      telegram_bot_name: "Registration bot",
      status: "active",
      enabled: true,
      validated_at: new Date(),
    })}`;
    // Clinic B has a patient with the very same number: another tenant's, never clinic A's business.
    [{ id: otherClinicPatient }] = await sql<{ id: string }[]>`
      insert into public.patients (clinic_id, full_name, phone) values (${clinicB}, ${`Begona Klinika Bemori ${suffix}`}, ${PHONE_LOCAL}) returning id`;
  });

  afterAll(async () => {
    if (!sql) return;
    // Everything of both clinics goes with them; errors fail the suite instead of leaking fixtures.
    await sql`delete from public.clinics where id in ${sql([clinicA, clinicB])}`;
    await sql`delete from auth.users where id in ${sql([receptionist, doctorUser])}`;
    const [{ left }] = await sql<{ left: number }[]>`
      select (select count(*)::int from public.clinics where id in ${sql([clinicA, clinicB])})
           + (select count(*)::int from public.patients where clinic_id in ${sql([clinicA, clinicB])}) as left`;
    expect(left).toBe(0);
    await sql.end({ timeout: 5 });
  });

  it("1. a new patient with a phone nobody has: 201, and exactly one patient — with the number as typed and normalized", async () => {
    const res = await book({ patientName: `Aziza Karimova ${suffix}`, phone: PHONE });
    expect(res.status).toBe(201);
    first = await patientOf(res);
    expect(await patient(first)).toMatchObject({ clinic_id: clinicA, full_name: `Aziza Karimova ${suffix}`, phone: PHONE, phone_normalized: NORMALIZED, telegram_user_id: null });
    expect(await samePhone()).toEqual([first]);
    expect(await counts()).toEqual({ patients: 1, appointments: 1 });
  });

  it("2. the same number typed another way, for a 'new' patient: 409 possible_duplicate naming exactly the clinic's patient — nothing is created", async () => {
    const before = await counts();
    for (const typed of [PHONE_LOCAL, PHONE_DASHED, `+${NORMALIZED}`, ` (${local.slice(0, 2)}) ${local.slice(2, 5)}-${local.slice(5)} `]) {
      const res = await book({ patientName: `Aziza Karimova ${suffix}`, phone: typed });
      expect(res, typed).toMatchObject({ status: 409, body: { ok: false, code: "possible_duplicate" } });
      // Exactly the fields reception needs to pick the patient — no more.
      expect(res.body.details?.candidates, typed).toEqual([{ id: first, fullName: `Aziza Karimova ${suffix}`, phone: PHONE }]);
    }
    // Checked before anything else about the booking: even a doctor of another clinic gets the duplicate question first.
    expect(await book({ patientName: "Aziza", phone: PHONE_LOCAL, doctorId: doctorB, serviceId: serviceB })).toMatchObject({ status: 409, body: { code: "possible_duplicate" } });
    expect(await counts()).toEqual(before);
    expect(await samePhone()).toEqual([first]);
  });

  it("3. confirmNewPatient: a different person who shares the phone is registered — two people may share one number", async () => {
    const res = await book({ patientName: `Nodira Karimova ${suffix}`, phone: PHONE_LOCAL, confirmNewPatient: true });
    expect(res.status).toBe(201);
    second = await patientOf(res);
    expect(second).not.toBe(first);
    expect(await patient(second)).toMatchObject({ full_name: `Nodira Karimova ${suffix}`, phone: PHONE_LOCAL, phone_normalized: NORMALIZED });
    expect(await samePhone()).toEqual([first, second].sort());
    // The first patient is untouched.
    expect(await patient(first)).toMatchObject({ full_name: `Aziza Karimova ${suffix}`, phone: PHONE });

    // From now on both are offered.
    const again = await book({ patientName: `Kimdir ${suffix}`, phone: PHONE_DASHED });
    expect(again.status).toBe(409);
    expect([...again.body.details!.candidates!].sort(byId)).toEqual(
      [
        { id: first, fullName: `Aziza Karimova ${suffix}`, phone: PHONE },
        { id: second, fullName: `Nodira Karimova ${suffix}`, phone: PHONE_LOCAL },
      ].sort(byId),
    );
  });

  it("4. patientId books the existing patient — whatever name and phone the form still holds, the record keeps its own", async () => {
    const before = await counts();
    const res = await book({ patientId: first, patientName: `Boshqa Ism ${suffix}`, phone: freshPhone() });
    expect(res.status).toBe(201);
    expect(await patientOf(res)).toBe(first);
    expect(await patient(first)).toMatchObject({ full_name: `Aziza Karimova ${suffix}`, phone: PHONE, phone_normalized: NORMALIZED });
    expect(await counts()).toEqual({ patients: before.patients, appointments: before.appointments + 1 });
  });

  it("4b. a patient with no stored name — a Telegram-only record — can be picked and booked without typing one", async () => {
    const [{ id: nameless }] = await sql<{ id: string }[]>`
      insert into public.patients (clinic_id, full_name, phone, telegram_first_name) values (${clinicA}, ${null}, ${freshPhone()}, ${`Nomsiz ${suffix}`}) returning id`;
    const before = await counts();
    const res = await book({ patientId: nameless });
    expect(res.status).toBe(201);
    expect(await patientOf(res)).toBe(nameless);
    expect((await patient(nameless)).full_name).toBeNull();
    expect(await counts()).toEqual({ patients: before.patients, appointments: before.appointments + 1 });
    // Without a patient to pick, a name is still required.
    expect(await book({ phone: freshPhone() })).toMatchObject({ status: 400 });
  });

  it("5. another clinic's patient with the same number is never a candidate, never found, and never blocks a registration", async () => {
    const res = await book({ patientName: `Aziza Karimova ${suffix}`, phone: PHONE });
    expect(res.status).toBe(409);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(otherClinicPatient);
    expect(text).not.toContain("Begona Klinika Bemori");
    expect(res.body.details!.candidates!.map((c) => c.id).sort()).toEqual([first, second].sort());
    expect(await search(PHONE_LOCAL)).not.toContain(otherClinicPatient);

    // A number only clinic B knows: clinic A registers its own patient, no question asked.
    const onlyInB = freshPhone();
    await sql`insert into public.patients (clinic_id, full_name, phone) values (${clinicB}, ${`Faqat B ${suffix}`}, ${onlyInB})`;
    const own = await book({ patientName: `Faqat A ${suffix}`, phone: onlyInB });
    expect(own.status).toBe(201);
    expect(await patient(await patientOf(own))).toMatchObject({ clinic_id: clinicA, full_name: `Faqat A ${suffix}` });
    // Clinic B's records are untouched.
    expect(await patient(otherClinicPatient)).toMatchObject({ clinic_id: clinicB, full_name: `Begona Klinika Bemori ${suffix}`, phone: PHONE_LOCAL });
  });

  it("6. a retry of the same request (same idempotency key) is not a duplicate of the patient it registered itself — it replays the booking", async () => {
    const request = { patientName: `Takror Bemor ${suffix}`, phone: freshPhone(), startAt: slot(), idempotencyKey: randomUUID() };
    const created = await book(request);
    expect(created.status).toBe(201);
    const retry = await book(request);
    expect(retry).toMatchObject({ status: 200, body: { data: { replayed: true } } });
    expect(appointmentIdOf(retry)).toBe(appointmentIdOf(created));
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.patients where clinic_id = ${clinicA} and phone = ${request.phone}`;
    expect(n).toBe(1);
    // A different attempt for that number is a new question, though.
    expect(await book({ ...request, idempotencyKey: randomUUID(), startAt: slot() })).toMatchObject({ status: 409, body: { code: "possible_duplicate" } });
  });

  it("7. a registration whose booking fails leaves no patient behind (occupied slot, another clinic's doctor)", async () => {
    const taken = slot();
    expect((await book({ patientId: first, patientName: "Aziza", startAt: taken })).status).toBe(201);
    const leftovers = async (phone: string) =>
      (await sql<{ n: number }[]>`select count(*)::int as n from public.patients where phone = ${phone}`)[0].n;

    for (const withKey of [true, false]) {
      const phone = freshPhone();
      const res = await book({ patientName: `Kech Qolgan ${suffix}`, phone, startAt: taken, ...(withKey ? {} : { idempotencyKey: undefined }) });
      expect(res, `idempotency key: ${withKey}`).toMatchObject({ status: 409, body: { code: "SLOT_UNAVAILABLE" } });
      expect(await leftovers(phone), `idempotency key: ${withKey}`).toBe(0);
    }

    const phone = freshPhone();
    const cross = await book({ patientName: `Boshqa Klinika Shifokori ${suffix}`, phone, doctorId: doctorB });
    expect(cross).toMatchObject({ status: 422, body: { code: "INVALID_DOCTOR" } });
    expect(await leftovers(phone)).toBe(0);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.appointments where doctor_id = ${doctorB}`;
    expect(n).toBe(0);
  });

  it("8. reception search finds the patient however the phone is typed; fewer than 5 digits match only the number as it was typed", async () => {
    for (const typed of [PHONE_LOCAL, PHONE_DASHED, `+${NORMALIZED}`, PHONE, local.slice(-5)]) {
      expect(await search(typed), typed).toEqual(expect.arrayContaining([first, second].sort()));
    }
    // "4567" (4 digits) is not looked up as a number: it matches the second
    // patient's phone as typed ("9…4567") but not the first's ("… 45 67").
    const lastFour = local.slice(-4);
    const short = await search(lastFour);
    expect(short).toContain(second);
    expect(short).not.toContain(first);
    // Never another clinic's patient.
    expect(await search(NORMALIZED)).not.toContain(otherClinicPatient);
  });

  it("9. neither a doctor nor an anonymous caller can register or book at the desk", async () => {
    const before = await counts();
    const asDoctor = () =>
      (session.ctx = { profileId: doctorUser, clinicId: clinicA, clinicName: "Registration A", clinicTimezone: "Asia/Tashkent", roles: ["doctor"], platformAdmin: false });
    const anonymous = () => (session.ctx = null);
    expect(await book({ patientName: `Shifokor Yozgan ${suffix}`, phone: freshPhone() }, asDoctor)).toMatchObject({ status: 403, body: { code: "forbidden" } });
    expect(await book({ patientName: `Anonim ${suffix}`, phone: freshPhone() }, anonymous)).toMatchObject({ status: 401, body: { code: "unauthorized" } });
    expect(await book({ patientId: first, patientName: "Aziza" }, anonymous)).toMatchObject({ status: 401 });
    expect(await counts()).toEqual(before);
  });

  it("the Mini App fills a verified patient's name and phone only while empty — never renames or re-numbers an existing record", async () => {
    const tg = () => 810_000_000 + Math.floor(Math.random() * 90_000_000);
    const [owner, blankName, noPhone] = [tg(), tg(), tg()];
    const ownerPhone = freshPhone();
    const [{ id: ownerId }] = await sql<{ id: string }[]>`
      insert into public.patients (clinic_id, full_name, phone, telegram_user_id) values (${clinicA}, ${`Asl Egasi ${suffix}`}, ${ownerPhone}, ${owner}) returning id`;
    const blankPhone = freshPhone();
    const [{ id: blankId }] = await sql<{ id: string }[]>`
      insert into public.patients (clinic_id, full_name, phone, telegram_user_id) values (${clinicA}, ${"   "}, ${blankPhone}, ${blankName}) returning id`;
    const [{ id: noPhoneId }] = await sql<{ id: string }[]>`
      insert into public.patients (clinic_id, full_name, phone, telegram_user_id) values (${clinicA}, ${`Ismi Bor ${suffix}`}, ${null}, ${noPhone}) returning id`;

    // Booking for a relative: the record keeps its owner's name and number.
    const relative = await bookOnline({ initData: signedInitData({ id: owner, first_name: "Asl" }), patientName: `Qarindosh ${suffix}`, phone: freshPhone() });
    expect(relative.status).toBe(201);
    expect(await patientOf(relative)).toBe(ownerId);
    expect(await patient(ownerId)).toMatchObject({ full_name: `Asl Egasi ${suffix}`, phone: ownerPhone, consent_given: true });

    // Only the empty field is filled.
    const named = await bookOnline({ initData: signedInitData({ id: blankName, first_name: "Bo'sh" }), patientName: `Yangi Ism ${suffix}`, phone: freshPhone() });
    expect(named.status).toBe(201);
    expect(await patient(blankId)).toMatchObject({ full_name: `Yangi Ism ${suffix}`, phone: blankPhone });
    const numbered = freshPhone();
    const phoned = await bookOnline({ initData: signedInitData({ id: noPhone, first_name: "Ismi" }), patientName: `Boshqa Ism ${suffix}`, phone: numbered });
    expect(phoned.status).toBe(201);
    expect(await patient(noPhoneId)).toMatchObject({ full_name: `Ismi Bor ${suffix}`, phone: numbered });

    // A first-time Telegram user: the record is created for them and filled from the form.
    const newcomer = tg();
    const newPhone = freshPhone();
    const fresh = await bookOnline({ initData: signedInitData({ id: newcomer, first_name: "Yangi" }), patientName: `Telegram Yangi ${suffix}`, phone: newPhone });
    expect(fresh.status).toBe(201);
    expect(await patient(await patientOf(fresh))).toMatchObject({ clinic_id: clinicA, telegram_user_id: String(newcomer), full_name: `Telegram Yangi ${suffix}`, phone: newPhone });

    // A forged signature is refused before anything is written.
    const forged = signedInitData({ id: owner, first_name: "Asl" }).replace(/hash=[0-9a-f]+/, `hash=${"0".repeat(64)}`);
    expect(await bookOnline({ initData: forged, patientName: `Soxta ${suffix}`, phone: freshPhone() })).toMatchObject({ status: 401, body: { code: "invalid_init_data" } });
    expect(await patient(ownerId)).toMatchObject({ full_name: `Asl Egasi ${suffix}`, phone: ownerPhone });
  });

  it("the website finds the returning visitor by the phone typed another way (and their name) instead of creating a duplicate", async () => {
    const before = await counts();
    const res = await bookOnline({ patientName: `  aziza   KARIMOVA ${suffix} `, phone: PHONE_DASHED });
    expect(res.status).toBe(201);
    expect(await patientOf(res)).toBe(first);
    expect(await counts()).toEqual({ patients: before.patients, appointments: before.appointments + 1 });
    // What the visitor typed is not written onto the record.
    expect(await patient(first)).toMatchObject({ full_name: `Aziza Karimova ${suffix}`, phone: PHONE });
    expect(await samePhone()).toEqual([first, second].sort());
  });
});

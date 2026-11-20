import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { localDbAvailable } from "@/test/local-db";

/**
 * Outpatient pilot through the real routes and database: reception
 * registers (and cannot take money), the cashier collects a split payment
 * and the queue number appears, refunds follow the grant rule, the doctor
 * works only their own queue, the waiting-room screen shows numbers only and
 * the digital ticket goes to the patient's own Telegram chat. Session
 * identity is the only input the server trusts; forged fields are refused.
 */

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const session = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});
const sent = vi.hoisted(() => ({ messages: [] as Array<{ chatId: number; text: string }> }));
vi.mock("@/lib/telegram/bot", () => ({
  sendTelegramMessage: vi.fn(async (m: { chatId: number; text: string }) => {
    sent.messages.push(m);
    return 4242;
  }),
  getTelegramFileUrl: vi.fn(async () => null),
  telegramConfigured: vi.fn(() => true),
}));

import { GET as searchPatients } from "./patients/route";
import { GET as catalog } from "./catalog/route";
import { GET as queue, POST as register } from "./arrivals/route";
import { POST as transition } from "./arrivals/[id]/route";
import { GET as kassa } from "./kassa/route";
import { POST as pay } from "./kassa/[visitId]/pay/route";
import { POST as refund } from "./kassa/[visitId]/refund/route";
import { GET as totals } from "./kassa/totals/route";
import { POST as grant } from "./refund-grants/route";
import { GET as doctorQueue } from "../doctor/visits/route";
import { POST as doctorAct } from "../doctor/visits/[id]/route";
import { GET as publicQueue } from "../queue/[clinicId]/route";
import { processDueNotificationJobs } from "@/lib/notifications/processor";

const describeDb = describe.skipIf(!localDbAvailable());

type Body = { ok: boolean; data?: Record<string, unknown>; code?: string; error?: string; details?: Record<string, unknown> };
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Body });
const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const params = <T,>(p: T) => ({ params: Promise.resolve(p) });

const minutesToClinicMidnight = () => {
  const local = new Date(Date.now() + 5 * 3_600_000);
  return 24 * 60 - (local.getUTCHours() * 60 + local.getUTCMinutes());
};

describeDb("outpatient pilot — routes", () => {
  let admin: SupabaseClient;
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const people = {
    owner: randomUUID(),
    manager: randomUUID(),
    admin: randomUUID(),
    reception: randomUUID(),
    cashier: randomUUID(),
    drA: randomUUID(),
    drC: randomUUID(),
    receptionB: randomUUID(),
  };
  const doctors = { a: randomUUID(), c: randomUUID() };
  const services = { consult: randomUUID(), ecg: randomUUID() };
  const tg = 980_000_000 + Math.floor(Math.random() * 1_000_000);

  const as = (profileId: string, role: string, clinicId = clinicA) => {
    session.ctx = { profileId, clinicId, clinicName: "Ops", clinicTimezone: "Asia/Tashkent", roles: [role], platformAdmin: false };
  };
  const registerNew = async (fullName: string, extra: Record<string, unknown> = {}, svc = [services.consult, services.ecg]) =>
    read(
      await register(
        new NextRequest("http://localhost/api/operations/arrivals", json("POST", { key: randomUUID(), doctorId: doctors.a, serviceIds: svc, newPatient: { fullName, dateOfBirth: "1990-05-06", ...extra } })),
      ),
    );
  const kassaList = async () => (await read(await kassa())).body.data as { open: Array<{ id: string; status: string; queueNumber: number | null; balance: { outstanding: number; cashNet: number } }>; canRefund: boolean };
  const payVisit = async (visitId: string, lines: unknown, expectedOutstanding: number) =>
    read(await pay(new NextRequest("http://x", json("POST", { key: randomUUID(), expectedOutstanding, lines })), params({ visitId })));
  const refundVisit = async (visitId: string, body: Record<string, unknown>) =>
    read(await refund(new NextRequest("http://x", json("POST", { key: randomUUID(), reason: "Xizmat ko‘rsatilmadi", ...body })), params({ visitId })));

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    sql = postgres(DB_URL, { max: 2, onnotice: () => {} });
    const { error: clinicError } = await admin.from("clinics").insert([
      { id: clinicA, name: `Ops A ${suffix}`, slug: `ops-api-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Ops B ${suffix}`, slug: `ops-api-b-${suffix}`, timezone: "Asia/Tashkent" },
    ]);
    if (clinicError) throw new Error(clinicError.message);
    for (const [name, id] of Object.entries(people)) {
      const { error } = await admin.auth.admin.createUser({ id, email: `opsapi-${name}-${suffix}@test.local`, email_confirm: true, password: `Pw-${randomUUID()}` });
      if (error) throw new Error(error.message);
      await admin.from("profiles").insert({ id, full_name: `${name} ${suffix}` });
    }
    const { error: rolesError } = await admin.from("staff_roles").insert([
      { clinic_id: clinicA, profile_id: people.owner, role: "owner" },
      { clinic_id: clinicA, profile_id: people.manager, role: "manager" },
      { clinic_id: clinicA, profile_id: people.admin, role: "admin" },
      { clinic_id: clinicA, profile_id: people.reception, role: "receptionist" },
      { clinic_id: clinicA, profile_id: people.cashier, role: "cashier" },
      { clinic_id: clinicA, profile_id: people.drA, role: "doctor" },
      { clinic_id: clinicA, profile_id: people.drC, role: "doctor" },
      { clinic_id: clinicB, profile_id: people.receptionB, role: "receptionist" },
    ]);
    if (rolesError) throw new Error(rolesError.message);
    await admin.from("doctors").insert([
      { id: doctors.a, clinic_id: clinicA, profile_id: people.drA, name: `Dr Navbat ${suffix}`, active: true },
      { id: doctors.c, clinic_id: clinicA, profile_id: people.drC, name: `Dr Boshqa ${suffix}`, active: true },
    ]);
    await admin.from("services").insert([
      { id: services.consult, clinic_id: clinicA, name: `Ko‘rik ${suffix}`, duration_minutes: 5, price: 120000 },
      { id: services.ecg, clinic_id: clinicA, name: `EKG ${suffix}`, duration_minutes: 5, price: 60000 },
    ]);
    await admin.from("doctor_working_hours").insert(
      [doctors.a, doctors.c].flatMap((doctor_id) => [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinicA, doctor_id, weekday, start_time: "00:00", end_time: "23:59" }))),
    );
  }, 60_000);

  afterAll(async () => {
    if (sql) {
      await sql.begin(async (tx) => {
        await tx.unsafe("set local session_replication_role = replica");
        const clinics = [clinicA, clinicB];
        await tx`delete from public.visit_transactions where clinic_id in ${tx(clinics)}`;
        await tx`delete from public.visit_charges where clinic_id in ${tx(clinics)}`;
        await tx`delete from public.refund_grants where clinic_id in ${tx(clinics)}`;
        await tx`delete from public.notification_jobs where clinic_id in ${tx(clinics)}`;
        await tx`delete from public.visits where clinic_id in ${tx(clinics)}`;
      });
      await sql.end({ timeout: 5 });
    }
    if (!admin) return;
    await admin.from("clinics").delete().in("id", [clinicA, clinicB]);
    for (const id of Object.values(people)) await admin.auth.admin.deleteUser(id).catch(() => {});
  });

  it("reception registers a new patient with itemized server prices; forged money fields are refused", async () => {
    as(people.reception, "receptionist");
    const cat = (await read(await catalog())).body.data as { doctors: Array<{ id: string; services: Array<{ id: string; price: number }> }> };
    expect(cat.doctors.find((d) => d.id === doctors.a)?.services.find((s) => s.id === services.ecg)?.price).toBe(60000);

    const forged = await read(
      await register(new NextRequest("http://x", json("POST", { key: randomUUID(), doctorId: doctors.a, serviceIds: [services.consult], newPatient: { fullName: "X Y", dateOfBirth: "1990-01-01" }, clinicId: clinicB, amount: 1 }))),
    );
    expect(forged.status).toBe(400);

    const r = await registerNew(`Aliyeva Nodira ${suffix}`, { documentNumber: "AC 1234567", phone: "+998 90 111 22 33" });
    expect(r.status).toBe(201);
    // Reception cannot open the kassa…
    expect((await read(await kassa())).status).toBe(403);

    // …nor take money.
    expect((await payVisit(r.body.data!.visitId as string, [{ method: "cash", amount: 180000 }], 180000)).status).toBe(403);

    // A passport alone is never looked up: the date of birth is required, on the server too.
    const bare = await read(await searchPatients(new NextRequest(`http://x/api/operations/patients?q=${encodeURIComponent("ac1234567")}`)));
    expect(bare).toMatchObject({ status: 400, body: { code: "dob_required" } });
    // The same person is found again by passport + date of birth and is never duplicated. Staff see name, phone and
    // card number only — no passport, JSHSHIR, date of birth or sex (owner decision 2026-10-08).
    const found = await read(await searchPatients(new NextRequest(`http://x/api/operations/patients?q=${encodeURIComponent("ac1234567")}&dob=1990-05-06`)));
    const matches = found.body.data!.patients as Array<{ id: string; phone: string; patientNumber: number; dobMatches: boolean }>;
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ phone: "+998 90 111 22 33", dobMatches: true });
    expect(Object.keys(matches[0]).sort()).toEqual(["dobMatches", "fullName", "id", "identityVerified", "patientNumber", "phone"]);
    expect(JSON.stringify(found.body)).not.toMatch(/1234567|1990-05-06|female|male/i);
    const dup = await registerNew(`Boshqa ism ${suffix}`, { documentNumber: "AC1234567" });
    expect(dup).toMatchObject({ status: 409, body: { code: "patient_exists", details: { patientId: matches[0].id } } });
    // The same passport with another date of birth: still never a second card, but the desk is not told whose
    // document it is — no card, no id, no name (owner decision 2026-10-08).
    const conflict = await registerNew(`Boshqa ism ${suffix}`, { documentNumber: "AC1234567", dateOfBirth: "1970-01-01" });
    expect(conflict).toMatchObject({ status: 409, body: { code: "identity_conflict" } });
    expect(JSON.stringify(conflict.body)).not.toContain(matches[0].id);
    expect(JSON.stringify(conflict.body)).not.toMatch(/Aliyeva|1990-05-06|matchedPatientId/);
    expect(((await sql`select count(*)::int as n from public.patients where clinic_id = ${clinicA} and document_number = 'AC1234567'`)[0] as { n: number }).n).toBe(1);

    // The owner's one-step lookup: passport + date of birth → exactly this card.
    const exact = (await read(await searchPatients(new NextRequest("http://x?q=AC1234567&dob=1990-05-06")))).body.data!;
    expect(exact).toMatchObject({ exact: true, dobMismatch: false });
    expect((exact.patients as Array<{ id: string }>).map((p) => p.id)).toEqual([matches[0].id]);
    // The right passport with another date of birth: reported, and the card is not shown.
    const wrong = (await read(await searchPatients(new NextRequest("http://x?q=AC1234567&dob=1991-05-06")))).body.data!;
    expect(wrong).toEqual({ patients: [], exact: false, dobMismatch: true });
    // An unknown passport: nothing, so reception opens the new-patient form.
    expect((await read(await searchPatients(new NextRequest("http://x?q=AC7654321&dob=1990-05-06")))).body.data).toEqual({ patients: [], exact: false, dobMismatch: false });

    // Another clinic's reception finds nothing of clinic A.
    as(people.receptionB, "receptionist", clinicB);
    expect(((await read(await searchPatients(new NextRequest("http://x?q=AC1234567&dob=1990-05-06")))).body.data!.patients as unknown[]).length).toBe(0);
  });

  it("the cashier takes a split payment; the queue number appears only then; totals reconcile by method", async () => {
    as(people.reception, "receptionist");
    const r = await registerNew(`Karimov Bobur ${suffix}`);
    const visitId = r.body.data!.visitId as string;

    as(people.cashier, "cashier");
    let open = (await kassaList()).open.find((v) => v.id === visitId)!;
    expect(open).toMatchObject({ status: "awaiting_payment", queueNumber: null, balance: { outstanding: 180000 } });
    expect((await payVisit(visitId, [{ method: "cash", amount: 100000 }], 180000))).toMatchObject({ status: 409, body: { code: "amount_mismatch" } });
    expect((await payVisit(visitId, [{ method: "cash", amount: 180000 }], 120000))).toMatchObject({ status: 409, body: { code: "stale" } });
    const paid = await payVisit(visitId, [{ method: "cash", amount: 80000 }, { method: "terminal", amount: 100000 }], 180000);
    expect(paid.status).toBe(200);
    expect(paid.body.data!.queueNumber).toEqual(expect.any(Number));
    open = (await kassaList()).open.find((v) => v.id === visitId)!;
    expect(open).toMatchObject({ status: "waiting", balance: { outstanding: 0 } });

    const mine = (await read(await totals(new NextRequest("http://x/api/operations/kassa/totals")))).body.data as { scope: string; byMethod: Record<string, { collected: number; net: number }> };
    expect(mine.scope).toBe("mine");
    expect(mine.byMethod.cash.collected).toBeGreaterThanOrEqual(80000);
    expect(mine.byMethod.terminal.collected).toBeGreaterThanOrEqual(100000);
  });

  it("refunds: admin never; cashier only after a manager's grant; partial, by method", async () => {
    as(people.reception, "receptionist");
    const r = await registerNew(`Refund bemor ${suffix}`);
    const visitId = r.body.data!.visitId as string;
    as(people.cashier, "cashier");
    await payVisit(visitId, [{ method: "cash", amount: 180000 }], 180000);
    expect((await kassaList()).canRefund).toBe(false);

    expect(await refundVisit(visitId, { method: "cash", amount: 60000 })).toMatchObject({ status: 403, body: { code: "refund_not_permitted" } });
    as(people.admin, "admin");
    expect((await refundVisit(visitId, { method: "cash", amount: 60000 })).status).toBe(403);

    as(people.manager, "manager");
    expect((await read(await grant(new NextRequest("http://x", json("POST", { cashierId: people.cashier }))))).status).toBe(200);

    as(people.cashier, "cashier");
    expect((await kassaList()).canRefund).toBe(true);
    expect(await refundVisit(visitId, { method: "terminal", amount: 1000 })).toMatchObject({ status: 409, body: { code: "refund_exceeds_paid" } });
    expect((await refundVisit(visitId, { method: "cash", amount: 60000 })).status).toBe(200);
    const row = (await kassaList()).open.find((v) => v.id === visitId)!;
    expect(row.balance.cashNet).toBe(120000);
    const [tx] = await sql<{ executed_by: string; authorized_by: string }[]>`
      select executed_by, authorized_by from public.visit_transactions where visit_id = ${visitId} and kind = 'refund'`;
    expect(tx).toEqual({ executed_by: people.cashier, authorized_by: people.manager });
  });

  it("the doctor works only their own queue; the waiting-room screen shows numbers, never names; the ticket goes to the patient's Telegram", async () => {
    // A Telegram patient, registered and paid.
    const { data: p } = await admin.from("patients").insert({ clinic_id: clinicA, full_name: `Telegram Bemor ${suffix}`, date_of_birth: "1988-01-01", telegram_user_id: tg }).select("id").single();
    as(people.reception, "receptionist");
    const r = await read(await register(new NextRequest("http://x", json("POST", { key: randomUUID(), doctorId: doctors.a, serviceIds: [services.consult], patientId: p!.id }))));
    const visitId = r.body.data!.visitId as string;
    as(people.cashier, "cashier");
    const paid = await payVisit(visitId, [{ method: "terminal", amount: 120000 }], 120000);
    const number = paid.body.data!.queueNumber as number;

    // The digital ticket: to the patient's own chat, with the number and no promised time.
    sent.messages.length = 0;
    await processDueNotificationJobs(50, [clinicA]);
    const ticket = sent.messages.find((m) => m.chatId === tg);
    expect(ticket?.text).toContain(`Navbat raqamingiz: ${number}`);
    expect(ticket?.text).toContain("aniq qabul vaqti emas");
    const { data: job } = await admin.from("notification_jobs").select("status, telegram_message_id").eq("visit_id", visitId).single();
    expect(job).toEqual({ status: "sent", telegram_message_id: 4242 });

    // Public screen: numbers and doctor names only.
    const screen = await read(await publicQueue(new NextRequest("http://x", { headers: { "x-forwarded-for": "10.9.9.9" } }), params({ clinicId: clinicA })));
    expect(screen.status).toBe(200);
    expect(JSON.stringify(screen.body)).toContain(`Dr Navbat ${suffix}`);
    expect(JSON.stringify(screen.body)).not.toContain("Telegram Bemor");
    expect(JSON.stringify(screen.body)).not.toContain(p!.id);

    // Dr C neither sees nor acts on Dr A's patient.
    as(people.drC, "doctor");
    expect(((await read(await doctorQueue())).body.data!.visits as Array<{ id: string }>).some((v) => v.id === visitId)).toBe(false);
    expect((await read(await doctorAct(new NextRequest("http://x", json("POST", { action: "call", expected: "waiting" })), params({ id: visitId })))).status).toBe(403);

    as(people.drA, "doctor");
    expect(((await read(await doctorQueue())).body.data!.visits as Array<{ id: string }>).some((v) => v.id === visitId)).toBe(true);
    expect((await read(await doctorAct(new NextRequest("http://x", json("POST", { action: "call", expected: "waiting" })), params({ id: visitId })))).status).toBe(200);
    // Reception sees it called; a stale action is refused.
    as(people.reception, "receptionist");
    expect((await read(await transition(new NextRequest("http://x", json("POST", { expected: "waiting", status: "called" })), params({ id: visitId })))).body.code).toBe("stale");
    const live = (await read(await queue(new NextRequest("http://x/api/operations/arrivals")))).body.data!.visits as Array<{ id: string; status: string }>;
    expect(live.find((v) => v.id === visitId)?.status).toBe("called");

    if (minutesToClinicMidnight() < 8) return; // a consultation must end before midnight in the clinic
    as(people.drA, "doctor");
    const started = await read(await doctorAct(new NextRequest("http://x", json("POST", { action: "start", expected: "called" })), params({ id: visitId })));
    expect(started).toMatchObject({ status: 200, body: { data: { patientId: p!.id } } });
    const done = await read(await doctorAct(new NextRequest("http://x", json("POST", { action: "complete", expected: "in_progress" })), params({ id: visitId })));
    expect(done).toMatchObject({ status: 200, body: { data: { status: "completed" } } });
  });
});

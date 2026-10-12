import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { localDbAvailable } from "@/test/local-db";
import type { StaffRole } from "@/lib/auth/staff";
import { loadTodayDashboard } from "./today";

/**
 * The staff "Bugun" dashboard against the real database: money received today
 * is counted once per payment and shown only to owner and admin, the live queue
 * and laboratory work reach every desk role, and nothing crosses clinics.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const describeDb = describe.skipIf(!localDbAvailable());

describeDb("today dashboard — one request, the right figures for each role", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const clinic = randomUUID();
  const other = randomUUID();
  const staffer = randomUUID();
  const doctor = randomUUID();
  const doctor2 = randomUUID();
  const otherDoctor = randomUUID();
  const service = randomUUID();
  const otherService = randomUUID();
  const p = { walkIn: randomUUID(), online: randomUUID(), legacy: randomUUID(), lab: randomUUID(), otherClinic: randomUUID() };
  const appt = { online: randomUUID(), legacy: randomUUID() };
  const visit = { walkIn: randomUUID(), online: randomUUID(), otherClinic: randomUUID() };
  const labOrder = randomUUID();
  const now = new Date();
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
  // Both booked appointments start now — inside today's clinic day whatever the hour — with different doctors.
  const startNow = now.toISOString();
  const endSoon = new Date(now.getTime() + 20 * 60_000).toISOString();

  const ctx = (roles: StaffRole[], clinicId = clinic) => ({
    profileId: staffer,
    clinicId,
    clinicName: "Dashboard",
    clinicTimezone: "Asia/Tashkent",
    roles,
    platformAdmin: false,
  });

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 2, onnotice: () => {} });
    // Fixture rows only, with triggers paused: the dashboard reads them; the workflows that write them are tested elsewhere.
    await sql.begin(async (tx) => {
      await tx.unsafe("set local session_replication_role = replica");
      await tx`insert into auth.users ${tx({ id: staffer, email: `dashboard-${suffix}@test.local` })}`;
      await tx`insert into public.profiles ${tx({ id: staffer, full_name: "Dashboard staff" })}`;
      await tx`insert into public.clinics ${tx([
        { id: clinic, name: `Dashboard ${suffix}`, slug: `dashboard-${suffix}`, timezone: "Asia/Tashkent" },
        { id: other, name: `Dashboard other ${suffix}`, slug: `dashboard-o-${suffix}`, timezone: "Asia/Tashkent" },
      ])}`;
      await tx`insert into public.doctors ${tx([
        { id: doctor, clinic_id: clinic, name: "Dr Dashboard", active: true },
        { id: doctor2, clinic_id: clinic, name: "Dr Second", active: true },
        { id: otherDoctor, clinic_id: other, name: "Dr Other", active: true },
      ])}`;
      await tx`insert into public.services ${tx([
        { id: service, clinic_id: clinic, name: "Ko‘rik", duration_minutes: 20, price: 150000 },
        { id: otherService, clinic_id: other, name: "Ko‘rik", duration_minutes: 20, price: 150000 },
      ])}`;
      await tx`insert into public.patients ${tx([
        { id: p.walkIn, clinic_id: clinic, full_name: "Navbat Bemor", patient_number: 1 },
        { id: p.online, clinic_id: clinic, full_name: "Onlayn Bemor", patient_number: 2 },
        { id: p.legacy, clinic_id: clinic, full_name: "Qabul Bemor", patient_number: 3 },
        { id: p.lab, clinic_id: clinic, full_name: "Tahlil Bemor", patient_number: 4 },
        { id: p.otherClinic, clinic_id: other, full_name: "Boshqa Bemor", patient_number: 1 },
      ])}`;
      await tx`insert into public.appointments ${tx([
        { id: appt.online, clinic_id: clinic, patient_id: p.online, doctor_id: doctor, service_id: service, start_at: startNow, end_at: endSoon, status: "confirmed", source: "telegram_mini_app" },
        { id: appt.legacy, clinic_id: clinic, patient_id: p.legacy, doctor_id: doctor2, service_id: service, start_at: startNow, end_at: endSoon, status: "completed", source: "admin" },
      ])}`;
      const today = (await tx<{ d: string }[]>`select (now() at time zone 'Asia/Tashkent')::date::text as d`)[0].d;
      // A walk-in waiting 20 minutes, billed 150 000, paid 100 000 cash of which 20 000 was given back.
      // An online booking paid 80 000 (its payment row AND its visit's online collection — the same money).
      for (const row of [
        { id: visit.walkIn, clinic_id: clinic, patient_id: p.walkIn, doctor_id: doctor, kind: "doctor", status: "waiting", source: "desk", arrived_at: minutesAgo(30), queue_date: today, queue_number: 1, queued_at: minutesAgo(20), created_by: staffer, idempotency_key: randomUUID(), request_fingerprint: "x" },
        { id: visit.online, clinic_id: clinic, patient_id: p.online, doctor_id: doctor, kind: "doctor", status: "booked", source: "online", appointment_id: appt.online, queue_date: today, queue_number: 2, queued_at: minutesAgo(10), idempotency_key: randomUUID(), request_fingerprint: "x" },
        { id: visit.otherClinic, clinic_id: other, patient_id: p.otherClinic, doctor_id: otherDoctor, kind: "doctor", status: "waiting", source: "desk", arrived_at: minutesAgo(5), queue_date: today, queue_number: 1, queued_at: minutesAgo(5), created_by: staffer, idempotency_key: randomUUID(), request_fingerprint: "x" },
      ]) await tx`insert into public.visits ${tx(row)}`;
      await tx`insert into public.visit_charges ${tx({ clinic_id: clinic, visit_id: visit.walkIn, patient_id: p.walkIn, service_id: service, service_name: "Ko‘rik", unit_price: 150000, amount: 150000, currency: "UZS" })}`;
      const t = (v: Record<string, unknown>) => ({ currency: "UZS", request_key: randomUUID(), request_fingerprint: "x", ...v });
      for (const row of [
        t({ clinic_id: clinic, visit_id: visit.walkIn, patient_id: p.walkIn, kind: "collection", method: "cash", amount: 100000, executed_by: staffer, authorized_by: staffer }),
        t({ clinic_id: clinic, visit_id: visit.walkIn, patient_id: p.walkIn, kind: "refund", method: "cash", amount: 20000, reason: "Ortiqcha to‘lov", executed_by: staffer, authorized_by: staffer }),
        t({ clinic_id: clinic, visit_id: visit.online, patient_id: p.online, kind: "collection", method: "online", amount: 80000 }),
        t({ clinic_id: other, visit_id: visit.otherClinic, patient_id: p.otherClinic, kind: "collection", method: "cash", amount: 999000, executed_by: staffer, authorized_by: staffer }),
      ]) await tx`insert into public.visit_transactions ${tx(row)}`;
      await tx`insert into public.lab_orders ${tx({ id: labOrder, clinic_id: clinic, patient_id: p.lab, source: "walk_in", ordered_by: staffer })}`;
      for (const row of [
        { clinic_id: clinic, appointment_id: appt.online, patient_id: p.online, amount: 80000, status: "paid", paid_at: minutesAgo(10) },
        { clinic_id: clinic, appointment_id: appt.legacy, patient_id: p.legacy, amount: 60000, status: "paid", paid_at: minutesAgo(5) },
        { clinic_id: clinic, lab_order_id: labOrder, patient_id: p.lab, amount: 30000, status: "paid", paid_at: minutesAgo(3) },
      ]) await tx`insert into public.payments ${tx(row)}`;
    });
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    await sql.begin(async (tx) => {
      await tx.unsafe("set local session_replication_role = replica");
      for (const table of ["visit_transactions", "visit_charges", "payments", "visits", "lab_orders", "appointments", "patients", "services", "doctors"]) {
        await tx.unsafe(`delete from public.${table} where clinic_id = any($1)`, [[clinic, other]]);
      }
      await tx`delete from public.clinics where id in ${tx([clinic, other])}`;
      await tx`delete from public.profiles where id = ${staffer}`;
      await tx`delete from auth.users where id = ${staffer}`;
    });
    await sql.end({ timeout: 5 });
  });

  it("owner: money received today counts each payment once — kassa, laboratory kassa, appointments outside the kassa", async () => {
    const d = await loadTodayDashboard(ctx(["owner"]), now);
    expect(d.can_view_payment_dynamics).toBe(true);
    expect(d.money).toEqual({
      total: 250000,
      kassa: { cash: 80000, terminal: 0, online: 80000, refunded: 20000, net: 160000 },
      lab: 30000,
      // The online booking's payment row is the same money as its visit's online collection: not counted again.
      appointments: 60000,
      // The walk-in owes 150 000 − 80 000.
      outstanding: 70000,
    });
  });

  it("owner: the live queue, today's appointments and the laboratory in the same answer", async () => {
    const d = await loadTodayDashboard(ctx(["owner"]), now);
    expect(d.queue).toMatchObject({ awaitingPayment: 0, waiting: 1, called: 0, inProgress: 0 });
    expect(d.queue.byQueue).toEqual([expect.objectContaining({ name: "Dr Dashboard", waiting: 1 })]);
    expect(d.queue.longestWaitMinutes).toBeGreaterThanOrEqual(19);
    expect(d.counts.total).toBe(2);
    expect(d.appointments.map((a) => a.patients?.full_name).sort()).toEqual(["Onlayn Bemor", "Qabul Bemor"]);
    expect(d.lab).not.toBeNull();
    expect(d.upcoming_reminders).not.toBeNull();
  });

  it("manager and receptionist get the queue and the laboratory, but no money", async () => {
    for (const roles of [["manager"], ["receptionist"]] as StaffRole[][]) {
      const d = await loadTodayDashboard(ctx(roles), now);
      expect(d.can_view_payment_dynamics, roles[0]).toBe(false);
      expect(d.money, roles[0]).toBeNull();
      expect(d.queue.waiting, roles[0]).toBe(1);
      expect(d.lab, roles[0]).not.toBeNull();
    }
    expect((await loadTodayDashboard(ctx(["receptionist"]), now)).upcoming_reminders).toBeNull();
  });

  it("another clinic sees only its own queue and money", async () => {
    const d = await loadTodayDashboard(ctx(["owner"], other), now);
    expect(d.queue.byQueue).toEqual([expect.objectContaining({ name: "Dr Other", waiting: 1 })]);
    expect(d.money?.kassa.cash).toBe(999000);
    expect(d.money?.lab).toBe(0);
    expect(d.money?.appointments).toBe(0);
    expect(d.appointments).toEqual([]);
  });
});

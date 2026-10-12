import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { localDbAvailable } from "@/test/local-db";

/**
 * GET /api/doctor/today — the doctor's home in one request: only the linked
 * doctor's own appointments of the clinic day, never a colleague's or another
 * clinic's; an unlinked doctor account is told so; other roles are refused.
 * Only the session lookup is mocked; the route reads the local database.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const session = vi.hoisted(() => ({ ctx: null as unknown }));

vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});

import { GET } from "./route";

const describeDb = describe.skipIf(!localDbAvailable());
type Body = { ok: boolean; code?: string; data?: { linked: boolean; doctorName: string | null; appointments: Array<{ id: string; patients: { full_name: string } | null }> } };

describeDb("doctor today — own appointments of the clinic day, in one request", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const clinic = randomUUID();
  const other = randomUUID();
  const users = { me: randomUUID(), colleague: randomUUID(), unlinked: randomUUID(), otherClinic: randomUUID() };
  const doctors = { me: randomUUID(), colleague: randomUUID(), otherClinic: randomUUID() };
  const services = { clinic: randomUUID(), other: randomUUID() };
  const patient = randomUUID();
  const otherPatient = randomUUID();
  const appts = { mine: randomUUID(), mineCancelled: randomUUID(), mineYesterday: randomUUID(), colleague: randomUUID(), otherClinic: randomUUID() };

  const as = (profileId: string, clinicId: string, roles: string[]) => {
    session.ctx = { profileId, clinicId, clinicName: "Today", clinicTimezone: "Asia/Tashkent", roles, platformAdmin: false };
  };
  const call = async () => {
    const res = await GET();
    return { status: res.status, body: (await res.json()) as Body };
  };

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 2, onnotice: () => {} });
    const now = Date.now();
    const at = (offsetMinutes: number) => new Date(now + offsetMinutes * 60_000).toISOString();
    await sql.begin(async (tx) => {
      await tx.unsafe("set local session_replication_role = replica");
      await tx`insert into auth.users ${tx(Object.values(users).map((id, i) => ({ id, email: `doctor-today-${i}-${suffix}@test.local` })))}`;
      await tx`insert into public.profiles ${tx(Object.values(users).map((id) => ({ id, full_name: "Doctor today" })))}`;
      await tx`insert into public.clinics ${tx([
        { id: clinic, name: `Today ${suffix}`, slug: `doctor-today-${suffix}`, timezone: "Asia/Tashkent" },
        { id: other, name: `Today other ${suffix}`, slug: `doctor-today-o-${suffix}`, timezone: "Asia/Tashkent" },
      ])}`;
      await tx`insert into public.doctors ${tx([
        { id: doctors.me, clinic_id: clinic, name: "Dr Men", profile_id: users.me, active: true },
        { id: doctors.colleague, clinic_id: clinic, name: "Dr Hamkasb", profile_id: users.colleague, active: true },
        { id: doctors.otherClinic, clinic_id: other, name: "Dr Boshqa", profile_id: users.otherClinic, active: true },
      ])}`;
      await tx`insert into public.services ${tx([
        { id: services.clinic, clinic_id: clinic, name: "Ko‘rik", duration_minutes: 20, price: 1 },
        { id: services.other, clinic_id: other, name: "Ko‘rik", duration_minutes: 20, price: 1 },
      ])}`;
      await tx`insert into public.patients ${tx([
        { id: patient, clinic_id: clinic, full_name: "Bugungi Bemor", patient_number: 1 },
        { id: otherPatient, clinic_id: other, full_name: "Boshqa Bemor", patient_number: 1 },
      ])}`;
      const row = (id: string, clinicId: string, doctorId: string, patientId: string, serviceId: string, start: string, status: string) => ({
        id, clinic_id: clinicId, doctor_id: doctorId, patient_id: patientId, service_id: serviceId, start_at: start, end_at: new Date(Date.parse(start) + 60_000).toISOString(), status,
      });
      for (const r of [
        row(appts.mine, clinic, doctors.me, patient, services.clinic, at(0), "confirmed"),
        row(appts.mineCancelled, clinic, doctors.me, patient, services.clinic, at(0), "cancelled"),
        row(appts.mineYesterday, clinic, doctors.me, patient, services.clinic, at(-26 * 60), "completed"),
        row(appts.colleague, clinic, doctors.colleague, patient, services.clinic, at(0), "confirmed"),
        row(appts.otherClinic, other, doctors.otherClinic, otherPatient, services.other, at(0), "confirmed"),
      ]) await tx`insert into public.appointments ${tx(r)}`;
    });
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    await sql.begin(async (tx) => {
      await tx.unsafe("set local session_replication_role = replica");
      for (const table of ["appointments", "patients", "services", "doctors"]) {
        await tx.unsafe(`delete from public.${table} where clinic_id = any($1)`, [[clinic, other]]);
      }
      await tx`delete from public.clinics where id in ${tx([clinic, other])}`;
      await tx`delete from public.profiles where id in ${tx(Object.values(users))}`;
      await tx`delete from auth.users where id in ${tx(Object.values(users))}`;
    });
    await sql.end({ timeout: 5 });
  });

  it("returns only the linked doctor's own active appointments of today", async () => {
    as(users.me, clinic, ["doctor"]);
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body.data!.linked).toBe(true);
    expect(body.data!.doctorName).toBe("Dr Men");
    // Not the cancelled one, not yesterday's, not the colleague's, not another clinic's.
    expect(body.data!.appointments.map((a) => a.id)).toEqual([appts.mine]);
    expect(body.data!.appointments[0].patients?.full_name).toBe("Bugungi Bemor");
  });

  it("a doctor account without a linked doctor record is told so — with no appointments", async () => {
    as(users.unlinked, clinic, ["doctor"]);
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body.data).toEqual({ linked: false, doctorName: null, appointments: [] });
  });

  it("a doctor signed in to the wrong clinic sees nothing of it", async () => {
    as(users.otherClinic, clinic, ["doctor"]);
    const { body } = await call();
    expect(body.data!.linked).toBe(false);
  });

  it("other roles are refused", async () => {
    as(users.me, clinic, ["receptionist"]);
    const { status } = await call();
    expect(status).toBe(403);
  });
});

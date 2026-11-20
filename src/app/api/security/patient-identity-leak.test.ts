import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import postgres from "postgres";
import { localDbAvailable } from "@/test/local-db";

/**
 * No staff-facing API returns a patient's identity values (owner decision 2026-10-08, 20261008000005): marker values
 * are planted in a patient's passport/ID number, JSHSHIR, date of birth and home address, then every route that reads
 * patients for staff is called the way its screen calls it, and the whole response is searched for the markers. The
 * desk, the lab, management, the merge tool and the doctor's workspace all still work — with name, phone, card number
 * and (where clinical work needs it) an age.
 *
 * Mocked: only the staff session lookup (getStaffContext).
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const session = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});

import { GET as receptionSearch } from "@/app/api/operations/patients/route";
import { GET as directory } from "@/app/api/admin/patients/route";
import { GET as labSearch } from "@/app/api/lab/patients/route";
import { GET as mergePreview } from "@/app/api/admin/patients/merge/route";
import { GET as duplicates } from "@/app/api/admin/patients/duplicates/route";
import { GET as doctorWorkspace } from "@/app/api/doctor/patients/[id]/route";
import { GET as doctorPatients } from "@/app/api/doctor/patients/route";

const describeDb = describe.skipIf(!localDbAvailable());
type Body = { ok: boolean; data?: Record<string, unknown>; code?: string };

describeDb("patient identity never leaves the server through a staff API", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const clinic = randomUUID();
  const people = { owner: randomUUID(), reception: randomUUID(), lab: randomUUID(), doctor: randomUUID() };
  const doctorId = randomUUID();
  const service = randomUUID();
  const patient = randomUUID();
  const twin = randomUUID();
  const name = `Markerova Dilnoza ${suffix}`;
  const M = {
    document: `QX${String(Date.now()).slice(-7)}`,
    pinfl: `4${String(Date.now()).slice(-13).padStart(13, "3")}`,
    dob: "1966-03-17",
    dobShown: "17.03.1966",
    address: `Markerlar mahallasi ${suffix}`,
  };

  const as = (profileId: string, role: string) => {
    session.ctx = { profileId, clinicId: clinic, clinicName: "Leak", clinicTimezone: "Asia/Tashkent", roles: [role], platformAdmin: false };
  };
  const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Body });
  const get = (url: string) => new NextRequest(`http://localhost${url}`);
  /** The response, whole, must not contain any planted identity value. */
  const clean = (label: string, r: { status: number; body: Body }) => {
    expect(r.status, `${label}: ${JSON.stringify(r.body).slice(0, 200)}`).toBe(200);
    const text = JSON.stringify(r.body);
    for (const [k, v] of Object.entries(M)) expect(text, `${label} leaks ${k}`).not.toContain(v);
    // Any date-of-birth field carrying a date (plan codes such as "same" are fine).
    expect(text, `${label} leaks a date_of_birth field`).not.toMatch(/"date_?[oO]f_?[bB]irth"\s*:\s*"\d{4}-\d{2}-\d{2}/);
  };

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 4, onnotice: () => {} });
    await sql`insert into public.clinics ${sql({ id: clinic, name: `Leak ${suffix}`, slug: `leak-${suffix}`, timezone: "Asia/Tashkent" })}`;
    const users = Object.entries(people).map(([n, id]) => ({ id, email: `leak-${n}-${suffix}@test.local` }));
    await sql`insert into auth.users ${sql(users)}`;
    await sql`insert into public.profiles ${sql(users.map((u) => ({ id: u.id, full_name: u.email })))}`;
    await sql`insert into public.staff_roles ${sql([
      { clinic_id: clinic, profile_id: people.owner, role: "owner" },
      { clinic_id: clinic, profile_id: people.reception, role: "receptionist" },
      { clinic_id: clinic, profile_id: people.lab, role: "lab" },
      { clinic_id: clinic, profile_id: people.doctor, role: "doctor" },
    ])}`;
    await sql`insert into public.doctors ${sql({ id: doctorId, clinic_id: clinic, profile_id: people.doctor, name: `Dr Leak ${suffix}`, active: true })}`;
    await sql`insert into public.services ${sql({ id: service, clinic_id: clinic, name: `Leak consult ${suffix}`, duration_minutes: 30, price: 1 })}`;
    await sql`insert into public.doctor_working_hours ${sql([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinic, doctor_id: doctorId, weekday, start_time: "00:00", end_time: "23:59" })))}`;
    await sql`insert into public.patients ${sql({ id: patient, clinic_id: clinic, full_name: name, phone: "+998 91 777 66 55", document_number: M.document, pinfl: M.pinfl, date_of_birth: M.dob, sex: "female", home_address: M.address })}`;
    // A second record of the same person (same name and date of birth): what the duplicates screen proposes.
    await sql`insert into public.patients ${sql({ id: twin, clinic_id: clinic, full_name: name, phone: "+998 91 777 66 55", date_of_birth: M.dob })}`;
    const start = new Date(Date.UTC(2024, 1, 5, 5, 0));
    await sql`insert into public.appointments ${sql({
      clinic_id: clinic, patient_id: patient, doctor_id: doctorId, service_id: service, start_at: start,
      end_at: new Date(start.getTime() + 1_800_000), status: "completed", source: "walk_in",
    })}`;
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from public.rate_limit_buckets where key like ${`%${people.doctor}%`}`.catch(() => undefined);
    await sql`delete from public.clinics where id = ${clinic}`;
    await sql`delete from auth.users where id in ${sql(Object.values(people))}`;
    await sql.end({ timeout: 5 });
  });

  it("reception: the passport + date-of-birth lookup finds the card and returns name, phone and card number only", async () => {
    as(people.reception, "receptionist");
    const byDocument = await read(await receptionSearch(get(`/api/operations/patients?q=${M.document}&dob=${M.dob}`)));
    clean("reception by passport", byDocument);
    expect(byDocument.body.data).toMatchObject({ exact: true });
    const byPinfl = await read(await receptionSearch(get(`/api/operations/patients?q=${M.pinfl}&dob=${M.dob}`)));
    clean("reception by JSHSHIR", byPinfl);
    expect(byPinfl.body.data).toMatchObject({ exact: true });
    clean("reception by name", await read(await receptionSearch(get(`/api/operations/patients?q=${encodeURIComponent(name)}`))));
    clean("reception by name + date", await read(await receptionSearch(get(`/api/operations/patients?q=${encodeURIComponent(name)}&dob=${M.dob}`))));
    // A passport alone is refused (the date of birth is required on the server).
    expect((await read(await receptionSearch(get(`/api/operations/patients?q=${M.document}`)))).body.code).toBe("dob_required");
  });

  it("the patient directory: list and card — whether a date of birth is recorded, never what it is", async () => {
    as(people.reception, "receptionist");
    clean("directory list", await read(await directory(get(`/api/admin/patients?q=${encodeURIComponent(name)}`))));
    const card = await read(await directory(get(`/api/admin/patients?id=${patient}`)));
    clean("directory card", card);
    expect(card.body.data!.patient).toMatchObject({ full_name: name, phone: "+998 91 777 66 55", has_date_of_birth: true, has_sex: true });
  });

  it("the laboratory: patient search shows name, age and phone", async () => {
    as(people.lab, "lab");
    const r = await read(await labSearch(get(`/api/lab/patients?q=${encodeURIComponent(name)}`)));
    clean("lab search", r);
    expect((r.body.data!.patients as Array<{ id: string; age: number }>).find((p) => p.id === patient)?.age).toBeGreaterThan(50);
  });

  it("the owner's merge tool: duplicates and the preview carry an age and an opaque token", async () => {
    as(people.owner, "owner");
    const d = await read(await duplicates());
    clean("duplicates", d);
    const preview = await read(await mergePreview(get(`/api/admin/patients/merge?canonical=${patient}&duplicate=${twin}`)));
    clean("merge preview", preview);
    expect(preview.body.data!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the doctor's workspace and patient list: clinical history with the name — no identity values", async () => {
    as(people.doctor, "doctor");
    clean("doctor workspace", await read(await doctorWorkspace(get(`/api/doctor/patients/${patient}`), { params: Promise.resolve({ id: patient }) })));
    clean("doctor patients", await read(await doctorPatients(get(`/api/doctor/patients?q=${encodeURIComponent(name)}`))));
  });
});

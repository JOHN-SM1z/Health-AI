import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";

/**
 * Patient date of birth and sex (Phase 21, finding B1), through the real
 * routes and database. The database refuses a lab order for a patient
 * without a date of birth, and before this route nothing in the application
 * could record one — so a real clinic could not order any lab test. Here the
 * front desk records it, the order then goes through, and the change is
 * audited without its values.
 */

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const session = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});

import { PATCH as setDemographics } from "./patients/demographics/route";
import { GET as patients } from "./patients/route";
import { GET as preview, POST as merge } from "./patients/merge/route";
import { POST as walkInOrder } from "../lab/orders/route";

const describeDb = describe.skipIf(!localDbAvailable());

type Body = { ok: boolean; data?: Record<string, unknown>; code?: string };
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Body });

describeDb("patient date of birth and sex (real database)", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const people = { owner: randomUUID(), reception: randomUUID(), manager: randomUUID(), doctor: randomUUID(), lab: randomUUID(), ownerB: randomUUID() };
  let test = "";

  const as = (profileId: string, role: string, clinicId = clinicA) => {
    session.ctx = { profileId, clinicId, clinicName: "Demo", clinicTimezone: "Asia/Tashkent", roles: [role], platformAdmin: false };
  };
  const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const set = async (patientId: string, dateOfBirth: unknown, sex: unknown = null) =>
    read(await setDemographics(new NextRequest("http://localhost/api/admin/patients/demographics", json("PATCH", { patientId, dateOfBirth, sex }))));
  const order = async (patientId: string) =>
    read(await walkInOrder(new NextRequest("http://localhost/api/lab/orders", json("POST", { idempotencyKey: randomUUID(), patientId, testIds: [test] }))));
  const newPatient = async (clinicId = clinicA, extra: Record<string, unknown> = {}) => {
    const { data, error } = await admin.from("patients").insert({ clinic_id: clinicId, full_name: `Demo bemor ${suffix}`, ...extra }).select("id").single();
    if (error) throw new Error(error.message);
    return data!.id as string;
  };
  const row = async (id: string) => (await admin.from("patients").select("date_of_birth, sex").eq("id", id).single()).data!;

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { error: clinicError } = await admin.from("clinics").insert([
      { id: clinicA, name: `Demo A ${suffix}`, slug: `demo-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Demo B ${suffix}`, slug: `demo-b-${suffix}`, timezone: "Asia/Tashkent" },
    ]);
    if (clinicError) throw new Error(clinicError.message);
    for (const [name, id] of Object.entries(people)) {
      const { error } = await admin.auth.admin.createUser({ id, email: `demo-${name}-${suffix}@test.local`, email_confirm: true, password: `Pw-${randomUUID()}` });
      if (error) throw new Error(error.message);
      await admin.from("profiles").insert({ id, full_name: name });
    }
    const { error: rolesError } = await admin.from("staff_roles").insert([
      { clinic_id: clinicA, profile_id: people.owner, role: "owner" },
      { clinic_id: clinicA, profile_id: people.reception, role: "receptionist" },
      { clinic_id: clinicA, profile_id: people.manager, role: "manager" },
      { clinic_id: clinicA, profile_id: people.doctor, role: "doctor" },
      { clinic_id: clinicA, profile_id: people.lab, role: "lab" },
      { clinic_id: clinicB, profile_id: people.ownerB, role: "owner" },
    ]);
    if (rolesError) throw new Error(rolesError.message);
    const { data, error } = await admin.from("lab_tests").insert({ clinic_id: clinicA, code: `DOB${suffix}`.slice(0, 32), name: "Umumiy qon", sample_type: "Qon", price: 50000 }).select("id").single();
    if (error) throw new Error(error.message);
    test = data!.id;
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.from("clinics").delete().in("id", [clinicA, clinicB]);
    for (const id of Object.values(people)) await admin.auth.admin.deleteUser(id);
  });

  it("a patient without a date of birth cannot be ordered for; once reception records it, the order goes through", async () => {
    const patient = await newPatient();
    as(people.lab, "lab");
    expect((await order(patient)).body.code).toBe("dob_required");

    as(people.reception, "receptionist");
    const saved = await set(patient, "1984-02-29", "female");
    expect(saved).toMatchObject({ status: 200, body: { data: { dateOfBirth: "1984-02-29", sex: "female", changed: true } } });
    expect(await row(patient)).toEqual({ date_of_birth: "1984-02-29", sex: "female" });

    // The patient card shows what was recorded.
    const card = await read(await patients(new NextRequest(`http://localhost/api/admin/patients?id=${patient}`)));
    expect(card.body.data!.patient).toMatchObject({ date_of_birth: "1984-02-29", sex: "female" });

    as(people.lab, "lab");
    expect((await order(patient)).status).toBe(201);
  });

  it("is audited with the changed field names only — never the values; an unchanged save writes nothing", async () => {
    const patient = await newPatient();
    as(people.manager, "manager");
    expect((await set(patient, "1990-07-15")).status).toBe(200);
    expect((await set(patient, "1990-07-15", "male")).status).toBe(200);
    const unchanged = await set(patient, "1990-07-15", "male");
    expect(unchanged.body.data!.changed).toBe(false);

    const { data: audit } = await admin
      .from("audit_events")
      .select("action, actor_id, actor_type, entity_id, patient_id, old_values, new_values, metadata")
      .eq("action", "patient_demographics_updated")
      .eq("patient_id", patient)
      .order("created_at");
    expect(audit).toEqual([
      { action: "patient_demographics_updated", actor_id: people.manager, actor_type: "staff", entity_id: patient, patient_id: patient, old_values: null, new_values: null, metadata: { fields: ["date_of_birth"] } },
      { action: "patient_demographics_updated", actor_id: people.manager, actor_type: "staff", entity_id: patient, patient_id: patient, old_values: null, new_values: null, metadata: { fields: ["sex"] } },
    ]);
    expect(JSON.stringify(audit)).not.toMatch(/1990|male/);

    // Sex can go back to unknown; it is never guessed.
    expect((await set(patient, "1990-07-15", null)).status).toBe(200);
    expect(await row(patient)).toEqual({ date_of_birth: "1990-07-15", sex: null });
  });

  it("refuses invalid dates: wrong format, impossible, before 1900, in the future, or missing", async () => {
    const patient = await newPatient();
    as(people.reception, "receptionist");
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    for (const bad of ["15.07.1990", "1990-02-30", "1899-12-31", tomorrow, "", null]) {
      const res = await set(patient, bad);
      expect(res.status, String(bad)).toBe(400);
    }
    expect((await set(patient, "1990-07-15", "unknown")).status).toBe(400);
    expect(await row(patient)).toEqual({ date_of_birth: null, sex: null });
  });

  it("only front desk and management, only in their own clinic, never on a merged record", async () => {
    const patient = await newPatient();
    for (const [who, role] of [[people.doctor, "doctor"], [people.lab, "lab"]] as const) {
      as(who, role);
      expect((await set(patient, "1990-07-15")).status).toBe(403);
    }
    // Another clinic's owner: the patient does not exist for them.
    as(people.ownerB, "owner", clinicB);
    expect((await set(patient, "1990-07-15")).status).toBe(404);
    expect(await row(patient)).toEqual({ date_of_birth: null, sex: null });

    // A record merged into another takes no changes; the canonical record does.
    as(people.owner, "owner");
    const canonical = await newPatient(clinicA, { date_of_birth: "1970-01-01" });
    const duplicate = await newPatient(clinicA, { date_of_birth: "1970-01-01" });
    const p = await read(await preview(new NextRequest(`http://localhost/api/admin/patients/merge?canonical=${canonical}&duplicate=${duplicate}`)));
    expect(p.body.data!.blockers).toEqual([]);
    const m = await read(await merge(new NextRequest("http://localhost/api/admin/patients/merge", json("POST", { canonicalId: canonical, duplicateId: duplicate, reason: "Bir odam, pasport bilan tekshirildi", fingerprint: p.body.data!.fingerprint, confirmSamePerson: true }))));
    expect(m.status).toBe(201);
    expect((await set(duplicate, "1971-01-01")).body.code).toBe("patient_merged");
    expect((await row(duplicate)).date_of_birth).toBe("1970-01-01");
    expect((await set(canonical, "1971-01-01")).status).toBe(200);
  });
});

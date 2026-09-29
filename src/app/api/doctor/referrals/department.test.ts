import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { localDbAvailable } from "@/test/local-db";

/**
 * Department referrals through the real routes, against the local Supabase
 * stack. A referral goes to a department (a specialty), a doctor, or both; an
 * untaken department referral waits in every department doctor's incoming list
 * (accept only — nobody can decline it for the others); the first acceptance
 * makes that doctor its receiving doctor and it leaves the others' lists. The
 * history is theirs from the moment it exists. Only the session lookup is
 * mocked; the handlers, services, decisions, triggers and audit run for real.
 *
 * Cast: Dr A (general medicine, refers), Dr B and Dr B2 (cardiology), Dr C
 * (dermatology, unrelated), Dr K (another clinic, a department of the same name).
 */

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const TZ = "Asia/Tashkent";

const session = vi.hoisted(() => ({ ctx: null as unknown }));

vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});

import { POST as createReferral, GET as listReferrals } from "./route";
import { GET as getReferral, PATCH as actOnReferral } from "./[id]/route";
import { GET as pendingCount } from "./pending-count/route";
import { GET as recipients } from "./recipients/route";
import { GET as getWorkspace } from "../patients/[id]/route";

const describeDb = describe.skipIf(!localDbAvailable());

type Body = { ok: boolean; data?: Record<string, unknown>; code?: string; error?: string };
type Summary = {
  id: string;
  status: string;
  role?: string;
  allowedActions: string[];
  department: { id: string; name: string } | null;
  referredToDoctor: { id: string } | null;
};

describeDb("department referrals — through the real routes", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const users: Record<string, string> = {};
  const clinicOf: Record<string, string> = {};
  const doctors: Record<string, string> = {};
  let clinic: string;
  let otherClinic: string;
  let cardiology: string;
  let general: string;
  let dermatology: string;
  let cardiologyOther: string;
  let service: string;
  let day = 0;

  const REASON = `Exertional chest pain, please assess (${suffix})`;

  const as = (name: string) => {
    session.ctx = { profileId: users[name], clinicId: clinicOf[name], clinicName: "Department Clinic", clinicTimezone: TZ, roles: ["doctor"], platformAdmin: false };
  };
  const request = (method: string, path: string, body?: unknown) =>
    new NextRequest(`http://localhost${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Body });
  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  async function makeUser(name: string, clinicId: string) {
    const { data, error } = await admin.auth.admin.createUser({ email: `department-${name}-${suffix}@test.local`, password: "Department-Test-123!", email_confirm: true });
    expect(error).toBeNull();
    users[name] = data.user!.id;
    clinicOf[name] = clinicId;
    await admin.from("profiles").insert({ id: users[name], full_name: name });
    await admin.from("staff_roles").insert({ clinic_id: clinicId, profile_id: users[name], role: "doctor" });
  }
  async function makeDoctor(name: string, specialtyId: string) {
    const { data } = await admin
      .from("doctors")
      .insert({ clinic_id: clinicOf[name], profile_id: users[name], name: `Dr ${name.toUpperCase()} ${suffix}`, specialty_id: specialtyId, active: true })
      .select("id")
      .single();
    doctors[name] = data!.id;
    await admin.from("doctor_working_hours").insert(
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinicOf[name], doctor_id: data!.id, weekday, start_time: "00:00", end_time: "23:59" })),
    );
  }

  /** A patient with one completed consultation with `by` (the visit a referral is raised from). */
  async function patientOf(by = "a") {
    const { data } = await admin.from("patients").insert({ clinic_id: clinic, full_name: `Department patient ${suffix}`, phone: "+998901230000" }).select("id").single();
    const start = new Date(Date.UTC(2026, 0, 5, 5, 0) + day++ * 86_400_000);
    const { data: visit, error } = await admin
      .from("appointments")
      .insert({
        clinic_id: clinic,
        patient_id: data!.id,
        doctor_id: doctors[by],
        service_id: service,
        start_at: start.toISOString(),
        end_at: new Date(start.getTime() + 30 * 60_000).toISOString(),
        status: "completed",
        source: "walk_in",
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return { id: data!.id as string, consultation: visit!.id as string };
  }

  const refer = async (by: string, x: { consultation: string }, target: Record<string, unknown>) => {
    as(by);
    return read(
      await createReferral(
        request("POST", "/api/doctor/referrals", { idempotencyKey: randomUUID(), appointmentId: x.consultation, reason: REASON, handoffNote: "ECG attached.", priority: "routine", ...target }),
      ),
    );
  };
  const referralId = (res: { body: Body }) => (res.body.data!.referral as { id: string }).id;
  const incoming = async (name: string) => {
    as(name);
    return ((await read(await listReferrals(request("GET", "/api/doctor/referrals?box=incoming")))).body.data!.referrals as Summary[]) ?? [];
  };
  const outgoing = async (name: string) => {
    as(name);
    return ((await read(await listReferrals(request("GET", "/api/doctor/referrals?box=outgoing")))).body.data!.referrals as Summary[]) ?? [];
  };
  const badge = async (name: string) => {
    as(name);
    return ((await read(await pendingCount())).body.data as { pending: number }).pending;
  };
  const act = async (name: string, id: string, body: Record<string, unknown>) => {
    as(name);
    return read(await actOnReferral(request("PATCH", `/api/doctor/referrals/${id}`, body), params(id)));
  };
  const detail = async (name: string, id: string) => {
    as(name);
    return read(await getReferral(request("GET", `/api/doctor/referrals/${id}`), params(id)));
  };
  const workspace = async (name: string, patientId: string) => {
    as(name);
    return read(await getWorkspace(request("GET", `/api/doctor/patients/${patientId}`), params(patientId)));
  };
  const row = async (id: string) =>
    (await admin.from("referrals").select("status, referred_to_doctor_id, referred_to_specialty_id, accepted_by").eq("id", id).single()).data!;
  const revoke = (id: string) => act("a", id, { action: "revoke", reason: "Referred in error" });

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { data: c1 } = await admin.from("clinics").insert({ name: `Department ${suffix}`, slug: `department-${suffix}`, timezone: TZ }).select("id").single();
    const { data: c2 } = await admin.from("clinics").insert({ name: `Department other ${suffix}`, slug: `department-other-${suffix}`, timezone: TZ }).select("id").single();
    clinic = c1!.id;
    otherClinic = c2!.id;
    const { data: specialties } = await admin
      .from("specialties")
      .insert([
        { clinic_id: clinic, name: `Terapiya ${suffix}` },
        { clinic_id: clinic, name: `Kardiologiya ${suffix}` },
        { clinic_id: clinic, name: `Dermatologiya ${suffix}` },
        { clinic_id: otherClinic, name: `Kardiologiya ${suffix}` },
      ])
      .select("id, name, clinic_id");
    const pick = (prefix: string, clinicId: string) => specialties!.find((s) => s.name.startsWith(prefix) && s.clinic_id === clinicId)!.id as string;
    general = pick("Terapiya", clinic);
    cardiology = pick("Kardiologiya", clinic);
    dermatology = pick("Dermatologiya", clinic);
    cardiologyOther = pick("Kardiologiya", otherClinic);
    for (const name of ["a", "b", "b2", "c"]) await makeUser(name, clinic);
    await makeUser("k", otherClinic);
    await makeDoctor("a", general);
    await makeDoctor("b", cardiology);
    await makeDoctor("b2", cardiology);
    await makeDoctor("c", dermatology);
    await makeDoctor("k", cardiologyOther);
    const { data: svc } = await admin
      .from("services")
      .insert({ clinic_id: clinic, name: `Department consult ${suffix}`, duration_minutes: 30, price: 100000, active: true })
      .select("id")
      .single();
    service = svc!.id;
  });

  afterAll(async () => {
    if (!admin || !clinic) return;
    for (const clinicId of [clinic, otherClinic]) {
      await admin.from("staff_roles").delete().eq("clinic_id", clinicId);
      await admin.from("clinics").delete().eq("id", clinicId);
    }
    for (const id of Object.values(users)) await admin.auth.admin.deleteUser(id).catch(() => {});
  });

  it("creating: a department alone, or a doctor with their own department — and the recipient rules", async () => {
    const x = await patientOf();
    const toDepartment = await refer("a", x, { referredToSpecialtyId: cardiology });
    expect(toDepartment.status).toBe(201);
    expect(await row(referralId(toDepartment))).toEqual({ status: "pending", referred_to_doctor_id: null, referred_to_specialty_id: cardiology, accepted_by: null });

    const y = await patientOf();
    const toDoctor = await refer("a", y, { referredToDoctorId: doctors.b, referredToSpecialtyId: cardiology });
    expect(toDoctor.status).toBe(201);
    expect(await row(referralId(toDoctor))).toMatchObject({ referred_to_doctor_id: doctors.b, referred_to_specialty_id: cardiology });

    const z = await patientOf();
    // A doctor of another department than the named one, another clinic's department, no recipient at all.
    expect(await refer("a", z, { referredToDoctorId: doctors.c, referredToSpecialtyId: cardiology })).toMatchObject({ status: 400, body: { code: "doctor_not_in_department" } });
    expect(await refer("a", z, { referredToSpecialtyId: cardiologyOther })).toMatchObject({ status: 404, body: { code: "department_not_found" } });
    expect((await refer("a", z, {})).status).toBe(400);
    // The department the referring doctor is alone in has no one to receive it.
    expect(await refer("a", z, { referredToSpecialtyId: general })).toMatchObject({ status: 404, body: { code: "department_not_found" } });
    // The same patient to the same department again while the first is open.
    expect(await refer("a", x, { referredToSpecialtyId: cardiology })).toMatchObject({ status: 409, body: { code: "referral_already_open" } });
    await revoke(referralId(toDepartment));
    await revoke(referralId(toDoctor));
  });

  it("recipients: this clinic's departments and colleagues only", async () => {
    as("a");
    const res = await read(await recipients());
    expect(res.status).toBe(200);
    const data = res.body.data as { doctors: Array<{ id: string; specialtyId: string | null }>; departments: Array<{ id: string; name: string }> };
    expect(data.departments.map((d) => d.id).sort()).toEqual([cardiology, dermatology].sort());
    expect(data.doctors.map((d) => d.id).sort()).toEqual([doctors.b, doctors.b2, doctors.c].sort());
    expect(JSON.stringify(res.body)).not.toContain(doctors.k);
    expect(JSON.stringify(res.body)).not.toContain(cardiologyOther);
  });

  it("an untaken referral is in every department doctor's incoming list and badge — accept only — and in nobody else's", async () => {
    const x = await patientOf();
    // The badge counts pending referrals; earlier tests may have left some open, so compare.
    const before = Object.fromEntries(await Promise.all(["b", "b2", "c", "k", "a"].map(async (n) => [n, await badge(n)] as const)));
    const id = referralId(await refer("a", x, { referredToSpecialtyId: cardiology }));

    for (const name of ["b", "b2"]) {
      expect((await incoming(name)).filter((r) => r.id === id)).toEqual([
        expect.objectContaining({ status: "pending", allowedActions: ["accept"], referredToDoctor: null, department: expect.objectContaining({ id: cardiology }) }),
      ]);
      expect(await badge(name), name).toBe(before[name] + 1);
    }
    for (const name of ["c", "k", "a"]) {
      expect((await incoming(name)).map((r) => r.id), name).not.toContain(id);
      expect(await badge(name), name).toBe(before[name]);
    }
    expect((await outgoing("a")).find((r) => r.id === id)).toMatchObject({ status: "pending", allowedActions: ["revoke"], referredToDoctor: null, department: { id: cardiology } });
    await revoke(id);
  });

  it("the detail view of an untaken referral: role receiver, the history at once, audited as referral_opened", async () => {
    const x = await patientOf();
    const id = referralId(await refer("a", x, { referredToSpecialtyId: cardiology }));

    const opened = await detail("b", id);
    expect(opened.status).toBe(200);
    const view = opened.body.data!.referral as { role: string; status: string; patientRecordAccessible: boolean; history: Array<{ id: string }>; allowedActions: string[]; department: { id: string } };
    expect(view).toMatchObject({ role: "receiver", status: "pending", patientRecordAccessible: true, allowedActions: ["accept"], department: { id: cardiology } });
    expect(view.history.length).toBeGreaterThanOrEqual(1);
    const { data: audited } = await admin.from("audit_events").select("actor_id, metadata").eq("action", "referral_opened").eq("referral_id", id);
    expect(audited).toEqual([{ actor_id: users.b, metadata: expect.objectContaining({ via: "detail", role: "receiver", history_shared: true }) }]);
    await revoke(id);
  });

  it("nobody can decline an untaken department referral — not even a department doctor", async () => {
    const x = await patientOf();
    const id = referralId(await refer("a", x, { referredToSpecialtyId: cardiology }));
    const declined = await act("b", id, { action: "decline", reason: "Not mine to decline" });
    expect(declined.status).toBe(409);
    expect(await row(id)).toMatchObject({ status: "pending", referred_to_doctor_id: null });
    await revoke(id);
  });

  it("the first acceptance takes it: the doctor becomes the receiving doctor, it leaves the others' lists, and only they keep the history", async () => {
    const x = await patientOf();
    const id = referralId(await refer("a", x, { referredToSpecialtyId: cardiology }));

    // A forged claim in the body cannot name another doctor.
    const forged = await act("b", id, { action: "accept", referredToDoctorId: doctors.b2 });
    expect([200, 400]).toContain(forged.status);
    expect((await row(id)).referred_to_doctor_id).not.toBe(doctors.b2);
    if (forged.status === 400) expect(await act("b", id, { action: "accept" })).toMatchObject({ status: 200 });

    expect(await row(id)).toEqual({ status: "accepted", referred_to_doctor_id: doctors.b, referred_to_specialty_id: cardiology, accepted_by: users.b });
    expect((await incoming("b")).find((r) => r.id === id)).toMatchObject({ status: "accepted", referredToDoctor: { id: doctors.b } });
    // Gone from Dr B2's list and badge; B2 can neither accept it nor open the patient.
    expect((await incoming("b2")).map((r) => r.id)).not.toContain(id);
    expect((await act("b2", id, { action: "accept" })).status).toBeGreaterThanOrEqual(400);
    expect((await detail("b2", id)).status).toBeGreaterThanOrEqual(400);
    expect(await workspace("b2", x.id)).toMatchObject({ status: 404, body: { code: "patient_not_found" } });
    // Dr B has the history.
    expect((await workspace("b", x.id)).status).toBe(200);
    await revoke(id);
  });

  it("revoked while untaken: every department doctor loses it — lists, badge, patient", async () => {
    const x = await patientOf();
    const id = referralId(await refer("a", x, { referredToSpecialtyId: cardiology }));
    expect((await workspace("b", x.id)).status).toBe(200);
    expect(await revoke(id)).toMatchObject({ status: 200, body: { data: { status: "revoked" } } });

    for (const name of ["b", "b2"]) {
      expect((await incoming(name)).map((r) => r.id), name).not.toContain(id);
      // They were never named on it, so nothing tells them a referral existed.
      expect(await workspace(name, x.id), name).toMatchObject({ status: 404, body: { code: "patient_not_found" } });
      expect((await detail(name, id)).status, name).toBeGreaterThanOrEqual(400);
    }
  });

  it("a doctor never receives the department referral they raised themselves", async () => {
    const x = await patientOf("b");
    const badgeBefore = await badge("b");
    const id = referralId(await refer("b", x, { referredToSpecialtyId: cardiology }));

    // Dr B2 receives it; Dr B — the referrer — has it only as their outgoing referral.
    expect((await incoming("b2")).map((r) => r.id)).toContain(id);
    expect((await incoming("b")).map((r) => r.id)).not.toContain(id);
    expect((await outgoing("b")).find((r) => r.id === id)).toMatchObject({ allowedActions: ["revoke"] });
    expect(await badge("b")).toBe(badgeBefore);
    // On it as the referrer, so accepting is a wrong-side action (403), whatever the department.
    expect((await act("b", id, { action: "accept" })).status).toBe(403);
    expect(await row(id)).toMatchObject({ status: "pending", referred_to_doctor_id: null });
    as("b");
    await act("b", id, { action: "revoke", reason: "Test cleanup" });
  });

  it("red team: another department, another clinic's department of the same name — nothing to see, accept or open", async () => {
    const x = await patientOf();
    const id = referralId(await refer("a", x, { referredToSpecialtyId: cardiology }));

    for (const name of ["c", "k"]) {
      expect((await incoming(name)).map((r) => r.id), name).not.toContain(id);
      expect((await detail(name, id)).status, name).toBeGreaterThanOrEqual(400);
      expect((await act(name, id, { action: "accept" })).status, name).toBeGreaterThanOrEqual(400);
      expect((await workspace(name, x.id)).status, name).toBe(404);
    }
    expect(await row(id)).toMatchObject({ status: "pending", referred_to_doctor_id: null });
    await revoke(id);
  });

  it("red team: an observer — a doctor with the history through their own visit, not on the referral — can read it but not act on it", async () => {
    const x = await patientOf();
    // Dr C (dermatology) also saw the patient: their own relationship gives the history.
    const start = new Date(Date.UTC(2026, 0, 5, 5, 0) + day++ * 86_400_000);
    await admin.from("appointments").insert({
      clinic_id: clinic, patient_id: x.id, doctor_id: doctors.c, service_id: service,
      start_at: start.toISOString(), end_at: new Date(start.getTime() + 30 * 60_000).toISOString(), status: "completed", source: "walk_in",
    });
    const id = referralId(await refer("a", x, { referredToSpecialtyId: cardiology }));

    const seen = await workspace("c", x.id);
    expect(seen.status).toBe(200);
    const listed = ((seen.body.data!.record as { referrals: Summary[] }).referrals).find((r) => r.id === id);
    expect(listed).toMatchObject({ role: "observer", allowedActions: [] });
    for (const action of [{ action: "accept" }, { action: "decline", reason: "No" }, { action: "complete" }, { action: "revoke", reason: "No" }]) {
      expect((await act("c", id, action)).status, action.action).toBeGreaterThanOrEqual(400);
    }
    expect(await row(id)).toMatchObject({ status: "pending", referred_to_doctor_id: null });
    await revoke(id);
  });
});

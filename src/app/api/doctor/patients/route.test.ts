import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { localDbAvailable } from "@/test/local-db";

/**
 * Referral-based clinical access — the SERVER and API layers, against the
 * local Supabase stack: GET /api/doctor/patients/[id], the referral routes,
 * canDoctorAccessPatientClinicalData(), and (test 10) the Supabase REST API
 * called directly with each doctor's own signed-in session.
 *
 * Only the session lookup is mocked; the route handlers are called directly,
 * without the proxy/middleware in front of them, so every denial below comes
 * from the handler's own server-side checks and the database — never from
 * middleware or hidden UI.
 *
 * Cast: Dr A (patient X's doctor), Dr E (also saw X once), Dr B (X is
 * referred to them), Dr C (same clinic, no relationship), Dr K (another
 * clinic), a receptionist and a manager.
 */

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const TZ = "Asia/Tashkent";
const PASSWORD = "AccessTest-Password-123!";

const session = vi.hoisted(() => ({ ctx: null as unknown }));

vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});

import { GET as getPatientRecord } from "./[id]/route";
import { POST as createReferral } from "../referrals/route";
import { GET as getReferral, PATCH as actOnReferral } from "../referrals/[id]/route";
import { PATCH as setAppointmentStatus } from "../appointments/[id]/route";
import { PATCH as revokeAsManagement } from "@/app/api/admin/referrals/[id]/route";
import { GET as getAdminPatient } from "@/app/api/admin/patients/route";
import { canDoctorAccessPatientClinicalData } from "@/lib/clinical-access/access";

const describeDb = describe.skipIf(!localDbAvailable());

type Body = { ok: boolean; data?: Record<string, unknown>; code?: string; error?: string };
type Record_ = {
  relationship: string;
  activeReferralIds: string[];
  patient: { id: string; phone: string | null };
  appointments: Array<{ id: string }>;
};

describeDb("referral-based clinical access — server and API layers", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const users: Record<string, string> = {};
  const emails: Record<string, string> = {};
  const doctors: Record<string, string> = {};
  let clinicA: string;
  let clinicB: string;
  let serviceA: string;
  let serviceB: string;
  let slot = 0;

  const as = (name: string | null, role = "doctor", clinicId?: string) => {
    session.ctx =
      name === null
        ? null
        : {
            profileId: users[name],
            clinicId: clinicId ?? (name === "k" ? clinicB : clinicA),
            clinicName: "Access Clinic",
            clinicTimezone: TZ,
            roles: [role],
            platformAdmin: false,
          };
  };

  const request = (method: string, path: string, body?: unknown) =>
    new NextRequest(`http://localhost${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Body });

  /** GET /api/doctor/patients/{patientId} as `name`. */
  async function record(name: string | null, patientId: string, role = "doctor", query = "") {
    as(name, role);
    return read(await getPatientRecord(request("GET", `/api/doctor/patients/${patientId}${query}`), params(patientId)));
  }
  const recordOf = (res: { body: Body }) => res.body.data!.record as Record_;
  const ids = (list: Array<{ id: string }>) => list.map((a) => a.id).sort();

  async function act(name: string, referralId: string, body: Record<string, unknown>, role = "doctor") {
    as(name, role);
    return read(await actOnReferral(request("PATCH", `/api/doctor/referrals/${referralId}`, body), params(referralId)));
  }
  async function referralDetail(name: string, referralId: string) {
    as(name, "doctor");
    return read(await getReferral(request("GET", `/api/doctor/referrals/${referralId}`), params(referralId)));
  }

  async function makeUser(name: string, clinicId: string, role: string) {
    emails[name] = `access-api-${name}-${suffix}@test.local`;
    const { data, error } = await admin.auth.admin.createUser({ email: emails[name], password: PASSWORD, email_confirm: true });
    expect(error).toBeNull();
    users[name] = data.user!.id;
    await admin.from("profiles").insert({ id: users[name], full_name: name });
    const { error: roleError } = await admin.from("staff_roles").insert({ clinic_id: clinicId, profile_id: users[name], role });
    expect(roleError).toBeNull();
  }

  async function makeDoctor(name: string, clinicId: string) {
    const { data, error } = await admin
      .from("doctors")
      .insert({ clinic_id: clinicId, profile_id: users[name], name: `Dr ${name.toUpperCase()} ${suffix}`, active: true })
      .select("id")
      .single();
    expect(error).toBeNull();
    doctors[name] = data!.id;
    await admin.from("doctor_working_hours").insert(
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinicId, doctor_id: data!.id, weekday, start_time: "00:00", end_time: "23:59" })),
    );
  }

  async function newPatient(clinicId = clinicA) {
    const { data } = await admin
      .from("patients")
      .insert({ clinic_id: clinicId, full_name: `Access API patient ${suffix}`, phone: "+998901112233" })
      .select("id")
      .single();
    return data!.id as string;
  }

  async function visit(patientId: string, doctor: string, clinicId = clinicA, status = "completed") {
    const start = new Date(Date.UTC(2026, 0, 5, 5, 0) + slot++ * 86_400_000);
    const { data, error } = await admin
      .from("appointments")
      .insert({
        clinic_id: clinicId,
        patient_id: patientId,
        doctor_id: doctor,
        service_id: clinicId === clinicA ? serviceA : serviceB,
        start_at: start.toISOString(),
        end_at: new Date(start.getTime() + 30 * 60_000).toISOString(),
        status,
        source: "walk_in",
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id as string;
  }

  /** Patient X: two visits with Dr A (the second is the consultation), one with Dr E. */
  async function patientX() {
    const id = await newPatient();
    const earlierWithA = await visit(id, doctors.a);
    const consultation = await visit(id, doctors.a);
    const withE = await visit(id, doctors.e);
    return { id, consultation, withA: [earlierWithA, consultation].sort(), withE };
  }

  /** Dr A refers the patient to Dr B through the API. */
  async function refer(patient: { consultation: string }) {
    as("a");
    const res = await read(
      await createReferral(
        request("POST", "/api/doctor/referrals", {
          idempotencyKey: randomUUID(),
          appointmentId: patient.consultation,
          referredToDoctorId: doctors.b,
          reason: `Please assess (${suffix})`,
          priority: "routine",
        }),
      ),
    );
    expect(res.status).toBe(201);
    return (res.body.data!.referral as { id: string }).id;
  }

  async function referredAndAccepted() {
    const x = await patientX();
    const referral = await refer(x);
    expect(await act("b", referral, { action: "accept" })).toMatchObject({ status: 200 });
    return { x, referral };
  }

  async function referralStatus(id: string) {
    const { data } = await admin.from("referrals").select("status").eq("id", id).single();
    return data!.status as string;
  }

  /** A real signed-in session: the doctor's own JWT against the Supabase REST API. */
  async function signedIn(name: string) {
    const client = createClient(URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await client.auth.signInWithPassword({ email: emails[name], password: PASSWORD });
    expect(error).toBeNull();
    return client;
  }

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { data: clinics } = await admin
      .from("clinics")
      .insert([
        { name: `Access API A ${suffix}`, slug: `access-api-a-${suffix}`, timezone: TZ },
        { name: `Access API B ${suffix}`, slug: `access-api-b-${suffix}`, timezone: TZ },
      ])
      .select("id, slug");
    clinicA = clinics!.find((c) => c.slug.startsWith("access-api-a"))!.id;
    clinicB = clinics!.find((c) => c.slug.startsWith("access-api-b"))!.id;

    for (const name of ["a", "b", "c", "e", "f"]) await makeUser(name, clinicA, "doctor");
    await makeUser("k", clinicB, "doctor");
    await makeUser("receptionist", clinicA, "receptionist");
    await makeUser("manager", clinicA, "manager");
    for (const name of ["a", "b", "c", "e", "f"]) await makeDoctor(name, clinicA);
    await makeDoctor("k", clinicB);

    const { data: services } = await admin
      .from("services")
      .insert([
        { clinic_id: clinicA, name: `Access API consult ${suffix}`, duration_minutes: 30, price: 100000, active: true },
        { clinic_id: clinicB, name: `Access API consult B ${suffix}`, duration_minutes: 30, price: 100000, active: true },
      ])
      .select("id, clinic_id");
    serviceA = services!.find((s) => s.clinic_id === clinicA)!.id;
    serviceB = services!.find((s) => s.clinic_id === clinicB)!.id;
  });

  afterAll(async () => {
    if (!admin) return;
    for (const clinicId of [clinicA, clinicB].filter(Boolean)) {
      await admin.from("patients").delete().eq("clinic_id", clinicId);
      await admin.from("staff_roles").delete().eq("clinic_id", clinicId);
      await admin.from("doctors").delete().eq("clinic_id", clinicId);
      await admin.from("services").delete().eq("clinic_id", clinicId);
      await admin.from("clinics").delete().eq("id", clinicId);
    }
    for (const id of Object.values(users)) await admin.auth.admin.deleteUser(id).catch(() => {});
  });

  it("1. Doctor A can access their authorized patient", async () => {
    const x = await patientX();
    const res = await record("a", x.id);
    expect(res.status).toBe(200);
    expect(recordOf(res)).toMatchObject({ relationship: "own", patient: { id: x.id, phone: "+998901112233" } });
    // Their own visits — Dr E's visit with the same patient is not theirs.
    expect(ids(recordOf(res).appointments)).toEqual(x.withA);

    expect(await canDoctorAccessPatientClinicalData(doctors.a, x.id)).toMatchObject({
      relationship: "own",
      allowed: true,
      scope: { patientRecord: true, ownAppointments: true, sharedHistoryDoctorIds: [] },
    });
    const { data: viewed } = await admin
      .from("audit_events")
      .select("actor_id, metadata")
      .eq("action", "patient_clinical_record_viewed")
      .eq("entity_id", x.id);
    expect(viewed).toEqual([{ actor_id: users.a, metadata: expect.objectContaining({ relationship: "own" }) }]);
  });

  it("2. Doctor B can access a patient actively referred to Doctor B", async () => {
    const x = await patientX();
    const referral = await refer(x);

    // Pending: the patient record and the consultation it came from — no history yet.
    const pending = await record("b", x.id);
    expect(pending.status).toBe(200);
    expect(recordOf(pending)).toMatchObject({ relationship: "referred", activeReferralIds: [referral] });
    expect(ids(recordOf(pending).appointments)).toEqual([x.consultation]);

    // Accepted: Dr A's visits with X — not Dr E's.
    await act("b", referral, { action: "accept" });
    const accepted = await record("b", x.id);
    expect(ids(recordOf(accepted).appointments)).toEqual(x.withA);
    expect(await canDoctorAccessPatientClinicalData(doctors.b, x.id)).toMatchObject({
      relationship: "referred",
      scope: { patientRecord: true, ownAppointments: false, sharedHistoryDoctorIds: [doctors.a] },
      activeReferralIds: [referral],
    });
    const detail = await referralDetail("b", referral);
    expect(ids((detail.body.data!.referral as { history: Array<{ id: string }> }).history)).toEqual(x.withA);
  });

  it("3. Doctor C cannot access that patient when not referred", async () => {
    const { x } = await referredAndAccepted();

    expect(await record("c", x.id)).toMatchObject({ status: 404, body: { code: "patient_not_found" } });
    expect(await canDoctorAccessPatientClinicalData(doctors.c, x.id)).toMatchObject({ relationship: "none", allowed: false });
    // The refusal itself is on the audit trail.
    const { data: denied } = await admin
      .from("audit_events")
      .select("actor_id")
      .eq("action", "patient_clinical_access_denied")
      .eq("entity_id", x.id);
    expect(denied).toEqual([{ actor_id: users.c }]);
  });

  it("4. Doctor B loses access after referral expiration", async () => {
    const x = await patientX();
    // Valid for four seconds; accepted straight away.
    const { data: short, error } = await admin
      .from("referrals")
      .insert({
        clinic_id: clinicA,
        patient_id: x.id,
        referring_doctor_id: doctors.a,
        referred_to_doctor_id: doctors.b,
        originating_appointment_id: x.consultation,
        reason: `Short-lived referral (${suffix})`,
        created_by: users.a,
        expires_at: new Date(Date.now() + 4_000).toISOString(),
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    expect(await act("b", short!.id, { action: "accept" })).toMatchObject({ status: 200 });
    expect(ids(recordOf(await record("b", x.id)).appointments)).toEqual(x.withA);

    await new Promise((r) => setTimeout(r, 4_500));

    // Dr B is told the referral expired — and gets nothing of the patient.
    expect(await record("b", x.id)).toMatchObject({ status: 410, body: { code: "referral_expired" } });
    expect(await referralDetail("b", short!.id)).toMatchObject({ status: 410, body: { code: "referral_expired" } });
    expect(await canDoctorAccessPatientClinicalData(doctors.b, x.id)).toMatchObject({ relationship: "none" });
    // Nothing had to mark it expired first.
    expect(await referralStatus(short!.id)).toBe("accepted");
  });

  it("5. Doctor B loses access after referral revocation", async () => {
    // By the referring doctor…
    const first = await referredAndAccepted();
    expect((await record("b", first.x.id)).status).toBe(200);
    expect(await act("a", first.referral, { action: "revoke", reason: "Referred in error" })).toMatchObject({ status: 200 });
    expect(await record("b", first.x.id)).toMatchObject({ status: 410, body: { code: "referral_revoked" } });
    expect(await referralDetail("b", first.referral)).toMatchObject({ status: 410, body: { code: "referral_revoked" } });

    // …or by clinic management.
    const second = await referredAndAccepted();
    as("manager", "manager");
    const revoked = await read(
      await revokeAsManagement(
        request("PATCH", `/api/admin/referrals/${second.referral}`, { action: "revoke", reason: "Doctor unavailable" }),
        params(second.referral),
      ),
    );
    expect(revoked.status).toBe(200);
    expect(await record("b", second.x.id)).toMatchObject({ status: 410, body: { code: "referral_revoked" } });
    expect(await canDoctorAccessPatientClinicalData(doctors.b, second.x.id)).toMatchObject({ relationship: "none" });
  });

  it("5b. completing the referral ends the handoff: no history, no contact details", async () => {
    const { x, referral } = await referredAndAccepted();
    expect(await act("b", referral, { action: "complete" })).toMatchObject({ status: 200 });

    expect(await record("b", x.id)).toMatchObject({ status: 410, body: { code: "referral_completed" } });
    // The referral stays on Dr B's record, without the patient's data.
    const detail = await referralDetail("b", referral);
    expect(detail.status).toBe(200);
    expect(detail.body.data!.referral).toMatchObject({
      status: "completed",
      history: null,
      consultation: null,
      patient: { fullName: `Access API patient ${suffix}`, phone: null, preferredLanguage: null },
    });
    // The referring doctor keeps their own patient.
    const asReferrer = await referralDetail("a", referral);
    expect(asReferrer.body.data!.referral).toMatchObject({ patient: { phone: "+998901112233" } });
    expect(ids((asReferrer.body.data!.referral as { history: Array<{ id: string }> }).history)).toEqual(x.withA);
  });

  it("6. Doctor B cannot access patients from another clinic", async () => {
    const z = await newPatient(clinicB);
    await visit(z, doctors.k, clinicB);
    expect(await record("b", z)).toMatchObject({ status: 404 });
    expect(await canDoctorAccessPatientClinicalData(doctors.b, z)).toMatchObject({ relationship: "none" });

    // Dr K (clinic B) never reaches clinic A's referred patient…
    const { x } = await referredAndAccepted();
    expect(await record("k", x.id)).toMatchObject({ status: 404 });
    // …and Dr B presenting clinic B as their clinic has no doctor record there.
    as("b", "doctor", clinicB);
    const forged = await read(await getPatientRecord(request("GET", `/api/doctor/patients/${z}`), params(z)));
    expect(forged).toMatchObject({ status: 403, body: { code: "doctor_not_linked" } });
  });

  it("7. A doctor cannot modify another doctor's referral unless authorized", async () => {
    const x = await patientX();
    const referral = await refer(x);

    for (const body of [
      { action: "accept" },
      { action: "decline" },
      { action: "complete" },
      { action: "revoke", reason: "Not my referral" },
    ]) {
      expect(await act("c", referral, body)).toMatchObject({ status: 404, body: { code: "referral_not_found" } });
    }
    expect(await act("a", referral, { action: "accept" })).toMatchObject({ status: 403, body: { code: "forbidden" } });
    expect(await act("b", referral, { action: "revoke", reason: "Not mine to revoke" })).toMatchObject({
      status: 403,
      body: { code: "forbidden" },
    });
    for (const [name, role] of [
      ["receptionist", "receptionist"],
      ["c", "doctor"],
    ]) {
      as(name, role);
      const res = await read(
        await revokeAsManagement(
          request("PATCH", `/api/admin/referrals/${referral}`, { action: "revoke", reason: "Unauthorized attempt" }),
          params(referral),
        ),
      );
      expect(res.status).toBe(403);
    }
    expect(await referralStatus(referral)).toBe("pending");

    // The authorized doctor can.
    expect(await act("b", referral, { action: "accept" })).toMatchObject({ status: 200 });
  });

  it("8. Patient IDs cannot be swapped to bypass authorization", async () => {
    const { x, referral } = await referredAndAccepted();
    const y = await newPatient();
    const yVisit = await visit(y, doctors.a);

    // The referral opens X only — never Dr A's other patient.
    expect(await record("b", y)).toMatchObject({ status: 404 });
    // A second patient id smuggled into the query is ignored.
    const smuggled = await record("b", x.id, "doctor", `?patientId=${y}&doctorId=${doctors.a}`);
    expect(recordOf(smuggled).patient.id).toBe(x.id);
    expect(ids(recordOf(smuggled).appointments)).not.toContain(yVisit);
    // Dr A's appointments stay Dr A's: Dr B can't act on them.
    as("b");
    const touched = await read(
      await setAppointmentStatus(
        request("PATCH", `/api/doctor/appointments/${x.consultation}`, { status: "completed" }),
        params(x.consultation),
      ),
    );
    expect(touched).toMatchObject({ status: 403, body: { code: "not_yours" } });
    // The referral detail is about X, whatever else is asked.
    const detail = await referralDetail("b", referral);
    expect(JSON.stringify(detail.body)).not.toContain(yVisit);
  });

  it("9. Direct API access is denied without referral", async () => {
    const { x, referral } = await referredAndAccepted();

    expect(await record("c", x.id)).toMatchObject({ status: 404 });
    expect(await referralDetail("c", referral)).toMatchObject({ status: 404 });
    expect(await record("c", "../../admin/patients")).toMatchObject({ status: 404 });
    expect(await record("c", "not-a-uuid")).toMatchObject({ status: 404 });
    // Not signed in at all, or not a doctor.
    expect(await record(null, x.id)).toMatchObject({ status: 401 });
    expect(await record("receptionist", x.id, "receptionist")).toMatchObject({ status: 403 });
    // The operational patient API is closed to doctors.
    as("c");
    expect((await getAdminPatient(request("GET", `/api/admin/patients?id=${x.id}`))).status).toBe(403);
  });

  it("10. RLS denies unauthorized access (real sessions against the Supabase REST API)", async () => {
    const { x, referral } = await referredAndAccepted();
    const [a, b, c, k] = await Promise.all(["a", "b", "c", "k"].map(signedIn));

    const seen = async (client: SupabaseClient) => ({
      patient: ((await client.from("patients").select("id").eq("id", x.id)).data ?? []).length === 1,
      appointments: ids((await client.from("appointments").select("id").eq("patient_id", x.id)).data ?? []),
      referral: ((await client.from("referrals").select("id").eq("id", referral)).data ?? []).length === 1,
    });

    expect(await seen(a)).toEqual({ patient: true, appointments: x.withA, referral: true });
    expect(await seen(b)).toEqual({ patient: true, appointments: x.withA, referral: true });
    for (const denied of [c, k]) expect(await seen(denied)).toEqual({ patient: false, appointments: [], referral: false });

    // No doctor can ask the database about someone else's access.
    const probe = await c.rpc("doctor_patient_access", { p_doctor_id: doctors.b, p_patient_id: x.id });
    expect(probe.error?.code).toBe("42501");
    // Writes are refused at the database, whatever the client sends.
    const forged = await c.from("referrals").update({ status: "revoked" }).eq("id", referral).select();
    expect(forged.error?.code).toBe("42501");

    // Revocation reaches the database immediately.
    expect(await act("a", referral, { action: "revoke", reason: "Handled elsewhere" })).toMatchObject({ status: 200 });
    expect(await seen(b)).toEqual({ patient: false, appointments: [], referral: false });
    await Promise.all([a, b, c, k].map((client) => client.auth.signOut()));
  });

  // ---------- Hardening ----------

  it("11. The server never shows a doctor an appointment their own token could not read", async () => {
    const x = await patientX();
    const referral = await refer(x);
    const clients = Object.fromEntries(await Promise.all(["a", "b", "c", "e"].map(async (n) => [n, await signedIn(n)] as const)));

    const viaApi = async (name: string) => {
      const res = await record(name, x.id);
      return res.status === 200 ? ids(recordOf(res).appointments) : [];
    };
    const viaRls = async (name: string) =>
      ids((await clients[name].from("appointments").select("id").eq("patient_id", x.id)).data ?? []);
    const detailAppointments = async (name: string) => {
      const res = await referralDetail(name, referral);
      if (res.status !== 200) return [];
      const r = res.body.data!.referral as { consultation: { id: string } | null; followUp: { id: string } | null; history: Array<{ id: string }> | null };
      return [r.consultation, r.followUp, ...(r.history ?? [])].filter((a): a is { id: string } => !!a).map((a) => a.id);
    };
    const expectParity = async () => {
      for (const name of ["a", "b", "c", "e"]) {
        const rls = await viaRls(name);
        expect(await viaApi(name), `patient record of Dr ${name}`).toEqual(rls);
        for (const id of await detailAppointments(name)) expect(rls, `referral detail of Dr ${name}`).toContain(id);
      }
    };

    await expectParity(); // pending
    await act("b", referral, { action: "accept" });
    await expectParity(); // accepted
    const followUp = await visit(x.id, doctors.b, clinicA, "confirmed");
    await admin.from("referrals").update({ follow_up_appointment_id: followUp }).eq("id", referral);
    await expectParity(); // follow-up booked: Dr A now sees it, through both layers
    expect(await viaRls("a")).toContain(followUp);
    await act("b", referral, { action: "complete" });
    await expectParity(); // completed: Dr B keeps only their own visit
    expect(await viaRls("b")).toEqual([followUp]);
    await Promise.all(Object.values(clients).map((client) => client.auth.signOut()));
  });

  it("12. A deactivated doctor is refused at the API and at the database", async () => {
    const { x } = await referredAndAccepted();
    const b = await signedIn("b");
    await admin.from("doctors").update({ active: false }).eq("id", doctors.b);
    try {
      expect(await record("b", x.id)).toMatchObject({ status: 403, body: { code: "doctor_not_linked" } });
      expect((await b.from("patients").select("id").eq("id", x.id)).data).toEqual([]);
      expect((await b.from("appointments").select("id").eq("patient_id", x.id)).data).toEqual([]);
    } finally {
      await admin.from("doctors").update({ active: true }).eq("id", doctors.b);
    }
    expect((await b.from("patients").select("id").eq("id", x.id)).data).toEqual([{ id: x.id }]);
    await b.auth.signOut();
  });

  it("13. Doctors cannot change appointments directly, only through the status API", async () => {
    const x = await patientX();
    const a = await signedIn("a");
    const direct = await a.from("appointments").update({ status: "cancelled" }).eq("id", x.consultation).select("id");
    expect(direct.data ?? []).toEqual([]);
    const { data: unchanged } = await admin.from("appointments").select("status").eq("id", x.consultation).single();
    expect(unchanged!.status).toBe("completed");
    await a.auth.signOut();
  });

  it("14. Patient lookups are rate limited per doctor", async () => {
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await record("f", randomUUID())).status;
    expect(last).toBe(429);
    // Another doctor is unaffected.
    expect((await record("c", randomUUID())).status).toBe(404);
  });
});

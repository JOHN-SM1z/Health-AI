import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { localDbAvailable } from "@/test/local-db";

/**
 * Referral API (doctor portal + reception) against the LOCAL Supabase stack.
 * Only the session lookup is mocked: the real guards (exact doctor role +
 * linked, active doctor record), the referral service and every database
 * rule run for real. The follow-up check is wrapped (not replaced) so a test
 * can change the referral between the check and the link, like a concurrent
 * request would.
 *
 * Requires: `npm run db:reset-local` + `.env` with local keys. Skips cleanly
 * when the stack is unavailable.
 */

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const TZ = "Asia/Tashkent";

const session = vi.hoisted(() => ({ ctx: null as unknown }));

vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});

const race = vi.hoisted(() => ({ afterFollowUpCheck: null as null | (() => Promise<void>) }));

vi.mock("@/lib/referrals/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/referrals/service")>();
  return {
    ...actual,
    assertFollowUpBookable: async (...args: Parameters<typeof actual.assertFollowUpBookable>) => {
      const checked = await actual.assertFollowUpBookable(...args);
      await race.afterFollowUpCheck?.();
      return checked;
    },
  };
});

import { GET as listReferrals, POST as createReferral } from "./route";
import { GET as getReferral, PATCH as actOnReferral } from "./[id]/route";
import { GET as listRecipients } from "./recipients/route";
import { POST as bookAppointment } from "@/app/api/admin/appointments/route";
import { GET as getPatient } from "@/app/api/admin/patients/route";
import { PATCH as revokeAsManagement } from "@/app/api/admin/referrals/[id]/route";

const describeDb = describe.skipIf(!localDbAvailable());

type Body = { ok: boolean; data?: Record<string, unknown> & { [key: string]: unknown }; code?: string; error?: string };

describeDb("referral API (doctor portal + reception)", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const users: Record<string, string> = {};
  const doctors: Record<string, string> = {};
  let clinicA: string;
  let clinicB: string;
  let serviceId: string;
  let patientId: string;
  let consultationId: string;
  let slot = 0;

  const as = (name: string, role: string, clinicId?: string) => {
    session.ctx = {
      profileId: users[name],
      clinicId: clinicId ?? clinicA,
      clinicName: "Referral API Clinic",
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

  async function makeUser(name: string, clinicId: string, role: string) {
    const { data, error } = await admin.auth.admin.createUser({
      email: `ref-api-${name}-${suffix}@test.local`,
      password: "TestPassword123!",
      email_confirm: true,
    });
    expect(error).toBeNull();
    users[name] = data.user!.id;
    await admin.from("profiles").insert({ id: users[name], full_name: name });
    const { error: roleError } = await admin.from("staff_roles").insert({ clinic_id: clinicId, profile_id: users[name], role });
    expect(roleError).toBeNull();
  }

  async function makeDoctor(key: string, clinicId: string, profile: string | null, active = true) {
    const { data, error } = await admin
      .from("doctors")
      .insert({ clinic_id: clinicId, profile_id: profile, name: `Dr ${key} ${suffix}`, active })
      .select("id")
      .single();
    expect(error).toBeNull();
    doctors[key] = data!.id;
    await admin.from("doctor_working_hours").insert(
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinicId, doctor_id: data!.id, weekday, start_time: "00:00", end_time: "23:59" })),
    );
  }

  /** A consultation with `doctor` — past-dated, so it never blocks a future booking. */
  async function consultation(doctor: string, status = "in_progress", patient = patientId) {
    const start = new Date(Date.UTC(2026, 0, 5, 5, 0) + slot++ * 86_400_000);
    const { data, error } = await admin
      .from("appointments")
      .insert({
        clinic_id: clinicA,
        patient_id: patient,
        doctor_id: doctor,
        service_id: serviceId,
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

  async function newPatient() {
    const { data } = await admin
      .from("patients")
      .insert({ clinic_id: clinicA, full_name: `Referral API patient ${suffix}` })
      .select("id")
      .single();
    return data!.id as string;
  }

  async function refer(overrides: Record<string, unknown> = {}) {
    as("referrer", "doctor");
    return read(
      await createReferral(
        request("POST", "/api/doctor/referrals", {
          idempotencyKey: randomUUID(),
          appointmentId: consultationId,
          referredToDoctorId: doctors.receiver,
          reason: `Suspected arrhythmia, please assess (${suffix})`,
          handoffNote: `Resting ECG attached to today's visit (${suffix})`,
          priority: "urgent",
          ...overrides,
        }),
      ),
    );
  }

  /** A fresh pending referral from a new consultation with a new patient. */
  async function freshReferral(): Promise<string> {
    const patient = await newPatient();
    const visit = await consultation(doctors.referrer, "completed", patient);
    const res = await refer({ appointmentId: visit });
    expect(res.status).toBe(201);
    return (res.body.data!.referral as { id: string }).id;
  }

  const act = async (name: string, id: string, body: Record<string, unknown>) => {
    as(name, "doctor");
    return read(await actOnReferral(request("PATCH", `/api/doctor/referrals/${id}`, body), params(id)));
  };

  const detail = async (name: string, id: string) => {
    as(name, "doctor");
    return read(await getReferral(request("GET", `/api/doctor/referrals/${id}`), params(id)));
  };

  const futureSlot = () => {
    const day = new Date(Date.now() + (3 + slot++) * 86_400_000);
    return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 5, 0)).toISOString();
  };

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });

    const { data: clinics } = await admin
      .from("clinics")
      .insert([
        { name: `Referral API A ${suffix}`, slug: `ref-api-a-${suffix}`, timezone: TZ },
        { name: `Referral API B ${suffix}`, slug: `ref-api-b-${suffix}`, timezone: TZ },
      ])
      .select("id, slug");
    clinicA = clinics!.find((c) => c.slug.startsWith("ref-api-a"))!.id;
    clinicB = clinics!.find((c) => c.slug.startsWith("ref-api-b"))!.id;

    for (const [name, role] of [
      ["referrer", "doctor"],
      ["receiver", "doctor"],
      ["bystander", "doctor"],
      ["sleeper", "doctor"],
      ["unlinked", "doctor"],
      ["receptionist", "receptionist"],
      ["manager", "manager"],
    ] as const) {
      await makeUser(name, clinicA, role);
    }
    await makeUser("doctorB", clinicB, "doctor");

    await makeDoctor("referrer", clinicA, users.referrer);
    await makeDoctor("receiver", clinicA, users.receiver);
    await makeDoctor("bystander", clinicA, users.bystander);
    await makeDoctor("inactive", clinicA, users.sleeper, false);
    await makeDoctor("clinicB", clinicB, users.doctorB);

    const { data: service } = await admin
      .from("services")
      .insert({ clinic_id: clinicA, name: `Referral API consult ${suffix}`, duration_minutes: 30, price: 100000, active: true })
      .select("id")
      .single();
    serviceId = service!.id;

    patientId = await newPatient();
    consultationId = await consultation(doctors.referrer);
  });

  afterAll(async () => {
    if (!admin) return;
    // Erasing the patients cascades their referrals and appointments; the
    // clinic itself is removed last so its audit rows can still be written.
    for (const clinicId of [clinicA, clinicB].filter(Boolean)) {
      await admin.from("patients").delete().eq("clinic_id", clinicId);
      await admin.from("staff_roles").delete().eq("clinic_id", clinicId);
      await admin.from("doctors").delete().eq("clinic_id", clinicId);
      await admin.from("services").delete().eq("clinic_id", clinicId);
      await admin.from("clinics").delete().eq("id", clinicId);
    }
    for (const id of Object.values(users)) await admin.auth.admin.deleteUser(id).catch(() => {});
  });

  it("is only for doctors acting through their own active doctor record", async () => {
    for (const [name, role] of [
      ["manager", "manager"],
      ["receptionist", "receptionist"],
    ]) {
      as(name, role);
      expect((await listReferrals(request("GET", "/api/doctor/referrals"))).status).toBe(403);
    }

    as("unlinked", "doctor");
    const unlinked = await read(await listReferrals(request("GET", "/api/doctor/referrals")));
    expect(unlinked.status).toBe(403);
    expect(unlinked.body.code).toBe("doctor_not_linked");

    as("sleeper", "doctor");
    expect((await listReferrals(request("GET", "/api/doctor/referrals"))).status).toBe(403);

    // Audit gap G3: a manager linked to a doctor record still isn't a doctor.
    // (A weight-based requireStaff("doctor") would have let this through.)
    await makeDoctor("managerLinked", clinicA, users.manager);
    as("manager", "manager");
    const linkedManager = await read(await listReferrals(request("GET", "/api/doctor/referrals")));
    expect(linkedManager).toMatchObject({ status: 403, body: { code: "forbidden" } });
  });

  it("offers active colleagues with a doctor account as recipients, never the caller", async () => {
    as("referrer", "doctor");
    const res = await read(await listRecipients());
    expect(res.status).toBe(200);
    const ids = (res.body.data!.doctors as Array<{ id: string }>).map((d) => d.id);
    expect(ids).toEqual(expect.arrayContaining([doctors.receiver, doctors.bystander]));
    for (const excluded of [doctors.referrer, doctors.inactive, doctors.clinicB]) expect(ids).not.toContain(excluded);
  });

  describe("creating a referral", () => {
    /** A consultation `doctor` held with a new patient, so no other referral is in the way. */
    async function ownConsultation(status = "completed", doctor = doctors.referrer) {
      const patient = await newPatient();
      return { appointmentId: await consultation(doctor, status, patient), patientId: patient };
    }

    const valid = (appointmentId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      idempotencyKey: randomUUID(),
      appointmentId,
      referredToDoctorId: doctors.receiver,
      reason: `Palpitations on exertion, please assess (${suffix})`,
      handoffNote: `Holter monitoring suggested (${suffix})`,
      priority: "routine",
      validForDays: 30,
      ...overrides,
    });

    const post = async (name: string, role: string, body: Record<string, unknown>, clinicId?: string) => {
      as(name, role, clinicId);
      return read(await createReferral(request("POST", "/api/doctor/referrals", body)));
    };

    const createdId = (res: { body: Body }) => (res.body.data!.referral as { id: string }).id;

    async function referralsFrom(appointmentId: string) {
      const { data } = await admin.from("referrals").select("id").eq("originating_appointment_id", appointmentId);
      return data ?? [];
    }

    async function creationAudit(referralId: string) {
      const { data } = await admin
        .from("audit_events")
        .select("clinic_id, action, actor_id, actor_type, entity_type, old_values, new_values")
        .eq("entity_id", referralId)
        .eq("action", "referral_created");
      return data ?? [];
    }

    it("a doctor creates a valid referral from their own consultation", async () => {
      const { appointmentId, patientId: patient } = await ownConsultation();
      const body = valid(appointmentId);
      const before = Date.now();
      const res = await post("referrer", "doctor", body);
      expect(res).toMatchObject({ status: 201, body: { data: { referral: { replayed: false } } } });
      const id = createdId(res);

      const { data: row } = await admin
        .from("referrals")
        .select(
          "clinic_id, patient_id, referring_doctor_id, referred_to_doctor_id, originating_appointment_id, status, priority, reason, handoff_note, created_by, creation_key, expires_at",
        )
        .eq("id", id)
        .single();
      expect(row).toMatchObject({
        clinic_id: clinicA,
        patient_id: patient,
        referring_doctor_id: doctors.referrer,
        referred_to_doctor_id: doctors.receiver,
        originating_appointment_id: appointmentId,
        status: "pending",
        priority: "routine",
        reason: body.reason,
        handoff_note: body.handoffNote,
        created_by: users.referrer,
        creation_key: body.idempotencyKey,
      });
      const validFor = Date.parse(row!.expires_at) - before;
      expect(validFor).toBeGreaterThan(29.9 * 86_400_000);
      expect(validFor).toBeLessThan(30.1 * 86_400_000);

      // The receiving doctor's dashboard lists it as pending (metadata only);
      // no other doctor's does.
      const pendingFor = async (name: string) => {
        as(name, "doctor");
        return read(await listReferrals(request("GET", "/api/doctor/referrals?box=incoming&status=pending")));
      };
      const dashboard = await pendingFor("receiver");
      const listed = dashboard.body.data!.referrals as Array<Record<string, unknown>>;
      expect(listed).toEqual(expect.arrayContaining([expect.objectContaining({ id, status: "pending", priority: "routine" })]));
      expect(listed.every((r) => r.status === "pending")).toBe(true);
      expect(JSON.stringify(listed)).not.toContain("Palpitations");
      expect((await pendingFor("bystander")).body.data!.referrals).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id })]),
      );

      as("receiver", "doctor");
      expect(await read(await listReferrals(request("GET", "/api/doctor/referrals?status=bogus")))).toMatchObject({
        status: 400,
        body: { code: "validation" },
      });
    });

    it("an unauthorized doctor cannot create a referral", async () => {
      const { appointmentId } = await ownConsultation();

      // A colleague who did not hold the consultation — including the doctor
      // it would be sent to.
      expect(await post("bystander", "doctor", valid(appointmentId))).toMatchObject({
        status: 404,
        body: { code: "consultation_not_found" },
      });
      expect(await post("receiver", "doctor", valid(appointmentId, { referredToDoctorId: doctors.bystander }))).toMatchObject({
        status: 404,
        body: { code: "consultation_not_found" },
      });
      // Staff without the doctor role, an account with no doctor record, and
      // a deactivated doctor record.
      expect(await post("receptionist", "receptionist", valid(appointmentId))).toMatchObject({ status: 403 });
      expect(await post("manager", "manager", valid(appointmentId))).toMatchObject({ status: 403 });
      expect(await post("unlinked", "doctor", valid(appointmentId))).toMatchObject({
        status: 403,
        body: { code: "doctor_not_linked" },
      });
      expect(await post("sleeper", "doctor", valid(appointmentId))).toMatchObject({ status: 403 });

      expect(await referralsFrom(appointmentId)).toEqual([]);
    });

    it("a doctor from another clinic can never be selected", async () => {
      as("referrer", "doctor");
      const offered = ((await read(await listRecipients())).body.data!.doctors as Array<{ id: string }>).map((d) => d.id);
      expect(offered).not.toContain(doctors.clinicB);

      const { appointmentId } = await ownConsultation();
      expect(await post("referrer", "doctor", valid(appointmentId, { referredToDoctorId: doctors.clinicB }))).toMatchObject({
        status: 404,
        body: { code: "doctor_not_found" },
      });
      // Indistinguishable from an id that exists nowhere: other clinics' doctors are not revealed.
      expect(await post("referrer", "doctor", valid(appointmentId, { referredToDoctorId: randomUUID() }))).toMatchObject({
        status: 404,
        body: { code: "doctor_not_found" },
      });

      // A clinic-B doctor is offered none of clinic A's doctors and cannot
      // refer from clinic A's consultations.
      as("doctorB", "doctor", clinicB);
      const offeredToB = ((await read(await listRecipients())).body.data!.doctors as Array<{ id: string }>).map((d) => d.id);
      for (const id of [doctors.referrer, doctors.receiver, doctors.bystander]) expect(offeredToB).not.toContain(id);
      expect(await post("doctorB", "doctor", valid(appointmentId), clinicB)).toMatchObject({
        status: 404,
        body: { code: "consultation_not_found" },
      });

      expect(await referralsFrom(appointmentId)).toEqual([]);
    });

    it("only accepts an active colleague holding the doctor role as the receiving doctor", async () => {
      const { appointmentId } = await ownConsultation();
      // A doctor record linked to a receptionist's account is not a doctor.
      if (!doctors.receptionLinked) await makeDoctor("receptionLinked", clinicA, users.receptionist);
      as("referrer", "doctor");
      const offered = ((await read(await listRecipients())).body.data!.doctors as Array<{ id: string }>).map((d) => d.id);
      expect(offered).not.toContain(doctors.receptionLinked);

      for (const referredToDoctorId of [doctors.receptionLinked, doctors.inactive]) {
        expect(await post("referrer", "doctor", valid(appointmentId, { referredToDoctorId }))).toMatchObject({
          status: 409,
          body: { code: "receiving_doctor_unavailable" },
        });
      }
      expect(await post("referrer", "doctor", valid(appointmentId, { referredToDoctorId: doctors.referrer }))).toMatchObject({
        status: 400,
        body: { code: "self_referral" },
      });
      expect(await referralsFrom(appointmentId)).toEqual([]);
    });

    it("rejects invalid patient access", async () => {
      // Scheduled, cancelled or missed visits are no clinical contact to refer from.
      for (const status of ["pending", "confirmed", "cancelled", "no_show"]) {
        const { appointmentId } = await ownConsultation(status);
        expect(await post("referrer", "doctor", valid(appointmentId))).toMatchObject({
          status: 409,
          body: { code: "consultation_not_attended" },
        });
        expect(await referralsFrom(appointmentId)).toEqual([]);
      }

      // Another doctor's patient, an unknown visit, and a visit in another clinic.
      const colleagues = await ownConsultation("completed", doctors.bystander);
      expect(await post("referrer", "doctor", valid(colleagues.appointmentId))).toMatchObject({
        status: 404,
        body: { code: "consultation_not_found" },
      });
      expect(await post("referrer", "doctor", valid(randomUUID()))).toMatchObject({ status: 404, body: { code: "consultation_not_found" } });

      const { data: patientB } = await admin
        .from("patients")
        .insert({ clinic_id: clinicB, full_name: `Clinic B patient ${suffix}` })
        .select("id")
        .single();
      const { data: serviceB } = await admin
        .from("services")
        .insert({ clinic_id: clinicB, name: `Clinic B consult ${suffix}`, duration_minutes: 30, price: 100000, active: true })
        .select("id")
        .single();
      const start = new Date(Date.UTC(2026, 0, 5, 5, 0) + slot++ * 86_400_000);
      const { data: visitB } = await admin
        .from("appointments")
        .insert({
          clinic_id: clinicB,
          patient_id: patientB!.id,
          doctor_id: doctors.clinicB,
          service_id: serviceB!.id,
          start_at: start.toISOString(),
          end_at: new Date(start.getTime() + 30 * 60_000).toISOString(),
          status: "completed",
          source: "walk_in",
        })
        .select("id")
        .single();
      expect(await post("referrer", "doctor", valid(visitB!.id))).toMatchObject({ status: 404, body: { code: "consultation_not_found" } });
      expect(await referralsFrom(visitB!.id)).toEqual([]);

      // Patient, clinic and referring doctor are taken from the consultation;
      // values smuggled into the request are ignored.
      const { appointmentId, patientId: patient } = await ownConsultation();
      const res = await post(
        "referrer",
        "doctor",
        valid(appointmentId, { patientId: colleagues.patientId, clinicId: clinicB, referringDoctorId: doctors.bystander }),
      );
      expect(res.status).toBe(201);
      const { data: row } = await admin
        .from("referrals")
        .select("clinic_id, patient_id, referring_doctor_id")
        .eq("id", createdId(res))
        .single();
      expect(row).toEqual({ clinic_id: clinicA, patient_id: patient, referring_doctor_id: doctors.referrer });
    });

    it("writes one audit event for the creation, attributed to the doctor, without clinical text", async () => {
      const { appointmentId, patientId: patient } = await ownConsultation();
      const body = valid(appointmentId);
      const id = createdId(await post("referrer", "doctor", body));

      const trail = await creationAudit(id);
      expect(trail).toEqual([
        expect.objectContaining({
          clinic_id: clinicA,
          action: "referral_created",
          actor_id: users.referrer,
          actor_type: "staff",
          entity_type: "referrals",
          old_values: null,
        }),
      ]);
      expect(trail[0].new_values).toMatchObject({
        status: "pending",
        patient_id: patient,
        referring_doctor_id: doctors.referrer,
        referred_to_doctor_id: doctors.receiver,
        originating_appointment_id: appointmentId,
      });
      const logged = JSON.stringify(trail);
      for (const secret of [body.reason, body.handoffNote, body.idempotencyKey] as string[]) expect(logged).not.toContain(secret);
    });

    it("handles a duplicate submission safely", async () => {
      const { appointmentId } = await ownConsultation();
      const body = valid(appointmentId);

      const first = await post("referrer", "doctor", body);
      expect(first.status).toBe(201);
      const id = createdId(first);

      // Double click, or a retry after the response was lost: same answer,
      // nothing written twice.
      expect(await post("referrer", "doctor", body)).toMatchObject({
        status: 200,
        body: { data: { referral: { id, replayed: true } } },
      });

      // The key reused for different content is refused, never answered with the first referral.
      expect(await post("referrer", "doctor", { ...body, reason: `Something else entirely (${suffix})` })).toMatchObject({
        status: 409,
        body: { code: "idempotency_key_reused" },
      });
      // A fresh submission of the same referral while it is open is a conflict, not a second referral.
      expect(await post("referrer", "doctor", { ...body, idempotencyKey: randomUUID() })).toMatchObject({
        status: 409,
        body: { code: "referral_already_open" },
      });
      // Every submission must carry a key.
      const keyless = { ...body };
      delete keyless.idempotencyKey;
      expect(await post("referrer", "doctor", keyless)).toMatchObject({ status: 400, body: { code: "validation" } });

      expect(await referralsFrom(appointmentId)).toEqual([{ id }]);
      expect(await creationAudit(id)).toHaveLength(1);
    });

    it("resolves concurrent copies of one submission to a single referral", async () => {
      const { appointmentId } = await ownConsultation();
      const body = valid(appointmentId);
      as("referrer", "doctor");
      const results = await Promise.all(
        Array.from({ length: 4 }, async () => read(await createReferral(request("POST", "/api/doctor/referrals", body)))),
      );

      expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 201]);
      const ids = new Set(results.map(createdId));
      expect(ids.size).toBe(1);
      const [id] = [...ids];
      expect(await referralsFrom(appointmentId)).toEqual([{ id }]);
      expect(await creationAudit(id)).toHaveLength(1);
    });

    it("never resolves one doctor's key to another doctor's referral", async () => {
      const mine = await ownConsultation();
      const body = valid(mine.appointmentId);
      const created = createdId(await post("referrer", "doctor", body));

      const theirs = await ownConsultation("completed", doctors.bystander);
      const res = await post("bystander", "doctor", { ...body, appointmentId: theirs.appointmentId });
      expect(res).toMatchObject({ status: 201, body: { data: { referral: { replayed: false } } } });
      expect(createdId(res)).not.toBe(created);
    });
  });

  it("creates a referral from the doctor's own consultation, visible only to the two doctors", async () => {
    const res = await refer();
    expect(res.status).toBe(201);
    const id = (res.body.data!.referral as { id: string }).id;

    as("referrer", "doctor");
    const outgoing = await read(await listReferrals(request("GET", "/api/doctor/referrals?box=outgoing")));
    expect((outgoing.body.data!.referrals as Array<{ id: string }>).map((r) => r.id)).toContain(id);

    as("receiver", "doctor");
    const incoming = await read(await listReferrals(request("GET", "/api/doctor/referrals")));
    const mine = (incoming.body.data!.referrals as Array<{ id: string; status: string; patientName: string }>).find((r) => r.id === id);
    expect(mine).toMatchObject({ status: "pending", patientName: `Referral API patient ${suffix}` });

    as("bystander", "doctor");
    const theirs = await read(await listReferrals(request("GET", "/api/doctor/referrals")));
    expect((theirs.body.data!.referrals as Array<{ id: string }>).map((r) => r.id)).not.toContain(id);
  });

  it("turns rule violations into clear errors", async () => {
    as("bystander", "doctor");
    const notMine = await read(
      await createReferral(
        request("POST", "/api/doctor/referrals", {
          idempotencyKey: randomUUID(),
          appointmentId: consultationId,
          referredToDoctorId: doctors.receiver,
          reason: "Not my patient",
        }),
      ),
    );
    expect(notMine).toMatchObject({ status: 404, body: { code: "consultation_not_found" } });

    expect(await refer()).toMatchObject({ status: 409, body: { code: "referral_already_open" } });
    expect(await refer({ referredToDoctorId: doctors.referrer })).toMatchObject({ status: 400, body: { code: "self_referral" } });
    expect(await refer({ referredToDoctorId: doctors.clinicB })).toMatchObject({ status: 404, body: { code: "doctor_not_found" } });
    expect(await refer({ referredToDoctorId: doctors.inactive })).toMatchObject({
      status: 409,
      body: { code: "receiving_doctor_unavailable" },
    });
    expect(await refer({ appointmentId: await consultation(doctors.referrer, "pending") })).toMatchObject({
      status: 409,
      body: { code: "consultation_not_attended" },
    });
    expect(await refer({ reason: " " })).toMatchObject({ status: 400, body: { code: "validation" } });
  });

  it("shows a referral only to its doctors, shares history after acceptance, and logs every view", async () => {
    const id = await freshReferral();

    expect(await detail("bystander", id)).toMatchObject({ status: 404, body: { code: "referral_not_found" } });
    expect(await detail("receiver", "not-a-uuid")).toMatchObject({ status: 404 });

    const pending = await detail("receiver", id);
    expect(pending.status).toBe(200);
    expect(pending.body.data!.referral).toMatchObject({
      role: "receiver",
      status: "pending",
      priority: "urgent",
      reason: `Suspected arrhythmia, please assess (${suffix})`,
      history: null,
      allowedActions: ["accept", "decline"],
      patient: { fullName: `Referral API patient ${suffix}` },
    });

    const asReferrer = await detail("referrer", id);
    expect(asReferrer.body.data!.referral).toMatchObject({ role: "referrer", allowedActions: ["revoke"] });
    expect((asReferrer.body.data!.referral as { history: unknown[] }).history).toHaveLength(1);

    const accepted = await act("receiver", id, { action: "accept" });
    expect(accepted).toMatchObject({ status: 200, body: { data: { status: "accepted" } } });
    const afterAccept = await detail("receiver", id);
    expect((afterAccept.body.data!.referral as { history: unknown[] }).history).toHaveLength(1);

    const { data: views } = await admin
      .from("audit_events")
      .select("actor_id, metadata")
      .eq("entity_id", id)
      .eq("action", "referral_viewed")
      .order("created_at");
    expect((views ?? []).map((v) => v.actor_id)).toEqual([users.receiver, users.referrer, users.receiver]);
    expect((views ?? []).map((v) => (v.metadata as { history_shared: boolean }).history_shared)).toEqual([false, true, true]);
  });

  it("lets only the right doctor act, and only in a valid order", async () => {
    const id = await freshReferral();
    expect(await act("referrer", id, { action: "accept" })).toMatchObject({ status: 403, body: { code: "forbidden" } });
    expect(await act("bystander", id, { action: "accept" })).toMatchObject({ status: 404 });
    expect(await act("receiver", id, { action: "revoke", reason: "Not mine to revoke" })).toMatchObject({ status: 403 });
    expect(await act("receiver", id, { action: "complete" })).toMatchObject({ status: 409, body: { code: "invalid_transition" } });

    expect(await act("receiver", id, { action: "accept" })).toMatchObject({ status: 200 });
    expect(await act("receiver", id, { action: "decline" })).toMatchObject({ status: 409, body: { code: "invalid_transition" } });
    expect(await act("receiver", id, { action: "complete" })).toMatchObject({ status: 200, body: { data: { status: "completed" } } });

    const declined = await freshReferral();
    expect(await act("receiver", declined, { action: "decline", reason: "Outside my specialty" })).toMatchObject({
      status: 200,
      body: { data: { status: "declined" } },
    });
    expect(await detail("receiver", declined)).toMatchObject({ status: 404 });

    const revoked = await freshReferral();
    expect(await act("referrer", revoked, { action: "revoke" })).toMatchObject({ status: 400, body: { code: "validation" } });
    expect(await act("referrer", revoked, { action: "revoke", reason: "Referred in error" })).toMatchObject({
      status: 200,
      body: { data: { status: "revoked" } },
    });
    expect(await detail("receiver", revoked)).toMatchObject({ status: 404 });
    expect(await detail("referrer", revoked)).toMatchObject({ status: 200 });
  });

  it("lets reception book the follow-up with the receiving doctor, linked to the referral", async () => {
    const id = await freshReferral();
    const { data: referral } = await admin.from("referrals").select("patient_id").eq("id", id).single();

    const book = async (overrides: Record<string, unknown> = {}) => {
      as("receptionist", "receptionist");
      return read(
        await bookAppointment(
          request("POST", "/api/admin/appointments", {
            patientName: "Referral follow-up",
            doctorId: doctors.receiver,
            serviceId,
            startAt: futureSlot(),
            source: "admin",
            referralId: id,
            ...overrides,
          }),
        ),
      );
    };

    expect(await book()).toMatchObject({ status: 409, body: { code: "referral_not_accepted" } });
    await act("receiver", id, { action: "accept" });

    expect(await book({ doctorId: doctors.bystander })).toMatchObject({ status: 400, body: { code: "follow_up_wrong_doctor" } });
    expect(await book({ patientId: await newPatient() })).toMatchObject({ status: 400, body: { code: "follow_up_wrong_patient" } });

    const booked = await book();
    expect(booked.status).toBe(201);
    const appointmentId = booked.body.data!.appointmentId as string;
    const { data: appointment } = await admin.from("appointments").select("patient_id, doctor_id").eq("id", appointmentId).single();
    expect(appointment).toEqual({ patient_id: referral!.patient_id, doctor_id: doctors.receiver });
    const { data: linked } = await admin.from("referrals").select("follow_up_appointment_id").eq("id", id).single();
    expect(linked!.follow_up_appointment_id).toBe(appointmentId);

    expect(await book()).toMatchObject({ status: 409, body: { code: "follow_up_exists" } });

    as("receptionist", "receptionist");
    const patient = await read(await getPatient(request("GET", `/api/admin/patients?id=${referral!.patient_id}`)));
    const referrals = patient.body.data!.referrals as Array<Record<string, unknown>>;
    expect(referrals[0]).toMatchObject({ id, status: "accepted", canBookFollowUp: false, followUp: { id: appointmentId } });
    // Reception sees scheduling metadata only, never the clinical text.
    expect(JSON.stringify(referrals)).not.toContain("arrhythmia");
    expect(referrals[0]).not.toHaveProperty("reason");
  });

  describe("when the referral changes between the check and the link", () => {
    async function acceptedReferral() {
      const id = await freshReferral();
      await act("receiver", id, { action: "accept" });
      const { data } = await admin.from("referrals").select("patient_id").eq("id", id).single();
      return { id, patientId: data!.patient_id as string };
    }

    async function bookFollowUp(id: string, startAt: string) {
      as("receptionist", "receptionist");
      return read(
        await bookAppointment(
          request("POST", "/api/admin/appointments", {
            patientName: "Referral follow-up",
            doctorId: doctors.receiver,
            serviceId,
            startAt,
            source: "admin",
            referralId: id,
          }),
        ),
      );
    }

    async function appointmentsAt(patient: string, startAt: string) {
      const { data } = await admin
        .from("appointments")
        .select("id, status")
        .eq("patient_id", patient)
        .eq("doctor_id", doctors.receiver)
        .eq("start_at", startAt);
      return data ?? [];
    }

    afterAll(() => {
      race.afterFollowUpCheck = null;
    });

    it("releases the slot when another follow-up wins the race", async () => {
      const { id, patientId: patient } = await acceptedReferral();
      const startAt = futureSlot();
      race.afterFollowUpCheck = async () => {
        race.afterFollowUpCheck = null;
        const winnerStart = futureSlot();
        const { data: winner, error } = await admin
          .from("appointments")
          .insert({
            clinic_id: clinicA,
            patient_id: patient,
            doctor_id: doctors.receiver,
            service_id: serviceId,
            start_at: winnerStart,
            end_at: new Date(Date.parse(winnerStart) + 30 * 60_000).toISOString(),
            status: "confirmed",
            source: "admin",
          })
          .select("id")
          .single();
        expect(error).toBeNull();
        const { error: linkError } = await admin.from("referrals").update({ follow_up_appointment_id: winner!.id }).eq("id", id);
        expect(linkError).toBeNull();
      };

      expect(await bookFollowUp(id, startAt)).toMatchObject({ status: 409, body: { code: "follow_up_exists" } });
      expect(await appointmentsAt(patient, startAt)).toEqual([{ id: expect.any(String), status: "cancelled" }]);
    });

    it("releases the slot when the referral is revoked in the meantime", async () => {
      const { id, patientId: patient } = await acceptedReferral();
      const startAt = futureSlot();
      race.afterFollowUpCheck = async () => {
        race.afterFollowUpCheck = null;
        const { error } = await admin
          .from("referrals")
          .update({ status: "revoked", revoked_by: users.referrer, revoked_reason: "No longer needed" })
          .eq("id", id);
        expect(error).toBeNull();
      };

      expect(await bookFollowUp(id, startAt)).toMatchObject({ status: 409, body: { code: "referral_not_accepted" } });
      expect(await appointmentsAt(patient, startAt)).toEqual([{ id: expect.any(String), status: "cancelled" }]);
      const { data: referral } = await admin.from("referrals").select("follow_up_appointment_id").eq("id", id).single();
      expect(referral!.follow_up_appointment_id).toBeNull();
    });
  });

  it("lets clinic management — not reception — revoke a referral", async () => {
    const id = await freshReferral();
    const revoke = async (name: string, role: string, clinicId?: string) => {
      as(name, role, clinicId);
      return read(await revokeAsManagement(request("PATCH", `/api/admin/referrals/${id}`, { action: "revoke", reason: "Doctor left" }), params(id)));
    };

    expect(await revoke("receptionist", "receptionist")).toMatchObject({ status: 403 });
    expect(await revoke("doctorB", "owner", clinicB)).toMatchObject({ status: 404 });
    expect(await revoke("manager", "manager")).toMatchObject({ status: 200, body: { data: { status: "revoked" } } });

    const { data: trail } = await admin.from("audit_events").select("action, actor_id").eq("entity_id", id).eq("action", "referral_revoked");
    expect(trail).toEqual([{ action: "referral_revoked", actor_id: users.manager }]);
  });
});

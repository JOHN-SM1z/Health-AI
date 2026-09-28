import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { localDbAvailable } from "@/test/local-db";
import { daytimeTimezone } from "@/test/daytime-timezone";

/**
 * The patient's journey end to end against the local Supabase stack — the
 * acceptance scenario of the longitudinal history + referral work:
 *
 *   registration finds/creates the patient → Doctor A examines and records →
 *   Doctor A refers to a department → a department doctor (B) sees the
 *   referral and the patient's history at once, no approval → B starts their
 *   own consultation (taking the referral) and records their own assessment →
 *   B cannot change A's record → the patient returns → reception finds the
 *   same patient → Doctor C sees the longitudinal history.
 *
 * Only the session lookup is mocked; routes, services, RLS-backed decisions,
 * triggers and audit all run for real. Cast: reception; Dr A (general), Dr B
 * and Dr B2 (cardiology), Dr C (general), Dr D (same clinic, no relationship),
 * Dr K (another clinic).
 */

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const PASSWORD = "Longitudinal-Test-123!";
const TZ = daytimeTimezone();

const session = vi.hoisted(() => ({ ctx: null as unknown }));

vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});

import { GET as getWorkspace } from "./[id]/route";
import { POST as addRecord } from "./[id]/records/route";
import { POST as correctRecord } from "./[id]/records/[recordId]/corrections/route";
import { GET as getHistory } from "./[id]/records/[recordId]/history/route";
import { POST as startConsultation } from "./[id]/consultations/route";
import { POST as createReferral, GET as listReferrals } from "../referrals/route";
import { GET as getReferral } from "../referrals/[id]/route";
import { GET as pendingCount } from "../referrals/pending-count/route";
import { POST as frontDeskBook } from "@/app/api/admin/appointments/route";
import { GET as frontDeskPatients } from "@/app/api/admin/patients/route";

const describeDb = describe.skipIf(!localDbAvailable());

type Body = { ok: boolean; data?: Record<string, unknown>; code?: string; error?: string; details?: Record<string, unknown> };
type WsRecord = { id: string; summary: string; author: { id: string }; mine: boolean; version: number; rootRecordId: string };
type WsReferral = { id: string; role: string; status: string; allowedActions: string[]; department: { id: string } | null };
type Workspace = {
  relationship: string;
  appointments: Array<{ id: string; mine: boolean; doctor: { id: string } | null }>;
  records: WsRecord[];
  referrals: WsReferral[];
  consultation: { current: { appointmentId: string; paymentStatus: string | null } | null; booked: { appointmentId: string; paymentStatus: string | null } | null };
};

describeDb("longitudinal patient history and department referrals — the patient's journey", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const users: Record<string, string> = {};
  const doctors: Record<string, string> = {};
  const clinicOf: Record<string, string> = {};
  let clinic: string;
  let otherClinic: string;
  let cardiology: string;
  let general: string;
  let service: string;
  const PHONE = `+998 90 ${String(Date.now()).slice(-3)} 45 67`;
  const PHONE_TYPED_AGAIN = PHONE.replace(/[^0-9]/g, "").slice(3); // 9 digits, no country code

  // The patient and the journey's ids.
  let patient: string;
  let visitA: string;
  let diagnosisA: string;
  let referral: string;
  let assessmentB: string;

  const as = (name: string, role = "doctor") => {
    session.ctx = { profileId: users[name], clinicId: clinicOf[name], clinicName: "Journey Clinic", clinicTimezone: TZ, roles: [role], platformAdmin: false };
  };
  const request = (method: string, path: string, body?: unknown) =>
    new NextRequest(`http://localhost${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Body });
  const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

  const workspace = async (name: string) => {
    as(name);
    return read(await getWorkspace(request("GET", `/api/doctor/patients/${patient}`), params({ id: patient })));
  };
  const ws = async (name: string) => {
    const res = await workspace(name);
    expect(res.status, name).toBe(200);
    return res.body.data!.record as Workspace;
  };
  const record = async (name: string, body: Record<string, unknown>) => {
    as(name);
    return read(
      await addRecord(
        request("POST", `/api/doctor/patients/${patient}/records`, { idempotencyKey: randomUUID(), recordType: "consultation_note", summary: "Note", ...body }),
        params({ id: patient }),
      ),
    );
  };
  const book = async (body: Record<string, unknown>) => {
    as("reception", "receptionist");
    return read(await frontDeskBook(request("POST", "/api/admin/appointments", { source: "admin", serviceId: service, idempotencyKey: randomUUID(), ...body })));
  };
  const audits = async (action: string, actor?: string) => {
    let query = admin.from("audit_events").select("action, actor_id, entity_type, entity_id, metadata, new_values").eq("clinic_id", clinic).eq("action", action);
    if (actor) query = query.eq("actor_id", users[actor]);
    return ((await query.order("created_at", { ascending: true })).data ?? []) as Array<{
      action: string;
      actor_id: string | null;
      entity_type: string;
      entity_id: string | null;
      metadata: Record<string, unknown> | null;
      new_values: Record<string, unknown> | null;
    }>;
  };
  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

  async function makeClinic(label: string) {
    const { data } = await admin
      .from("clinics")
      .insert({ name: `Journey ${label} ${suffix}`, slug: `journey-${label}-${suffix}`, timezone: TZ })
      .select("id")
      .single();
    return data!.id as string;
  }
  async function makeUser(name: string, clinicId: string, role = "doctor") {
    const { data, error } = await admin.auth.admin.createUser({ email: `journey-${name}-${suffix}@test.local`, password: PASSWORD, email_confirm: true });
    expect(error).toBeNull();
    users[name] = data.user!.id;
    clinicOf[name] = clinicId;
    await admin.from("profiles").insert({ id: users[name], full_name: name });
    await admin.from("staff_roles").insert({ clinic_id: clinicId, profile_id: users[name], role });
  }
  async function makeDoctor(name: string, specialtyId: string | null) {
    const clinicId = clinicOf[name];
    const { data } = await admin
      .from("doctors")
      .insert({ clinic_id: clinicId, profile_id: users[name], name: `Dr ${name.toUpperCase()} ${suffix}`, specialty_id: specialtyId, active: true })
      .select("id")
      .single();
    doctors[name] = data!.id;
    await admin.from("doctor_working_hours").insert(
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinicId, doctor_id: data!.id, weekday, start_time: "00:00", end_time: "23:59" })),
    );
  }

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    clinic = await makeClinic("main");
    otherClinic = await makeClinic("other");
    const { data: specialties } = await admin
      .from("specialties")
      .insert([
        { clinic_id: clinic, name: `Kardiologiya ${suffix}` },
        { clinic_id: clinic, name: `Terapiya ${suffix}` },
      ])
      .select("id, name");
    cardiology = specialties!.find((s) => s.name.startsWith("Kardiologiya"))!.id;
    general = specialties!.find((s) => s.name.startsWith("Terapiya"))!.id;
    await makeUser("reception", clinic, "receptionist");
    for (const name of ["a", "b", "b2", "c", "d"]) await makeUser(name, clinic);
    await makeUser("k", otherClinic);
    await makeDoctor("a", general);
    await makeDoctor("b", cardiology);
    await makeDoctor("b2", cardiology);
    await makeDoctor("c", general);
    await makeDoctor("d", general);
    await makeDoctor("k", null);
    const { data: svc } = await admin
      .from("services")
      .insert({ clinic_id: clinic, name: `Journey consult ${suffix}`, duration_minutes: 20, price: 100000, active: true })
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

  it("registration: a new patient is created once; the same person typed again is found, not duplicated", async () => {
    const first = await book({ patientName: `Journey Patient ${suffix}`, phone: PHONE, doctorId: doctors.a, startAt: inHours(1), source: "walk_in" });
    expect(first.status).toBe(201);
    visitA = (first.body.data as { appointmentId: string }).appointmentId;
    patient = (await admin.from("appointments").select("patient_id").eq("id", visitA).single()).data!.patient_id;

    // The same phone typed another way, for "a new patient": the existing one is offered instead.
    const again = await book({ patientName: `Journey Patient ${suffix}`, phone: PHONE_TYPED_AGAIN, doctorId: doctors.a, startAt: inHours(3), source: "walk_in" });
    expect(again).toMatchObject({ status: 409, body: { code: "possible_duplicate" } });
    expect(again.body.details?.candidates).toEqual([expect.objectContaining({ id: patient })]);
    const { count } = await admin.from("patients").select("id", { count: "exact", head: true }).eq("clinic_id", clinic);
    expect(count).toBe(1);
  });

  it("Doctor A examines the patient and writes their own clinical record", async () => {
    as("a");
    const started = await read(await startConsultation(request("POST", `/api/doctor/patients/${patient}/consultations`, { appointmentId: visitA }), params({ id: patient })));
    expect(started).toMatchObject({ status: 201, body: { data: { consultation: { appointmentId: visitA, started: true } } } });
    const res = await record("a", { appointmentId: visitA, recordType: "diagnosis", summary: `Recurring chest discomfort (${suffix})` });
    expect(res.status).toBe(201);
    diagnosisA = (res.body.data!.record as { id: string }).id;
  });

  it("Tests 1–2: Doctor A refers to the cardiology department; every cardiologist receives it — nobody else", async () => {
    as("a");
    const res = await read(
      await createReferral(
        request("POST", "/api/doctor/referrals", {
          idempotencyKey: randomUUID(),
          appointmentId: visitA,
          referredToSpecialtyId: cardiology,
          reason: `Further cardiac evaluation (${suffix})`,
          handoffNote: "Patient reports recurring chest discomfort.",
          priority: "routine",
        }),
      ),
    );
    expect(res.status).toBe(201);
    referral = (res.body.data!.referral as { id: string }).id;

    for (const name of ["b", "b2"]) {
      as(name);
      const incoming = await read(await listReferrals(request("GET", "/api/doctor/referrals?box=incoming")));
      expect(incoming.body.data!.referrals, name).toEqual([
        expect.objectContaining({ id: referral, status: "pending", referredToDoctor: null, allowedActions: ["accept"], department: expect.objectContaining({ id: cardiology }) }),
      ]);
      expect(((await read(await pendingCount())).body.data as { pending: number }).pending, name).toBe(1);
    }
    for (const name of ["c", "d"]) {
      as(name);
      expect((await read(await listReferrals(request("GET", "/api/doctor/referrals?box=incoming")))).body.data!.referrals, name).toEqual([]);
    }
  });

  it("Test 3: Doctor B opens the referred patient and sees the history immediately — no approval", async () => {
    as("b");
    const detail = await read(await getReferral(request("GET", `/api/doctor/referrals/${referral}`), params({ id: referral })));
    expect(detail).toMatchObject({ status: 200, body: { data: { referral: { status: "pending", role: "receiver", patientRecordAccessible: true } } } });
    const history = (detail.body.data!.referral as { history: Array<{ id: string }> }).history;
    expect(history.map((a) => a.id)).toContain(visitA);

    const seen = await ws("b");
    expect(seen.relationship).toBe("referred");
    expect(seen.records.find((r) => r.id === diagnosisA)).toMatchObject({ author: { id: doctors.a }, mine: false });
    expect((await audits("referral_opened", "b")).map((a) => a.entity_id)).toContain(referral);
  });

  it("Test 4: Doctor B starts their own consultation (taking the referral) and records their own assessment", async () => {
    as("b");
    const started = await read(await startConsultation(request("POST", `/api/doctor/patients/${patient}/consultations`, { serviceId: service }), params({ id: patient })));
    expect(started.status).toBe(201);
    const visitB = (started.body.data!.consultation as { appointmentId: string }).appointmentId;

    const row = (await admin.from("referrals").select("status, referred_to_doctor_id, follow_up_appointment_id").eq("id", referral).single()).data;
    expect(row).toEqual({ status: "in_progress", referred_to_doctor_id: doctors.b, follow_up_appointment_id: visitB });
    // Taken: it left the other cardiologist's inbox.
    as("b2");
    expect((await read(await listReferrals(request("GET", "/api/doctor/referrals?box=incoming")))).body.data!.referrals).toEqual([]);

    const res = await record("b", { appointmentId: visitB, recordType: "assessment", summary: `Findings suggest stable angina (${suffix})` });
    expect(res.status).toBe(201);
    assessmentB = (res.body.data!.record as { id: string }).id;
    expect((await admin.from("clinical_records").select("author_doctor_id, created_by").eq("id", assessmentB).single()).data).toEqual({
      author_doctor_id: doctors.b,
      created_by: users.b,
    });
  });

  it("Tests 5, 6, 9, 11: Doctor B cannot correct, update or delete Doctor A's record — not via the API, not via REST", async () => {
    as("b");
    const correction = await read(
      await correctRecord(
        request("POST", `/api/doctor/patients/${patient}/records/${diagnosisA}/corrections`, { idempotencyKey: randomUUID(), summary: "Rewritten by Dr B" }),
        params({ id: patient, recordId: diagnosisA }),
      ),
    );
    expect(correction).toMatchObject({ status: 403, body: { code: "CLINICAL_RECORD_NOT_OWNED" } });
    expect((await audits("unauthorized_clinical_mutation_attempt", "b")).map((a) => a.metadata?.reason)).toContain("not_owned");

    const client = createClient(URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    expect((await client.auth.signInWithPassword({ email: `journey-b-${suffix}@test.local`, password: PASSWORD })).error).toBeNull();
    for (const attempt of [
      await client.from("clinical_records").update({ summary: "Changed by Dr B" }).eq("id", diagnosisA),
      await client.from("clinical_records").delete().eq("id", diagnosisA),
    ]) {
      expect(attempt.error?.code).toBe("42501");
    }
    await client.auth.signOut();
    expect((await admin.from("clinical_records").select("summary").eq("id", diagnosisA).single()).data!.summary).toBe(`Recurring chest discomfort (${suffix})`);
  });

  it("Test 10: Doctor A corrects their own record — the new version is current, the old one superseded, no reason asked", async () => {
    as("a");
    const res = await read(
      await correctRecord(
        request("POST", `/api/doctor/patients/${patient}/records/${diagnosisA}/corrections`, {
          idempotencyKey: randomUUID(),
          summary: `Recurring exertional chest discomfort (${suffix})`,
          expectedVersion: 1,
        }),
        params({ id: patient, recordId: diagnosisA }),
      ),
    );
    expect(res).toMatchObject({ status: 201, body: { data: { record: { version: 2 } } } });
    const history = await read(await getHistory(request("GET", `/api/doctor/patients/${patient}/records/${diagnosisA}/history`), params({ id: patient, recordId: diagnosisA })));
    expect((history.body.data!.history as { versions: Array<{ version: number; status: string }> }).versions.map((v) => [v.version, v.status])).toEqual([
      [1, "superseded"],
      [2, "current"],
    ]);
  });

  it("Tests 7–8: the patient returns; reception finds the same patient; Doctor C sees the whole longitudinal history", async () => {
    // Reception finds them however the phone is typed.
    as("reception", "receptionist");
    const found = await read(await frontDeskPatients(request("GET", `/api/admin/patients?q=${encodeURIComponent(PHONE_TYPED_AGAIN)}`)));
    expect((found.body.data as { patients: Array<{ id: string }> }).patients.map((p) => p.id)).toEqual([patient]);
    const booked = await book({ patientName: `Journey Patient ${suffix}`, patientId: patient, doctorId: doctors.c, startAt: inHours(2) });
    expect(booked.status).toBe(201);

    const seen = await ws("c");
    expect(seen.relationship).toBe("own");
    // Every doctor's current record, each attributed to its author — nothing hidden, nothing reassigned.
    const byId = new Map(seen.records.map((r) => [r.rootRecordId, r]));
    expect(byId.get(diagnosisA)).toMatchObject({ summary: `Recurring exertional chest discomfort (${suffix})`, version: 2, author: { id: doctors.a }, mine: false });
    expect(byId.get(assessmentB)).toMatchObject({ author: { id: doctors.b }, mine: false });
    expect(seen.appointments.map((a) => a.doctor?.id)).toEqual(expect.arrayContaining([doctors.a, doctors.b, doctors.c]));
    // The referral is part of the journey — read-only for Dr C.
    expect(seen.referrals).toEqual([expect.objectContaining({ id: referral, role: "observer", allowedActions: [] })]);
    // Payments: only the status of Dr C's own visit in front of them.
    expect(seen.consultation.booked).toMatchObject({ paymentStatus: "unpaid" });
    expect(JSON.stringify(seen)).not.toMatch(/"amount"|"price"/);
    expect(await audits("clinical_record_viewed", "c")).toEqual([
      expect.objectContaining({ entity_type: "patients", entity_id: patient, metadata: expect.objectContaining({ via: "workspace", relationship: "own" }) }),
    ]);
  });

  it("Test 8: nobody without a relationship — same clinic or another — sees anything, even knowing every id", async () => {
    expect(await workspace("d")).toMatchObject({ status: 404, body: { code: "patient_not_found" } });
    expect(await workspace("k")).toMatchObject({ status: 404 });
    as("k");
    const cross = await read(
      await correctRecord(
        request("POST", `/api/doctor/patients/${patient}/records/${diagnosisA}/corrections`, { idempotencyKey: randomUUID(), summary: "Cross-clinic" }),
        params({ id: patient, recordId: diagnosisA }),
      ),
    );
    expect(cross.status).toBe(404);
    expect((await audits("unauthorized_clinical_access_attempt", "d")).map((a) => a.entity_id)).toContain(patient);
  });

  it("the audit trail follows the journey — ids only, never clinical text", async () => {
    const referralEvents = await admin
      .from("audit_events")
      .select("action")
      .eq("clinic_id", clinic)
      .eq("referral_id", referral)
      .order("created_at", { ascending: true });
    expect((referralEvents.data ?? []).map((e) => e.action)).toEqual(expect.arrayContaining(["referral_created", "referral_accepted", "referral_in_progress"]));
    const accepted = (await audits("referral_accepted"))[0];
    expect(accepted.actor_id).toBe(users.b);
    expect(accepted.new_values).toMatchObject({ referred_to_doctor_id: doctors.b, referred_to_specialty_id: cardiology });
    expect((await audits("clinical_record_version_created", "a")).map((a) => a.entity_id)).toHaveLength(1);

    const all = JSON.stringify((await admin.from("audit_events").select("*").eq("clinic_id", clinic)).data);
    expect(all).not.toContain("chest discomfort");
    expect(all).not.toContain("stable angina");
    expect(all).not.toContain("Further cardiac evaluation");
  });
});

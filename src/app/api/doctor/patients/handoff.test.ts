import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { localDbAvailable } from "@/test/local-db";

/**
 * The clinical handoff, end to end against the local Supabase stack: Doctor A
 * refers their patient to Doctor B, who has the patient's whole history from
 * the moment the referral exists (no approval), accepts, starts their own
 * consultation, documents it and completes the
 * referral — PENDING → ACCEPTED → IN_PROGRESS → COMPLETED, or DECLINED.
 * Only the session lookup is mocked; every rule (routes, services, RLS-backed
 * decision, triggers, audit) runs for real.
 *
 * Cast: Dr A (referring), Dr B (receiving), Dr E (also saw the patient — their
 * record is part of the longitudinal history too), a receptionist.
 */

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
// A zone where it is daytime now: walk-ins "now" stay inside one local day.
const TZ = daytimeTimezone();

const session = vi.hoisted(() => ({ ctx: null as unknown }));

vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});

import { GET as getWorkspace } from "./[id]/route";
import { POST as addRecord } from "./[id]/records/route";
import { POST as startConsultation } from "./[id]/consultations/route";
import { POST as createReferral, GET as listReferrals } from "../referrals/route";
import { GET as getReferral, PATCH as actOnReferral } from "../referrals/[id]/route";
import { PATCH as doctorAppointmentStatus } from "../appointments/[id]/route";
import { PATCH as frontDeskAppointment } from "@/app/api/admin/appointments/[id]/route";
import { daytimeTimezone } from "@/test/daytime-timezone";

const describeDb = describe.skipIf(!localDbAvailable());

type Body = { ok: boolean; data?: Record<string, unknown>; code?: string; error?: string };
type WsRecord = {
  id: string;
  type: string;
  summary: string;
  code: string | null;
  appointmentId: string;
  author: { id: string; name: string | null };
  mine: boolean;
  stage: "current" | "historical";
  category: string;
  version: number;
  rootRecordId: string;
};
type Workspace = {
  relationship: string;
  appointments: Array<{ id: string; mine: boolean }>;
  records: WsRecord[];
  referrals: Array<{ id: string; role: string; status: string; followUpAppointmentId: string | null; startedAt: string | null }>;
  consultation: { current: { appointmentId: string } | null; canStartWalkIn: boolean; blockedReason: string | null };
};
type AuditRow = {
  action: string;
  actor_id: string | null;
  entity_type: string;
  entity_id: string;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
};

describeDb("clinical handoff workflow", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const startedAt = new Date().toISOString();
  const users: Record<string, string> = {};
  const doctors: Record<string, string> = {};
  let clinicA: string;
  let serviceA: string;
  let quickService: string;
  let slot = 0;

  const REASON = `Uncontrolled BP on amlodipine, ?LVH (${suffix})`;
  const NOTE = `Home readings 160/100 for a month (${suffix})`;

  const as = (name: string, role = "doctor") => {
    session.ctx = { profileId: users[name], clinicId: clinicA, clinicName: "Handoff Clinic", clinicTimezone: TZ, roles: [role], platformAdmin: false };
  };
  const request = (method: string, path: string, body?: unknown) =>
    new NextRequest(`http://localhost${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Body });

  const workspace = async (name: string, patientId: string) => {
    as(name);
    return read(await getWorkspace(request("GET", `/api/doctor/patients/${patientId}`), params(patientId)));
  };
  const ws = async (name: string, patientId: string) => {
    const res = await workspace(name, patientId);
    expect(res.status).toBe(200);
    return res.body.data!.record as Workspace;
  };
  const write = async (name: string, patientId: string, body: Record<string, unknown>) => {
    as(name);
    return read(
      await addRecord(
        request("POST", `/api/doctor/patients/${patientId}/records`, { idempotencyKey: randomUUID(), recordType: "consultation_note", summary: "Note", ...body }),
        params(patientId),
      ),
    );
  };
  const written = async (name: string, patientId: string, body: Record<string, unknown>) => {
    const res = await write(name, patientId, body);
    expect(res.status).toBe(201);
    return (res.body.data!.record as { id: string }).id;
  };
  const start = async (name: string, patientId: string, body: Record<string, unknown>) => {
    as(name);
    return read(await startConsultation(request("POST", `/api/doctor/patients/${patientId}/consultations`, body), params(patientId)));
  };
  const act = async (name: string, referralId: string, body: Record<string, unknown>) => {
    as(name);
    return read(await actOnReferral(request("PATCH", `/api/doctor/referrals/${referralId}`, body), params(referralId)));
  };
  const detail = async (name: string, referralId: string) => {
    as(name);
    return read(await getReferral(request("GET", `/api/doctor/referrals/${referralId}`), params(referralId)));
  };
  const queue = async (name: string, appointmentId: string, status: string) => {
    as(name);
    return read(await doctorAppointmentStatus(request("PATCH", `/api/doctor/appointments/${appointmentId}`, { status }), params(appointmentId)));
  };
  const frontDesk = async (appointmentId: string, status: string) => {
    as("receptionist", "receptionist");
    return read(await frontDeskAppointment(request("PATCH", `/api/admin/appointments/${appointmentId}`, { action: "status", status }), params(appointmentId)));
  };
  const referralRow = async (id: string) =>
    (await admin.from("referrals").select("status, follow_up_appointment_id, started_by, started_at").eq("id", id).single()).data!;
  const audits = async (entityId: string) =>
    ((await admin
      .from("audit_events")
      .select("action, actor_id, entity_type, entity_id, old_values, new_values, metadata")
      .eq("clinic_id", clinicA)
      .eq("entity_id", entityId)
      .order("created_at", { ascending: true })).data ?? []) as AuditRow[];

  async function makeUser(name: string, role: string) {
    const { data, error } = await admin.auth.admin.createUser({ email: `handoff-${name}-${suffix}@test.local`, password: "Handoff-Test-123!", email_confirm: true });
    expect(error).toBeNull();
    users[name] = data.user!.id;
    await admin.from("profiles").insert({ id: users[name], full_name: name });
    await admin.from("staff_roles").insert({ clinic_id: clinicA, profile_id: users[name], role });
  }

  async function makeDoctor(name: string) {
    const { data } = await admin
      .from("doctors")
      .insert({ clinic_id: clinicA, profile_id: users[name], name: `Dr ${name.toUpperCase()} ${suffix}`, active: true })
      .select("id")
      .single();
    doctors[name] = data!.id;
    await admin.from("doctor_working_hours").insert(
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinicA, doctor_id: data!.id, weekday, start_time: "00:00", end_time: "23:59" })),
    );
  }

  async function visit(patientId: string, doctor: string, status = "completed") {
    const startTime = new Date(Date.UTC(2026, 0, 5, 5, 0) + slot++ * 86_400_000);
    const { data, error } = await admin
      .from("appointments")
      .insert({
        clinic_id: clinicA,
        patient_id: patientId,
        doctor_id: doctor,
        service_id: serviceA,
        start_at: startTime.toISOString(),
        end_at: new Date(startTime.getTime() + 30 * 60_000).toISOString(),
        status,
        source: "walk_in",
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id as string;
  }

  /** Patient X: Dr A's earlier visit and the consultation they refer from, each documented; Dr E's visit too. */
  async function patientX() {
    const { data } = await admin
      .from("patients")
      .insert({ clinic_id: clinicA, full_name: `Handoff patient ${suffix}`, phone: "+998907770011" })
      .select("id")
      .single();
    const id = data!.id as string;
    const earlier = await visit(id, doctors.a);
    const consultation = await visit(id, doctors.a);
    const withE = await visit(id, doctors.e);
    const history = await written("a", id, { appointmentId: earlier, recordType: "medical_history", summary: `Type 2 diabetes since 2015 (${suffix})` });
    const diagnosis = await written("a", id, { appointmentId: consultation, recordType: "diagnosis", summary: `Essential hypertension (${suffix})`, code: "I10" });
    const prescription = await written("a", id, { appointmentId: consultation, recordType: "prescription", summary: `Amlodipine 10 mg daily (${suffix})` });
    const eRecord = await written("e", id, { appointmentId: withE, recordType: "consultation_note", summary: `Dermatology review (${suffix})` });
    return { id, earlier, consultation, withE, history, diagnosis, prescription, eRecord };
  }

  async function refer(x: { consultation: string }, to = doctors.b) {
    as("a");
    const res = await read(
      await createReferral(
        request("POST", "/api/doctor/referrals", {
          idempotencyKey: randomUUID(),
          appointmentId: x.consultation,
          referredToDoctorId: to,
          reason: REASON,
          handoffNote: NOTE,
          priority: "urgent",
          validForDays: 30,
        }),
      ),
    );
    expect(res.status).toBe(201);
    return (res.body.data!.referral as { id: string }).id;
  }

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { data: clinic } = await admin
      .from("clinics")
      .insert({ name: `Handoff Clinic ${suffix}`, slug: `handoff-${suffix}`, timezone: TZ })
      .select("id")
      .single();
    clinicA = clinic!.id;
    for (const name of ["a", "b", "e"]) await makeUser(name, "doctor");
    await makeUser("receptionist", "receptionist");
    for (const name of ["a", "b", "e"]) await makeDoctor(name);
    const { data: services } = await admin
      .from("services")
      .insert([
        { clinic_id: clinicA, name: `Handoff consult ${suffix}`, duration_minutes: 30, price: 100000, active: true },
        { clinic_id: clinicA, name: `Handoff quick visit ${suffix}`, duration_minutes: 5, price: 50000, active: true },
      ])
      .select("id, duration_minutes");
    serviceA = services!.find((s) => s.duration_minutes === 30)!.id;
    quickService = services!.find((s) => s.duration_minutes === 5)!.id;
  });

  afterAll(async () => {
    if (!admin || !clinicA) return;
    await admin.from("patients").delete().eq("clinic_id", clinicA);
    await admin.from("staff_roles").delete().eq("clinic_id", clinicA);
    await admin.from("doctors").delete().eq("clinic_id", clinicA);
    await admin.from("services").delete().eq("clinic_id", clinicA);
    await admin.from("clinics").delete().eq("id", clinicA);
    for (const id of Object.values(users)) await admin.auth.admin.deleteUser(id).catch(() => {});
  });

  it("the complete handoff: review → accept → own consultation → new records → complete, never rewriting history", async () => {
    const x = await patientX();
    const diagnosisBefore = (await admin.from("clinical_records").select("*").eq("id", x.diagnosis).single()).data;
    const referral = await refer(x);

    // 1. Pending: Dr B has the whole longitudinal history at once — every doctor's records, each attributed to its author.
    const everyRecord = [x.history, x.diagnosis, x.prescription, x.eRecord].sort();
    const pending = await ws("b", x.id);
    expect(pending).toMatchObject({ relationship: "referred", consultation: { current: null, canStartWalkIn: true } });
    expect(pending.consultation).not.toHaveProperty("blockedReason");
    expect(pending.records.map((r) => r.id).sort()).toEqual(everyRecord);
    expect(pending.records.find((r) => r.id === x.diagnosis)).toMatchObject({
      author: { id: doctors.a },
      mine: false,
      stage: "historical",
      category: "historical_diagnosis",
    });
    expect(pending.records.find((r) => r.id === x.eRecord)).toMatchObject({ author: { id: doctors.e }, mine: false });

    // 2. Accept (audited): a care step, not a gate — the view of the history is exactly the same.
    expect(await act("b", referral, { action: "accept" })).toMatchObject({ status: 200, body: { data: { status: "accepted" } } });
    const accepted = await ws("b", x.id);
    expect(accepted.records.map((r) => r.id).sort()).toEqual(everyRecord);
    expect(accepted.records.every((r) => !r.mine && r.stage === "historical")).toBe(true);
    expect(accepted.records.filter((r) => r.author.id === doctors.a).map((r) => r.id).sort()).toEqual([x.history, x.diagnosis, x.prescription].sort());
    // Completing before seeing the patient is neither offered nor accepted.
    expect((await detail("b", referral)).body.data!.referral).toMatchObject({ status: "accepted", allowedActions: [] });
    expect(await act("b", referral, { action: "complete" })).toMatchObject({ status: 409, body: { code: "consultation_not_started" } });

    // 3. Dr B starts their own consultation: linked to the referral, which is now in progress.
    const started = await start("b", x.id, { serviceId: quickService });
    expect(started).toMatchObject({ status: 201, body: { data: { consultation: { started: true } } } });
    const consultationId = (started.body.data!.consultation as { appointmentId: string }).appointmentId;
    expect(await referralRow(referral)).toMatchObject({ status: "in_progress", follow_up_appointment_id: consultationId, started_by: users.b });
    expect((await detail("b", referral)).body.data!.referral).toMatchObject({ status: "in_progress", allowedActions: ["complete"], followUp: { id: consultationId } });

    // 4–5. Dr B documents it in the existing clinical-record system — every record authored by Dr B.
    const mine = {
      assessment: await written("b", x.id, { appointmentId: consultationId, recordType: "assessment", summary: `BP 165/100, LVH on ECG (${suffix})` }),
      diagnosis: await written("b", x.id, { appointmentId: consultationId, recordType: "diagnosis", summary: `Hypertensive heart disease (${suffix})`, code: "I11.9" }),
      note: await written("b", x.id, { appointmentId: consultationId, recordType: "consultation_note", summary: `Reviewed Dr A's history (${suffix})` }),
      prescription: await written("b", x.id, { appointmentId: consultationId, recordType: "prescription", summary: `Add losartan 50 mg (${suffix})` }),
      labOrder: await written("b", x.id, { appointmentId: consultationId, recordType: "lab_order", summary: `Echocardiogram, lipid panel (${suffix})` }),
      followUp: await written("b", x.id, { appointmentId: consultationId, recordType: "follow_up", summary: `Review in 4 weeks with results (${suffix})` }),
    };
    const { data: rows } = await admin
      .from("clinical_records")
      .select("id, author_doctor_id, created_by, appointment_id")
      .in("id", Object.values(mine));
    expect(rows).toHaveLength(6);
    for (const row of rows!) expect(row).toMatchObject({ author_doctor_id: doctors.b, created_by: users.b, appointment_id: consultationId });

    // The distinction a doctor sees: historical vs current, by category.
    const during = await ws("b", x.id);
    const category = (id: string) => during.records.find((r) => r.id === id)?.category;
    expect(Object.fromEntries(Object.entries(mine).map(([k, id]) => [k, category(id)]))).toEqual({
      assessment: "current_assessment",
      diagnosis: "new_diagnosis",
      note: "clinical_note",
      prescription: "prescription",
      labOrder: "lab_order",
      followUp: "follow_up",
    });
    expect(category(x.diagnosis)).toBe("historical_diagnosis");
    expect(during.records.filter((r) => Object.values(mine).includes(r.id)).every((r) => r.mine && r.stage === "current")).toBe(true);

    // 6–7. Dr A's records stay Dr A's, untouched: reviewing, a new diagnosis or an attempt to correct changes nothing.
    expect(await write("b", x.id, { appointmentId: consultationId, recordType: "diagnosis", summary: "Overwrite", correctsRecordId: x.diagnosis })).toMatchObject({
      status: 403,
      body: { code: "CLINICAL_RECORD_NOT_OWNED" },
    });
    expect(await write("b", x.id, { appointmentId: x.consultation, recordType: "diagnosis", summary: "Into Dr A's visit" })).toMatchObject({
      status: 404,
      body: { code: "consultation_not_found" },
    });
    expect((await admin.from("clinical_records").select("*").eq("id", x.diagnosis).single()).data).toEqual(diagnosisBefore);
    expect(during.records.find((r) => r.id === x.diagnosis)).toMatchObject({ author: { id: doctors.a }, version: 1 });

    // Consultation and referral completed (audited).
    expect(await queue("b", consultationId, "completed")).toMatchObject({ status: 200 });
    expect(await act("b", referral, { action: "complete" })).toMatchObject({ status: 200, body: { data: { status: "completed" } } });

    // Afterwards Dr B is the patient's doctor themselves: the whole history stays, and their own records are now history too, still theirs.
    const after = await ws("b", x.id);
    expect(after.relationship).toBe("own");
    expect(after.records.map((r) => r.id).sort()).toEqual([...everyRecord, ...Object.values(mine)].sort());
    expect(after.records.find((r) => r.id === mine.diagnosis)).toMatchObject({ stage: "historical", category: "historical_diagnosis", mine: true });
    // Dr A sees the follow-up and its records — authored by Dr B — next to their own, unchanged.
    const referrer = await ws("a", x.id);
    expect(referrer.records.find((r) => r.id === mine.diagnosis)).toMatchObject({ author: { id: doctors.b }, mine: false });
    expect(referrer.records.find((r) => r.id === x.diagnosis)).toMatchObject({ author: { id: doctors.a }, mine: true, version: 1 });

    // The audit trail: every step, with its actor — and no clinical text anywhere.
    expect((await audits(referral)).filter((a) => a.action.startsWith("referral_") && !["referral_viewed", "referral_opened"].includes(a.action)).map((a) => [a.action, a.actor_id])).toEqual([
      ["referral_created", users.a],
      ["referral_accepted", users.b],
      ["referral_in_progress", users.b],
      ["referral_completed", users.b],
    ]);
    const consultationAudit = (await audits(consultationId)).filter((a) => a.action === "consultation_started");
    expect(consultationAudit).toHaveLength(1);
    expect(consultationAudit[0]).toMatchObject({
      actor_id: users.b,
      entity_type: "appointments",
      metadata: { referral_id: referral, doctor_id: doctors.b, patient_id: x.id, via: "doctor_workspace", walk_in: true },
    });
    const { data: trail } = await admin.from("audit_events").select("*").eq("clinic_id", clinicA).gte("created_at", startedAt);
    const text = JSON.stringify(trail);
    for (const secret of [REASON, NOTE, "Hypertensive heart disease", "losartan", "Echocardiogram", "LVH", "Essential hypertension"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("declined: Dr B declines a pending referral — audited, reason for Dr A only, no access, no consultation", async () => {
    const x = await patientX();
    const referral = await refer(x);
    const reason = `Better seen by nephrology (${suffix})`;
    expect(await act("b", referral, { action: "decline", reason })).toMatchObject({ status: 200, body: { data: { status: "declined" } } });

    expect(await workspace("b", x.id)).toMatchObject({ status: 410, body: { code: "referral_declined" } });
    expect(await start("b", x.id, { serviceId: quickService })).toMatchObject({ status: 410, body: { code: "referral_declined" } });
    // Declined is final: Dr B no longer has it, so accepting answers why (410) and writes nothing.
    expect(await act("b", referral, { action: "accept" })).toMatchObject({ status: 410, body: { code: "referral_declined" } });
    expect((await detail("a", referral)).body.data!.referral).toMatchObject({ status: "declined", declinedReason: reason });

    const declined = (await audits(referral)).find((a) => a.action === "referral_declined");
    expect(declined).toMatchObject({ actor_id: users.b, old_values: { status: "pending" } });
    expect(JSON.stringify(declined)).not.toContain("nephrology");
  });

  it("starting a consultation while the referral is still pending takes the referral on: accepted, then in progress, audited as the receiving doctor", async () => {
    // Dr E receives it: Dr B's walk-in slots "now" are taken by the tests above (a slot stays taken after it is completed).
    const { data: created } = await admin.from("patients").insert({ clinic_id: clinicA, full_name: `Pending-start patient ${suffix}`, phone: "+998907770022" }).select("id").single();
    const patientId = created!.id as string;
    const x = { id: patientId, consultation: await visit(patientId, doctors.a) };
    const referral = await refer(x, doctors.e);
    // Once refused with 409 "accept first" — a pending referral is no longer a gate.
    const started = await start("e", x.id, { serviceId: quickService });
    expect(started).toMatchObject({ status: 201, body: { data: { consultation: { started: true } } } });
    const consultationId = (started.body.data!.consultation as { appointmentId: string }).appointmentId;

    expect(await referralRow(referral)).toMatchObject({ status: "in_progress", follow_up_appointment_id: consultationId, started_by: users.e });
    expect((await audits(referral)).filter((a) => ["referral_accepted", "referral_in_progress"].includes(a.action)).map((a) => [a.action, a.actor_id])).toEqual([
      ["referral_accepted", users.e],
      ["referral_in_progress", users.e],
    ]);
    // Starting again is idempotent: the same consultation, nothing more accepted.
    expect(await start("e", x.id, { serviceId: quickService })).toMatchObject({ status: 200, body: { data: { consultation: { appointmentId: consultationId, started: false } } } });
  });

  it("starting the consultation from the queue or the front desk links it and moves the referral in progress", async () => {
    // A follow-up booked by reception, started from Dr B's queue.
    const x = await patientX();
    const referral = await refer(x);
    await act("b", referral, { action: "accept" });
    const booked = await visit(x.id, doctors.b, "confirmed");
    await admin.from("referrals").update({ follow_up_appointment_id: booked }).eq("id", referral);
    expect(await queue("b", booked, "checked_in")).toMatchObject({ status: 200 });
    expect((await referralRow(referral)).status).toBe("accepted");
    expect(await queue("b", booked, "in_progress")).toMatchObject({ status: 200 });
    expect(await referralRow(referral)).toMatchObject({ status: "in_progress", started_by: users.b });
    expect((await audits(booked)).find((a) => a.action === "consultation_started")).toMatchObject({
      actor_id: users.b,
      metadata: { referral_id: referral, via: "doctor_queue" },
    });

    // A visit that was not booked as the follow-up becomes it when Dr B starts it.
    const y = await patientX();
    const second = await refer(y);
    await act("b", second, { action: "accept" });
    const unlinked = await visit(y.id, doctors.b, "checked_in");
    expect(await queue("b", unlinked, "in_progress")).toMatchObject({ status: 200 });
    expect(await referralRow(second)).toMatchObject({ status: "in_progress", follow_up_appointment_id: unlinked });

    // The front desk marking the booked follow-up in progress moves it too, audited as them.
    const z = await patientX();
    const third = await refer(z);
    await act("b", third, { action: "accept" });
    const booked3 = await visit(z.id, doctors.b, "checked_in");
    await admin.from("referrals").update({ follow_up_appointment_id: booked3 }).eq("id", third);
    expect(await frontDesk(booked3, "in_progress")).toMatchObject({ status: 200 });
    expect(await referralRow(third)).toMatchObject({ status: "in_progress", started_by: users.b });
    expect((await audits(booked3)).find((a) => a.action === "consultation_started")).toMatchObject({
      actor_id: users.receptionist,
      metadata: { referral_id: third, via: "front_desk" },
    });
  });

  it("an in-progress referral: listed as open, revocable by Dr A — Dr B then keeps the history through their own consultation", async () => {
    const x = await patientX();
    const referral = await refer(x);
    await act("b", referral, { action: "accept" });
    const own = await visit(x.id, doctors.b, "checked_in");
    await queue("b", own, "in_progress");
    const ownRecord = await written("b", x.id, { appointmentId: own, recordType: "assessment", summary: `Stable (${suffix})` });

    as("b");
    const incoming = (await read(await listReferrals(request("GET", "/api/doctor/referrals?box=incoming")))).body.data!.referrals as Array<{ id: string; status: string }>;
    expect(incoming.find((r) => r.id === referral)?.status).toBe("in_progress");
    expect((await ws("b", x.id)).referrals.find((r) => r.id === referral)).toMatchObject({ status: "in_progress", followUpAppointmentId: own, startedAt: expect.any(String) });

    expect(await act("a", referral, { action: "revoke", reason: "Patient transferred" })).toMatchObject({ status: 200, body: { data: { status: "revoked" } } });
    const after = await ws("b", x.id);
    expect(after.relationship).toBe("own");
    expect(after.records.map((r) => r.id).sort()).toEqual([x.history, x.diagnosis, x.prescription, x.eRecord, ownRecord].sort());
    expect(after.records.find((r) => r.id === ownRecord)).toMatchObject({ stage: "current", category: "current_assessment", mine: true });
  });
});

import { cleanupTestClinics } from "@/test/cleanup-clinics";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { NextRequest } from "next/server";
import { localDbAvailable } from "@/test/local-db";
import { daytimeTimezone } from "@/test/daytime-timezone";

/**
 * Clinical record governance, end to end against the local Supabase stack:
 * a doctor's record belongs to its author. Only the author corrects it — edit
 * and save, no reason — as its next version; the earlier version is kept,
 * superseded, never destroyed. Every doctor with a legitimate relationship to
 * the patient — a treating relationship or a referral — READS the whole
 * longitudinal history, never changes another doctor's record: they record
 * their own assessment in their own consultation. Every refusal is audited,
 * the database refuses the same things on its own, and nothing crosses
 * clinics. Only the session lookup is mocked.
 *
 * Cast: Dr A (writes the diagnosis, refers the patient), Dr B (receives the
 * referral), Dr C (same clinic, no relationship), Dr E (also saw the patient,
 * no referral — a treating relationship of their own), Dr K (another clinic).
 */

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const PASSWORD = "Governance-Test-123!";
// A zone where it is daytime now: walk-ins "now" stay inside one local day.
const TZ = daytimeTimezone();

const session = vi.hoisted(() => ({ ctx: null as unknown }));

vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});

import { GET as getWorkspace } from "./[id]/route";
import { POST as addRecord } from "./[id]/records/route";
import { POST as correctRecord } from "./[id]/records/[recordId]/corrections/route";
import * as historyRoute from "./[id]/records/[recordId]/history/route";
import { POST as startConsultation } from "./[id]/consultations/route";
import { POST as createReferral } from "../referrals/route";
import { PATCH as actOnReferral } from "../referrals/[id]/route";
import { PATCH as updateDoctor } from "@/app/api/admin/doctors/route";

const describeDb = describe.skipIf(!localDbAvailable());

type Body = { ok: boolean; data?: Record<string, unknown>; code?: string; error?: string; details?: Record<string, unknown> };
type WsRecord = { id: string; summary: string; author: { id: string }; mine: boolean; version: number; rootRecordId: string };
type Version = { id: string; version: number; status: string; summary: string; author: { id: string } };
type AuditRow = {
  action: string;
  actor_id: string | null;
  entity_id: string | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
};

describeDb("clinical record governance — author-only versioned corrections", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const users: Record<string, string> = {};
  const doctors: Record<string, string> = {};
  const clinicOf: Record<string, string> = {};
  let clinicA: string;
  let clinicK: string;
  let serviceA: string;
  let quickService: string;
  let slot = 0;
  // Patient X: Dr A's consultation with Dr A's diagnosis, referred to Dr B.
  let patient: string;
  let consultation: string;
  let diagnosisV1: string;
  let diagnosisV2: string;
  let referral: string;
  let assessment: string;

  const GASTRITIS = `Gastritis (${suffix})`;
  const ULCER = `Peptic ulcer disease (${suffix})`;

  const as = (name: string) => {
    session.ctx = {
      profileId: users[name],
      clinicId: clinicOf[name],
      clinicName: "Governance Clinic",
      clinicTimezone: TZ,
      roles: ["doctor"],
      platformAdmin: false,
    };
  };
  const request = (method: string, path: string, body?: unknown) =>
    new NextRequest(`http://localhost${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Body });

  const workspace = async (name: string, patientId: string) => {
    as(name);
    return read(await getWorkspace(request("GET", `/api/doctor/patients/${patientId}`), { params: Promise.resolve({ id: patientId }) }));
  };
  const records = async (name: string, patientId: string) => {
    const res = await workspace(name, patientId);
    expect(res.status).toBe(200);
    return (res.body.data!.record as { records: WsRecord[] }).records;
  };
  const history = async (name: string, patientId: string, recordId: string) => {
    as(name);
    return read(
      await historyRoute.GET(request("GET", `/api/doctor/patients/${patientId}/records/${recordId}/history`), {
        params: Promise.resolve({ id: patientId, recordId }),
      }),
    );
  };
  const correct = async (name: string, patientId: string, recordId: string, body: Record<string, unknown>) => {
    as(name);
    return read(
      await correctRecord(
        request("POST", `/api/doctor/patients/${patientId}/records/${recordId}/corrections`, { idempotencyKey: randomUUID(), ...body }),
        { params: Promise.resolve({ id: patientId, recordId }) },
      ),
    );
  };
  const write = async (name: string, patientId: string, body: Record<string, unknown>) => {
    as(name);
    return read(
      await addRecord(
        request("POST", `/api/doctor/patients/${patientId}/records`, { idempotencyKey: randomUUID(), recordType: "consultation_note", summary: "Note", ...body }),
        { params: Promise.resolve({ id: patientId }) },
      ),
    );
  };
  const row = async (id: string) =>
    (await admin.from("clinical_records").select("id, summary, version, root_record_id, author_doctor_id, created_by, corrects_record_id").eq("id", id).single())
      .data!;
  const versionsOf = async (rootId: string) =>
    ((await admin.from("clinical_record_versions").select("id, version, status, summary, author_doctor_id, created_by").eq("root_record_id", rootId).order("version"))
      .data ?? []) as Array<{ id: string; version: number; status: string; summary: string; author_doctor_id: string; created_by: string }>;
  const audits = async (action: string, actor: string) =>
    ((await admin
      .from("audit_events")
      .select("action, actor_id, entity_id, old_values, new_values, metadata")
      .eq("clinic_id", clinicA)
      .eq("action", action)
      .eq("actor_id", users[actor])
      .order("created_at", { ascending: true })).data ?? []) as AuditRow[];

  async function makeClinic(label: string) {
    const { data } = await admin
      .from("clinics")
      .insert({ name: `Governance ${label} ${suffix}`, slug: `governance-${label}-${suffix}`, timezone: TZ })
      .select("id")
      .single();
    return data!.id as string;
  }

  async function makeUser(name: string, clinicId: string) {
    const { data, error } = await admin.auth.admin.createUser({ email: `governance-${name}-${suffix}@test.local`, password: PASSWORD, email_confirm: true });
    expect(error).toBeNull();
    users[name] = data.user!.id;
    clinicOf[name] = clinicId;
    await admin.from("profiles").insert({ id: users[name], full_name: name });
    await admin.from("staff_roles").insert({ clinic_id: clinicId, profile_id: users[name], role: "doctor" });
  }

  async function makeDoctor(name: string) {
    const clinicId = clinicOf[name];
    const { data } = await admin
      .from("doctors")
      .insert({ clinic_id: clinicId, profile_id: users[name], name: `Dr ${name.toUpperCase()} ${suffix}`, active: true })
      .select("id")
      .single();
    doctors[name] = data!.id;
    await admin.from("doctor_working_hours").insert(
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinicId, doctor_id: data!.id, weekday, start_time: "00:00", end_time: "23:59" })),
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

  /** A signed-in doctor's own Supabase client — exactly what their browser token can do. */
  async function signedIn(name: string) {
    const client = createClient(URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await client.auth.signInWithPassword({ email: `governance-${name}-${suffix}@test.local`, password: PASSWORD });
    expect(error).toBeNull();
    return client;
  }

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    clinicA = await makeClinic("a");
    clinicK = await makeClinic("k");
    for (const name of ["a", "b", "c", "e"]) await makeUser(name, clinicA);
    await makeUser("k", clinicK);
    for (const name of ["a", "b", "c", "e", "k"]) await makeDoctor(name);
    const { data: services } = await admin
      .from("services")
      .insert([
        { clinic_id: clinicA, name: `Governance consult ${suffix}`, duration_minutes: 30, price: 100000, active: true },
        { clinic_id: clinicA, name: `Governance quick visit ${suffix}`, duration_minutes: 5, price: 50000, active: true },
      ])
      .select("id, duration_minutes");
    serviceA = services!.find((s) => s.duration_minutes === 30)!.id;
    quickService = services!.find((s) => s.duration_minutes === 5)!.id;

    const { data } = await admin
      .from("patients")
      .insert({ clinic_id: clinicA, full_name: `Governance patient ${suffix}`, phone: "+998907770022" })
      .select("id")
      .single();
    patient = data!.id;
    consultation = await visit(patient, doctors.a);
    await visit(patient, doctors.e);
    const res = await write("a", patient, { appointmentId: consultation, recordType: "diagnosis", summary: GASTRITIS, code: "K29" });
    expect(res.status).toBe(201);
    diagnosisV1 = (res.body.data!.record as { id: string }).id;
  });

  afterAll(async () => {
    if (!admin || !clinicA) return;
    // The retained domains go explicitly (cleanupTestClinics); a patient or
    // clinic cannot be deleted from under their records.
    for (const clinicId of [clinicA, clinicK]) {
      await admin.from("staff_roles").delete().eq("clinic_id", clinicId);
      await cleanupTestClinics([clinicId]);
    }
    for (const id of Object.values(users)) await admin.auth.admin.deleteUser(id).catch(() => {});
  });

  it("A. the author corrects their own record: edit → save makes the next version, no reason asked", async () => {
    const res = await correct("a", patient, diagnosisV1, { summary: ULCER, code: "K27", expectedVersion: 1 });
    expect(res).toMatchObject({ status: 201, body: { ok: true, data: { record: { version: 2, replayed: false } } } });
    diagnosisV2 = (res.body.data!.record as { id: string }).id;

    const [v1, v2] = [await row(diagnosisV1), await row(diagnosisV2)];
    expect(v1).toMatchObject({ summary: GASTRITIS, version: 1, root_record_id: diagnosisV1, author_doctor_id: doctors.a, created_by: users.a });
    expect(v2).toMatchObject({
      summary: ULCER,
      version: 2,
      root_record_id: diagnosisV1,
      corrects_record_id: diagnosisV1,
      author_doctor_id: doctors.a,
      created_by: users.a,
    });
  });

  it("H. the history keeps every version with its attribution; only the latest is current, nothing is destroyed", async () => {
    expect(await versionsOf(diagnosisV1)).toEqual([
      { id: diagnosisV1, version: 1, status: "superseded", summary: GASTRITIS, author_doctor_id: doctors.a, created_by: users.a },
      { id: diagnosisV2, version: 2, status: "current", summary: ULCER, author_doctor_id: doctors.a, created_by: users.a },
    ]);

    // The correction's audit row names both versions and the original author — ids and numbers only.
    const [corrected] = await audits("clinical_record_version_created", "a");
    expect(corrected).toMatchObject({
      entity_id: diagnosisV2,
      old_values: { record_id: diagnosisV1, version: 1, author_doctor_id: doctors.a, created_by: users.a },
      new_values: { version: 2, root_record_id: diagnosisV1, corrects_record_id: diagnosisV1, author_doctor_id: doctors.a },
    });
    expect(JSON.stringify(corrected)).not.toContain("Gastritis");
    expect(JSON.stringify(corrected)).not.toContain("Peptic");
  });

  it("I. the normal view shows only the current value; the read-only history view reconstructs both", async () => {
    const shown = (await records("a", patient)).filter((r) => r.rootRecordId === diagnosisV1);
    expect(shown).toEqual([expect.objectContaining({ id: diagnosisV2, summary: ULCER, version: 2, mine: true })]);
    expect(JSON.stringify(await records("a", patient))).not.toContain(GASTRITIS);

    const res = await history("a", patient, diagnosisV2);
    expect(res.status).toBe(200);
    const versions = (res.body.data!.history as { versions: Version[] }).versions;
    expect(versions.map((v) => [v.version, v.status, v.summary, v.author.id])).toEqual([
      [1, "superseded", GASTRITIS, doctors.a],
      [2, "current", ULCER, doctors.a],
    ]);
    // The history is read-only: its route has no write method at all.
    expect(Object.keys(historyRoute).filter((k) => ["POST", "PUT", "PATCH", "DELETE"].includes(k))).toEqual([]);
    // A history read is an access-log entry of its own (the workspace reads above are logged too).
    expect((await audits("clinical_record_viewed", "a")).filter((a) => a.metadata?.via === "history")).toEqual([
      expect.objectContaining({ entity_id: diagnosisV1, metadata: expect.objectContaining({ via: "history", relationship: "own", version_count: 2 }) }),
    ]);
  });

  it("C. a referred doctor reads the history from the moment of the referral — no approval — and every read is audited", async () => {
    as("a");
    const created = await read(
      await createReferral(
        request("POST", "/api/doctor/referrals", {
          idempotencyKey: randomUUID(),
          appointmentId: consultation,
          referredToDoctorId: doctors.b,
          reason: `Epigastric pain despite PPI (${suffix})`,
          priority: "routine",
          validForDays: 30,
        }),
      ),
    );
    expect(created.status).toBe(201);
    referral = (created.body.data!.referral as { id: string }).id;

    // Pending, not accepted: Dr B already reads Dr A's current record — acceptance is no gate.
    const seen = (await records("b", patient)).find((r) => r.rootRecordId === diagnosisV1);
    expect(seen).toMatchObject({ id: diagnosisV2, summary: ULCER, author: { id: doctors.a }, mine: false });
    const [viewed] = (await audits("clinical_record_viewed", "b")).filter((a) => a.metadata?.via === "workspace");
    expect(viewed.metadata).toMatchObject({
      relationship: "referred",
      referral_ids: [referral],
      record_ids: expect.arrayContaining([diagnosisV2]),
      other_author_record_ids: expect.arrayContaining([diagnosisV2]),
    });

    as("b");
    expect(
      (await read(await actOnReferral(request("PATCH", `/api/doctor/referrals/${referral}`, { action: "accept" }), { params: Promise.resolve({ id: referral }) })))
        .status,
    ).toBe(200);

    const res = await history("b", patient, diagnosisV2);
    expect(res.status).toBe(200);
    expect((res.body.data!.history as { versions: Version[] }).versions.map((v) => v.summary)).toEqual([GASTRITIS, ULCER]);
    expect((await audits("clinical_record_viewed", "b")).filter((a) => a.metadata?.via === "history")).toEqual([
      expect.objectContaining({ entity_id: diagnosisV1, metadata: expect.objectContaining({ relationship: "referred", referral_ids: [referral], author_doctor_id: doctors.a }) }),
    ]);
  });

  it("B/D. another doctor — even one the patient is referred to — cannot correct the record; the refusal is audited", async () => {
    // Dr B can read Dr A's record through the referral, but only its author may correct it.
    for (const attempt of [
      () => correct("b", patient, diagnosisV2, { summary: "Ulcer, per Dr B", expectedVersion: 2 }),
      () => write("b", patient, { appointmentId: consultation, recordType: "diagnosis", summary: "Ulcer, per Dr B", correctsRecordId: diagnosisV2 }),
    ]) {
      expect(await attempt()).toMatchObject({ status: 403, body: { ok: false, code: "CLINICAL_RECORD_NOT_OWNED" } });
    }
    // No database detail leaks into the answer.
    const refused = await correct("b", patient, diagnosisV2, { summary: "Ulcer, per Dr B" });
    expect(JSON.stringify(refused.body)).not.toMatch(/CRNOT|clinical_records|constraint|violat/i);
    expect(await audits("unauthorized_clinical_mutation_attempt", "b")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity_id: diagnosisV2, metadata: expect.objectContaining({ reason: "not_owned", attempted: "correct" }) }),
      ]),
    );

    // Dr E saw the patient too — a treating relationship of their own, so the
    // whole history is theirs to read; correcting Dr A's record still is not.
    expect(await correct("e", patient, diagnosisV2, { summary: "Ulcer, per Dr E" })).toMatchObject({ status: 403, body: { code: "CLINICAL_RECORD_NOT_OWNED" } });
    expect((await history("e", patient, diagnosisV2)).status).toBe(200);
    expect((await audits("unauthorized_clinical_mutation_attempt", "e")).map((a) => a.metadata?.reason)).toEqual(["not_owned"]);
    // Dr C has no relationship with the patient at all: nothing to read, nothing to correct, and the probe is logged.
    expect(await correct("c", patient, diagnosisV2, { summary: "Ulcer, per Dr C" })).toMatchObject({ status: 404, body: { code: "patient_not_found" } });
    expect(await history("c", patient, diagnosisV2)).toMatchObject({ status: 404, body: { code: "patient_not_found" } });
    expect((await audits("unauthorized_clinical_access_attempt", "c")).length).toBeGreaterThanOrEqual(2);

    // Nothing changed: still two versions, both Dr A's, the current one untouched.
    expect((await versionsOf(diagnosisV1)).map((v) => [v.version, v.status, v.summary, v.created_by])).toEqual([
      [1, "superseded", GASTRITIS, users.a],
      [2, "current", ULCER, users.a],
    ]);
  });

  it("E. the referred doctor records their own assessment as a new record in their own consultation", async () => {
    as("b");
    const started = await read(
      await startConsultation(request("POST", `/api/doctor/patients/${patient}/consultations`, { serviceId: quickService }), {
        params: Promise.resolve({ id: patient }),
      }),
    );
    expect(started.status).toBe(201);
    const own = (started.body.data!.consultation as { appointmentId: string }).appointmentId;

    const res = await write("b", patient, {
      appointmentId: own,
      recordType: "assessment",
      summary: `Clinical findings suggest peptic ulcer disease (${suffix})`,
    });
    expect(res.status).toBe(201);
    assessment = (res.body.data!.record as { id: string }).id;
    expect(await row(assessment)).toMatchObject({ author_doctor_id: doctors.b, created_by: users.b, version: 1, corrects_record_id: null });

    // Both doctors' decisions stand, each attributed to its author.
    const shown = await records("b", patient);
    expect(shown.find((r) => r.id === assessment)).toMatchObject({ author: { id: doctors.b }, mine: true });
    expect(shown.find((r) => r.id === diagnosisV2)).toMatchObject({ summary: ULCER, author: { id: doctors.a }, mine: false });

    // Dr A reads Dr B's record next to their own: attributed to Dr B, and the
    // access log names it among the records of other authors that were shown.
    expect((await records("a", patient)).find((r) => r.id === assessment)).toMatchObject({ author: { id: doctors.b }, mine: false });
    const viewedByA = (await audits("clinical_record_viewed", "a")).filter((a) => a.metadata?.via === "workspace");
    expect(viewedByA.at(-1)!.metadata).toMatchObject({ relationship: "own", other_author_record_ids: [assessment] });
  });

  it("no number of corrections pushes another doctor's record out of the list", { timeout: 60_000 }, async () => {
    // Dr B corrects their own record 505 times (more than the list's 500-row cap).
    const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
    try {
      expect(assessment).toMatch(/^[0-9a-f-]{36}$/);
      await sql.unsafe(`
        do $$
        declare v_head uuid := '${assessment}'; v_next uuid;
        begin
          for i in 1..505 loop
            insert into public.clinical_records (clinic_id, patient_id, author_doctor_id, appointment_id, record_type, summary, created_by, corrects_record_id)
            select clinic_id, patient_id, author_doctor_id, appointment_id, record_type, 'Flood ' || i, created_by, id
              from public.clinical_records where id = v_head
            returning id into v_next;
            v_head := v_next;
          end loop;
        end $$;`);
    } finally {
      await sql.end({ timeout: 5 });
    }
    for (const name of ["a", "b"]) {
      const shown = await records(name, patient);
      expect(shown.find((r) => r.rootRecordId === diagnosisV1), name).toMatchObject({ summary: ULCER, author: { id: doctors.a } });
      expect(shown.filter((r) => r.rootRecordId === assessment), name).toEqual([expect.objectContaining({ summary: "Flood 505", version: 506 })]);
    }
  });

  it("F. a doctor's own token cannot read, change, delete or forge any record through the REST API", async () => {
    for (const name of ["b", "a"]) {
      const client = await signedIn(name);
      const attempts = [
        await client.from("clinical_records").select("id").eq("id", diagnosisV2),
        await client.from("clinical_records").update({ summary: "Changed" }).eq("id", diagnosisV2),
        await client.from("clinical_records").delete().eq("id", diagnosisV2),
        await client.from("clinical_records").insert({
          clinic_id: clinicA,
          patient_id: patient,
          author_doctor_id: doctors[name],
          appointment_id: consultation,
          record_type: "diagnosis",
          summary: "Forged",
          corrects_record_id: diagnosisV2,
          created_by: users[name],
        }),
        await client.from("clinical_record_versions").select("id").eq("root_record_id", diagnosisV1),
        await client.from("retention_policies").select("clinic_id"),
        await client.from("audit_events").update({ action: "tampered" }).eq("entity_id", diagnosisV2),
        await client.from("audit_events").delete().eq("entity_id", diagnosisV2),
      ];
      for (const attempt of attempts) expect(attempt.error?.code, name).toBe("42501");
      await client.auth.signOut();
    }
    expect((await versionsOf(diagnosisV1)).map((v) => v.summary)).toEqual([GASTRITIS, ULCER]);
    expect((await admin.from("audit_events").select("action").eq("entity_id", diagnosisV2).eq("action", "tampered")).data).toEqual([]);
  });

  it("G. a doctor of another clinic can neither read nor correct, even knowing every id", async () => {
    expect(await workspace("k", patient)).toMatchObject({ status: 404 });
    expect(await history("k", patient, diagnosisV2)).toMatchObject({ status: 404 });
    expect(await correct("k", patient, diagnosisV2, { summary: "Cross-clinic" })).toMatchObject({ status: 404 });
    // Nor can a server bug file it for them: the database refuses the lineage across clinics.
    const { error } = await admin.from("clinical_records").insert({
      clinic_id: clinicK,
      patient_id: patient,
      author_doctor_id: doctors.k,
      appointment_id: consultation,
      record_type: "diagnosis",
      summary: "Cross-clinic",
      corrects_record_id: diagnosisV2,
      created_by: users.k,
    });
    expect(error?.code).toMatch(/^(CRNOT|23503)$/);
    expect((await versionsOf(diagnosisV1)).length).toBe(2);
  });

  it("VERSION_CONFLICT: a stale version or a concurrent correction never silently overwrites", async () => {
    // The doctor was looking at version 1; it is at version 2 now.
    const stale = await correct("a", patient, diagnosisV2, { summary: "From a stale screen", expectedVersion: 1 });
    expect(stale).toMatchObject({ status: 409, body: { code: "VERSION_CONFLICT", details: { currentRecordId: diagnosisV2, currentVersion: 2 } } });
    // Correcting a superseded version.
    expect(await correct("a", patient, diagnosisV1, { summary: "On top of version 1" })).toMatchObject({
      status: 409,
      body: { code: "VERSION_CONFLICT", details: { currentVersion: 2 } },
    });

    // Two corrections of version 2 at once: exactly one lands, the other is told.
    const results = await Promise.all(
      ["first", "second"].map((label) => correct("a", patient, diagnosisV2, { summary: `${ULCER} — ${label}`, expectedVersion: 2 })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe("VERSION_CONFLICT");
    const lineage = await versionsOf(diagnosisV1);
    expect(lineage.map((v) => [v.version, v.status])).toEqual([
      [1, "superseded"],
      [2, "superseded"],
      [3, "current"],
    ]);

    // The same request twice (a retry after a lost response) saves once.
    const key = randomUUID();
    const current = lineage[2].id;
    const once = await correct("a", patient, current, { idempotencyKey: key, summary: `${ULCER} — final` });
    const again = await correct("a", patient, current, { idempotencyKey: key, summary: `${ULCER} — final` });
    expect(once.status).toBe(201);
    expect(again).toMatchObject({ status: 200, body: { data: { record: { id: (once.body.data!.record as { id: string }).id, replayed: true } } } });
  });

  it("a doctor record whose records another login wrote can't be handed to a new login", async () => {
    await makeUser("a2", clinicA);
    // The admin screen gets a clear refusal …
    session.ctx = { profileId: users.c, clinicId: clinicA, clinicName: "Governance Clinic", clinicTimezone: TZ, roles: ["admin"], platformAdmin: false };
    const relink = await read(await updateDoctor(request("PATCH", `/api/admin/doctors?id=${doctors.a}`, { profileId: users.a2 })));
    expect(relink).toMatchObject({ status: 409, body: { code: "doctor_has_clinical_records" } });
    // … and the database refuses it for any caller.
    const { error } = await admin.from("doctors").update({ profile_id: users.a2 }).eq("id", doctors.a);
    expect(error?.code).toBe("CRLNK");
    expect((await admin.from("doctors").select("profile_id").eq("id", doctors.a).single()).data).toEqual({ profile_id: users.a });
    // Unlinking and re-linking the records' own author stays possible.
    expect((await admin.from("doctors").update({ profile_id: null }).eq("id", doctors.a)).error).toBeNull();
    expect((await admin.from("doctors").update({ profile_id: users.a }).eq("id", doctors.a)).error).toBeNull();
  });

  it("deleting the patient never takes their clinical, referral or booking records along", async () => {
    const { error } = await admin.from("patients").delete().eq("id", patient);
    expect(error?.code).toBe("23503");
    const count = async (table: string) => (await admin.from(table).select("id", { count: "exact", head: true }).eq("patient_id", patient)).count;
    expect((await admin.from("patients").select("id").eq("id", patient)).data).toHaveLength(1);
    expect(await count("clinical_records")).toBeGreaterThanOrEqual(5);
    expect(await count("referrals")).toBe(1);
    expect(await count("appointments")).toBeGreaterThanOrEqual(3);
  });
});

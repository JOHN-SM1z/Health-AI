import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  results: [] as Array<{ data: unknown; error: unknown }>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  access: vi.fn(), audit: vi.fn(), doctor: vi.fn(), rpc: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({
  from: (table: string) => {
    const q: Record<string, unknown> = {};
    for (const method of ["select", "eq", "or", "order", "limit", "insert", "maybeSingle", "single"]) {
      q[method] = (...args: unknown[]) => { h.calls.push({ table, method, args }); return q; };
    }
    q.then = (resolve: (v: unknown) => void) => {
      if (!h.results.length) throw new Error("Unexpected database call");
      return Promise.resolve(h.results.shift()).then(resolve);
    };
    return q;
  }, rpc: h.rpc,
}) }));
vi.mock("@/lib/clinical-access/access", async (original) => ({
  ...await original<typeof import("@/lib/clinical-access/access")>(), canDoctorAccessPatientClinicalData: h.access,
}));
vi.mock("@/lib/clinical-access/denial", () => ({ patientAccessDenied: async () => Object.assign(new Error("Denied"), { status: 404 }) }));
vi.mock("@/lib/audit", () => ({ recordAudit: h.audit, recordAudits: h.audit }));
vi.mock("@/lib/rate-limit-shared", () => ({ sharedRateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/auth/guards", () => ({ requireLinkedDoctor: h.doctor }));
import { createClinicalRecord, getClinicalRecordHistory, listVisibleClinicalRecords } from "./service";
import { POST } from "@/app/api/doctor/patients/[id]/records/route";
import type { LinkedDoctor } from "@/lib/auth/guards";

const doctor = { doctorId: randomUUID(), profileId: randomUUID(), clinicId: randomUUID() } as LinkedDoctor;
const patient = randomUUID(), appointment = randomUUID(), original = randomUUID();
const access = { allowed: true, relationship: "own" as const,
  scope: { ownAppointments: true, patientRecord: true, sharedHistoryDoctorIds: [], referralAppointmentIds: [] }, activeReferralIds: [] };
const input = () => ({ idempotencyKey: randomUUID(), appointmentId: appointment, recordType: "diagnosis" as const,
  summary: "Corrected assessment", correctsRecordId: original });
const row = (data: unknown) => ({ data, error: null });
const target = (patch = {}) => ({ id: original, root_record_id: original, version: 1, created_by: doctor.profileId, author_doctor_id: doctor.doctorId, appointment_id: appointment, record_type: "diagnosis", status: "current", ...patch });

beforeEach(() => {
  vi.clearAllMocks(); h.results = []; h.calls = [];
  h.access.mockResolvedValue(access); h.audit.mockResolvedValue(undefined); h.doctor.mockResolvedValue(doctor);
});

describe("clinical governance at the server boundary", () => {
  it("denies a direct forged-author correction request from a referred doctor before insertion", async () => {
    const other = randomUUID();
    h.access.mockResolvedValue({ ...access, relationship: "referred", scope: { ...access.scope, ownAppointments: false, sharedHistoryDoctorIds: [other] }, activeReferralIds: [randomUUID()] });
    h.results.push(row(null), row(target({ author_doctor_id: other })));
    const response = await POST(new NextRequest("http://localhost/api/doctor/patients/x/records", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input(), authorDoctorId: doctor.doctorId, clinicId: randomUUID() }),
    }), { params: Promise.resolve({ id: patient }) });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "CLINICAL_RECORD_NOT_OWNED" });
    expect(h.calls.some((c) => c.method === "insert")).toBe(false);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "clinical_record_access_denied", strict: true }));
  });

  it("allows an author correction and stamps session provenance, without a reason", async () => {
    h.results.push(row(null), row(target()), row({ id: "v2", version: 2 }));
    expect(await createClinicalRecord(doctor, patient, input())).toEqual({ id: "v2", version: 2, replayed: false });
    expect(h.calls.find((c) => c.method === "insert")?.args[0]).toMatchObject({
      author_doctor_id: doctor.doctorId, created_by: doctor.profileId, clinic_id: doctor.clinicId, corrects_record_id: original,
    });
  });

  it("rejects a stale version without writing", async () => {
    h.results.push(row(null), row(target({ status: "superseded" })), row({ id: "v2", version: 2 }));
    await expect(createClinicalRecord(doctor, patient, input())).rejects.toMatchObject({ status: 409, code: "VERSION_CONFLICT" });
    expect(h.calls.some((c) => c.method === "insert")).toBe(false);
  });

  it("maps a concurrent unique-index loser to VERSION_CONFLICT", async () => {
    h.results.push(row(null), row(target()),
      { data: null, error: { code: "23505", message: "clinical_records_one_correction" } }, row(null), row({ id: "v2", version: 2 }));
    await expect(createClinicalRecord(doctor, patient, input())).rejects.toMatchObject({ status: 409, code: "VERSION_CONFLICT" });
  });

  it("does not let a same-author correction change consultation or record type", async () => {
    h.results.push(row(null), row(target()));
    await expect(createClinicalRecord(doctor, patient, { ...input(), appointmentId: randomUUID() }))
      .rejects.toMatchObject({ code: "correction_not_allowed" });
  });

  it("filters current records before limiting, retaining author and tenant scope", async () => {
    h.results.push(row([]));
    await listVisibleClinicalRecords(doctor, patient, access);
    const filters = h.calls.filter((c) => c.method === "eq").map((c) => c.args);
    expect(filters).toContainEqual(["clinic_id", doctor.clinicId]);
    expect(filters).toContainEqual(["patient_id", patient]);
    expect(filters).toContainEqual(["status", "current"]);
    expect(h.calls.findIndex((c) => c.method === "eq" && c.args[0] === "status"))
      .toBeLessThan(h.calls.findIndex((c) => c.method === "limit"));
  });

  it("cannot obtain history of another doctor's unrelated consultation", async () => {
    h.results.push(row({ id: original, appointment_id: randomUUID(), author_doctor_id: randomUUID() }));
    await expect(getClinicalRecordHistory(doctor, patient, original)).rejects.toMatchObject({ status: 404 });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("does not release history if mandatory audit logging fails", async () => {
    h.results.push(row(target()), row([]), row({ name: "Synthetic doctor" })); h.audit.mockRejectedValueOnce(new Error("Audit unavailable"));
    await expect(getClinicalRecordHistory(doctor, patient, original)).rejects.toThrow("Audit unavailable");
  });
  it("requires current authorization before a replay can return a prior write", async () => {
    h.access.mockResolvedValue({ ...access, allowed: false });
    await expect(createClinicalRecord(doctor, patient, input())).rejects.toMatchObject({status:404});
    expect(h.calls).toEqual([]);
  });

  it("binds the replay key to the authenticated original login as well as the doctor", async () => {
    h.results.push(row(null), row(target()), row({id:"v2",version:2}));
    await createClinicalRecord(doctor, patient, input());
    expect(h.calls.filter(c=>c.table==="clinical_records" && c.method==="eq").map(c=>c.args))
      .toContainEqual(["created_by",doctor.profileId]);
  });

  it("serves authorized longitudinal history read-only and audits its direct care basis", async () => {
    const other=randomUUID();
    h.access.mockResolvedValue({...access, scope:{...access.scope,sharedHistoryDoctorIds:[other]}});
    h.results.push(row(target({author_doctor_id:other})),row([{...target({author_doctor_id:other}),summary:"Historical assessment",created_at:"2026-01-01T00:00:00Z"}]),row({name:"Prior doctor"}));
    const result=await getClinicalRecordHistory(doctor,patient,original);
    expect(result.versions[0].author.id).toBe(other);
    expect(h.audit).toHaveBeenCalledWith([expect.objectContaining({action:"clinical_record_history_viewed",metadata:expect.objectContaining({relationship:"own",record_ids:[original]})})],{strict:true});
    expect(h.calls.some(c=>c.method==="insert")).toBe(false);
  });

});

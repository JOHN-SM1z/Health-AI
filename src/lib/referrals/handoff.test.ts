/**
 * Clinical handoff workflow — integration tests.
 *
 * Tests the complete referral lifecycle:
 *   pending → accepted  (referral_accepted audit)
 *   pending → declined  (referral_declined audit)
 *   accepted → in_progress  (consultation_started audit)
 *   in_progress → completed  (referral_completed audit)
 *
 * Also covers:
 *   - Creating a clinical note linked to a referral (referral_id FK)
 *   - Authorization: in_progress referral grants patient clinical access
 *   - Authorization: completed referral does NOT grant access (terminal)
 *   - Invalid transitions are rejected
 *   - Self-transitions (same status) are rejected
 *   - Only the receiving doctor may transition pending → accepted/declined
 *   - Only the receiving doctor may transition accepted → in_progress
 *   - Any involved party may transition active → completed
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Shared mocks (hoisted before imports)
// ---------------------------------------------------------------------------

const staffMock = vi.hoisted(() => ({ impl: async () => null as unknown }));
const adminClientMock = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
const assertReferralAccessMock = vi.hoisted(() => vi.fn());
const requireLinkedDoctorMock = vi.hoisted(() => vi.fn());
const requirePatientClinicalAccessMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/guards", () => ({
  requireStaff: () => staffMock.impl(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => adminClientMock,
}));

vi.mock("@/lib/audit", () => ({
  recordAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/referrals/access", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/referrals/access")>();
  return {
    ...real,
    assertReferralAccess: assertReferralAccessMock,
    requireLinkedDoctor: requireLinkedDoctorMock,
    requirePatientClinicalAccess: requirePatientClinicalAccessMock,
  };
});

import { PATCH } from "@/app/api/doctor/referrals/[id]/route";
import { POST } from "@/app/api/doctor/clinical-notes/route";
import { recordAudit } from "@/lib/audit";
import { ApiError } from "@/lib/api/errors";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLINIC_ID = "c1111111-1111-4111-8111-111111111111";
const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const DOCTOR_ID = "d1111111-1111-4111-8111-111111111111";
const PATIENT_ID = "22222222-2222-4222-8222-222222222222";
const REFERRAL_ID = "33333333-3333-4333-8333-333333333333";
const DR_A_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_PATIENT_ID = "44444444-4444-4444-8444-444444444444";

function makeStaffCtx(roles: string[] = ["doctor"]) {
  return {
    profileId: PROFILE_ID,
    clinicId: CLINIC_ID,
    clinicName: "Test Clinic",
    clinicTimezone: "Asia/Tashkent",
    roles,
  };
}

function makeReferral(status: string, overrides: Record<string, unknown> = {}) {
  return {
    id: REFERRAL_ID,
    clinic_id: CLINIC_ID,
    patient_id: PATIENT_ID,
    referring_doctor_id: DR_A_ID,
    referred_to_doctor_id: DOCTOR_ID,
    status,
    priority: "routine",
    referral_reason: "Specialist consultation needed",
    clinical_handoff_note: null,
    created_at: new Date().toISOString(),
    accepted_at: null,
    completed_at: null,
    revoked_at: null,
    expires_at: new Date(Date.now()+30*86400_000).toISOString(),
    ...overrides,
  };
}

/** Fluent chain mock that settles all builder calls and resolves `terminal`. */
function chain(terminal: { data: unknown; error: unknown }) {
  const self: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "in", "is", "or", "order", "limit", "update", "insert", "single", "maybeSingle"]) {
    self[m] = vi.fn().mockReturnValue(self);
  }
  (self.single as ReturnType<typeof vi.fn>).mockResolvedValue(terminal);
  (self.maybeSingle as ReturnType<typeof vi.fn>).mockResolvedValue(terminal);
  return self;
}

function routeCtx(id: string = REFERRAL_ID) {
  return { params: Promise.resolve({ id }) };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function patchRequest(body: Record<string, unknown>) {
  return new NextRequest(`http://localhost/api/doctor/referrals/${REFERRAL_ID}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// PATCH lifecycle tests
// ---------------------------------------------------------------------------

describe("Clinical handoff workflow — PATCH /api/doctor/referrals/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    staffMock.impl = async () => makeStaffCtx();
  });

  // -----------------------------------------------------------------------
  // 1. pending → accepted (receiving doctor)
  // -----------------------------------------------------------------------
  it("1. transitions pending → accepted and emits referral_accepted audit event", async () => {
    const referral = makeReferral("pending");
    assertReferralAccessMock.mockResolvedValue({
      referral,
      callerRole: "receiving_doctor",
      callerDoctorId: DOCTOR_ID,
    });

    const updated = { ...referral, status: "accepted", accepted_at: new Date().toISOString() };
    adminClientMock.from.mockImplementation(() =>
      chain({ data: updated, error: null }),
    );

    const res = await PATCH(patchRequest({ status: "accepted" }), routeCtx());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.referral.status).toBe("accepted");

    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "referral_accepted", entityId: REFERRAL_ID }),
    );
  });

  // -----------------------------------------------------------------------
  // 2. pending → declined (receiving doctor)
  // -----------------------------------------------------------------------
  it("2. transitions pending → declined and emits referral_declined audit event", async () => {
    const referral = makeReferral("pending");
    assertReferralAccessMock.mockResolvedValue({
      referral,
      callerRole: "receiving_doctor",
      callerDoctorId: DOCTOR_ID,
    });

    const updated = { ...referral, status: "declined" };
    adminClientMock.from.mockImplementation(() => chain({ data: updated, error: null }));

    const res = await PATCH(patchRequest({ status: "declined" }), routeCtx());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.referral.status).toBe("declined");

    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "referral_declined" }),
    );
  });

  // -----------------------------------------------------------------------
  // 3. accepted → in_progress (receiving doctor — consultation_started)
  // -----------------------------------------------------------------------
  it("3. transitions accepted → in_progress and emits consultation_started audit event", async () => {
    const referral = makeReferral("accepted", { accepted_at: new Date().toISOString() });
    assertReferralAccessMock.mockResolvedValue({
      referral,
      callerRole: "receiving_doctor",
      callerDoctorId: DOCTOR_ID,
    });

    const updated = { ...referral, status: "in_progress" };
    adminClientMock.from.mockImplementation(() => chain({ data: updated, error: null }));

    const res = await PATCH(patchRequest({ status: "in_progress" }), routeCtx());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.referral.status).toBe("in_progress");

    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "consultation_started" }),
    );
  });

  // -----------------------------------------------------------------------
  // 4. in_progress → completed (referral_completed)
  // -----------------------------------------------------------------------
  it("4. transitions in_progress → completed and emits referral_completed audit event", async () => {
    const referral = makeReferral("in_progress");
    assertReferralAccessMock.mockResolvedValue({
      referral,
      callerRole: "receiving_doctor",
      callerDoctorId: DOCTOR_ID,
    });

    const updated = { ...referral, status: "completed", completed_at: new Date().toISOString() };
    adminClientMock.from.mockImplementation(() => chain({ data: updated, error: null }));

    const res = await PATCH(patchRequest({ status: "completed" }), routeCtx());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.referral.status).toBe("completed");

    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "referral_completed" }),
    );
  });

  // -----------------------------------------------------------------------
  // 5. accepted → completed (skipping in_progress — also valid)
  // -----------------------------------------------------------------------
  it("5. allows accepted → completed directly (skipping in_progress step)", async () => {
    const referral = makeReferral("accepted");
    assertReferralAccessMock.mockResolvedValue({
      referral,
      callerRole: "receiving_doctor",
      callerDoctorId: DOCTOR_ID,
    });

    const updated = { ...referral, status: "completed", completed_at: new Date().toISOString() };
    adminClientMock.from.mockImplementation(() => chain({ data: updated, error: null }));

    const res = await PATCH(patchRequest({ status: "completed" }), routeCtx());
    expect(res.status).toBe(200);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "referral_completed" }),
    );
  });

  // -----------------------------------------------------------------------
  // 6. Invalid transition: pending → in_progress (must go through accepted first)
  // -----------------------------------------------------------------------
  it("6. rejects pending → in_progress (invalid transition)", async () => {
    const referral = makeReferral("pending");
    assertReferralAccessMock.mockResolvedValue({
      referral,
      callerRole: "receiving_doctor",
      callerDoctorId: DOCTOR_ID,
    });

    const res = await PATCH(patchRequest({ status: "in_progress" }), routeCtx());
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("invalid_transition");
  });

  // -----------------------------------------------------------------------
  // 7. Invalid transition: completed → accepted (terminal state)
  // -----------------------------------------------------------------------
  it("7. rejects completed → accepted (terminal state re-open)", async () => {
    const referral = makeReferral("completed");
    assertReferralAccessMock.mockResolvedValue({
      referral,
      callerRole: "receiving_doctor",
      callerDoctorId: DOCTOR_ID,
    });

    const res = await PATCH(patchRequest({ status: "accepted" }), routeCtx());
    expect(res.status).toBe(400);
  });

  // -----------------------------------------------------------------------
  // 8. Forbidden: referring doctor cannot accept/decline (only receiving can)
  // -----------------------------------------------------------------------
  it("8. rejects acceptance attempt by referring doctor (not receiving_doctor)", async () => {
    const referral = makeReferral("pending");
    assertReferralAccessMock.mockResolvedValue({
      referral,
      callerRole: "referring_doctor",
      callerDoctorId: DR_A_ID,
    });

    const res = await PATCH(patchRequest({ status: "accepted" }), routeCtx());
    expect(res.status).toBe(403);
  });

  // -----------------------------------------------------------------------
  // 9. Forbidden: referring doctor cannot start consultation
  // -----------------------------------------------------------------------
  it("9. rejects start-consultation attempt by referring doctor", async () => {
    const referral = makeReferral("accepted");
    assertReferralAccessMock.mockResolvedValue({
      referral,
      callerRole: "referring_doctor",
      callerDoctorId: DR_A_ID,
    });

    const res = await PATCH(patchRequest({ status: "in_progress" }), routeCtx());
    expect(res.status).toBe(403);
  });

  // -----------------------------------------------------------------------
  // 10. Management can complete a referral in any involved role
  // -----------------------------------------------------------------------
  it("10. management role can complete an in_progress referral", async () => {
    const referral = makeReferral("in_progress");
    assertReferralAccessMock.mockResolvedValue({
      referral,
      callerRole: "management",
      callerDoctorId: null,
    });
    staffMock.impl = async () => makeStaffCtx(["admin"]);

    const updated = { ...referral, status: "completed", completed_at: new Date().toISOString() };
    adminClientMock.from.mockImplementation(() => chain({ data: updated, error: null }));

    const res = await PATCH(patchRequest({ status: "completed" }), routeCtx());
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Authorization: in_progress referral grants clinical access
// ---------------------------------------------------------------------------
describe("canDoctorAccessPatientClinicalData — in_progress status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("11. grants referral access for in_progress referral", async () => {
    adminClientMock.rpc.mockResolvedValue({data:true,error:null});
    const { canDoctorAccessPatientClinicalData } = await import("@/lib/referrals/access");

    adminClientMock.from.mockImplementation((table: string) => {
      if (table === "patients") return chain({ data: { id: PATIENT_ID }, error: null });
      if (table === "doctors") return chain({ data: { id: DOCTOR_ID }, error: null });
      if (table === "appointments") return { ...chain({ data: null, error: null }), count: 0 };
      if (table === "referrals") {
        return chain({
          data: { id: REFERRAL_ID, status: "in_progress", expires_at: new Date(Date.now()+30*86400_000).toISOString(), revoked_at: null },
          error: null,
        });
      }
      return chain({ data: null, error: null });
    });

    const result = await canDoctorAccessPatientClinicalData(
      PROFILE_ID, PATIENT_ID, CLINIC_ID, ["doctor"],
    );

    expect(result.level).toBe("own_patient");
    expect(result.doctorId).toBe(DOCTOR_ID);
  });

  it("12. denies clinical access when referral is completed (terminal, no ongoing grant)", async () => {
    adminClientMock.rpc.mockResolvedValue({data:false,error:null});
    const { canDoctorAccessPatientClinicalData } = await import("@/lib/referrals/access");

    adminClientMock.from.mockImplementation((table: string) => {
      if (table === "patients") return chain({ data: { id: PATIENT_ID }, error: null });
      if (table === "doctors") return chain({ data: { id: DOCTOR_ID }, error: null });
      if (table === "appointments") return { ...chain({ data: null, error: null }), count: 0 };
      if (table === "referrals") {
        // Completed referrals are filtered by .in("status", ["pending","accepted","in_progress"])
        // so the query returns null — no grant.
        return chain({ data: null, error: null });
      }
      return chain({ data: null, error: null });
    });

    const result = await canDoctorAccessPatientClinicalData(
      PROFILE_ID, PATIENT_ID, CLINIC_ID, ["doctor"],
    );

    expect(result.level).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// Clinical note creation with referral linkage
// ---------------------------------------------------------------------------
describe("POST /api/doctor/clinical-notes — referral linkage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    staffMock.impl = async () => makeStaffCtx();
    requireLinkedDoctorMock.mockResolvedValue({ id: DOCTOR_ID });
    requirePatientClinicalAccessMock.mockResolvedValue({
      level: "referral",
      doctorId: DOCTOR_ID,
      referralId: REFERRAL_ID,
    });
  });

  it("13. creates note linked to referral and records audit event with referral_id", async () => {
    const newNote = {
      id: "note-001",
      title: "Initial assessment",
      content: "Patient presented with...",
      note_type: "current_assessment",
      is_private: false,
      created_at: new Date().toISOString(),
      doctor_id: DOCTOR_ID,
      appointment_id: null,
      referral_id: REFERRAL_ID,
    };

    adminClientMock.from.mockImplementation((table: string) => {
      if (table === "patients") return chain({ data: { id: PATIENT_ID }, error: null });
      if (table === "referrals") {
        return chain({
          data: {
            id: REFERRAL_ID,
            patient_id: PATIENT_ID,
            status: "in_progress",
            revoked_at: null,
            expires_at: new Date(Date.now()+30*86400_000).toISOString(),
          },
          error: null,
        });
      }
      if (table === "clinical_notes") {
        return chain({ data: newNote, error: null });
      }
      return chain({ data: null, error: null });
    });

    const req = new NextRequest("http://localhost/api/doctor/clinical-notes", {
      method: "POST",
      body: JSON.stringify({
        patientId: PATIENT_ID,
        referralId: REFERRAL_ID,
        title: "Initial assessment",
        content: "Patient presented with...",
        noteType: "current_assessment",
        isPrivate: false,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.note.referral_id).toBe(REFERRAL_ID);
    expect(json.data.note.doctor_id).toBe(DOCTOR_ID); // authored by caller

    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "clinical_note_created",
        newValues: expect.objectContaining({
          referral_id: REFERRAL_ID,
          doctor_id: DOCTOR_ID,
        }),
      }),
    );
  });

  it("14. rejects note creation when referral is for a different patient", async () => {
    requireLinkedDoctorMock.mockResolvedValue({ id: DOCTOR_ID });

    adminClientMock.from.mockImplementation((table: string) => {
      if (table === "patients") return chain({ data: { id: PATIENT_ID }, error: null });
      if (table === "referrals") {
        return chain({
          data: {
            id: REFERRAL_ID,
            patient_id: OTHER_PATIENT_ID, // mismatch
            status: "in_progress",
            revoked_at: null,
            expires_at: new Date(Date.now()+30*86400_000).toISOString(),
          },
          error: null,
        });
      }
      return chain({ data: null, error: null });
    });

    const req = new NextRequest("http://localhost/api/doctor/clinical-notes", {
      method: "POST",
      body: JSON.stringify({
        patientId: PATIENT_ID,
        referralId: REFERRAL_ID,
        title: "Test",
        content: "Content",
        noteType: "clinical_note",
        isPrivate: false,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("referral_patient_mismatch");
  });

  it("15. rejects note creation when referral is declined", async () => {
    requireLinkedDoctorMock.mockResolvedValue({ id: DOCTOR_ID });

    adminClientMock.from.mockImplementation((table: string) => {
      if (table === "patients") return chain({ data: { id: PATIENT_ID }, error: null });
      if (table === "referrals") {
        return chain({
          data: {
            id: REFERRAL_ID,
            patient_id: PATIENT_ID,
            status: "declined", // not active
            revoked_at: null,
            expires_at: new Date(Date.now()+30*86400_000).toISOString(),
          },
          error: null,
        });
      }
      return chain({ data: null, error: null });
    });

    const req = new NextRequest("http://localhost/api/doctor/clinical-notes", {
      method: "POST",
      body: JSON.stringify({
        patientId: PATIENT_ID,
        referralId: REFERRAL_ID,
        title: "Test",
        content: "Content",
        noteType: "clinical_note",
        isPrivate: false,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe("referral_not_active");
  });

  it("16. rejects note when requireStaff throws 401", async () => {
    staffMock.impl = async () => {
      throw new ApiError(401, "Kirish talab qilinadi");
    };

    const req = new NextRequest("http://localhost/api/doctor/clinical-notes", {
      method: "POST",
      body: JSON.stringify({
        patientId: PATIENT_ID,
        title: "Test",
        content: "Content",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
  });
});

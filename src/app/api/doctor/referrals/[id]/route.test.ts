import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before any imports that use them
// ---------------------------------------------------------------------------

const staffMock = vi.hoisted(() => ({ impl: async () => null as unknown }));
const adminClientMock = vi.hoisted(() => ({ from: vi.fn() }));
const recordAuditMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@/lib/auth/guards", () => ({
  requireStaff: () => staffMock.impl(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => adminClientMock,
}));

vi.mock("@/lib/audit", () => ({
  recordAudit: recordAuditMock,
}));

// ---------------------------------------------------------------------------
// Route under test (must be imported after mocks)
// ---------------------------------------------------------------------------

import { GET, PATCH } from "./route";
import { ApiError } from "@/lib/api/errors";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const clinicId = "11111111-1111-4111-8111-111111111111";
const patientId = "22222222-2222-4222-8222-222222222222";
const referralId = "33333333-3333-4333-8333-333333333333";
const referringDoctorId = "44444444-4444-4444-8444-444444444444";
const receivingDoctorId = "55555555-5555-4555-8555-555555555555";
const referringProfileId = "66666666-6666-4666-8666-666666666666";
const receivingProfileId = "77777777-7777-4777-8777-777777777777";
const mgmtProfileId = "88888888-8888-4888-8888-888888888888";

function makeStaffCtx(profileId: string, roles: string[] = ["doctor"]): unknown {
  return {
    profileId,
    clinicId,
    clinicName: "Test Clinic",
    clinicTimezone: "Asia/Tashkent",
    roles,
    platformAdmin: false,
  };
}

function makeChain(overrides: Record<string, unknown> = {}) {
  const chain: Record<string, unknown> = {
    select: vi.fn(),
    eq: vi.fn(),
    neq: vi.fn(),
    in: vi.fn(),
    is: vi.fn(),
    lte: vi.fn(),
    or: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    update: vi.fn(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    ...overrides,
  };
  for (const k of ["select", "eq", "neq", "in", "is", "lte", "or", "order", "limit", "update"]) {
    if (!overrides[k]) {
      chain[k] = vi.fn().mockReturnValue(chain);
    }
  }
  return chain;
}

function makeReferral(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: referralId,
    clinic_id: clinicId,
    patient_id: patientId,
    referring_doctor_id: referringDoctorId,
    referred_to_doctor_id: receivingDoctorId,
    status,
    priority: "routine",
    referral_reason: "Consultation needed",
    clinical_handoff_note: null as string | null,
    created_at: new Date(Date.now() - 60_000).toISOString(),
    updated_at: new Date().toISOString(),
    accepted_at: null,
    completed_at: null,
    expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
    revoked_at: null,
    revocation_reason: null,
    revoked_by: null,
    created_by: referringProfileId,
    updated_by: referringProfileId,
    ...extra,
  };
}

function setupMocks(
  referralRow: ReturnType<typeof makeReferral>,
  _profileId: string,
  doctorId: string,
  updatedReferral?: ReturnType<typeof makeReferral>,
) {
  adminClientMock.from.mockImplementation((table: string) => {
    if (table === "referrals") {
      const selectChain = makeChain({
        single: vi.fn().mockResolvedValue({
          data: updatedReferral ?? { ...referralRow },
          error: null,
        }),
      });
      const chain = makeChain({
        maybeSingle: vi.fn().mockResolvedValue({ data: referralRow, error: null }),
        single: vi.fn().mockResolvedValue({
          data: updatedReferral ?? { ...referralRow },
          error: null,
        }),
      });
      chain.update = vi.fn().mockReturnValue(selectChain);
      return chain;
    }
    if (table === "doctors") {
      return makeChain({
        maybeSingle: vi.fn().mockResolvedValue({
          data: { id: doctorId, clinic_id: clinicId },
          error: null,
        }),
      });
    }
    return makeChain();
  });
}

function makeRequest(id: string, body: Record<string, unknown>, method = "PATCH") {
  return new NextRequest(`http://localhost/api/doctor/referrals/${id}`, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const routeContext = (id: string) => ({ params: Promise.resolve({ id }) });

// ---------------------------------------------------------------------------
// GET tests
// ---------------------------------------------------------------------------

describe("GET /api/doctor/referrals/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordAuditMock.mockResolvedValue(undefined);
  });

  it("returns 401 when requireStaff throws", async () => {
    staffMock.impl = async () => {
      throw new ApiError(401, "Kirish talab qilinadi");
    };
    const req = new NextRequest(`http://localhost/api/doctor/referrals/${referralId}`);
    const res = await GET(req, routeContext(referralId));
    expect(res.status).toBe(401);
  });

  it("emits referral_viewed audit event and returns 200", async () => {
    staffMock.impl = async () => makeStaffCtx(receivingProfileId);
    const referral = makeReferral("pending");
    setupMocks(referral, receivingProfileId, receivingDoctorId);

    const req = new NextRequest(`http://localhost/api/doctor/referrals/${referralId}`);
    const res = await GET(req, routeContext(referralId));
    expect(res.status).toBe(200);
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "referral_viewed", entityId: referralId }),
    );
  });

  it("returns 404 when referral does not exist in caller's clinic", async () => {
    staffMock.impl = async () => makeStaffCtx(receivingProfileId);
    adminClientMock.from.mockImplementation(() =>
      makeChain({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }),
    );
    const req = new NextRequest(`http://localhost/api/doctor/referrals/${referralId}`);
    const res = await GET(req, routeContext(referralId));
    expect(res.status).toBe(404);
  });

  it("returns 403 when unrelated doctor tries to access a referral", async () => {
    // Unrelated doctor — not referring_doctor_id or referred_to_doctor_id
    const unrelatedProfileId = "99999999-9999-4999-8999-999999999999";
    const unrelatedDoctorId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    staffMock.impl = async () => makeStaffCtx(unrelatedProfileId);
    const referral = makeReferral("pending");

    adminClientMock.from.mockImplementation((table: string) => {
      if (table === "referrals") {
        return makeChain({
          maybeSingle: vi.fn().mockResolvedValue({ data: referral, error: null }),
        });
      }
      if (table === "doctors") {
        return makeChain({
          maybeSingle: vi.fn().mockResolvedValue({
            data: { id: unrelatedDoctorId, clinic_id: clinicId },
            error: null,
          }),
        });
      }
      return makeChain();
    });

    const req = new NextRequest(`http://localhost/api/doctor/referrals/${referralId}`);
    const res = await GET(req, routeContext(referralId));
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// PATCH lifecycle transitions
// ---------------------------------------------------------------------------

describe("PATCH /api/doctor/referrals/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordAuditMock.mockResolvedValue(undefined);
  });

  // ── accept ────────────────────────────────────────────────────────────────

  describe("pending → accepted", () => {
    it("receiving doctor can accept a pending referral", async () => {
      staffMock.impl = async () => makeStaffCtx(receivingProfileId);
      const referral = makeReferral("pending");
      const updated = makeReferral("accepted", { accepted_at: new Date().toISOString() });
      setupMocks(referral, receivingProfileId, receivingDoctorId, updated);

      const res = await PATCH(makeRequest(referralId, { status: "accepted" }), routeContext(referralId));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.referral.status).toBe("accepted");
      expect(recordAuditMock).toHaveBeenCalledWith(
        expect.objectContaining({ action: "referral_accepted" }),
      );
    });

    it("management cannot perform clinical accepted action", async () => {
      staffMock.impl = async () => makeStaffCtx(mgmtProfileId, ["manager"]);
      const res = await PATCH(makeRequest(referralId, {status:"accepted"}), routeContext(referralId));
      expect(res.status).toBe(403);
      expect(recordAuditMock).not.toHaveBeenCalled();
    });

    it("referring doctor cannot accept their own referral (forbidden)", async () => {
      staffMock.impl = async () => makeStaffCtx(referringProfileId);
      setupMocks(makeReferral("pending"), referringProfileId, referringDoctorId);

      const res = await PATCH(makeRequest(referralId, { status: "accepted" }), routeContext(referralId));
      expect(res.status).toBe(403);
    });

    it("rejects accept from already-accepted state (invalid_transition)", async () => {
      staffMock.impl = async () => makeStaffCtx(receivingProfileId);
      setupMocks(
        makeReferral("accepted", { accepted_at: new Date().toISOString() }),
        receivingProfileId,
        receivingDoctorId,
      );

      const res = await PATCH(makeRequest(referralId, { status: "accepted" }), routeContext(referralId));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("invalid_transition");
    });
  });

  // ── decline ───────────────────────────────────────────────────────────────

  describe("pending → declined", () => {
    it("receiving doctor can decline a pending referral", async () => {
      staffMock.impl = async () => makeStaffCtx(receivingProfileId);
      const referral = makeReferral("pending");
      const updated = makeReferral("declined");
      setupMocks(referral, receivingProfileId, receivingDoctorId, updated);

      const res = await PATCH(makeRequest(referralId, { status: "declined" }), routeContext(referralId));
      expect(res.status).toBe(200);
      expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "referral_declined" }));
    });

    it("cannot decline a completed referral (terminal state → invalid_transition)", async () => {
      staffMock.impl = async () => makeStaffCtx(receivingProfileId);
      setupMocks(makeReferral("completed", { completed_at: new Date().toISOString() }), receivingProfileId, receivingDoctorId);

      const res = await PATCH(makeRequest(referralId, { status: "declined" }), routeContext(referralId));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("invalid_transition");
    });
  });

  // ── in_progress ────────────────────────────────────────────────────────────

  describe("accepted → in_progress (consultation started)", () => {
    it("receiving doctor can start consultation", async () => {
      staffMock.impl = async () => makeStaffCtx(receivingProfileId);
      const referral = makeReferral("accepted", { accepted_at: new Date().toISOString() });
      const updated = makeReferral("in_progress", { accepted_at: referral.accepted_at });
      setupMocks(referral, receivingProfileId, receivingDoctorId, updated);

      const res = await PATCH(makeRequest(referralId, { status: "in_progress" }), routeContext(referralId));
      expect(res.status).toBe(200);
      expect((await res.json()).data.referral.status).toBe("in_progress");
      expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "consultation_started" }));
    });

    it("cannot jump from pending to in_progress (invalid_transition)", async () => {
      staffMock.impl = async () => makeStaffCtx(receivingProfileId);
      setupMocks(makeReferral("pending"), receivingProfileId, receivingDoctorId);

      const res = await PATCH(makeRequest(referralId, { status: "in_progress" }), routeContext(referralId));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("invalid_transition");
    });

    it("referring doctor cannot start consultation (forbidden)", async () => {
      staffMock.impl = async () => makeStaffCtx(referringProfileId);
      setupMocks(makeReferral("accepted", { accepted_at: new Date().toISOString() }), referringProfileId, referringDoctorId);

      const res = await PATCH(makeRequest(referralId, { status: "in_progress" }), routeContext(referralId));
      expect(res.status).toBe(403);
    });
  });

  // ── complete ──────────────────────────────────────────────────────────────

  describe("accepted|in_progress → completed", () => {
    it("receiving doctor can complete an in_progress referral", async () => {
      staffMock.impl = async () => makeStaffCtx(receivingProfileId);
      const referral = makeReferral("in_progress", { accepted_at: new Date().toISOString() });
      const updated = makeReferral("completed", { accepted_at: referral.accepted_at, completed_at: new Date().toISOString() });
      setupMocks(referral, receivingProfileId, receivingDoctorId, updated);

      const res = await PATCH(makeRequest(referralId, { status: "completed" }), routeContext(referralId));
      expect(res.status).toBe(200);
      expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "referral_completed" }));
    });

    it("referring doctor can complete an in_progress referral", async () => {
      staffMock.impl = async () => makeStaffCtx(referringProfileId);
      const referral = makeReferral("in_progress", { accepted_at: new Date().toISOString() });
      const updated = makeReferral("completed", { accepted_at: referral.accepted_at, completed_at: new Date().toISOString() });
      setupMocks(referral, referringProfileId, referringDoctorId, updated);

      const res = await PATCH(makeRequest(referralId, { status: "completed" }), routeContext(referralId));
      expect(res.status).toBe(200);
      expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "referral_completed" }));
    });

    it("completes an open referral without acceptance ceremony", async () => {
      staffMock.impl = async () => makeStaffCtx(receivingProfileId);
      setupMocks(makeReferral("pending"), receivingProfileId, receivingDoctorId, makeReferral("completed"));
      const res = await PATCH(makeRequest(referralId, { status: "completed" }), routeContext(referralId));
      expect(res.status).toBe(200);
      expect((await res.json()).data.referral.status).toBe("completed");
    });

    it("cannot re-complete an already-completed referral (terminal)", async () => {
      staffMock.impl = async () => makeStaffCtx(receivingProfileId);
      setupMocks(makeReferral("completed", { completed_at: new Date().toISOString() }), receivingProfileId, receivingDoctorId);

      const res = await PATCH(makeRequest(referralId, { status: "completed" }), routeContext(referralId));
      expect(res.status).toBe(400);
    });
  });

  // ── revoke ────────────────────────────────────────────────────────────────

  describe("revocation", () => {
    it("referring doctor can revoke a pending referral", async () => {
      staffMock.impl = async () => makeStaffCtx(referringProfileId);
      const referral = makeReferral("pending");
      const updated = makeReferral("revoked", { revoked_at: new Date().toISOString(), revoked_by: referringProfileId });
      setupMocks(referral, referringProfileId, referringDoctorId, updated);

      const res = await PATCH(
        makeRequest(referralId, { status: "revoked", reason: "Patient declined" }),
        routeContext(referralId),
      );
      expect(res.status).toBe(200);
      expect((await res.json()).data.referral.status).toBe("revoked");
      expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "referral_revoked" }));
    });

    it("referring doctor can revoke an accepted referral", async () => {
      staffMock.impl = async () => makeStaffCtx(referringProfileId);
      const referral = makeReferral("accepted", { accepted_at: new Date().toISOString() });
      const updated = makeReferral("revoked", { revoked_at: new Date().toISOString() });
      setupMocks(referral, referringProfileId, referringDoctorId, updated);

      const res = await PATCH(makeRequest(referralId, { status: "revoked" }), routeContext(referralId));
      expect(res.status).toBe(200);
      expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "referral_revoked" }));
    });

    it("referring doctor can revoke an in_progress referral", async () => {
      staffMock.impl = async () => makeStaffCtx(referringProfileId);
      const referral = makeReferral("in_progress", { accepted_at: new Date().toISOString() });
      const updated = makeReferral("revoked", { revoked_at: new Date().toISOString() });
      setupMocks(referral, referringProfileId, referringDoctorId, updated);

      const res = await PATCH(makeRequest(referralId, { status: "revoked" }), routeContext(referralId));
      expect(res.status).toBe(200);
      expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "referral_revoked" }));
    });

    it("management cannot perform clinical revoked action", async () => {
      staffMock.impl = async () => makeStaffCtx(mgmtProfileId, ["manager"]);
      const res = await PATCH(makeRequest(referralId, {status:"revoked"}), routeContext(referralId));
      expect(res.status).toBe(403);
      expect(recordAuditMock).not.toHaveBeenCalled();
    });

    it("receiving doctor cannot revoke a referral (forbidden)", async () => {
      staffMock.impl = async () => makeStaffCtx(receivingProfileId);
      setupMocks(makeReferral("pending"), receivingProfileId, receivingDoctorId);

      const res = await PATCH(makeRequest(referralId, { status: "revoked" }), routeContext(referralId));
      expect(res.status).toBe(403);
    });

    it("cannot revoke a completed referral (terminal state)", async () => {
      staffMock.impl = async () => makeStaffCtx(referringProfileId);
      setupMocks(makeReferral("completed", { completed_at: new Date().toISOString() }), referringProfileId, referringDoctorId);

      const res = await PATCH(makeRequest(referralId, { status: "revoked" }), routeContext(referralId));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("invalid_transition");
    });

    it("cannot revoke a declined referral (terminal state)", async () => {
      staffMock.impl = async () => makeStaffCtx(referringProfileId);
      setupMocks(makeReferral("declined"), referringProfileId, referringDoctorId);

      const res = await PATCH(makeRequest(referralId, { status: "revoked" }), routeContext(referralId));
      expect(res.status).toBe(400);
    });

    it("cannot revoke an already-revoked referral (terminal state)", async () => {
      staffMock.impl = async () => makeStaffCtx(referringProfileId);
      setupMocks(makeReferral("revoked", { revoked_at: new Date().toISOString() }), referringProfileId, referringDoctorId);

      const res = await PATCH(makeRequest(referralId, { status: "revoked" }), routeContext(referralId));
      expect(res.status).toBe(400);
    });
  });

  // ── notes update ──────────────────────────────────────────────────────────

  describe("notes-only update (no status change)", () => {
    it("referring doctor cannot rewrite the original handoff", async () => {
      staffMock.impl = async () => makeStaffCtx(referringProfileId);
      const referral = makeReferral("pending");
      const updated = { ...referral, clinical_handoff_note: "Updated handoff note" };
      setupMocks(referral, referringProfileId, referringDoctorId, updated);

      const res = await PATCH(makeRequest(referralId, { notes: "Updated handoff note" }), routeContext(referralId));
      expect(res.status).toBe(400);
      expect(recordAuditMock).not.toHaveBeenCalled();
    });
  });
});

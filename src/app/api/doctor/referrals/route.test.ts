import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const staffMock = vi.hoisted(() => ({ impl: async () => null as unknown }));
const adminClientMock = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/auth/guards", () => ({
  requireStaff: () => staffMock.impl(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => adminClientMock,
}));

vi.mock("@/lib/audit", () => ({
  recordAudit: vi.fn().mockResolvedValue(undefined),
}));

import { GET, POST } from "./route";
import { ApiError } from "@/lib/api/errors";

function makeChain(overrides: Record<string, unknown> = {}) {
  const chain: Record<string, unknown> = {
    select: vi.fn(),
    eq: vi.fn(),
    neq: vi.fn(),
    gte: vi.fn(),
    or: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    insert: vi.fn(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    ...overrides,
  };
  for (const k of ["select", "eq", "neq", "gte", "or", "order", "limit", "insert"]) {
    if (!overrides[k]) {
      chain[k] = vi.fn().mockReturnValue(chain);
    }
  }
  return chain;
}

describe("/api/doctor/referrals routes", () => {
  const clinicId = "11111111-1111-4111-8111-111111111111";
  const doctorId = "22222222-2222-4222-8222-222222222222";
  const otherDoctorId = "33333333-3333-4333-8333-333333333333";
  const patientId = "44444444-4444-4444-8444-444444444444";
  const profileId = "55555555-5555-4555-8555-555555555555";

  beforeEach(() => {
    vi.clearAllMocks();
    adminClientMock.rpc.mockResolvedValue({data:true,error:null});
    adminClientMock.from.mockImplementation(() => makeChain());
    staffMock.impl = async () => ({
      profileId,
      clinicId,
      clinicName: "Test Clinic",
      clinicTimezone: "Asia/Tashkent",
      roles: ["doctor"],
      platformAdmin: false,
    });
  });

  describe("POST /api/doctor/referrals", () => {
    it("rejects unauthorized caller if requireStaff throws", async () => {
      staffMock.impl = async () => {
        throw new ApiError(401, "Kirish talab qilinadi");
      };

      const req = new NextRequest("http://localhost/api/doctor/referrals", {
        method: "POST",
        body: JSON.stringify({
          patientId,
          receivingDoctorId: otherDoctorId,
          reason: "Consultation",
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(401);
    });

    it("rejects self-referral", async () => {
      adminClientMock.from.mockImplementation((table: string) => {
        if (table === "doctors") {
          return makeChain({
            maybeSingle: vi.fn().mockResolvedValue({
              data: { id: doctorId, clinic_id: clinicId, name: "Dr Self" },
              error: null,
            }),
          });
        }
        return makeChain();
      });

      const req = new NextRequest("http://localhost/api/doctor/referrals", {
        method: "POST",
        body: JSON.stringify({
          patientId,
          receivingDoctorId: doctorId, // self!
          reason: "Cardiology checkup",
        }),
      });

      const res = await POST(req);
      const json = await res.json();
      expect(res.status).toBe(400);
      expect(json.code).toBe("self_referral");
    });

    it("rejects when receiving doctor is not found in same clinic", async () => {
      let callCount = 0;
      adminClientMock.from.mockImplementation((table: string) => {
        if (table === "doctors") {
          return makeChain({
            maybeSingle: vi.fn().mockImplementation(() => {
              callCount++;
              if (callCount === 1) {
                return Promise.resolve({ data: { id: doctorId, clinic_id: clinicId }, error: null });
              }
              return Promise.resolve({ data: null, error: null });
            }),
          });
        }
        return makeChain();
      });

      const req = new NextRequest("http://localhost/api/doctor/referrals", {
        method: "POST",
        body: JSON.stringify({
          patientId,
          receivingDoctorId: otherDoctorId,
          reason: "Consultation",
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.code).toBe("receiving_doctor_not_found");
    });

    it("creates referral successfully, records audit event, and returns 201", async () => {
      let docCall = 0;
      adminClientMock.from.mockImplementation((table: string) => {
        if (table === "doctors") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockImplementation(() => {
              docCall++;
              if (docCall === 1) {
                return Promise.resolve({ data: { id: doctorId, clinic_id: clinicId }, error: null });
              }
              return Promise.resolve({ data: { id: otherDoctorId, clinic_id: clinicId, name: "Dr Specialist" }, error: null });
            }),
          };
        }
        if (table === "patients") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { id: patientId, full_name: "John Doe", clinic_id: clinicId },
              error: null,
            }),
          };
        }
        if (table === "appointments") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            // Mock that the doctor has an appointment with this patient
            count: 1,
            data: [{ id: "apt-1", doctor_id: doctorId, patient_id: patientId }],
            error: null,
          };
        }
        if (table === "referrals") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            gte: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: {
                    id: "11111111-2222-3333-4444-555555555555",
                    clinic_id: clinicId,
                    patient_id: patientId,
                    referring_doctor_id: doctorId,
                    referred_to_doctor_id: otherDoctorId,
                    priority: "routine",
                    referral_reason: "Need specialty consultation",
                    status: "pending",
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        return {};
      });

      const req = new NextRequest("http://localhost/api/doctor/referrals", {
        method: "POST",
        body: JSON.stringify({
          patientId,
          receivingDoctorId: otherDoctorId,
          reason: "Need specialty consultation",
          urgency: "routine",
          idempotencyKey: "test-key-123",
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.referral.id).toBe("11111111-2222-3333-4444-555555555555");
      expect(json.data.referral.status).toBe("pending");

      // Verify audit event is recorded
      const { recordAudit } = await import("@/lib/audit");
      expect(recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          clinicId,
          action: "referral_created",
          entityType: "referrals",
          entityId: "11111111-2222-3333-4444-555555555555",
        }),
      );
    });

    it("rejects referral when doctor has no authorized clinical access to patient", async () => {
      adminClientMock.rpc.mockResolvedValue({data:false,error:null});
      let docCall = 0;
      adminClientMock.from.mockImplementation((table: string) => {
        if (table === "doctors") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockImplementation(() => {
              docCall++;
              if (docCall === 1) {
                return Promise.resolve({ data: { id: doctorId, clinic_id: clinicId }, error: null });
              }
              return Promise.resolve({ data: { id: otherDoctorId, clinic_id: clinicId, name: "Dr Specialist" }, error: null });
            }),
          };
        }
        if (table === "patients") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { id: patientId, full_name: "John Doe", clinic_id: clinicId },
              error: null,
            }),
          };
        }
        if (table === "appointments") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            // No appointment between this doctor and patient
            count: 0,
            data: [],
            error: null,
          };
        }
        if (table === "referrals") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            neq: vi.fn().mockReturnThis(),
            or: vi.fn().mockReturnThis(),
            gte: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            // No prior referral
            count: 0,
          };
        }
        return {};
      });

      const req = new NextRequest("http://localhost/api/doctor/referrals", {
        method: "POST",
        body: JSON.stringify({
          patientId,
          receivingDoctorId: otherDoctorId,
          reason: "Unauthorized access test",
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.code).toBe("unauthorized_patient_access");
    });

    it("handles duplicate submission safely using idempotency key", async () => {
      const existingReferral = {
        id: "existing-ref-id",
        clinic_id: clinicId,
        patient_id: patientId,
        referring_doctor_id: doctorId,
        referred_to_doctor_id: otherDoctorId,
        referral_reason: "First submission reason",
        status: "pending",
        idempotency_key: "idem-key-abc",
        priority:"routine", clinical_handoff_note:null, originating_appointment_id:null,
      };

      adminClientMock.from.mockImplementation((table: string) => {
        if (table === "doctors") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: { id: doctorId, clinic_id: clinicId }, error: null }),
          };
        }
        if (table === "referrals") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: existingReferral, error: null }),
          };
        }
        return {};
      });

      const req = new NextRequest("http://localhost/api/doctor/referrals", {
        method: "POST",
        headers: { "idempotency-key": "idem-key-abc" },
        body: JSON.stringify({
          patientId,
          receivingDoctorId: otherDoctorId,
          reason: "First submission reason",
          idempotencyKey: "idem-key-abc",
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.referral.id).toBe("existing-ref-id");
      expect(json.data.idempotentReplay).toBe(true);
    });

    it("rejects when required fields are missing", async () => {
      adminClientMock.from.mockImplementation((table: string) => {
        if (table === "doctors") {
          return makeChain({
            maybeSingle: vi.fn().mockResolvedValue({
              data: { id: doctorId, clinic_id: clinicId, name: "Dr Alpha" },
              error: null,
            }),
          });
        }
        return makeChain();
      });

      const req = new NextRequest("http://localhost/api/doctor/referrals", {
        method: "POST",
        body: JSON.stringify({
          patientId,
          receivingDoctorId: otherDoctorId,
          // reason is missing
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("rejects when patient is not found in same clinic", async () => {
      let docCall = 0;
      adminClientMock.from.mockImplementation((table: string) => {
        if (table === "doctors") {
          return makeChain({
            maybeSingle: vi.fn().mockImplementation(() => {
              docCall++;
              if (docCall === 1) {
                return Promise.resolve({ data: { id: doctorId, clinic_id: clinicId }, error: null });
              }
              return Promise.resolve({ data: { id: otherDoctorId, clinic_id: clinicId, name: "Dr Specialist" }, error: null });
            }),
          });
        }
        if (table === "patients") {
          return makeChain({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          });
        }
        return makeChain();
      });

      const req = new NextRequest("http://localhost/api/doctor/referrals", {
        method: "POST",
        body: JSON.stringify({
          patientId,
          receivingDoctorId: otherDoctorId,
          reason: "Consultation reason",
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.code).toBe("patient_not_found");
    });
  });

  describe("GET /api/doctor/referrals", () => {
    it("returns list of referrals for the logged in doctor", async () => {
      adminClientMock.from.mockImplementation((table: string) => {
        if (table === "doctors") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { id: doctorId, clinic_id: clinicId },
              error: null,
            }),
          };
        }
        if (table === "referrals") {
          const queryMock: Record<string, unknown> = {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            or: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
              data: [
                {
                  id: "ref-1",
                  status: "pending",
                  priority: "routine",
                  referral_reason: "Echocardiogram review",
                },
              ],
              error: null,
            }),
          };
          return queryMock as never;
        }
        return {};
      });

      const req = new NextRequest("http://localhost/api/doctor/referrals?direction=incoming");
      const res = await GET(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.referrals).toHaveLength(1);
      expect(json.data.referrals[0].id).toBe("ref-1");
    });
  });
});

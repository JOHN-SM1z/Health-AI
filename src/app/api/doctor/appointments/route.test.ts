import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { localDbAvailable } from "@/test/local-db";

/**
 * Doctor portal (Phase 10 remediation, audit finding #2): the doctor routes
 * previously had ZERO automated coverage. These tests exercise the real
 * route handlers against the local database with a mocked staff session,
 * so the server-side ownership checks (own clinic, own doctor record,
 * own appointment, forward-only transitions) are verified end-to-end.
 *
 * Requires: `npm run db:reset-local`. Skips cleanly when the stack is down.
 */

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const URL = process.env.SUPABASE_URL ?? "";

const staffMock = vi.hoisted(() => ({ impl: async () => null as unknown }));

vi.mock("@/lib/auth/guards", () => ({
  requireStaff: () => staffMock.impl(),
}));

import { POST } from "./route";
import { PATCH } from "./[id]/route";

const describeDb = describe.skipIf(!localDbAvailable());

describeDb("doctor appointments routes (real DB, mocked session)", () => {
  let admin: SupabaseClient;
  let clinicId: string;
  let otherClinicId: string;
  let doctorId: string;
  let otherDoctorId: string;
  let otherClinicDoctorId: string;
  let serviceId: string;
  let otherServiceId: string;
  let patientId: string;
  let otherPatientId: string;
  let profileId: string;
  let seq = 0;
  const suffix = Date.now().toString(36);
  const TZ = "Asia/Tashkent";

  const staffCtx = () => ({
    profileId,
    clinicId,
    clinicName: "Doctor Test Clinic",
    clinicTimezone: TZ,
    roles: ["doctor"] as const,
    platformAdmin: false,
  });

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });

    const email = `doctor-${suffix}@test.local`;
    const { data: authUser, error: authError } = await admin.auth.admin.createUser({
      email,
      password: "TestPass123!",
      email_confirm: true,
    });
    expect(authError).toBeNull();
    if (!authUser?.user) throw new Error("doctor auth user creation failed");
    profileId = authUser.user.id;

    const { error: profileError } = await admin
      .from("profiles")
      .insert({ id: profileId, full_name: `Dr User ${suffix}` });
    expect(profileError).toBeNull();

    const { data: clinic } = await admin
      .from("clinics")
      .insert({ name: `Doctor Clinic ${suffix}`, slug: `doctor-${suffix}`, timezone: TZ, currency: "UZS" })
      .select("id")
      .single();
    clinicId = clinic!.id;
    const { data: otherClinic } = await admin
      .from("clinics")
      .insert({ name: `Other Clinic ${suffix}`, slug: `doctor-other-${suffix}`, timezone: TZ, currency: "UZS" })
      .select("id")
      .single();
    otherClinicId = otherClinic!.id;

    const { data: doc } = await admin
      .from("doctors")
      .insert({ clinic_id: clinicId, name: `Dr One ${suffix}`, active: true, profile_id: profileId })
      .select("id")
      .single();
    doctorId = doc!.id;
    const { data: otherDoc } = await admin
      .from("doctors")
      .insert({ clinic_id: clinicId, name: `Dr Two ${suffix}`, active: true })
      .select("id")
      .single();
    otherDoctorId = otherDoc!.id;
    const { data: otherClinicDoc } = await admin
      .from("doctors")
      .insert({ clinic_id: otherClinicId, name: `Dr Other ${suffix}`, active: true })
      .select("id")
      .single();
    otherClinicDoctorId = otherClinicDoc!.id;
    const allDayHours = [
      { weekday: 1, start_time: "00:00", end_time: "23:59" },
      { weekday: 2, start_time: "00:00", end_time: "23:59" },
      { weekday: 3, start_time: "00:00", end_time: "23:59" },
      { weekday: 4, start_time: "00:00", end_time: "23:59" },
      { weekday: 5, start_time: "00:00", end_time: "23:59" },
      { weekday: 6, start_time: "00:00", end_time: "23:59" },
      { weekday: 7, start_time: "00:00", end_time: "23:59" },
    ];
    await admin.from("doctor_working_hours").insert(
      allDayHours.map((h) => ({ clinic_id: clinicId, doctor_id: doctorId, ...h })),
    );
    await admin.from("doctor_working_hours").insert(
      allDayHours.map((h) => ({ clinic_id: clinicId, doctor_id: otherDoctorId, ...h })),
    );
    await admin.from("doctor_working_hours").insert(
      allDayHours.map((h) => ({ clinic_id: otherClinicId, doctor_id: otherClinicDoctorId, ...h })),
    );

    const { data: service } = await admin
      .from("services")
      .insert({ clinic_id: clinicId, name: `Svc ${suffix}`, price: 100000, duration_minutes: 30, active: true, sort_order: 1 })
      .select("id")
      .single();
    serviceId = service!.id;
    const { data: otherService } = await admin
      .from("services")
      .insert({ clinic_id: otherClinicId, name: `Svc Other ${suffix}`, price: 50000, duration_minutes: 30, active: true, sort_order: 1 })
      .select("id")
      .single();
    otherServiceId = otherService!.id;

    const { data: patient } = await admin
      .from("patients")
      .insert({ clinic_id: clinicId, full_name: `Patient ${suffix}`, phone: `+99890${suffix.slice(0, 7)}`, consent_given: true })
      .select("id")
      .single();
    patientId = patient!.id;
    const { data: otherPatient } = await admin
      .from("patients")
      .insert({ clinic_id: otherClinicId, full_name: `Patient Other ${suffix}`, phone: `+99891${suffix.slice(0, 7)}`, consent_given: true })
      .select("id")
      .single();
    otherPatientId = otherPatient!.id;

    staffMock.impl = async () => staffCtx();
  });

  afterAll(async () => {
    await admin.from("doctor_time_blocks").delete().eq("clinic_id", clinicId);
    await admin.from("appointments").delete().eq("clinic_id", clinicId);
    await admin.from("appointments").delete().eq("clinic_id", otherClinicId);
    await admin.from("doctors").delete().eq("clinic_id", clinicId);
    await admin.from("patients").delete().eq("id", patientId);
    await admin.from("services").delete().eq("id", serviceId);
    await admin.from("clinics").delete().in("id", [clinicId, otherClinicId]);
    await admin.from("profiles").delete().eq("id", profileId);
    if (profileId) {
      await admin.auth.admin.deleteUser(profileId);
    }
  });

  beforeEach(() => {
    staffMock.impl = async () => staffCtx();
  });

  async function insertAppointment(over: Partial<{ doctor: string; clinic: string; status: string; start: string }> = {}) {
    const start = over.start ?? new Date(Date.now() + 3 * 86400000 + seq++ * 60 * 60000).toISOString();
    const { data, error } = await admin
      .from("appointments")
      .insert({
        clinic_id: over.clinic ?? clinicId,
        doctor_id: over.doctor ?? doctorId,
        service_id: over.clinic === otherClinicId ? otherServiceId : serviceId,
        patient_id: over.clinic === otherClinicId ? otherPatientId : patientId,
        start_at: start,
        end_at: new Date(new Date(start).getTime() + 30 * 60000).toISOString(),
        status: (over.status ?? "pending") as never,
        source: "walk_in",
      })
      .select("id, status")
      .single();
    expect(error).toBeNull();
    return data!;
  }

  function patch(id: string, body: Record<string, unknown>): Promise<Response> {
    return PATCH(
      new NextRequest(`http://localhost/api/doctor/appointments/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );
  }

  describe("PATCH /api/doctor/appointments/[id]", () => {
    it("rejects an appointment from another clinic with 404", async () => {
      const appt = await insertAppointment({ clinic: otherClinicId, doctor: otherClinicDoctorId });
      const res = await patch(appt.id, { status: "checked_in" });
      expect(res.status).toBe(404);
    });

    it("rejects someone else's appointment with 403", async () => {
      const appt = await insertAppointment({ doctor: otherDoctorId });
      const res = await patch(appt.id, { status: "checked_in" });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("not_yours");
    });

    it("rejects a backwards transition with 409", async () => {
      const appt = await insertAppointment({ status: "in_progress" });
      const res = await patch(appt.id, { status: "checked_in" });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("invalid_transition");
    });

    it("rejects a status outside the doctor allowlist with 400", async () => {
      const appt = await insertAppointment();
      const res = await patch(appt.id, { status: "cancelled" });
      expect(res.status).toBe(400);
    });

    it("advances a doctor's own appointment forward", async () => {
      const appt = await insertAppointment();
      const res = await patch(appt.id, { status: "checked_in" });
      expect(res.status).toBe(200);
      const { data: after } = await admin.from("appointments").select("status").eq("id", appt.id).single();
      expect(after!.status).toBe("checked_in");

      const res2 = await patch(appt.id, { status: "in_progress" });
      expect(res2.status).toBe(200);
      const res3 = await patch(appt.id, { status: "completed" });
      expect(res3.status).toBe(200);
      const { data: done } = await admin.from("appointments").select("status").eq("id", appt.id).single();
      expect(done!.status).toBe("completed");
    });

    it("returns 403 when the staff profile is not linked to an active doctor", async () => {
      staffMock.impl = async () => ({ ...staffCtx(), profileId: "20000000-0000-4000-8000-000000000000" });
      const appt = await insertAppointment();
      const res = await patch(appt.id, { status: "checked_in" });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("doctor_not_linked");
    });
  });

  describe("POST /api/doctor/appointments (own time blocks)", () => {
    function post(body: Record<string, unknown>): Promise<Response> {
      return POST(
        new NextRequest("http://localhost/api/doctor/appointments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    }

    it("creates a break block", async () => {
      const start = new Date(Date.now() + 10 * 86400000).toISOString();
      const res = await post({ startsAt: start, endsAt: new Date(Date.now() + 10 * 86400000 + 60 * 60000).toISOString(), reason: "break" });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { data?: { block?: { id?: string } } };
      expect(body.data?.block?.id).toBeTruthy();
      const { data: block } = await admin
        .from("doctor_time_blocks")
        .select("doctor_id, reason, created_by")
        .eq("id", body.data!.block!.id!)
        .single();
      expect(block!.doctor_id).toBe(doctorId);
      expect(block!.created_by).toBe(profileId);
    });

    it("rejects an inverted range with 400", async () => {
      const start = new Date(Date.now() + 10 * 86400000).toISOString();
      const res = await post({
        startsAt: start,
        endsAt: new Date(Date.now() + 10 * 86400000 - 60 * 60000).toISOString(),
        reason: "break",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("bad_range");
    });

    it("rejects a block for a clinic the doctor does not belong to", async () => {
      staffMock.impl = async () => ({ ...staffCtx(), clinicId: otherClinicId });
      const start = new Date(Date.now() + 10 * 86400000).toISOString();
      const res = await post({
        startsAt: start,
        endsAt: new Date(Date.now() + 10 * 86400000 + 60 * 60000).toISOString(),
        reason: "break",
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("doctor_not_linked");
    });
  });
});
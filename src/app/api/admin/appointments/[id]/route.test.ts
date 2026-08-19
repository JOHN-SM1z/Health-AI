import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { localDbAvailable } from "@/test/local-db";

/**
 * No-show reason capture (audit finding, Phase 7/9): marking an appointment
 * no_show REQUIRES a reason, it is persisted, and analytics aggregation
 * groups by it. Regression tests run the real route handler against the
 * local database with a mocked staff session.
 *
 * Requires: `npm run db:reset-local`. Skips cleanly when the stack is down.
 */

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

const staffMock = vi.hoisted(() => ({ impl: async () => null as unknown }));

vi.mock("@/lib/auth/guards", () => ({
  requireRoles: () => staffMock.impl(),
}));

import { PATCH } from "./route";

const describeDb = describe.skipIf(!localDbAvailable());

describeDb("admin appointment status PATCH (real DB, mocked session)", () => {
  let admin: SupabaseClient;
  let clinicId: string;
  let doctorId: string;
  let serviceId: string;
  let patientId: string;
  let profileId: string;
  let seq = 0;
  const suffix = Date.now().toString(36);

  const staffCtx = () => ({
    profileId,
    clinicId,
    clinicName: "Admin Test Clinic",
    clinicTimezone: "Asia/Tashkent",
    roles: ["admin"] as const,
    platformAdmin: false,
  });

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });

    const email = `admin-${suffix}@test.local`;
    const { data: authUser, error: authError } = await admin.auth.admin.createUser({
      email,
      password: "TestPass123!",
      email_confirm: true,
    });
    expect(authError).toBeNull();
    if (!authUser?.user) throw new Error("admin auth user creation failed");
    profileId = authUser.user.id;
    await admin.from("profiles").insert({ id: profileId, full_name: `Admin User ${suffix}` });

    const { data: clinic } = await admin
      .from("clinics")
      .insert({ name: `NoShow Clinic ${suffix}`, slug: `noshow-${suffix}`, timezone: "Asia/Tashkent", currency: "UZS" })
      .select("id")
      .single();
    clinicId = clinic!.id;

    const { data: doc } = await admin
      .from("doctors")
      .insert({ clinic_id: clinicId, name: `Dr NoShow ${suffix}`, active: true })
      .select("id")
      .single();
    doctorId = doc!.id;
    await admin.from("doctor_working_hours").insert(
      Array.from({ length: 7 }, (_, i) => ({
        clinic_id: clinicId,
        doctor_id: doctorId,
        weekday: i + 1,
        start_time: "00:00",
        end_time: "23:59",
      })),
    );

    const { data: service } = await admin
      .from("services")
      .insert({ clinic_id: clinicId, name: `Svc ${suffix}`, price: 60000, duration_minutes: 30, active: true, sort_order: 1 })
      .select("id")
      .single();
    serviceId = service!.id;

    const { data: patient } = await admin
      .from("patients")
      .insert({ clinic_id: clinicId, full_name: `Patient ${suffix}`, phone: `+99892${suffix.slice(0, 7)}`, consent_given: true })
      .select("id")
      .single();
    patientId = patient!.id;

    staffMock.impl = async () => staffCtx();
  });

  afterAll(async () => {
    await admin.from("appointments").delete().eq("clinic_id", clinicId);
    await admin.from("doctors").delete().eq("clinic_id", clinicId);
    await admin.from("patients").delete().eq("id", patientId);
    await admin.from("services").delete().eq("id", serviceId);
    await admin.from("clinics").delete().eq("id", clinicId);
    await admin.from("profiles").delete().eq("id", profileId);
    if (profileId) await admin.auth.admin.deleteUser(profileId);
  });

  beforeEach(() => {
    staffMock.impl = async () => staffCtx();
  });

  async function insertAppointment(status = "pending") {
    const start = new Date(Date.now() + 3 * 86400000 + seq++ * 30 * 60000).toISOString();
    const { data, error } = await admin
      .from("appointments")
      .insert({
        clinic_id: clinicId,
        doctor_id: doctorId,
        service_id: serviceId,
        patient_id: patientId,
        start_at: start,
        end_at: new Date(new Date(start).getTime() + 30 * 60000).toISOString(),
        status: status as never,
        source: "walk_in",
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    return data!.id;
  }

  function patch(id: string, body: Record<string, unknown>): Promise<Response> {
    return PATCH(
      new NextRequest(`http://localhost/api/admin/appointments/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );
  }

  it("stores the reason when marking no_show", async () => {
    const id = await insertAppointment();
    const res = await patch(id, { action: "status", status: "no_show", noShowReason: "Bemor qo‘ng‘iroq qilib, kela olmasligini aytdi" });
    expect(res.status).toBe(200);
    const { data: appt } = await admin.from("appointments").select("status, no_show_reason").eq("id", id).single();
    expect(appt!.status).toBe("no_show");
    expect(appt!.no_show_reason).toBe("Bemor qo‘ng‘iroq qilib, kela olmasligini aytdi");
  });

  it("rejects no_show without a reason (400)", async () => {
    const id = await insertAppointment();
    const res = await patch(id, { action: "status", status: "no_show" });
    expect(res.status).toBe(400);
    const { data: appt } = await admin.from("appointments").select("status, no_show_reason").eq("id", id).single();
    expect(appt!.status).toBe("pending");
    expect(appt!.no_show_reason).toBeNull();
  });

  it("rejects an empty/whitespace reason (400)", async () => {
    const id = await insertAppointment();
    const res = await patch(id, { action: "status", status: "no_show", noShowReason: "   " });
    expect(res.status).toBe(400);
  });

  it("rejects a reason over 300 characters (400)", async () => {
    const id = await insertAppointment();
    const res = await patch(id, { action: "status", status: "no_show", noShowReason: "x".repeat(301) });
    expect(res.status).toBe(400);
  });

  it("does not clobber cancellation fields when marking no_show", async () => {
    const id = await insertAppointment();
    await patch(id, { action: "status", status: "no_show", noShowReason: "Aloqa yo‘q" });
    const { data: appt } = await admin.from("appointments").select("cancelled_at, cancelled_reason, cancelled_by").eq("id", id).single();
    expect(appt!.cancelled_at).toBeNull();
    expect(appt!.cancelled_reason).toBeNull();
    expect(appt!.cancelled_by).toBeNull();
  });
});
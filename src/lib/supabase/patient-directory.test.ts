import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { localDbAvailable } from "@/test/local-db";

/**
 * Patient directory (Phase 5) against the LOCAL Supabase stack:
 * search, filters, and tenant scoping end-to-end via the API route.
 * Requires: `npm run db:reset-local` + `.env` local keys; skips otherwise.
 */

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

const describeDb = describe.skipIf(!localDbAvailable());

const SEED_CLINIC_ID = "11111111-1111-4111-8111-111111111111";

vi.mock("@/lib/auth/guards", () => ({
  requireRoles: vi.fn(),
}));

const loggerMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: loggerMock }));

import { requireRoles } from "@/lib/auth/guards";
import { GET } from "@/app/api/admin/patients/route";

const requireMock = vi.mocked(requireRoles);

describeDb("admin patients directory (Phase 5)", () => {
  let admin: SupabaseClient;
  let clinicB: string;
  let patientAId: string;
  let patientBId: string;
  let doctorId: string;
  const suffix = Date.now().toString(36);

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });

    const makeClinic = async (name: string) => {
      const { data } = await admin
        .from("clinics")
        .insert({ name: `${name} ${suffix}`, slug: `${name.toLowerCase()}-${suffix}`, timezone: "Asia/Tashkent", currency: "UZS" })
        .select("id")
        .single();
      return data!.id;
    };
    clinicB = await makeClinic("Px Clinic B");

    // The staff member belongs to the SEED clinic (real tenant) whose
    // doctors/services are shared fixtures.
    requireMock.mockResolvedValue({
      profileId: "staff-1",
      clinicId: SEED_CLINIC_ID,
      clinicName: "Seed Clinic",
      clinicTimezone: "Asia/Tashkent",
      platformAdmin: false,
      roles: ["admin"],
    });

    // Same searchable name in both clinics: only the seed clinic's row may
    // surface for seed-clinic staff.
    const [{ data: pa }, { data: pb }] = await Promise.all([
      admin.from("patients").insert({
        clinic_id: SEED_CLINIC_ID,
        full_name: "Nodira Karimova",
        phone: "+998900000111",
        telegram_user_id: 991001,
        telegram_username: "nodira_k",
        consent_given: false,
      }).select("id").single(),
      admin.from("patients").insert({
        clinic_id: clinicB,
        full_name: "Nodira Karimova",
        phone: "+998900000222",
        telegram_user_id: 991002,
        telegram_username: "nodira_k",
        consent_given: true,
      }).select("id").single(),
    ]);
    patientAId = pa!.id;
    patientBId = pb!.id;

    // One appointment for the seed clinic's patient so counts are visible.
    // The doctor is this suite's OWN fixture (with working hours) so that
    // other suites' cleanup of shared seed-doctor rows can never interfere.
    const { data: specialty } = await admin
      .from("specialties")
      .select("id")
      .eq("clinic_id", SEED_CLINIC_ID)
      .limit(1)
      .single();
    const { data: doctor } = await admin
      .from("doctors")
      .insert({
        clinic_id: SEED_CLINIC_ID,
        name: `Dir ${suffix}`,
        title: "Test shifokor",
        specialty_id: specialty!.id,
        active: true,
      })
      .select("id")
      .single();
    doctorId = doctor!.id;
    const { error: whError } = await admin.from("doctor_working_hours").insert(
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        clinic_id: SEED_CLINIC_ID,
        doctor_id: doctorId,
        weekday,
        start_time: "09:00",
        end_time: "18:00",
      })),
    );
    expect(whError).toBeNull();
    const { data: service } = await admin.from("services").select("id").eq("name", "Terapevt qabuli").single();
    const { error: rpcError } = await admin.rpc("book_appointment", {
      p_clinic_id: SEED_CLINIC_ID,
      p_patient_id: patientAId,
      p_doctor_id: doctorId,
      p_service_id: service!.id,
      p_start_at: "2030-01-07T05:00:00Z",
      p_status: "pending",
      p_source: "telegram_mini_app",
      p_notes: null,
      p_created_by: null,
    });
    if (rpcError) throw new Error(`fixture appointment failed: ${rpcError.message}`);
  });

  afterAll(async () => {
    if (!admin) return;
    for (const id of [patientAId, patientBId]) {
      if (!id) continue;
      try {
        const { data: convs } = await admin.from("conversations").select("id").eq("patient_id", id);
        for (const c of convs ?? []) {
          await admin.from("messages").delete().eq("conversation_id", c.id);
          await admin.from("voice_messages").delete().eq("conversation_id", c.id);
        }
        await admin.from("conversations").delete().eq("patient_id", id);
        await admin.from("appointments").delete().eq("patient_id", id);
        await admin.from("patients").delete().eq("id", id);
      } catch {
        // best effort cleanup
      }
    }
    if (doctorId) {
      try {
        await admin.from("appointments").delete().eq("doctor_id", doctorId);
        await admin.from("doctor_working_hours").delete().eq("doctor_id", doctorId);
        await admin.from("doctors").delete().eq("id", doctorId);
      } catch {
        // best effort cleanup
      }
    }
    if (clinicB) {
      try {
        await admin.from("clinics").delete().eq("id", clinicB);
      } catch {
        // best effort cleanup
      }
    }
  });

  it("lists only the staff clinic's patients with real appointment counts", async () => {
    const res = await GET(new NextRequest("http://localhost/api/admin/patients"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      data: { patients: Array<{ id: string; full_name: string; appointments_count: number }>; total: number };
    };
    expect(json.ok).toBe(true);
    const nodira = json.data.patients.find((p) => p.id === patientAId);
    expect(nodira).toBeTruthy();
    expect(nodira!.appointments_count).toBeGreaterThanOrEqual(1);
    // Clinic B's identical-name patient is invisible to Clinic A staff.
    expect(json.data.patients.some((p) => p.id === patientBId)).toBe(false);
  });

  it("searches by name, phone and Telegram username", async () => {
    for (const q of ["Nodira", "900000111", "nodira_k"]) {
      const res = await GET(new NextRequest(`http://localhost/api/admin/patients?q=${encodeURIComponent(q)}`));
      const json = (await res.json()) as { data: { patients: Array<{ id: string }> } };
      expect(json.data.patients.map((p) => p.id)).toContain(patientAId);
      expect(json.data.patients.map((p) => p.id)).not.toContain(patientBId);
    }
  });

  it("filters to Telegram-only and no-consent patients", async () => {
    const tg = await GET(new NextRequest("http://localhost/api/admin/patients?telegram=1"));
    const tgJson = (await tg.json()) as { data: { patients: Array<{ id: string }> } };
    expect(tgJson.data.patients.map((p) => p.id)).toContain(patientAId);

    const nc = await GET(new NextRequest("http://localhost/api/admin/patients?noConsent=1"));
    const ncJson = (await nc.json()) as { data: { patients: Array<{ id: string; consent_given: boolean }> } };
    const row = ncJson.data.patients.find((p) => p.id === patientAId);
    expect(row?.consent_given).toBe(false);
  });

  it("returns detail with appointments for the clinic's own patient only", async () => {
    const res = await GET(new NextRequest(`http://localhost/api/admin/patients?id=${patientAId}`));
    const json = (await res.json()) as {
      data: { patient: { id: string } | null; appointments: unknown[] };
    };
    expect(json.data.patient?.id).toBe(patientAId);
    expect(json.data.appointments.length).toBeGreaterThanOrEqual(1);

    // Foreign-clinic detail resolves to null — no cross-tenant data leak.
    const foreign = await GET(new NextRequest(`http://localhost/api/admin/patients?id=${patientBId}`));
    const foreignJson = (await foreign.json()) as { data: { patient: null } };
    expect(foreignJson.data.patient).toBeNull();
  });
});
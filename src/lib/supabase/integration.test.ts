import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Integration tests against the LOCAL Supabase stack (Docker).
 *
 * They run only when real local keys are present (a .env file with
 * SUPABASE_URL=http://127.0.0.1:54321 and the local service role key).
 * With the placeholder .env.test.example values they are skipped.
 *
 * Requires: supabase/migrations + supabase/seed.sql applied (see README).
 */

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
const URL = process.env.SUPABASE_URL ?? "";

const isPlaceholder = !URL || SERVICE_KEY.startsWith("test-") || ANON_KEY.startsWith("test-");
const CLINIC_ID = "11111111-1111-4111-8111-111111111111";
const TZ = "Asia/Tashkent"; // UTC+5

let admin: SupabaseClient;
let anon: SupabaseClient;
let doctorId: string;
let serviceId: string;
let patientId: string;

function skip(): boolean {
  if (isPlaceholder) return true;
  try {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    anon = createClient(URL, ANON_KEY, { auth: { persistSession: false } });
    return false;
  } catch {
    return true;
  }
}

const describeDb = describe.skipIf(skip());

describeDb("local Supabase booking engine", () => {
  beforeAll(async () => {
    // Seed fixture lookups.
    const [{ data: doctor }, { data: service }, { data: patient }] = await Promise.all([
      admin.from("doctors").select("id").eq("name", "Karimov Alisher").single(),
      admin.from("services").select("id").eq("name", "Terapevt qabuli").single(),
      admin.from("patients").select("id").eq("telegram_user_id", 777000).single(),
    ]);
    doctorId = doctor!.id;
    serviceId = service!.id;
    patientId = patient!.id;
    // Wipe leftovers from previous runs so the suite is idempotent.
    // All fixture appointments target this seed doctor.
    await admin.from("appointments").delete().eq("doctor_id", doctorId);
  });

  /** Next occurrence of `weekday` (1=Mon..7=Sun) at 10:00 Tashkent, ≥48h ahead. */
  function nextWeekdayAt10(weekday: number, minDaysAhead = 2): string {
    const now = new Date();
    const target = new Date(now.getTime() + minDaysAhead * 86400000);
    // Local calendar date in Tashkent, then its ISO weekday.
    const localDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(target);
    const day = new Date(`${localDate}T00:00:00Z`);
    const localWeekday = day.getUTCDay() === 0 ? 7 : day.getUTCDay(); // Sun=7
    const diff = ((weekday - localWeekday) % 7 + 7) % 7;
    target.setUTCDate(target.getUTCDate() + diff);
    // 10:00 Tashkent == 05:00 UTC.
    const startUtc = new Date(target.toISOString().slice(0, 10) + "T05:00:00Z");
    return startUtc.toISOString();
  }

  it("books an appointment via RPC within working hours", async () => {
    const startAt = nextWeekdayAt10(1); // Monday 10:00 local
    const { data, error } = await admin.rpc("book_appointment", {
      p_clinic_id: CLINIC_ID,
      p_patient_id: patientId,
      p_doctor_id: doctorId,
      p_service_id: serviceId,
      p_start_at: startAt,
      p_status: "pending",
      p_source: "telegram_mini_app",
      p_notes: null,
      p_created_by: null,
    });
    expect(error).toBeNull();
    const result = data as { appointment_id: string | null; error_code: string | null; error_message: string | null };
    expect(result.error_code).toBeNull();
    expect(result.appointment_id).toBeTruthy();

    // Cleanup so other tests run on a fresh schedule.
    await admin.from("appointments").delete().eq("id", result.appointment_id);
  });

  it("rejects a double booking on the same slot (slot_taken)", async () => {
    const startAt = nextWeekdayAt10(2); // Tuesday
    const params = {
      p_clinic_id: CLINIC_ID,
      p_patient_id: patientId,
      p_doctor_id: doctorId,
      p_service_id: serviceId,
      p_start_at: startAt,
      p_status: "pending",
      p_source: "telegram_mini_app",
      p_notes: null,
      p_created_by: null,
    };
    const first = (await admin.rpc("book_appointment", params)).data as {
      appointment_id: string | null;
      error_code: string | null;
    };
    expect(first.error_code).toBeNull();

    const second = (await admin.rpc("book_appointment", params)).data as {
      appointment_id: string | null;
      error_code: string | null;
    };
    expect(second.error_code).toBe("slot_taken");
    expect(second.appointment_id).toBeNull();

    await admin.from("appointments").delete().eq("id", first.appointment_id!);
  });

  it("rejects booking outside working hours (outside_working_hours)", async () => {
    const startAt = nextWeekdayAt10(1);
    const offHours = new Date(new Date(startAt).getTime() - 6 * 3600000).toISOString(); // 04:00 local
    const { data } = await admin.rpc("book_appointment", {
      p_clinic_id: CLINIC_ID,
      p_patient_id: patientId,
      p_doctor_id: doctorId,
      p_service_id: serviceId,
      p_start_at: offHours,
      p_status: "pending",
      p_source: "telegram_mini_app",
      p_notes: null,
      p_created_by: null,
    });
    const result = data as { error_code: string | null; error_message: string | null };
    expect(result.error_code).toBe("outside_working_hours");
  });

  it("allows rebooking a slot after the previous booking is cancelled", async () => {
    const startAt = nextWeekdayAt10(3); // Wednesday
    const params = {
      p_clinic_id: CLINIC_ID,
      p_patient_id: patientId,
      p_doctor_id: doctorId,
      p_service_id: serviceId,
      p_start_at: startAt,
      p_status: "pending",
      p_source: "telegram_mini_app",
      p_notes: null,
      p_created_by: null,
    };
    const first = (await admin.rpc("book_appointment", params)).data as { appointment_id: string | null };
    await admin.from("appointments").update({ status: "cancelled" }).eq("id", first.appointment_id!);

    const second = (await admin.rpc("book_appointment", params)).data as {
      appointment_id: string | null;
      error_code: string | null;
    };
    expect(second.error_code).toBeNull();
    expect(second.appointment_id).toBeTruthy();

    await admin.from("appointments").delete().eq("id", second.appointment_id!);
  });

  it("enforces the no-overlap exclusion constraint on direct inserts", async () => {
    const startAt = new Date(nextWeekdayAt10(4)); // Thursday
    const endAt = new Date(startAt.getTime() + 60 * 60000).toISOString();
    const row = {
      clinic_id: CLINIC_ID,
      patient_id: patientId,
      doctor_id: doctorId,
      service_id: serviceId,
      start_at: startAt.toISOString(),
      end_at: endAt,
      status: "confirmed",
      source: "admin",
    };
    const first = await admin.from("appointments").insert(row).select("id").single();
    expect(first.error).toBeNull();

    const overlap = await admin.from("appointments").insert(row).select("id").single();
    // Either the constraint rejects it or the advisory lock serializes —
    // the engine must never produce two overlapping active bookings.
    if (!overlap.error) {
      const { count } = await admin
        .from("appointments")
        .select("id", { count: "exact", head: true })
        .eq("doctor_id", doctorId)
        .eq("start_at", startAt.toISOString())
        .in("status", ["pending", "confirmed", "checked_in", "in_progress"]);
      expect(count).toBe(1);
    } else {
      expect(overlap.error.code).toBe("23P01"); // exclusion_constraint_violation
    }

    await admin.from("appointments").delete().eq("id", first.data!.id);
  });
});

describeDb("local Supabase security posture", () => {
  it("blocks anonymous clients from reading patient data (RLS)", async () => {
    const { data, error } = await anon
      .from("patients")
      .select("id")
      .limit(1);
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });

  it("blocks anonymous clients from creating appointments directly", async () => {
    const { error } = await anon.from("appointments").insert({
      clinic_id: CLINIC_ID,
      patient_id: "00000000-0000-0000-0000-000000000000",
      doctor_id: "00000000-0000-0000-0000-000000000000",
      service_id: "00000000-0000-0000-0000-000000000000",
      start_at: new Date().toISOString(),
      end_at: new Date().toISOString(),
      status: "pending",
      source: "telegram_mini_app",
    });
    expect(error).not.toBeNull();
  });
});
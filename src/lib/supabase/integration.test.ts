import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";

vi.mock("@/lib/telegram/bot", () => ({
  sendTelegramMessage: vi.fn(async () => 1),
  getTelegramFileUrl: vi.fn(async () => null),
  telegramConfigured: vi.fn(() => true),
}));

vi.mock("@/lib/transcription/provider", () => ({
  getTranscriptionProvider: vi.fn(() => ({ name: "test-provider", transcribe: async () => "..." })),
}));

import { sendTelegramMessage } from "@/lib/telegram/bot";
import { handleTelegramMessage } from "@/lib/telegram/handlers";

/**
 * Integration tests against the LOCAL Supabase stack (Docker).
 *
 * They run only when the stack is up, migrated and seeded (probed by
 * src/test/global-setup.ts → localDbAvailable()); otherwise they skip with
 * a clear warning — a half-configured database never produces a misleading
 * failed run.
 *
 * Requires: `npm run db:reset-local` (migrations + seed) and a `.env` with
 * the real local keys (see README / docs/supabase-setup.md).
 */

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

const CLINIC_ID = "11111111-1111-4111-8111-111111111111";
const TZ = "Asia/Tashkent"; // UTC+5
/** Throwaway processed_webhooks key used by the server-only RPC grant tests. */
const RPC_GRANT_PROBE = `rpc-grant-probe-${Date.now()}`;

let admin: SupabaseClient;
let anon: SupabaseClient;
let doctorId: string;
let serviceId: string;
let patientId: string;

const describeDb = describe.skipIf(!localDbAvailable());

function buildClients(): { admin: SupabaseClient; anon: SupabaseClient } {
  admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
  anon = createClient(URL, ANON_KEY, { auth: { persistSession: false } });
  return { admin, anon };
}

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

describeDb("local Supabase booking engine", () => {
  beforeAll(async () => {
    buildClients();
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

  it("exactly one of two concurrent RPC bookings wins the same slot (no race)", async () => {
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
    const [a, b] = await Promise.all([admin.rpc("book_appointment", params), admin.rpc("book_appointment", params)]);
    const ra = a.data as { appointment_id: string | null; error_code: string | null };
    const rb = b.data as { appointment_id: string | null; error_code: string | null };
    const winners = [ra, rb].filter((r) => r.error_code === null && r.appointment_id !== null).length;
    expect(winners).toBe(1);
    const loser = winners === 1 && ra.error_code !== null ? ra : rb;
    expect(loser.error_code).toBe("slot_taken");
    const winnerId = ra.error_code === null ? ra.appointment_id : rb.appointment_id;
    await admin.from("appointments").delete().eq("id", winnerId!);
  });

  it("cancel-after-book race: exactly one active appointment survives at the slot", async () => {
    const startAt = nextWeekdayAt10(4); // Thursday
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
    const booked = (await admin.rpc("book_appointment", params)).data as {
      appointment_id: string | null;
      error_code: string | null;
    };
    expect(booked.error_code).toBeNull();

    // Patient cancels while (another) booking attempt races for the same slot.
    await Promise.all([
      admin.from("appointments").update({ status: "cancelled" }).eq("id", booked.appointment_id!),
      admin.rpc("book_appointment", params),
    ]);

    // The slot must NEVER hold two active appointments. Depending on which
    // operation committed first: the rebook wins (1 pending + 1 cancelled)
    // or it correctly failed with slot_taken while the cancel went through
    // (0 pending + 1 cancelled).
    const { data: all } = await admin
      .from("appointments")
      .select("id, status")
      .eq("doctor_id", doctorId)
      .eq("start_at", startAt);
    const pending = (all ?? []).filter((a) => a.status === "pending");
    const cancelled = (all ?? []).filter((a) => a.status === "cancelled");
    expect(pending.length).toBeLessThanOrEqual(1);
    const rebookWon = pending.length === 1 && cancelled.length === 1;
    const cancelWon = pending.length === 0 && cancelled.length === 1 && (all ?? []).length === 1;
    expect(rebookWon || cancelWon).toBe(true);
    await admin.from("appointments").delete().eq("doctor_id", doctorId).eq("start_at", startAt);
  });

  it("reschedule-during-booking race: exactly one appointment lands on the target slot", async () => {
    const slot1 = nextWeekdayAt10(5); // Friday
    const slot2 = nextWeekdayAt10(1); // next Monday
    const booked = (await admin.rpc("book_appointment", {
      p_clinic_id: CLINIC_ID,
      p_patient_id: patientId,
      p_doctor_id: doctorId,
      p_service_id: serviceId,
      p_start_at: slot1,
      p_status: "pending",
      p_source: "telegram_mini_app",
      p_notes: null,
      p_created_by: null,
    })).data as { appointment_id: string | null; error_code: string | null };
    expect(booked.error_code).toBeNull();

    // A fresh patient tries to book slot2 while the first appointment is
    // rescheduled onto slot2 — serialized by the per-doctor advisory lock.
    await Promise.all([
      admin.rpc("reschedule_appointment", {
        p_appointment_id: booked.appointment_id!,
        p_new_start_at: slot2,
        p_actor: null,
      }),
      admin.rpc("book_appointment", {
        p_clinic_id: CLINIC_ID,
        p_patient_id: patientId,
        p_doctor_id: doctorId,
        p_service_id: serviceId,
        p_start_at: slot2,
        p_status: "pending",
        p_source: "telegram_mini_app",
        p_notes: null,
        p_created_by: null,
      }),
    ]);

    // Exactly one pending appointment may occupy slot2 (the rescheduled one
    // or the new one — never both, never zero with two successes).
    const { data: onSlot2 } = await admin
      .from("appointments")
      .select("id, status")
      .eq("doctor_id", doctorId)
      .eq("start_at", slot2)
      .eq("status", "pending");
    expect(onSlot2 ?? []).toHaveLength(1);

    await admin.from("appointments").delete().eq("doctor_id", doctorId).eq("start_at", slot1);
    await admin.from("appointments").delete().eq("doctor_id", doctorId).eq("start_at", slot2);
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
    // Either the BEFORE trigger rejects it (P0001 — raise exception from
    // appointments_validate_slot) or the exclusion constraint does
    // (23P01); if the advisory lock serializes instead, the second write
    // never lands. The engine must never produce two overlapping active
    // bookings.
    if (!overlap.error) {
      const { count } = await admin
        .from("appointments")
        .select("id", { count: "exact", head: true })
        .eq("doctor_id", doctorId)
        .eq("start_at", startAt.toISOString())
        .in("status", ["pending", "confirmed", "checked_in", "in_progress"]);
      expect(count).toBe(1);
    } else {
      expect(["P0001", "23P01"]).toContain(overlap.error.code);
    }

    await admin.from("appointments").delete().eq("id", first.data!.id);
  });

  it("rejects a non-existent clinic (clinic_not_found)", async () => {
    const { data } = await admin.rpc("book_appointment", {
      p_clinic_id: "00000000-0000-4000-8000-000000000000",
      p_patient_id: patientId,
      p_doctor_id: doctorId,
      p_service_id: serviceId,
      p_start_at: nextWeekdayAt10(1),
      p_status: "pending",
      p_source: "admin",
      p_notes: null,
      p_created_by: null,
    });
    expect((data as { error_code: string | null }).error_code).toBe("clinic_not_found");
  });

  it("rejects a doctor from a different clinic (doctor_not_found — no cross-clinic booking via a substituted id)", async () => {
    const { data: otherClinic } = await admin
      .from("clinics")
      .insert({ name: "Foreign Booking Clinic", slug: `foreign-booking-${Date.now()}`, timezone: TZ, currency: "UZS" })
      .select("id")
      .single();
    const { data: otherDoctor } = await admin
      .from("doctors")
      .insert({ clinic_id: otherClinic!.id, name: "Dr. Foreign", active: true })
      .select("id")
      .single();

    const { data } = await admin.rpc("book_appointment", {
      p_clinic_id: CLINIC_ID,
      p_patient_id: patientId,
      p_doctor_id: otherDoctor!.id,
      p_service_id: serviceId,
      p_start_at: nextWeekdayAt10(1),
      p_status: "pending",
      p_source: "admin",
      p_notes: null,
      p_created_by: null,
    });
    expect((data as { error_code: string | null }).error_code).toBe("doctor_not_found");

    await admin.from("doctors").delete().eq("id", otherDoctor!.id);
    await admin.from("clinics").delete().eq("id", otherClinic!.id);
  });

  it("rejects a patient from a different clinic (patient_not_found)", async () => {
    const { data: otherClinic } = await admin
      .from("clinics")
      .insert({ name: "Foreign Patient Clinic", slug: `foreign-patient-${Date.now()}`, timezone: TZ, currency: "UZS" })
      .select("id")
      .single();
    const { data: otherPatient } = await admin
      .from("patients")
      .insert({ clinic_id: otherClinic!.id, full_name: "Foreign Patient", telegram_user_id: 999_555_111 })
      .select("id")
      .single();

    const { data } = await admin.rpc("book_appointment", {
      p_clinic_id: CLINIC_ID,
      p_patient_id: otherPatient!.id,
      p_doctor_id: doctorId,
      p_service_id: serviceId,
      p_start_at: nextWeekdayAt10(1),
      p_status: "pending",
      p_source: "admin",
      p_notes: null,
      p_created_by: null,
    });
    expect((data as { error_code: string | null }).error_code).toBe("patient_not_found");

    await admin.from("patients").delete().eq("id", otherPatient!.id);
    await admin.from("clinics").delete().eq("id", otherClinic!.id);
  });

  it("rejects a doctor+service combination the doctor does not offer (service_not_offered)", async () => {
    // A restricted doctor (has doctor_services rows) may only be booked for
    // a service on that explicit list — this is the exact rule
    // api/catalog/route.ts's per-doctor doctor list must also honor.
    const { data: restrictedDoctor } = await admin
      .from("doctors")
      .insert({ clinic_id: CLINIC_ID, name: "Dr. Restricted", active: true })
      .select("id")
      .single();
    const { data: otherService } = await admin
      .from("services")
      .insert({ clinic_id: CLINIC_ID, name: `Boshqa xizmat ${Date.now()}`, price: 50000, duration_minutes: 20, active: true })
      .select("id")
      .single();
    await admin.from("doctor_services").insert({ doctor_id: restrictedDoctor!.id, service_id: otherService!.id });
    for (let weekday = 1; weekday <= 5; weekday++) {
      await admin
        .from("doctor_working_hours")
        .insert({ clinic_id: CLINIC_ID, doctor_id: restrictedDoctor!.id, weekday, start_time: "09:00", end_time: "18:00" });
    }

    // Booking the SEED service (not on this doctor's list) must fail...
    const rejected = await admin.rpc("book_appointment", {
      p_clinic_id: CLINIC_ID,
      p_patient_id: patientId,
      p_doctor_id: restrictedDoctor!.id,
      p_service_id: serviceId,
      p_start_at: nextWeekdayAt10(2),
      p_status: "pending",
      p_source: "admin",
      p_notes: null,
      p_created_by: null,
    });
    expect((rejected.data as { error_code: string | null }).error_code).toBe("service_not_offered");

    // ...while the doctor's OWN listed service still books normally.
    const accepted = await admin.rpc("book_appointment", {
      p_clinic_id: CLINIC_ID,
      p_patient_id: patientId,
      p_doctor_id: restrictedDoctor!.id,
      p_service_id: otherService!.id,
      p_start_at: nextWeekdayAt10(2),
      p_status: "pending",
      p_source: "admin",
      p_notes: null,
      p_created_by: null,
    });
    const acceptedResult = accepted.data as { appointment_id: string | null; error_code: string | null };
    expect(acceptedResult.error_code).toBeNull();

    await admin.from("appointments").delete().eq("id", acceptedResult.appointment_id!);
    await admin.from("doctor_working_hours").delete().eq("doctor_id", restrictedDoctor!.id);
    await admin.from("doctor_services").delete().eq("doctor_id", restrictedDoctor!.id);
    await admin.from("services").delete().eq("id", otherService!.id);
    await admin.from("doctors").delete().eq("id", restrictedDoctor!.id);
  });

  it("rejects a slot inside a doctor time block (time_blocked)", async () => {
    const startAt = new Date(nextWeekdayAt10(5)); // Friday
    const blockEnd = new Date(startAt.getTime() + 60 * 60000).toISOString();
    const { data: block } = await admin
      .from("doctor_time_blocks")
      .insert({
        clinic_id: CLINIC_ID,
        doctor_id: doctorId,
        starts_at: startAt.toISOString(),
        ends_at: blockEnd,
        reason: "break",
      })
      .select("id")
      .single();

    const { data } = await admin.rpc("book_appointment", {
      p_clinic_id: CLINIC_ID,
      p_patient_id: patientId,
      p_doctor_id: doctorId,
      p_service_id: serviceId,
      p_start_at: startAt.toISOString(),
      p_status: "pending",
      p_source: "admin",
      p_notes: null,
      p_created_by: null,
    });
    expect((data as { error_code: string | null }).error_code).toBe("time_blocked");

    await admin.from("doctor_time_blocks").delete().eq("id", block!.id);
  });
});

describeDb("local Supabase security posture", () => {
  beforeAll(() => {
    buildClients();
  });

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

  it("blocks anonymous clients from executing the booking RPC", async () => {
    const { data, error } = await anon.rpc("book_appointment", {
      p_clinic_id: CLINIC_ID,
      p_patient_id: "00000000-0000-0000-0000-000000000000",
      p_doctor_id: "00000000-0000-0000-0000-000000000000",
      p_service_id: "00000000-0000-0000-0000-000000000000",
      p_start_at: new Date(Date.now() + 86400000).toISOString(),
    });
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });
});

describeDb("RPC authorization + tenant isolation", () => {
  let userClient: SupabaseClient;
  let userId: string;
  const email = `rpc-denial-${Date.now()}@test.local`;
  const password = "TestPassword123!";

  beforeAll(async () => {
    buildClients();
    const { data, error } = await anon.auth.signUp({ email, password });
    expect(error).toBeNull();
    expect(data.session).toBeTruthy();
    userId = data.user!.id;
    userClient = createClient(URL, ANON_KEY, { auth: { persistSession: false } });
    await userClient.auth.setSession(data.session!);
  });

  afterAll(async () => {
    await admin.from("processed_webhooks").delete().eq("source", RPC_GRANT_PROBE);
    if (userId) {
      await admin.auth.admin.deleteUser(userId);
    }
  });

  it("denies book_appointment to an authenticated non-staff user (no cross-clinic booking)", async () => {
    const { data, error } = await userClient.rpc("book_appointment", {
      p_clinic_id: CLINIC_ID,
      p_patient_id: "00000000-0000-0000-0000-000000000000",
      p_doctor_id: "00000000-0000-0000-0000-000000000000",
      p_service_id: "00000000-0000-0000-0000-000000000000",
      p_start_at: new Date(Date.now() + 86400000).toISOString(),
      p_status: "pending",
      p_source: "telegram_mini_app",
    });
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });

  it("denies reschedule_appointment to an authenticated non-staff user", async () => {
    const { data, error } = await userClient.rpc("reschedule_appointment", {
      p_appointment_id: "00000000-0000-0000-0000-000000000000",
      p_new_start_at: new Date(Date.now() + 2 * 86400000).toISOString(),
    });
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });

  it("blocks an authenticated non-staff user from inserting appointments (RLS)", async () => {
    const { error } = await userClient.from("appointments").insert({
      clinic_id: CLINIC_ID,
      patient_id: "00000000-0000-0000-0000-000000000000",
      doctor_id: "00000000-0000-0000-0000-000000000000",
      service_id: "00000000-0000-0000-0000-000000000000",
      start_at: new Date(Date.now() + 86400000).toISOString(),
      end_at: new Date(Date.now() + 86400000 + 3600000).toISOString(),
      status: "pending",
      source: "telegram_mini_app",
    });
    expect(error).not.toBeNull();
  });

  it("hides other clinics' patient data from an authenticated non-staff user", async () => {
    const { data, error } = await userClient.from("patients").select("id");
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("service_role can still book after the revoke (server path unaffected)", async () => {
    const [{ data: doctor }, { data: service }, { data: patient }] = await Promise.all([
      admin.from("doctors").select("id").eq("name", "Karimov Alisher").single(),
      admin.from("services").select("id").eq("name", "Terapevt qabuli").single(),
      admin.from("patients").select("id").eq("telegram_user_id", 777000).single(),
    ]);
    const startAt = nextWeekdayAt10(5); // Friday 10:00 local — within working hours
    const { data, error } = await admin.rpc("book_appointment", {
      p_clinic_id: CLINIC_ID,
      p_patient_id: patient!.id,
      p_doctor_id: doctor!.id,
      p_service_id: service!.id,
      p_start_at: startAt,
      p_status: "pending",
      p_source: "telegram_mini_app",
    });
    expect(error).toBeNull();
    expect((data as { error_code: string | null }).error_code).toBeNull();
    if (data?.appointment_id) {
      await admin.from("appointments").delete().eq("id", data.appointment_id);
    }
  });

  // Server-only job/idempotency primitives. They are SECURITY DEFINER and the
  // only callers in the codebase go through the service-role client, but
  // PostgreSQL's default PUBLIC EXECUTE plus Supabase's blanket
  // anon/authenticated grants left them callable over PostgREST with nothing
  // but the publishable anon key. That was enough for an anonymous caller to
  // read pending reminder payloads and flip them to 'in_progress' so patients
  // never got reminded, or to pre-claim Telegram update ids so genuine
  // deliveries were discarded as duplicates and the bot went silent.
  const SERVER_ONLY_RPCS: Array<[string, Record<string, unknown>]> = [
    ["claim_due_notification_jobs", { p_limit: 1 }],
    ["claim_webhook_update", { p_source: RPC_GRANT_PROBE, p_external_id: RPC_GRANT_PROBE }],
    ["finish_webhook_update", { p_source: RPC_GRANT_PROBE, p_external_id: RPC_GRANT_PROBE }],
    ["release_webhook_update", { p_source: RPC_GRANT_PROBE, p_external_id: RPC_GRANT_PROBE }],
  ];

  it.each(SERVER_ONLY_RPCS)("denies %s to an anonymous caller", async (fn, args) => {
    const { data, error } = await anon.rpc(fn, args);
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });

  it.each(SERVER_ONLY_RPCS)("denies %s to an authenticated non-staff user", async (fn, args) => {
    const { data, error } = await userClient.rpc(fn, args);
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });

  // Positive control: the same arguments succeed for service_role, so the
  // denials above are genuinely about the EXECUTE grant and not about a
  // malformed call that would "pass" the test for the wrong reason.
  it("still allows the server's own service-role client through", async () => {
    const claimed = await admin.rpc("claim_webhook_update", {
      p_source: RPC_GRANT_PROBE,
      p_external_id: RPC_GRANT_PROBE,
    });
    expect(claimed.error).toBeNull();
    expect(claimed.data).toBe(true);

    const finished = await admin.rpc("finish_webhook_update", {
      p_source: RPC_GRANT_PROBE,
      p_external_id: RPC_GRANT_PROBE,
    });
    expect(finished.error).toBeNull();

    await admin.from("processed_webhooks").delete().eq("source", RPC_GRANT_PROBE);
  });
});

describeDb("telegram voice consent flow", () => {
  const voiceUserId = 777100;

  beforeAll(() => {
    buildClients();
    vi.mocked(sendTelegramMessage).mockClear();
  });

  afterAll(async () => {
    const { data: patients } = await admin.from("patients").select("id").eq("telegram_user_id", voiceUserId);
    const patientIds = (patients ?? []).map((p) => p.id);
    if (patientIds.length > 0) {
      const { data: convs } = await admin.from("conversations").select("id").in("patient_id", patientIds);
      const convIds = (convs ?? []).map((c) => c.id);
      if (convIds.length > 0) {
        await admin.from("voice_messages").delete().in("conversation_id", convIds);
        await admin.from("messages").delete().in("conversation_id", convIds);
        await admin.from("conversations").delete().in("id", convIds);
      }
      await admin.from("patients").delete().in("id", patientIds);
    }
  });

  it("routes a voice update into metadata storage and consent — no transcription without consent", async () => {
    await handleTelegramMessage({
      clinicId: CLINIC_ID,
      chatId: voiceUserId,
      from: { id: voiceUserId, first_name: "Ovoz" },
      voice: {
        file_id: "voice-file-123",
        file_unique_id: "voice-unique-123",
        duration: 6,
        mime_type: "audio/ogg",
        file_size: 2048,
      },
      updateId: 700001,
    });

    // 1. Voice metadata was persisted first, with transcription NOT started.
    const { data: voiceRows, error } = await admin
      .from("voice_messages")
      .select("telegram_file_id, transcription_status, conversation_id")
      .eq("telegram_file_unique_id", "voice-unique-123");
    expect(error).toBeNull();
    expect(voiceRows).toHaveLength(1);
    expect(voiceRows![0].telegram_file_id).toBe("voice-file-123");
    expect(voiceRows![0].transcription_status).toBe("none");

    // 2. The patient was asked for consent (explicit consent gate).
    const consentCall = vi.mocked(sendTelegramMessage).mock.calls.find((c) =>
      String(c[0].text).includes("Ruxsat berasizmi"),
    );
    expect(consentCall).toBeTruthy();
    type InlineButton = { text: string; callback_data?: string };
    const replyMarkup = consentCall![0].replyMarkup as { inline_keyboard: InlineButton[][] } | undefined;
    const keyboard = replyMarkup?.inline_keyboard ?? [];
    const buttons = keyboard.flat();
    expect(buttons.map((b) => b.callback_data)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^voice_consent_yes:/),
        expect.stringMatching(/^voice_consent_no:/),
      ]),
    );

    // 3. Nothing was transcribed: status is still 'none' after handling.
    const { data: after } = await admin
      .from("voice_messages")
      .select("transcription_status")
      .eq("telegram_file_unique_id", "voice-unique-123")
      .single();
    expect(after!.transcription_status).toBe("none");
  });
});

describeDb("webhook idempotency atomic claim", () => {
  const source = `test-${Date.now()}`;

  beforeAll(() => {
    buildClients();
  });

  afterAll(async () => {
    await admin.from("processed_webhooks").delete().eq("source", source);
  });

  it("exactly one of ten concurrent claims wins", async () => {
    const externalId = "dup-1";
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        admin.rpc("claim_webhook_update", { p_source: source, p_external_id: externalId }),
      ),
    );
    const winners = results.filter((r) => !r.error && r.data === true);
    expect(winners).toHaveLength(1);
  });

  it("a released claim can be claimed again (failed handler → safe retry)", async () => {
    const externalId = "dup-2";
    const first = await admin.rpc("claim_webhook_update", { p_source: source, p_external_id: externalId });
    expect(first.data).toBe(true);
    await admin.rpc("release_webhook_update", { p_source: source, p_external_id: externalId });
    const second = await admin.rpc("claim_webhook_update", { p_source: source, p_external_id: externalId });
    expect(second.data).toBe(true);
    await admin.rpc("finish_webhook_update", { p_source: source, p_external_id: externalId });
  });

  it("a finished claim is never processed again", async () => {
    const externalId = "dup-3";
    await admin.rpc("claim_webhook_update", { p_source: source, p_external_id: externalId });
    await admin.rpc("finish_webhook_update", { p_source: source, p_external_id: externalId });
    const again = await admin.rpc("claim_webhook_update", { p_source: source, p_external_id: externalId });
    expect(again.data).toBe(false);
  });

  it("release only removes processing claims (finished rows stay)", async () => {
    const externalId = "dup-4";
    await admin.rpc("claim_webhook_update", { p_source: source, p_external_id: externalId });
    await admin.rpc("finish_webhook_update", { p_source: source, p_external_id: externalId });
    await admin.rpc("release_webhook_update", { p_source: source, p_external_id: externalId });
    const { data } = await admin
      .from("processed_webhooks")
      .select("status")
      .eq("source", source)
      .eq("external_id", externalId)
      .single();
    expect(data!.status).toBe("processed");
  });

  it("a recent (non-stale) processing claim is never reclaimed as a duplicate", async () => {
    // A genuinely in-flight concurrent/retried delivery must still be
    // rejected — the 5-minute reclaim window must not weaken the base
    // dedup guarantee for anything still plausibly running.
    const externalId = "dup-fresh";
    const first = await admin.rpc("claim_webhook_update", { p_source: source, p_external_id: externalId });
    expect(first.data).toBe(true);
    const second = await admin.rpc("claim_webhook_update", { p_source: source, p_external_id: externalId });
    expect(second.data).toBe(false);
    await admin.rpc("release_webhook_update", { p_source: source, p_external_id: externalId });
  });

  it("a stale processing claim (crashed/killed handler) can be reclaimed", async () => {
    // Regression test for the orphaned-claim fix: simulate a handler that
    // claimed the update and then never released or finished it (killed
    // mid-request) by backdating processed_at past the 5-minute window.
    const externalId = "dup-stale";
    const first = await admin.rpc("claim_webhook_update", { p_source: source, p_external_id: externalId });
    expect(first.data).toBe(true);
    await admin
      .from("processed_webhooks")
      .update({ processed_at: new Date(Date.now() - 6 * 60_000).toISOString() })
      .eq("source", source)
      .eq("external_id", externalId);

    const reclaimed = await admin.rpc("claim_webhook_update", { p_source: source, p_external_id: externalId });
    expect(reclaimed.data).toBe(true);
    await admin.rpc("finish_webhook_update", { p_source: source, p_external_id: externalId });
  });
});
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
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
const URL = process.env.SUPABASE_URL ?? "";

const CLINIC_ID = "11111111-1111-4111-8111-111111111111";
const TZ = "Asia/Tashkent"; // UTC+5

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
});
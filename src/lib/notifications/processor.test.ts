import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";

vi.mock("@/lib/telegram/bot", () => ({
  sendTelegramMessage: vi.fn(async () => 12345),
  getTelegramFileUrl: vi.fn(async () => null),
  telegramConfigured: vi.fn(() => true),
}));

import { sendTelegramMessage } from "@/lib/telegram/bot";
import { processDueNotificationJobs } from "@/lib/notifications/processor";

/**
 * DB-gated tests for the notification claim RPC and the processor.
 * Prove that concurrent workers never send the same job twice.
 */

const URL = process.env.SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const CLINIC_ID = "11111111-1111-4111-8111-111111111111";

let admin: SupabaseClient;

const describeDb = describe.skipIf(!localDbAvailable());

describeDb("notification processor — atomic claims", () => {
  let appointmentId: string;
  let doctorId: string;
  let serviceId: string;
  let patientId: string;
  const createdJobKeys: string[] = [];

  async function insertJob(key: string, opts: { maxAttempts?: number; status?: string } = {}) {
    createdJobKeys.push(key);
    const { data, error } = await admin.from("notification_jobs").insert({
      clinic_id: CLINIC_ID,
      appointment_id: appointmentId,
      type: "booking_confirmation",
      channel: "telegram",
      recipient_type: "patient",
      patient_telegram_user_id: 777000,
      scheduled_for: new Date(Date.now() - 1000).toISOString(),
      status: opts.status ?? "pending",
      max_attempts: opts.maxAttempts ?? 3,
      idempotency_key: key,
    }).select("id").single();
    expect(error).toBeNull();
    return data!.id;
  }

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    const [{ data: doctor }, { data: service }, { data: patient }] = await Promise.all([
      admin.from("doctors").select("id").eq("name", "Karimov Alisher").single(),
      admin.from("services").select("id").eq("name", "Terapevt qabuli").single(),
      admin.from("patients").select("id").eq("telegram_user_id", 777000).single(),
    ]);
    doctorId = doctor!.id;
    serviceId = service!.id;
    patientId = patient!.id;

    // A far-future Monday 10:00 Tashkent so direct insert never collides
    // with the booking-engine suite's slots.
    const start = new Date(Date.now() + 30 * 86400000);
    const mondayOffset = (8 - start.getUTCDay()) % 7;
    start.setUTCDate(start.getUTCDate() + mondayOffset);
    start.setUTCHours(5, 0, 0, 0); // 10:00 Tashkent
    const endAt = new Date(start.getTime() + 20 * 60000).toISOString();

    const { data: appt, error: apptError } = await admin.from("appointments").insert({
      clinic_id: CLINIC_ID,
      patient_id: patientId,
      doctor_id: doctorId,
      service_id: serviceId,
      start_at: start.toISOString(),
      end_at: endAt,
      status: "pending",
      source: "telegram_mini_app",
    }).select("id").single();
    expect(apptError).toBeNull();
    appointmentId = appt!.id;

    const { error: payError } = await admin.from("payments").insert({
      clinic_id: CLINIC_ID,
      appointment_id: appointmentId,
      patient_id: patientId,
      amount: 150000,
      currency: "UZS",
    });
    expect(payError).toBeNull();
  });

  afterAll(async () => {
    await admin.from("notification_jobs").delete().in("idempotency_key", createdJobKeys);
    await admin.from("payments").delete().eq("appointment_id", appointmentId);
    await admin.from("appointments").delete().eq("id", appointmentId);
  });

  it("concurrent claim calls return disjoint job sets (FOR UPDATE SKIP LOCKED)", async () => {
    const keys = Array.from({ length: 5 }, (_, i) => `claim-conc-${Date.now()}-${i}`);
    for (const key of keys) await insertJob(key);

    const [a, b] = await Promise.all([
      admin.rpc("claim_due_notification_jobs", { p_limit: 5 }),
      admin.rpc("claim_due_notification_jobs", { p_limit: 5 }),
    ]);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    const idsA = new Set((a.data ?? []).map((j: { id: string }) => j.id));
    const idsB = (b.data ?? []).map((j: { id: string }) => j.id);
    const overlap = idsB.filter((id: string) => idsA.has(id));
    expect(overlap).toHaveLength(0);
    expect(idsA.size + idsB.length).toBe(5);

    // Nothing was left pending.
    const { count } = await admin
      .from("notification_jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
      .in("idempotency_key", keys);
    expect(count).toBe(0);
  });

  it("two concurrent workers send exactly one Telegram message per job", async () => {
    const sendMock = vi.mocked(sendTelegramMessage);
    sendMock.mockClear();
    const key = `send-once-${Date.now()}`;
    const jobId = await insertJob(key);

    const [r1, r2] = await Promise.all([
      processDueNotificationJobs(50),
      processDueNotificationJobs(50),
    ]);

    expect(r1.processed + r2.processed).toBe(1);
    expect(sendMock).toHaveBeenCalledTimes(1);

    const { data: job } = await admin
      .from("notification_jobs")
      .select("status, attempts, telegram_message_id")
      .eq("id", jobId)
      .single();
    expect(job!.status).toBe("sent");
    expect(job!.telegram_message_id).toBe(12345);
  });

  it("a failed send stays pending until max attempts, then fails", async () => {
    const sendMock = vi.mocked(sendTelegramMessage);
    const key = `retry-${Date.now()}`;
    const jobId = await insertJob(key, { maxAttempts: 1 });

    sendMock.mockResolvedValueOnce(null);
    const first = await processDueNotificationJobs(50);
    expect(first.processed).toBe(1);
    expect(first.sent).toBe(0);
    const { data: afterFirst } = await admin
      .from("notification_jobs")
      .select("status, attempts")
      .eq("id", jobId)
      .single();
    expect(afterFirst!.status).toBe("failed");
    expect(afterFirst!.attempts).toBe(1);
    sendMock.mockResolvedValue(12345);
  });

  it("an in_progress job is not claimed by another worker", async () => {
    const key = `in-progress-${Date.now()}`;
    const jobId = await insertJob(key);
    await admin.from("notification_jobs").update({ status: "in_progress" }).eq("id", jobId);

    const { data } = await admin.rpc("claim_due_notification_jobs", { p_limit: 50 });
    const claimedIds = (data ?? []).map((j: { id: string }) => j.id);
    expect(claimedIds).not.toContain(jobId);
  });
});
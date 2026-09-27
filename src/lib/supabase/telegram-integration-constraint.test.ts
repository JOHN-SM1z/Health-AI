import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";

/**
 * Integration tests for the clinic_telegram_integrations CHECK constraint.
 *
 * The trigger `clinic_telegram_integrations_check_token` prevents enabling
 * a Telegram integration without a bot token. These tests verify all four
 * INSERT / UPDATE permutations against the LOCAL Supabase stack.
 *
 * Requires: `supabase db reset` and a `.env` with the real local keys.
 */

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const URL = process.env.SUPABASE_URL ?? "";

const describeDb = describe.skipIf(!localDbAvailable());

let admin: SupabaseClient;
/**
 * A throwaway clinic, never the shared seed clinic: these tests delete and
 * rewrite the clinic's single integration row (clinic_id is its primary key).
 */
let clinicId: string;

describeDb("clinic_telegram_integrations CHECK constraint", () => {
  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    const suffix = Date.now().toString(36);
    const { data: clinic, error } = await admin
      .from("clinics")
      .insert({ name: `Integration Constraint Clinic ${suffix}`, slug: `integration-constraint-${suffix}`, timezone: "Asia/Tashkent", currency: "UZS" })
      .select("id")
      .single();
    expect(error).toBeNull();
    clinicId = clinic!.id;
  });

  afterAll(async () => {
    // Cascades to the clinic's clinic_telegram_integrations row.
    if (clinicId) await admin.from("clinics").delete().eq("id", clinicId);
  });

  it("allows INSERT with enabled=false and no token", async () => {
    const { data, error } = await admin
      .from("clinic_telegram_integrations")
      .insert({
        clinic_id: clinicId,
        enabled: false,
      })
      .select("clinic_id, enabled")
      .single();

    expect(error).toBeNull();
    expect(data).toBeTruthy();
    expect(data!.enabled).toBe(false);
  });

  it("rejects INSERT with enabled=true and no token", async () => {
    // Clean up the row from the previous test first.
    await admin
      .from("clinic_telegram_integrations")
      .delete()
      .eq("clinic_id", clinicId);

    const { error } = await admin
      .from("clinic_telegram_integrations")
      .insert({
        clinic_id: clinicId,
        enabled: true,
      });

    expect(error).not.toBeNull();
    expect(error!.message).toContain(
      "Cannot enable Telegram integration without a bot token",
    );
  });

  it("allows INSERT with enabled=true and a token", async () => {
    // Clean up the row from the previous test first.
    await admin
      .from("clinic_telegram_integrations")
      .delete()
      .eq("clinic_id", clinicId);

    const { data, error } = await admin
      .from("clinic_telegram_integrations")
      .insert({
        clinic_id: clinicId,
        telegram_bot_token: "fake-token-123",
        enabled: true,
      })
      .select("clinic_id, enabled, telegram_bot_token")
      .single();

    expect(error).toBeNull();
    expect(data).toBeTruthy();
    expect(data!.enabled).toBe(true);
    expect(data!.telegram_bot_token).toBe("fake-token-123");
  });

  it("rejects UPDATE that removes token while enabled=true", async () => {
    // Row from previous test should already exist with token + enabled=true.
    // Verify, then try to remove the token while keeping enabled=true.
    const { error } = await admin
      .from("clinic_telegram_integrations")
      .update({ telegram_bot_token: null })
      .eq("clinic_id", clinicId);

    expect(error).not.toBeNull();
    expect(error!.message).toContain(
      "Cannot enable Telegram integration without a bot token",
    );
  });

  it("allows UPDATE that sets enabled=false and removes token", async () => {
    const { data, error } = await admin
      .from("clinic_telegram_integrations")
      .update({
        enabled: false,
        telegram_bot_token: null,
      })
      .eq("clinic_id", clinicId)
      .select("clinic_id, enabled, telegram_bot_token")
      .single();

    expect(error).toBeNull();
    expect(data!.enabled).toBe(false);
    expect(data!.telegram_bot_token).toBeNull();
  });

  it("allows UPDATE that adds token and enables simultaneously", async () => {
    const { data, error } = await admin
      .from("clinic_telegram_integrations")
      .update({
        telegram_bot_token: "new-token-789",
        enabled: true,
      })
      .eq("clinic_id", clinicId)
      .select("clinic_id, enabled, telegram_bot_token")
      .single();

    expect(error).toBeNull();
    expect(data!.enabled).toBe(true);
    expect(data!.telegram_bot_token).toBe("new-token-789");
  });

  it("rejects UPDATE that enables without a token after prior disable", async () => {
    // Disable and remove token first.
    await admin
      .from("clinic_telegram_integrations")
      .update({ enabled: false, telegram_bot_token: null })
      .eq("clinic_id", clinicId);

    // Now try to enable without adding a token.
    const { error } = await admin
      .from("clinic_telegram_integrations")
      .update({ enabled: true })
      .eq("clinic_id", clinicId);

    expect(error).not.toBeNull();
    expect(error!.message).toContain(
      "Cannot enable Telegram integration without a bot token",
    );
  });
});

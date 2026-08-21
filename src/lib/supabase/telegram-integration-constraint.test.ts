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

const CLINIC_ID = "11111111-1111-4111-8111-111111111111";

let admin: SupabaseClient;

describeDb("clinic_telegram_integrations CHECK constraint", () => {
  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    // Clean slate: remove any leftover row for this clinic.
    await admin
      .from("clinic_telegram_integrations")
      .delete()
      .eq("clinic_id", CLINIC_ID);
  });

  afterAll(async () => {
    // Clean up any rows we inserted.
    await admin
      .from("clinic_telegram_integrations")
      .delete()
      .eq("clinic_id", CLINIC_ID);
  });

  it("allows INSERT with enabled=false and no token", async () => {
    const { data, error } = await admin
      .from("clinic_telegram_integrations")
      .insert({
        clinic_id: CLINIC_ID,
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
      .eq("clinic_id", CLINIC_ID);

    const { error } = await admin
      .from("clinic_telegram_integrations")
      .insert({
        clinic_id: CLINIC_ID,
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
      .eq("clinic_id", CLINIC_ID);

    const { data, error } = await admin
      .from("clinic_telegram_integrations")
      .insert({
        clinic_id: CLINIC_ID,
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
      .eq("clinic_id", CLINIC_ID);

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
      .eq("clinic_id", CLINIC_ID)
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
      .eq("clinic_id", CLINIC_ID)
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
      .eq("clinic_id", CLINIC_ID);

    // Now try to enable without adding a token.
    const { error } = await admin
      .from("clinic_telegram_integrations")
      .update({ enabled: true })
      .eq("clinic_id", CLINIC_ID);

    expect(error).not.toBeNull();
    expect(error!.message).toContain(
      "Cannot enable Telegram integration without a bot token",
    );
  });
});

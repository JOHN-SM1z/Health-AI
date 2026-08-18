import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHmac } from "node:crypto";
import { localDbAvailable } from "@/test/local-db";
import { resolveClinicByBotUsername, getClinicBotToken, botWebhookSecret } from "@/lib/telegram/bots";
import { validateTelegramInitDataForClinic } from "@/lib/telegram/init-data";
import { getOrCreatePatient } from "@/lib/patients/identity";

/**
 * Per-clinic Telegram bot routing (Phase 3) against the LOCAL Supabase stack.
 *
 * Contract:
 *   Clinic A -> Bot A (webhook ?bot=bot_a resolves clinic A)
 *   Clinic B -> Bot B (webhook ?bot=bot_b resolves clinic B)
 *   Disabled bots resolve to nothing — Telegram gets 401, no dispatch.
 *   A patient talking to Bot A lands in Clinic A only; Bot B -> Clinic B only.
 *   Mini App initData is accepted ONLY by the clinic whose bot signed it
 *   (red-team: a tampered ?clinic= parameter cannot move a patient between
 *   tenants).
 *
 * Requires: `npm run db:reset-local` (migrations + seed) and a `.env` with
 * the real local keys. Skips cleanly when the stack is unavailable.
 */

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const URL = process.env.SUPABASE_URL ?? "";

const describeDb = describe.skipIf(!localDbAvailable());

const BOT_A_TOKEN = "111:CLINIC_A_BOT_SECRET_TOKEN";
const BOT_B_TOKEN = "222:CLINIC_B_BOT_SECRET_TOKEN";

describeDb("per-clinic telegram bots (Phase 3)", () => {
  let admin: SupabaseClient;
  let clinicA: string;
  let clinicB: string;
  let clinicWithoutBot: string;
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

    clinicA = await makeClinic("Bot Clinic A");
    clinicB = await makeClinic("Bot Clinic B");
    clinicWithoutBot = await makeClinic("No Bot Clinic");

    await admin.from("clinic_telegram_integrations").insert({
      clinic_id: clinicA,
      telegram_bot_token: BOT_A_TOKEN,
      telegram_bot_id: 111,
      telegram_username: `bot_a_${suffix}`,
      telegram_bot_name: "Bot A",
      status: "active",
      enabled: true,
      validated_at: new Date().toISOString(),
    });
    await admin.from("clinic_telegram_integrations").insert({
      clinic_id: clinicB,
      telegram_bot_token: BOT_B_TOKEN,
      telegram_bot_id: 222,
      telegram_username: `bot_b_${suffix}`,
      telegram_bot_name: "Bot B",
      status: "active",
      enabled: true,
      validated_at: new Date().toISOString(),
    });
  });

  afterAll(async () => {
    if (admin) {
      for (const id of [clinicA, clinicB, clinicWithoutBot]) {
        if (!id) continue;
        try {
          await admin.from("clinics").delete().eq("id", id);
        } catch {
          // cleanup best effort
        }
      }
    }
  });

  it("resolves Clinic A from Bot A and Clinic B from Bot B", async () => {
    const a = await resolveClinicByBotUsername(`bot_a_${suffix}`);
    expect(a?.clinicId).toBe(clinicA);
    expect(a?.integration.telegram_bot_token).toBe(BOT_A_TOKEN);

    const b = await resolveClinicByBotUsername(`bot_b_${suffix}`);
    expect(b?.clinicId).toBe(clinicB);
    expect(b?.integration.telegram_bot_token).toBe(BOT_B_TOKEN);
  });

  it("returns null for unknown bots and for clinics without any bot", async () => {
    expect(await resolveClinicByBotUsername("definitely_not_a_bot")).toBeNull();
    expect(await getClinicBotToken(clinicWithoutBot)).toBeNull();
  });

  it("per-bot webhook secrets differ (routing + auth are bot-specific)", () => {
    expect(botWebhookSecret(BOT_A_TOKEN)).not.toBe(botWebhookSecret(BOT_B_TOKEN));
    expect(botWebhookSecret(BOT_A_TOKEN)).toBe(botWebhookSecret(BOT_A_TOKEN));
  });

  it("a patient writing to Bot A exists ONLY in Clinic A; Bot B patient only in Clinic B", async () => {
    const user = { id: 888_111, first_name: "Same User", username: "same_user" };

    const patientA = await getOrCreatePatient({ clinicId: clinicA, user });
    const patientB = await getOrCreatePatient({ clinicId: clinicB, user });

    const { data: rows } = await admin
      .from("patients")
      .select("clinic_id")
      .eq("telegram_user_id", 888_111)
      .in("clinic_id", [clinicA, clinicB]);
    const clinicIds = (rows ?? []).map((r) => r.clinic_id);

    // Same Telegram identity exists exactly once per clinic — the bot's
    // clinic scopes the patient row. No cross-tenant row was created.
    expect(clinicIds).toHaveLength(2);
    expect(clinicIds).toContain(clinicA);
    expect(clinicIds).toContain(clinicB);
    expect(patientA.clinic_id).toBe(clinicA);
    expect(patientB.clinic_id).toBe(clinicB);
  });

  it("Mini App initData validates ONLY for the clinic whose bot signed it (no cross-tenant)", async () => {
    // Build a legitimate initData payload signed with BOT_B_TOKEN — exactly
    // what Telegram would produce for Bot B's web_app button.
    const user = JSON.stringify({ id: 888_222, first_name: "Mini", username: "mini_user" });
    const authDate = Math.floor(Date.now() / 1000);
    const fields = new Map([
      ["auth_date", String(authDate)],
      ["query_id", "AAHdF6IQAAAAAN0XohDhrOrc"],
      ["user", user],
    ]);
    const checkString = [...fields.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join("\n");
    const secretKey = createHmac("sha256", "WebAppData").update(BOT_B_TOKEN).digest();
    const hash = createHmac("sha256", secretKey).update(checkString).digest("hex");

    const initData = `auth_date=${authDate}&query_id=${encodeURIComponent(fields.get("query_id")!)}&user=${encodeURIComponent(user)}&hash=${hash}`;

    // Legitimate: Clinic B's bot signed it, so Clinic B accepts the patient.
    const verifiedB = await validateTelegramInitDataForClinic(initData, clinicB);
    expect(verifiedB?.user.id).toBe(888_222);

    // Red-team: a patient swaps ?clinic= to Clinic A (or a clinic without a
    // bot) — the signature must NOT validate, so no patient row or booking
    // can be created in the foreign clinic.
    expect(await validateTelegramInitDataForClinic(initData, clinicA)).toBeNull();
    expect(await validateTelegramInitDataForClinic(initData, clinicWithoutBot)).toBeNull();
  });

  it("AI knowledge for a clinic never contains another clinic's doctors or prices", async () => {
    const { loadClinicKnowledge, buildReceptionistSystemPrompt } = await import("@/lib/ai/knowledge");

    const insertCatalog = async (clinicId: string, doctorName: string, serviceName: string, price: number) => {
      const { data: spec } = await admin
        .from("specialties")
        .insert({ clinic_id: clinicId, name: `Spec ${suffix} ${doctorName}`, active: true, sort_order: 1 })
        .select("id")
        .single();
      const { data: doc } = await admin
        .from("doctors")
        .insert({ clinic_id: clinicId, name: doctorName, active: true })
        .select("id")
        .single();
      await admin.from("doctor_working_hours").insert({
        clinic_id: clinicId,
        doctor_id: doc!.id,
        weekday: 1,
        start_time: "09:00",
        end_time: "18:00",
      });
      await admin.from("services").insert({
        clinic_id: clinicId,
        name: serviceName,
        price,
        duration_minutes: 30,
        active: true,
        specialty_id: spec!.id,
        sort_order: 1,
      });
    };

    await insertCatalog(clinicA, `Dr A ${suffix}`, `Xizmat A ${suffix}`, 100_000);
    await insertCatalog(clinicB, `Dr B ${suffix}`, `Xizmat B ${suffix}`, 250_000);

    const knowledgeA = await loadClinicKnowledge(clinicA);
    const promptA = buildReceptionistSystemPrompt(knowledgeA);

    // Clinic A's prompt lists A's own doctor + price...
    expect(promptA).toContain(`Dr A ${suffix}`);
    expect(promptA).toContain("100000 UZS");
    // ...and NEVER Clinic B's doctor, service or price (no hallucination
    // vector from cross-tenant data).
    expect(promptA).not.toContain(`Dr B ${suffix}`);
    expect(promptA).not.toContain(`Xizmat B ${suffix}`);
    expect(promptA).not.toContain("250000");

    const knowledgeB = await loadClinicKnowledge(clinicB);
    expect(buildReceptionistSystemPrompt(knowledgeB)).not.toContain(`Dr A ${suffix}`);
  });
});

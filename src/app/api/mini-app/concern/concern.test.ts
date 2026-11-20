import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";

vi.mock("@/lib/telegram/bot", () => ({
  sendTelegramMessage: vi.fn(async () => 4242),
  getTelegramFileUrl: vi.fn(async () => null),
  telegramConfigured: vi.fn(() => true),
  answerCallbackQuery: vi.fn(async () => undefined),
}));

import { sendTelegramMessage } from "@/lib/telegram/bot";
import { POST as concern } from "./route";
import { POST as voice } from "./voice/route";

/**
 * The Mini App concern step (Slice B), real database and routes: the patient's words suggest one of the clinic's own
 * bookable directions (never a disease); urgent wording is escalated to staff exactly as in the chat and no booking is
 * offered; voice is refused unless an allowed local speech service is configured.
 */

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const describeDb = describe.skipIf(!localDbAvailable());

type Body = { ok: boolean; data?: Record<string, unknown>; code?: string };
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Body });

function signInitData(botToken: string, telegramUserId: number) {
  const user = JSON.stringify({ id: telegramUserId, first_name: "Bemor" });
  const fields: Array<[string, string]> = [["auth_date", String(Math.floor(Date.now() / 1000))], ["query_id", "AAHdF6IQAAAAAN0XohDhrOrc"], ["user", user]];
  const check = fields.map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  return `${fields.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}&hash=${createHmac("sha256", secret).update(check).digest("hex")}`;
}

describeDb("Mini App concern — suggest a direction, escalate urgent wording", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const seed = Math.floor(Math.random() * 1_000_000);
  const clinic = randomUUID();
  const BOT = `${500000 + (seed % 1000)}:CN${suffix}bot${"c".repeat(24)}`;
  const spec = { cardio: randomUUID(), general: randomUUID(), dental: randomUUID() };
  const service = { cardio: randomUUID(), general: randomUUID() };
  const doctor = randomUUID();
  let tg = 920_000_000 + seed * 10;

  const post = (text: string, user = tg) =>
    concern(
      new NextRequest(`http://localhost/api/mini-app/concern?clinic=${clinic}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `10.7.${seed % 250}.${user % 250}` },
        body: JSON.stringify({ initData: signInitData(BOT, user), text }),
      }),
    ).then(read);

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    await admin.from("clinics").insert({ id: clinic, name: `Concern ${suffix}`, slug: `concern-${suffix}`, timezone: "Asia/Tashkent", phone: "+998 71 200 00 00" });
    await admin.from("clinic_telegram_integrations").insert({
      clinic_id: clinic, telegram_bot_token: BOT, telegram_bot_id: 500000 + seed, telegram_username: `cn_${suffix}_bot`,
      telegram_bot_name: "Concern", status: "active", enabled: true, validated_at: new Date().toISOString(),
    });
    await admin.from("specialties").insert([
      { id: spec.cardio, clinic_id: clinic, name: "Kardiologiya" },
      { id: spec.general, clinic_id: clinic, name: "Terapevt" },
      { id: spec.dental, clinic_id: clinic, name: "Stomatologiya" }, // no services: never suggested
    ]);
    await admin.from("services").insert([
      { id: service.cardio, clinic_id: clinic, name: `Kardiolog ko‘rigi ${suffix}`, duration_minutes: 20, price: 100000, specialty_id: spec.cardio },
      { id: service.general, clinic_id: clinic, name: `Terapevt ko‘rigi ${suffix}`, duration_minutes: 20, price: 80000, specialty_id: spec.general },
    ]);
    await admin.from("doctors").insert({ id: doctor, clinic_id: clinic, name: `Dr Yurak ${suffix}`, specialty_id: spec.cardio, active: true });
  }, 60_000);

  afterAll(async () => {
    if (admin) await admin.from("clinics").delete().eq("id", clinic);
  });

  it("suggests the clinic's own bookable direction with its services and doctors, plus the general consultation", async () => {
    const r = await post("Qon bosimim ko‘tarilyapti, yuragim tez uradi");
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      urgent: false,
      matched: true,
      suggestions: [{ specialtyId: spec.cardio, name: "Kardiologiya", serviceIds: [service.cardio], doctorIds: [doctor] }],
      general: { specialtyId: spec.general, serviceIds: [service.general] },
    });
    expect(String(r.body.data!.disclaimer)).toMatch(/tashxis qo‘ymaydi/);
  });

  it("never suggests a direction the clinic cannot book, and falls back to the general consultation", async () => {
    tg++;
    const r = await post("Tishim og‘riyapti");
    expect(r.body.data).toMatchObject({ urgent: false, matched: false, suggestions: [], general: { specialtyId: spec.general } });
  });

  it("urgent wording: the approved message, staff alerted through the patient's conversation, no suggestion", async () => {
    tg++;
    vi.mocked(sendTelegramMessage).mockClear();
    const r = await post("Ko‘kragim qattiq og‘riyapti, nafas ololmayapman");
    expect(r.body.data).toMatchObject({ urgent: true, clinicPhone: "+998 71 200 00 00" });
    expect(r.body.data).not.toHaveProperty("suggestions");
    const { data: patient } = await admin.from("patients").select("id").eq("clinic_id", clinic).eq("telegram_user_id", tg).single();
    const { data: conv } = await admin.from("conversations").select("id, urgent_at, ai_enabled").eq("patient_id", patient!.id).single();
    expect(conv).toMatchObject({ ai_enabled: false });
    expect(conv!.urgent_at).not.toBeNull();
    const { data: audit } = await admin.from("audit_events").select("action, old_values, new_values").eq("entity_id", conv!.id).eq("action", "conversation_urgent");
    expect(audit).toEqual([{ action: "conversation_urgent", old_values: null, new_values: null }]);
    expect(vi.mocked(sendTelegramMessage).mock.calls.some(([m]) => m.chatId === tg)).toBe(true);
  });

  it("voice: refused without consent, and refused when no allowed local speech service is configured", async () => {
    const form = (consent: string) => {
      const f = new FormData();
      f.set("initData", signInitData(BOT, tg));
      f.set("consent", consent);
      f.set("audio", new Blob([new Uint8Array(200)], { type: "audio/webm" }), "concern.webm");
      return new NextRequest(`http://localhost/api/mini-app/concern/voice?clinic=${clinic}`, { method: "POST", body: f });
    };
    expect((await read(await voice(form("false")))).body.code).toBe("consent_required");
    expect(await read(await voice(form("true")))).toMatchObject({ status: 503, body: { code: "voice_unavailable" } });
  });
});

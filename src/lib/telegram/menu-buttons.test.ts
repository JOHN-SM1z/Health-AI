import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";

vi.mock("@/lib/telegram/bot", () => ({
  sendTelegramMessage: vi.fn(async () => 1),
  getTelegramFileUrl: vi.fn(async () => null),
  telegramConfigured: vi.fn(() => true),
}));

import { sendTelegramMessage } from "@/lib/telegram/bot";
import { handleMenuButton, handleTelegramMessage } from "@/lib/telegram/handlers";

/**
 * The bot's main menu buttons against the real database (Telegram itself
 * mocked, no AI provider): prices from the clinic's services, the doctor
 * directory for "Shifokor tanlashda yordam", and the operator handoff with
 * the phone the owner set under Sozlamalar.
 */

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const describeDb = describe.skipIf(!localDbAvailable());

describeDb("bot menu buttons (real database)", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const clinic = randomUUID();
  const spec = { cardio: randomUUID(), derma: randomUUID() };
  const tgUser = 930_000_000 + Math.floor(Math.random() * 1_000_000);
  const from = { id: tgUser, first_name: "Bemor" };
  let update = 1;

  const sent = () => vi.mocked(sendTelegramMessage).mock.calls.map((c) => (c[0] as { text: string }).text);
  const press = (button: string) => handleMenuButton({ clinicId: clinic, chatId: tgUser, from, button });

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    await admin.from("clinics").insert({ id: clinic, name: `Menu ${suffix}`, slug: `menu-${suffix}`, timezone: "Asia/Tashkent", currency: "UZS" });
    await admin.from("specialties").insert([
      { id: spec.cardio, clinic_id: clinic, name: "Kardiologiya", active: true, sort_order: 1 },
      { id: spec.derma, clinic_id: clinic, name: "Dermatologiya", active: true, sort_order: 2 },
    ]);
    await admin.from("doctors").insert([
      { clinic_id: clinic, name: "Rahimova Dilnoza", title: "Kardiolog", specialty_id: spec.cardio, active: true },
      { clinic_id: clinic, name: "Nazarova Gulnora", title: "Dermatolog", specialty_id: spec.derma, active: true },
      { clinic_id: clinic, name: "Ishdan ketgan", title: "Kardiolog", specialty_id: spec.cardio, active: false },
    ]);
    await admin.from("services").insert([
      { clinic_id: clinic, name: "Kardiolog qabuli", price: 250000, duration_minutes: 30, active: true, sort_order: 1 },
      // Not "Terapevt qabuli": other suites look the seed clinic's service up by that name.
      { clinic_id: clinic, name: "Nevrolog qabuli", price: 150000, duration_minutes: 20, active: true, sort_order: 2 },
      { clinic_id: clinic, name: "Eski xizmat", price: 1000, duration_minutes: 10, active: false, sort_order: 3 },
    ]);
    // The owner's contact details, as saved under Sozlamalar.
    await admin.from("app_settings").insert([
      { clinic_id: clinic, key: "phone", value: { text: "+998 90 414 02 19" } },
      { clinic_id: clinic, key: "address", value: { text: "Toshkent sh., Chilonzor 1" } },
    ]);
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin.from("clinics").delete().eq("id", clinic);
  });

  beforeEach(() => vi.mocked(sendTelegramMessage).mockClear());

  it("💰 Narxlar lists the clinic's active services with their prices", async () => {
    await press("💰 Narxlar");
    const text = sent()[0];
    expect(text).toContain("Kardiolog qabuli — 250");
    expect(text).toContain("Nevrolog qabuli — 150");
    expect(text).toContain("UZS, 30 daq.");
    expect(text).not.toContain("Eski xizmat");
  });

  it("🤖 Shifokor tanlashda yordam asks, then lists each direction with its doctors (no diagnosis, no AI needed)", async () => {
    await press("🤖 Shifokor tanlashda yordam");
    expect(sent()[0]).toContain("muammoingizni bir-ikki gapda yozing");
    vi.mocked(sendTelegramMessage).mockClear();
    await handleTelegramMessage({ clinicId: clinic, chatId: tgUser, from, text: "teri toshmasi bor", updateId: update++ });
    const reply = sent()[0];
    expect(reply).toContain("• Kardiologiya — Rahimova Dilnoza (Kardiolog)");
    expect(reply).toContain("• Dermatologiya — Nazarova Gulnora (Dermatolog)");
    expect(reply).not.toContain("Ishdan ketgan");
    expect(reply).toContain("tashxis");
  });

  it("👤 Operator bilan bog‘lanish pauses the bot and gives the phone set under Sozlamalar; 📍 Manzil uses the same details", async () => {
    await press("👤 Operator bilan bog‘lanish");
    expect(sent()[0]).toContain("Operatorlarimiz siz bilan shu yerda bog‘lanadi");
    expect(sent()[0]).toContain("☎️ Tezroq bog‘lanish uchun qo‘ng‘iroq qiling: +998 90 414 02 19");
    const { data: conv } = await admin.from("conversations").select("ai_enabled").eq("clinic_id", clinic).single();
    expect(conv?.ai_enabled).toBe(false);

    await press("🚪 Suhbatni yakunlash");
    vi.mocked(sendTelegramMessage).mockClear();
    await press("📍 Manzil");
    expect(sent()[0]).toContain("📍 Manzil: Toshkent sh., Chilonzor 1");
    expect(sent()[0]).toContain("☎️ Telefon: +998 90 414 02 19");
  });
});

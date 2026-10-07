import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";

// The app URL is read once, when the env module loads.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_APP_URL = "https://health.example.com";
});

vi.mock("@/lib/telegram/bot", () => ({
  sendTelegramMessage: vi.fn(async () => 1),
  getTelegramFileUrl: vi.fn(async () => null),
  telegramConfigured: vi.fn(() => true),
}));

import { sendTelegramMessage } from "@/lib/telegram/bot";
import { POST as myAppointments } from "./appointments/route";
import { listUpcomingAppointments, upcomingAppointmentsText } from "@/lib/appointments/patient-upcoming";
import { handleMenuButton } from "@/lib/telegram/handlers";

/**
 * "Mening qabullarim" (real database, signed initData): the patient's
 * upcoming visits are found again on every visit — in the Mini App and in
 * the bot chat — soonest first, with the status the clinic set a moment ago,
 * and never anyone else's.
 */

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const describeDb = describe.skipIf(!localDbAvailable());

type Body = { ok: boolean; data?: Record<string, unknown>; code?: string };
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Body });

function signInitData(botToken: string, telegramUserId: number) {
  const user = JSON.stringify({ id: telegramUserId, first_name: "Bemor" });
  const fields: Array<[string, string]> = [["auth_date", String(Math.floor(Date.now() / 1000))], ["user", user]];
  const check = fields.map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return `${fields.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}&hash=${hash}`;
}

describeDb("Mening qabullarim (real database)", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const seed = Math.floor(Math.random() * 1_000_000);
  const clinic = randomUUID();
  const doctor = randomUUID();
  const service = randomUUID();
  const BOT = `${600000 + (seed % 1000)}:MY${suffix}bot${"z".repeat(24)}`;
  const tg = { me: 910_000_000 + seed, other: 920_000_000 + seed };
  const ids = { me: "", other: "", soon: "", later: "", atClinic: "", cancelled: "", done: "", stale: "", others: "" };

  const call = async (initData: string | null, clinicId: string | null = clinic) => {
    const url = `http://localhost/api/me/appointments${clinicId ? `?clinic=${clinicId}` : ""}`;
    const req = new NextRequest(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `10.8.${seed % 250}.${Math.floor(Math.random() * 250)}` },
      body: JSON.stringify(initData === null ? {} : { initData }),
    });
    return read(await myAppointments(req));
  };
  const at = (hoursFromNow: number) => new Date(Date.now() + hoursFromNow * 3_600_000);
  const book = async (patient: string, startH: number, status: string) => {
    const start = at(startH);
    const { data, error } = await admin
      .from("appointments")
      .insert({ clinic_id: clinic, patient_id: patient, doctor_id: doctor, service_id: service, start_at: start.toISOString(), end_at: new Date(start.getTime() + 1_800_000).toISOString(), status, source: "telegram_mini_app" })
      .select("id")
      .single();
    if (error) throw new Error(`${status} @${startH}h: ${error.message}`);
    return data!.id as string;
  };

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    await admin.from("clinics").insert({ id: clinic, name: `Mine ${suffix}`, slug: `mine-${suffix}`, timezone: "Asia/Tashkent" });
    await admin.from("clinic_telegram_integrations").insert({ clinic_id: clinic, telegram_bot_token: BOT, telegram_bot_id: 600000 + seed, telegram_username: `mine_${suffix}_bot`, telegram_bot_name: "Mine", status: "active", enabled: true, validated_at: new Date().toISOString() });
    await admin.from("doctors").insert({ id: doctor, clinic_id: clinic, name: `Dr Mine ${suffix}`, active: true });
    await admin.from("services").insert({ id: service, clinic_id: clinic, name: `Konsultatsiya ${suffix}`, duration_minutes: 30, price: 100000 });
    await admin.from("doctor_working_hours").insert([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinic, doctor_id: doctor, weekday, start_time: "00:00", end_time: "23:59" })));
    const { data: pts } = await admin
      .from("patients")
      .insert([
        { clinic_id: clinic, full_name: `Men ${suffix}`, telegram_user_id: tg.me },
        { clinic_id: clinic, full_name: `Boshqa ${suffix}`, telegram_user_id: tg.other },
      ])
      .select("id, telegram_user_id");
    ids.me = pts!.find((p) => Number(p.telegram_user_id) === tg.me)!.id;
    ids.other = pts!.find((p) => Number(p.telegram_user_id) === tg.other)!.id;

    // Past visits first (the booking engine refuses overlapping active slots).
    ids.done = await book(ids.me, -72, "completed");
    ids.stale = await book(ids.me, -48, "pending"); // a pending visit long past: shown as past
    ids.atClinic = await book(ids.me, -0.25, "checked_in"); // started 15 min ago, patient at the clinic
    ids.later = await book(ids.me, 72, "confirmed");
    ids.soon = await book(ids.me, 24, "pending");
    ids.cancelled = await book(ids.me, 48, "cancelled");
    ids.others = await book(ids.other, 30, "confirmed");
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin.from("clinics").delete().eq("id", clinic);
  });

  it("the Mini App finds the patient's visits again on every visit, with the clinic's time zone — never another patient's", async () => {
    const res = await call(signInitData(BOT, tg.me));
    expect(res.status).toBe(200);
    const list = res.body.data!.appointments as Array<{ id: string }>;
    expect(list.map((a) => a.id).sort()).toEqual([ids.done, ids.stale, ids.atClinic, ids.later, ids.soon, ids.cancelled].sort());
    expect(res.body.data!.clinic).toEqual({ name: `Mine ${suffix}`, timezone: "Asia/Tashkent" });

    // A fresh launch (new initData, same Telegram user) sees the same list.
    const again = await call(signInitData(BOT, tg.me));
    expect((again.body.data!.appointments as unknown[]).length).toBe(6);
    // Without ?clinic= the server still resolves the clinic and the patient is verified against its bot.
    expect((await call(null)).status).toBe(401);
  });

  it("a status set by the clinic shows on the next refresh", async () => {
    await admin.from("appointments").update({ status: "in_progress" }).eq("id", ids.atClinic);
    const list = (await call(signInitData(BOT, tg.me))).body.data!.appointments as Array<{ id: string; status: string }>;
    expect(list.find((a) => a.id === ids.atClinic)?.status).toBe("in_progress");
  });

  it("upcoming visits: the one in progress, then the soonest — never cancelled, finished or stale ones", async () => {
    const upcoming = await listUpcomingAppointments(clinic, ids.me);
    expect(upcoming.map((a) => a.id)).toEqual([ids.atClinic, ids.soon, ids.later]);
    expect(upcoming[1]).toMatchObject({ status: "pending", doctorName: `Dr Mine ${suffix}`, serviceName: `Konsultatsiya ${suffix}` });
    expect(await listUpcomingAppointments(clinic, ids.other)).toEqual([expect.objectContaining({ id: ids.others })]);
  });

  it("the bot's “📋 Mening qabullarim” lists them in the chat and opens the page with the clinic", async () => {
    vi.mocked(sendTelegramMessage).mockClear();
    await handleMenuButton({ clinicId: clinic, chatId: tg.me, from: { id: tg.me, first_name: "Men" }, button: "📋 Mening qabullarim" });
    const payload = vi.mocked(sendTelegramMessage).mock.calls[0][0] as { text: string; replyMarkup?: { inline_keyboard?: Array<Array<{ web_app?: { url: string }; url?: string }>> } };
    expect(payload.text).toContain("📋 Mening qabullarim");
    expect(payload.text).toContain("Holati: Qabulda");
    expect(payload.text).toContain("Holati: Tasdiq kutilmoqda");
    expect(payload.text).not.toContain("Bekor qilingan");
    expect(payload.text.indexOf("Qabulda")).toBeLessThan(payload.text.indexOf("Tasdiq kutilmoqda"));
    const button = payload.replyMarkup?.inline_keyboard?.[0]?.[0];
    expect(button?.web_app?.url ?? button?.url).toContain(`/my-appointments?clinic=${clinic}`);
    // Nothing to show: a clear message, no stale list.
    expect(upcomingAppointmentsText([], "Asia/Tashkent")).toContain("rejalashtirilgan qabul yo‘q");
  });
});

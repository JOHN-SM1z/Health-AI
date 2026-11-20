import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { localDbAvailable } from "@/test/local-db";

vi.mock("@/lib/telegram/bot", () => ({
  sendTelegramMessage: vi.fn(async () => 1),
  getTelegramFileUrl: vi.fn(async () => null),
  telegramConfigured: vi.fn(() => true),
}));

import { sendTelegramMessage } from "@/lib/telegram/bot";
import { handleQueueFollowStart, handleQueueStatus } from "@/lib/telegram/queue-follow";
import { createVisitFollowLink, recordVisitPayment, registerLabArrival, transitionVisit } from "@/lib/operations/outpatient";
import { processDueNotificationJobs } from "@/lib/notifications/processor";

/**
 * The walk-in patient's Telegram queue, end to end against the real database
 * (Telegram itself mocked): the kassa issues the QR link, the patient opens
 * it in the clinic's bot and gets the ticket, "🔄 Navbatim" answers with the
 * live position, and calling the number delivers "you are called". Following
 * creates no patient card and reveals nothing but the queue.
 */

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const describeDb = describe.skipIf(!localDbAvailable());

describeDb("Telegram queue follow-up (real database)", () => {
  let admin: SupabaseClient;
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const clinic = randomUUID();
  const noBotClinic = randomUUID();
  const test = randomUUID();
  const people = { reception: randomUUID(), cashier: randomUUID() };
  const follower = 940_000_000 + Math.floor(Math.random() * 1_000_000);
  const stranger = follower + 1;
  const PATIENT = `Navbatchi Sardor ${suffix}`;

  const staff = (profileId: string, role: "receptionist" | "cashier", clinicId = clinic) => ({
    profileId,
    clinicId,
    clinicName: "Follow",
    clinicTimezone: "Asia/Tashkent",
    roles: [role],
    platformAdmin: false,
  });
  const sentTo = (chatId: number) =>
    vi
      .mocked(sendTelegramMessage)
      .mock.calls.filter((c) => (c[0] as { chatId: number }).chatId === chatId)
      .map((c) => c[0] as { text: string; replyMarkup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } });

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    sql = postgres(DB_URL, { max: 2, onnotice: () => {} });
    await sql`insert into public.clinics ${sql([
      { id: clinic, name: `Follow bot ${suffix}`, slug: `follow-bot-${suffix}`, timezone: "Asia/Tashkent" },
      { id: noBotClinic, name: `No bot ${suffix}`, slug: `no-bot-${suffix}`, timezone: "Asia/Tashkent" },
    ])}`;
    for (const [name, id] of Object.entries(people)) {
      const r = await admin.auth.admin.createUser({ id, email: `follow-bot-${name}-${suffix}@test.local`, email_confirm: true, password: `Pw-${randomUUID()}` });
      if (r.error) throw new Error(r.error.message);
      await admin.from("profiles").insert({ id, full_name: name });
    }
    await admin.from("staff_roles").insert([
      { clinic_id: clinic, profile_id: people.reception, role: "receptionist" },
      { clinic_id: clinic, profile_id: people.cashier, role: "cashier" },
      { clinic_id: noBotClinic, profile_id: people.cashier, role: "cashier" },
    ]);
    await admin.from("clinic_telegram_integrations").insert({
      clinic_id: clinic,
      telegram_bot_token: `${700000 + Math.floor(Math.random() * 1000)}:FOLLOW_${suffix}`,
      telegram_bot_id: 700000 + Math.floor(Math.random() * 100000),
      telegram_username: `follow_${suffix}_bot`,
      telegram_bot_name: "Follow",
      status: "active",
      enabled: true,
      validated_at: new Date().toISOString(),
    });
    await admin.from("lab_tests").insert({ id: test, clinic_id: clinic, code: `FB${suffix}`.slice(0, 30), name: "Qand", sample_type: "Qon", price: 25000 });
  }, 60_000);

  afterAll(async () => {
    if (sql) {
      await sql.begin(async (tx) => {
        await tx.unsafe("set local session_replication_role = replica");
        for (const c of [clinic, noBotClinic]) {
          await tx`delete from public.visit_followers where clinic_id = ${c}`;
          await tx`delete from public.visit_follow_tokens where clinic_id = ${c}`;
          await tx`delete from public.visit_transactions where clinic_id = ${c}`;
          await tx`delete from public.visit_charges where clinic_id = ${c}`;
          await tx`delete from public.notification_jobs where clinic_id = ${c}`;
          await tx`update public.lab_orders set visit_id = null where clinic_id = ${c}`;
          await tx`delete from public.visits where clinic_id = ${c}`;
        }
      });
      await sql.end({ timeout: 5 });
    }
    if (!admin) return;
    await admin.from("clinics").delete().in("id", [clinic, noBotClinic]);
    for (const id of Object.values(people)) await admin.auth.admin.deleteUser(id).catch(() => {});
  });

  beforeEach(() => vi.mocked(sendTelegramMessage).mockClear());

  it("QR at the kassa → ticket in the bot → live position → 'you are called'", async () => {
    const { visitId } = await registerLabArrival(staff(people.reception, "receptionist"), {
      key: randomUUID(),
      newPatient: { fullName: PATIENT, dateOfBirth: "1979-04-05" },
      testIds: [test],
      panelIds: [],
    });
    const { queueNumber } = await recordVisitPayment(staff(people.cashier, "cashier"), visitId, {
      key: randomUUID(),
      lines: [{ method: "cash", amount: 25000 }],
      expectedOutstanding: 25000,
    });

    const { url } = await createVisitFollowLink(staff(people.cashier, "cashier"), visitId);
    const link = new globalThis.URL(url);
    expect(link.origin + link.pathname).toBe(`https://t.me/follow_${suffix}_bot`);
    const token = link.searchParams.get("start")!.replace(/^v_/, "");
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);

    await handleQueueFollowStart({ clinicId: clinic, chatId: follower, telegramUserId: follower, token });
    const [ticket] = sentTo(follower);
    expect(ticket.text).toContain(`Navbat raqamingiz: ${queueNumber}`);
    expect(ticket.text).toContain("Laboratoriya");
    expect(ticket.text).toContain("aniq qabul vaqti emas");
    expect(ticket.text).not.toContain(PATIENT);
    expect(ticket.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data).toBe("queue_status");
    // Following made no patient card for this Telegram user.
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.patients where telegram_user_id = ${follower}`;
    expect(n).toBe(0);

    // Someone else with the same link gets the neutral answer only.
    await handleQueueFollowStart({ clinicId: clinic, chatId: stranger, telegramUserId: stranger, token });
    expect(sentTo(stranger).map((m) => m.text)).toEqual(["Bu havola yaroqsiz yoki muddati o‘tgan. Kassadan yangi QR kod so‘rang."]);
    await handleQueueStatus({ clinicId: clinic, chatId: stranger, telegramUserId: stranger });
    expect(sentTo(stranger)[1].text).toContain("kuzatilayotgan navbatingiz yo‘q");

    // "🔄 Navbatim".
    await handleQueueStatus({ clinicId: clinic, chatId: follower, telegramUserId: follower });
    expect(sentTo(follower)[1].text).toBe(`№ ${queueNumber} — Laboratoriya: navbatda · oldingizda 0 bemor`);

    // The desk calls the number: the follower is told at once (delivered by the worker).
    vi.mocked(sendTelegramMessage).mockClear();
    await transitionVisit(staff(people.reception, "receptionist"), visitId, { expected: "waiting", status: "called" });
    await processDueNotificationJobs(20, [clinic]);
    const [called] = sentTo(follower);
    expect(called.text).toBe(`📣 Navbatingiz keldi — № ${queueNumber}\n\n🧪 Laboratoriyaga kiring.`);
    const [job] = await sql<{ status: string }[]>`select status from public.notification_jobs where visit_id = ${visitId} and type = 'queue_called'`;
    expect(job.status).toBe("sent");
  });

  it("a clinic without a connected bot gets a clear refusal, not a dead QR", async () => {
    const [p] = await sql<{ id: string }[]>`insert into public.patients ${sql({ clinic_id: noBotClinic, full_name: `Botsiz ${suffix}`, date_of_birth: "1990-01-01" })} returning id`;
    const [v] = await sql<{ id: string }[]>`
      insert into public.visits ${sql({ clinic_id: noBotClinic, patient_id: p.id, kind: "lab", status: "awaiting_payment", created_by: people.cashier, idempotency_key: randomUUID(), request_fingerprint: "x" })} returning id`;
    await expect(createVisitFollowLink(staff(people.cashier, "cashier", noBotClinic), v.id)).rejects.toMatchObject({ status: 409, code: "bot_not_configured" });
  });
});

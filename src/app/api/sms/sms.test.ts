import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import postgres from "postgres";
import { localDbAvailable } from "@/test/local-db";

/**
 * Queue SMS for patients without Telegram, and the SMS-code card link (Slice D, 20261008000013) — real database, the
 * local test SMS outbox (nothing is sent). Mocked: Telegram sending only.
 */
process.env.SMS_PROVIDER = "test";
const CALLBACK_SECRET = `cb-${randomUUID()}-${randomUUID()}`;
process.env.ESKIZ_CALLBACK_SECRET = CALLBACK_SECRET;

vi.mock("@/lib/telegram/bot", () => ({
  sendTelegramMessage: vi.fn(async () => 4242),
  getTelegramFileUrl: vi.fn(async () => null),
  telegramConfigured: vi.fn(() => true),
  answerCallbackQuery: vi.fn(async () => undefined),
}));

import { processDueSmsJobs } from "@/lib/sms/processor";
import { testOutbox } from "@/lib/sms/test-provider";
import { POST as eskizCallback } from "./eskiz/callback/route";
import { POST as lookup } from "@/app/api/mini-app/identity/lookup/route";
import { POST as phoneStep } from "@/app/api/mini-app/identity/phone/route";
import { POST as smsSend } from "@/app/api/mini-app/identity/sms/route";
import { POST as smsVerify } from "@/app/api/mini-app/identity/sms/verify/route";

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
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

describeDb("queue SMS and the SMS-code card link (test outbox, real database)", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const seed = Math.floor(Math.random() * 1_000_000);
  const clinic = randomUUID();
  const BOT = `${300000 + (seed % 1000)}:SM${suffix}bot${"s".repeat(24)}`;
  const staffId = randomUUID();
  const doctor = randomUUID();
  const phoneKey = (n: number) => `9${n}${String(seed).padStart(7, "0").slice(-7)}`;
  let tg = 940_000_000 + seed * 10;
  const pts = { sms: "", telegram: "", noConsent: "" };

  const visit = async (patientId: string, queueNumber: number) => {
    const [v] = await sql<{ id: string }[]>`insert into public.visits ${sql({
      clinic_id: clinic, patient_id: patientId, doctor_id: doctor, kind: "doctor", status: "waiting", queue_date: new Date().toISOString().slice(0, 10),
      queue_number: queueNumber, queued_at: new Date(), created_by: staffId, idempotency_key: randomUUID(), request_fingerprint: "x",
    })} returning id`;
    return v.id;
  };
  const jobsFor = (visitId: string) => sql<{ type: string; status: string; channel: string; recipient_patient_id: string | null }[]>`
    select type, status, channel, recipient_patient_id from public.notification_jobs where visit_id = ${visitId} and channel = 'sms' order by created_at`;
  const mini = (handler: (r: NextRequest) => Promise<Response>, user: number, body: Record<string, unknown>) =>
    handler(new NextRequest(`http://localhost/api/mini-app/identity?clinic=${clinic}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `10.5.${seed % 250}.${user % 250}` },
      body: JSON.stringify({ initData: signInitData(BOT, user), ...body }),
    })).then(read);

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 8, onnotice: () => {} });
    await sql`insert into public.clinics ${sql({ id: clinic, name: `Shifo SMS ${suffix}`, slug: `sms-${suffix}`, timezone: "Asia/Tashkent", sms_enabled: true })}`;
    await sql`insert into public.clinic_telegram_integrations ${sql({ clinic_id: clinic, telegram_bot_token: BOT, telegram_bot_id: 300000 + seed, telegram_username: `sm_${suffix}_bot`, telegram_bot_name: "SMS", status: "active", enabled: true, validated_at: new Date() })}`;
    await sql`insert into auth.users ${sql({ id: staffId, email: `sms-staff-${suffix}@test.local` })}`;
    await sql`insert into public.profiles ${sql({ id: staffId, full_name: "staff" })}`;
    await sql`insert into public.staff_roles ${sql({ clinic_id: clinic, profile_id: staffId, role: "receptionist" })}`;
    await sql`insert into public.doctors ${sql({ id: doctor, clinic_id: clinic, name: `Dr Maxfiy ${suffix}`, active: true })}`;
    const [a] = await sql<{ id: string }[]>`insert into public.patients ${sql({ clinic_id: clinic, full_name: `SMS Bemor ${suffix}`, phone: `+998 ${phoneKey(0)}`, sms_consent_at: new Date() })} returning id`;
    const [b] = await sql<{ id: string }[]>`insert into public.patients ${sql({ clinic_id: clinic, full_name: `Tg Bemor ${suffix}`, phone: `+998 ${phoneKey(1)}`, sms_consent_at: new Date(), telegram_user_id: tg++ })} returning id`;
    const [c] = await sql<{ id: string }[]>`insert into public.patients ${sql({ clinic_id: clinic, full_name: `Rozisiz ${suffix}`, phone: `+998 ${phoneKey(2)}` })} returning id`;
    Object.assign(pts, { sms: a.id, telegram: b.id, noConsent: c.id });
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    await sql.begin(async (tx) => {
      await tx.unsafe("set local session_replication_role = replica");
      for (const table of ["sms_messages", "notification_jobs", "card_link_otps", "visits"]) await tx.unsafe(`delete from public.${table} where clinic_id = $1`, [clinic]);
    });
    await sql`delete from public.clinics where id = ${clinic}`;
    await sql`delete from auth.users where id = ${staffId}`;
    await sql.end({ timeout: 5 });
  });

  it("only a patient without Telegram who agreed gets the ticket by SMS — the clinic name and the number, nothing medical", async () => {
    const [va, vb, vc] = [await visit(pts.sms, 11), await visit(pts.telegram, 12), await visit(pts.noConsent, 13)];
    expect(await jobsFor(va)).toEqual([{ type: "queue_ticket", status: "pending", channel: "sms", recipient_patient_id: pts.sms }]);
    expect(await jobsFor(vb)).toEqual([]);
    expect(await jobsFor(vc)).toEqual([]);

    const before = testOutbox.length;
    // Two workers at once: the job is claimed once, so the SMS goes once.
    const results = await Promise.all([processDueSmsJobs(50, [clinic]), processDueSmsJobs(50, [clinic])]);
    expect(results.reduce((n, r) => n + r.sent, 0)).toBe(1);
    const sent = testOutbox.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0].phone).toBe(`+998${phoneKey(0)}`);
    expect(sent[0].text).toMatch(/navbat raqamingiz 11/);
    expect(sent[0].text).not.toMatch(/Dr Maxfiy|SMS Bemor/); // no doctor, no patient name
    expect(sent[0].text).toMatch(/^[\x20-\x7E]+$/); // one plain segment, no Cyrillic or curly quotes
    const [row] = await sql`select purpose, provider, status, provider_message_id is not null as has_id from public.sms_messages where job_id is not null and clinic_id = ${clinic}`;
    expect(row).toMatchObject({ purpose: "queue_ticket", provider: "test", status: "sent", has_id: true });
    const cols = await sql`select column_name from information_schema.columns where table_name = 'sms_messages'`;
    expect(cols.map((c) => c.column_name)).not.toEqual(expect.arrayContaining(["phone"]));
    expect((await jobsFor(va))[0].status).toBe("sent");
  });

  it("'you are called' goes by SMS too; a patient who linked Telegram meanwhile is skipped", async () => {
    const v = await visit(pts.sms, 21);
    await processDueSmsJobs(50, [clinic]);
    const before = testOutbox.length;
    await sql`update public.visits set status = 'called', called_at = now() where id = ${v}`;
    await processDueSmsJobs(50, [clinic]);
    expect(testOutbox.slice(before).map((m) => m.text)).toEqual([expect.stringMatching(/21-raqam, navbatingiz keldi/)]);

    const v2 = await visit(pts.sms, 22);
    await sql`update public.patients set telegram_user_id = ${tg++} where id = ${pts.sms}`;
    const r = await processDueSmsJobs(50, [clinic]);
    expect(r.skipped).toBeGreaterThanOrEqual(1);
    expect((await jobsFor(v2))[0].status).toBe("skipped");
    await sql`update public.patients set telegram_user_id = null where id = ${pts.sms}`;
  });

  it("no SMS at all while the clinic has SMS off", async () => {
    await sql`update public.clinics set sms_enabled = false where id = ${clinic}`;
    const v = await visit(pts.sms, 31);
    expect(await jobsFor(v)).toEqual([]);
    await sql`update public.clinics set sms_enabled = true where id = ${clinic}`;
  });

  it("Eskiz delivery reports need the secret and only move an existing message", async () => {
    const id = `esk-${randomUUID()}`;
    await sql`insert into public.sms_messages ${sql({ clinic_id: clinic, purpose: "queue_ticket", provider: "eskiz", provider_message_id: id })}`;
    const post = (key: string | null, body: Record<string, string>) =>
      eskizCallback(new NextRequest(`http://localhost/api/sms/eskiz/callback${key ? `?key=${encodeURIComponent(key)}` : ""}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }));
    expect((await post(null, { message_id: id, status: "DELIVRD" })).status).toBe(401);
    expect((await post("wrong".padEnd(CALLBACK_SECRET.length, "x"), { message_id: id, status: "DELIVRD" })).status).toBe(401);
    expect((await post(CALLBACK_SECRET, { message_id: id, status: "DELIVRD" })).status).toBe(200);
    const [m] = await sql`select status, delivered_at is not null as delivered from public.sms_messages where provider_message_id = ${id}`;
    expect(m).toEqual({ status: "delivered", delivered: true });
    expect((await post(CALLBACK_SECRET, { message_id: `unknown-${id}`, status: "DELIVRD" })).status).toBe(200);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from public.sms_messages where provider_message_id = ${`unknown-${id}`}`;
    expect(n).toBe(0);
  });

  it("a card whose phone differs from the patient's Telegram phone: a code to the card's phone links it; the answers reveal nothing", async () => {
    const doc = `SM${String(seed).padStart(7, "0").slice(-7)}`;
    const [card] = await sql<{ id: string }[]>`insert into public.patients ${sql({ clinic_id: clinic, full_name: `Karta Egasi ${suffix}`, document_number: doc, date_of_birth: "1979-09-19", phone: `+998 ${phoneKey(5)}` })} returning id`;
    const user = tg++;
    await sql`insert into public.telegram_verified_phones ${sql({ clinic_id: clinic, telegram_user_id: user, phone_key: phoneKey(6) })}`;
    const l = await mini(lookup, user, { document: doc, dateOfBirth: "1979-09-19" });
    const lookupId = l.body.data!.lookupId as string;
    expect((await mini(phoneStep, user, { lookupId })).body.data).toMatchObject({ next: "details" });

    const before = testOutbox.length;
    const sent = await mini(smsSend, user, { lookupId });
    expect(sent.body.data).toEqual({ sent: "if_card" });
    const codeMessage = testOutbox.slice(before).find((m) => m.phone === `+998${phoneKey(5)}`)!;
    expect(codeMessage.text).toMatch(/kartani ulash kodi \d{6}/);
    const code = /(\d{6})/.exec(codeMessage.text)![1];

    // A stranger with an unknown document gets the same answer, and nothing is sent.
    const other = tg++;
    const ol = await mini(lookup, other, { document: `ZZ${String(seed).padStart(7, "1").slice(-7)}`, dateOfBirth: "1979-09-19" });
    const otherBefore = testOutbox.length;
    expect((await mini(smsSend, other, { lookupId: ol.body.data!.lookupId })).body.data).toEqual({ sent: "if_card" });
    expect(testOutbox.length).toBe(otherBefore);

    const wrong = code === "000000" ? "111111" : "000000";
    expect((await mini(smsVerify, user, { lookupId, code: wrong })).body.code).toBe("wrong_code");
    const done = await mini(smsVerify, user, { lookupId, code });
    expect(done.body.data).toMatchObject({ next: "done", profile: { fullName: `Karta Egasi ${suffix}`, dateOfBirth: "1979-09-19" } });
    const [linked] = await sql`select telegram_user_id, telegram_link_method from public.patients where id = ${card.id}`;
    expect(linked).toEqual({ telegram_user_id: String(user), telegram_link_method: "sms_code" });
    // A used code does not work twice.
    expect((await mini(smsVerify, user, { lookupId, code })).body.code).toBe("code_expired");
  });

  it("five wrong codes end the code; it cannot be guessed", async () => {
    const doc = `SG${String(seed).padStart(7, "0").slice(-7)}`;
    await sql`insert into public.patients ${sql({ clinic_id: clinic, full_name: `Himoya ${suffix}`, document_number: doc, date_of_birth: "1981-01-11", phone: `+998 ${phoneKey(7)}` })}`;
    const user = tg++;
    await sql`insert into public.telegram_verified_phones ${sql({ clinic_id: clinic, telegram_user_id: user, phone_key: phoneKey(8) })}`;
    const lookupId = (await mini(lookup, user, { document: doc, dateOfBirth: "1981-01-11" })).body.data!.lookupId as string;
    const before = testOutbox.length;
    await mini(smsSend, user, { lookupId });
    const code = /(\d{6})/.exec(testOutbox.slice(before)[0].text)![1];
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect((await mini(smsVerify, user, { lookupId, code: wrong })).body.code).toBe("wrong_code");
    expect((await mini(smsVerify, user, { lookupId, code })).body.code).toBe("code_expired");
  });
});

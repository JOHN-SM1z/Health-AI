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
import { handleContactShared } from "@/lib/telegram/handlers";
import { POST as status } from "./status/route";
import { POST as lookup } from "./lookup/route";
import { POST as phone } from "./phone/route";
import { POST as details } from "./details/route";
import { POST as book } from "@/app/api/bookings/route";

/**
 * Online identity in the Mini App (Slice B, 20261008000010), with the real database, real routes and real Telegram
 * initData signatures (only sending Telegram messages is mocked):
 *   passport/JSHSHIR + date of birth is a lookup key, never proof — every outcome answers the same; the patient's own
 *   Telegram-verified phone links their card and its details appear; anything else continues as a new patient, and a
 *   document that is someone else's is never stored on the new record (a claim goes to staff instead).
 */

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const describeDb = describe.skipIf(!localDbAvailable());

type Body = { ok: boolean; data?: Record<string, unknown>; code?: string };
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Body });

function signInitData(botToken: string, telegramUserId: number) {
  const user = JSON.stringify({ id: telegramUserId, first_name: "Bemor", username: `u${telegramUserId}` });
  const fields: Array<[string, string]> = [
    ["auth_date", String(Math.floor(Date.now() / 1000))],
    ["query_id", "AAHdF6IQAAAAAN0XohDhrOrc"],
    ["user", user],
  ];
  const check = fields.map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return `${fields.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}&hash=${hash}`;
}

describeDb("online identity — passport first, proven by the patient's own Telegram phone", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const seed = Math.floor(Math.random() * 1_000_000);
  const clinic = randomUUID();
  const BOT = `${600000 + (seed % 1000)}:ID${suffix}bot${"z".repeat(24)}`;
  let nextTg = 910_000_000 + seed * 10;
  const newTg = () => nextTg++;
  const doc = (n: number) => `Q${String.fromCharCode(65 + (seed % 26))}${String(seed * 10 + n).padStart(7, "0").slice(-7)}`;
  const phoneOf = (n: number) => `+998 9${n % 10} ${String(seed).padStart(7, "0").slice(-7).replace(/(\d{3})(\d{2})(\d{2})/, "$1 $2 $3")}`;

  const post = (handler: (r: NextRequest) => Promise<Response>, tg: number, body: Record<string, unknown> = {}) =>
    handler(
      new NextRequest(`http://localhost/api/mini-app/identity?clinic=${clinic}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `10.9.${seed % 250}.${tg % 250}` },
        body: JSON.stringify({ initData: signInitData(BOT, tg), ...body }),
      }),
    ).then(read);
  const share = (tg: number, phoneNumber: string, contactUserId = tg) =>
    handleContactShared({ clinicId: clinic, chatId: tg, from: { id: tg }, contact: { phone_number: phoneNumber, user_id: contactUserId } });
  const card = async (fields: Record<string, unknown>) => {
    const { data, error } = await admin.from("patients").insert({ clinic_id: clinic, ...fields }).select("id").single();
    if (error) throw new Error(error.message);
    return data.id as string;
  };
  const row = async (id: string) =>
    (await admin.from("patients").select("telegram_user_id, telegram_link_method, full_name, document_number, pinfl, date_of_birth, phone, home_address").eq("id", id).single()).data!;

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { error } = await admin.from("clinics").insert({ id: clinic, name: `Identity ${suffix}`, slug: `identity-${suffix}`, timezone: "Asia/Tashkent" });
    if (error) throw new Error(error.message);
    await admin.from("clinic_telegram_integrations").insert({
      clinic_id: clinic, telegram_bot_token: BOT, telegram_bot_id: 600000 + seed, telegram_username: `id_${suffix}_bot`,
      telegram_bot_name: "Identity", status: "active", enabled: true, validated_at: new Date().toISOString(),
    });
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin.from("clinics").delete().eq("id", clinic);
  });

  it("a returning desk patient: passport + date of birth, then their own Telegram phone → the card is theirs and its details appear", async () => {
    const tg = newTg();
    const deskCard = await card({ full_name: `Karimova Dilnoza ${suffix}`, document_number: doc(1), date_of_birth: "1988-04-12", phone: phoneOf(1), home_address: "Chilonzor 5" });

    // First open: nothing is known yet.
    const first = await post(status, tg);
    expect(first.body.data).toMatchObject({ profile: null });

    const step1 = await post(lookup, tg, { consent: true, document: doc(1).toLowerCase(), dateOfBirth: "1988-04-12" });
    expect(step1).toMatchObject({ status: 200, body: { data: { next: "phone" } } });
    const lookupId = step1.body.data!.lookupId as string;

    // Before sharing the phone: asked to share it.
    expect((await post(phone, tg, { lookupId })).body.data).toMatchObject({ next: "phone_needed" });

    await share(tg, phoneOf(1).replace(/\s/g, ""));
    const step2 = await post(phone, tg, { lookupId });
    expect(step2.body.data).toMatchObject({
      next: "done",
      profile: { fullName: `Karimova Dilnoza ${suffix}`, dateOfBirth: "1988-04-12", homeAddress: "Chilonzor 5", complete: true },
    });
    expect(JSON.stringify(step2.body)).not.toContain(doc(1)); // the patient sees their details, never the document number

    expect(await row(deskCard)).toMatchObject({ telegram_user_id: tg, telegram_link_method: "contact_phone" });
    const after = await post(status, tg);
    expect(after.body.data).toMatchObject({ profile: { fullName: `Karimova Dilnoza ${suffix}`, complete: true } });

    // Audited with ids and the method only.
    const { data: audit } = await admin.from("audit_events").select("action, actor_type, old_values, new_values, metadata").eq("patient_id", deskCard);
    expect(audit).toEqual([expect.objectContaining({ action: "patient_telegram_linked", actor_type: "patient", old_values: null, new_values: null })]);
    expect(JSON.stringify(audit)).not.toMatch(new RegExp(`${doc(1)}|1988|Karimova|\\d{9}`));
  });

  it("the answer never tells whether a document exists, or whose it is: no card, a wrong date and a right one look the same", async () => {
    await card({ full_name: `Yusupov Bobur ${suffix}`, document_number: doc(2), date_of_birth: "1975-01-30", phone: phoneOf(2) });
    const shape = async (document: string, dateOfBirth: string) => {
      const tg = newTg();
      const r = await post(lookup, tg, { consent: true, document, dateOfBirth });
      expect(r.status).toBe(200);
      const { lookupId, ...rest } = r.body.data as { lookupId: string };
      expect(lookupId).toMatch(/^[0-9a-f-]{36}$/);
      return { tg, lookupId, rest: JSON.stringify(rest) };
    };
    const known = await shape(doc(2), "1975-01-30");
    const wrongDate = await shape(doc(2), "1975-01-31");
    const unknown = await shape(doc(3), "1975-01-30");
    expect(new Set([known.rest, wrongDate.rest, unknown.rest]).size).toBe(1);

    // A stranger who shares their OWN phone (not the card's) continues as a new patient — exactly like no card at all.
    for (const s of [known, wrongDate, unknown]) await share(s.tg, `+99899${String(s.tg).slice(-7)}`);
    const next = await Promise.all([known, wrongDate, unknown].map(async (s) => {
      const r = await post(phone, s.tg, { lookupId: s.lookupId });
      return { next: (r.body.data as { next: string }).next, keys: Object.keys(r.body.data!).sort().join() };
    }));
    expect(next).toEqual([next[0], next[0], next[0]]);
    expect(next[0].next).toBe("details");
  });

  it("someone else's document is never stored on a new record; staff get a claim; the patient's answer is the same", async () => {
    const owner = await card({ full_name: `Haqiqiy Egasi ${suffix}`, document_number: doc(4), date_of_birth: "1990-09-09", phone: phoneOf(4) });
    const intruder = newTg();
    const r = await post(lookup, intruder, { consent: true, document: doc(4), dateOfBirth: "1991-01-01" });
    await share(intruder, `+99897${String(intruder).slice(-7)}`);
    const lookupId = r.body.data!.lookupId as string;
    expect((await post(phone, intruder, { lookupId })).body.data).toMatchObject({ next: "details" });
    const done = await post(details, intruder, { lookupId, fullName: `Begona ${suffix}`, homeAddress: "Yunusobod" });
    expect(done.body.data).toMatchObject({ next: "done", profile: { fullName: `Begona ${suffix}` } });

    const { data: mine } = await admin.from("patients").select("id, document_number, date_of_birth, phone, full_name").eq("clinic_id", clinic).eq("telegram_user_id", intruder).single();
    expect(mine).toMatchObject({ document_number: null, full_name: `Begona ${suffix}`, phone: `+99897${String(intruder).slice(-7)}` });
    expect(await row(owner)).toMatchObject({ telegram_user_id: null, document_number: doc(4) }); // untouched
    const { data: claims } = await admin.from("patient_identity_claims").select("patient_id, conflicting_patient_id, reason").eq("clinic_id", clinic).eq("patient_id", mine!.id);
    expect(claims).toEqual([{ patient_id: mine!.id, conflicting_patient_id: owner, reason: "document_in_use" }]);

    // A genuinely new patient: the same answer, and the document is stored.
    const fresh = newTg();
    const f = await post(lookup, fresh, { consent: true, document: doc(5), dateOfBirth: "2001-02-03" });
    await share(fresh, `+99895${String(fresh).slice(-7)}`);
    const fid = f.body.data!.lookupId as string;
    expect((await post(phone, fresh, { lookupId: fid })).body.data).toMatchObject({ next: "details" });
    const fdone = await post(details, fresh, { lookupId: fid, fullName: `Yangi Bemor ${suffix}`, sex: "female" });
    expect(Object.keys(fdone.body.data!).sort()).toEqual(Object.keys(done.body.data!).sort());
    const { data: freshRow } = await admin.from("patients").select("document_number, date_of_birth").eq("clinic_id", clinic).eq("telegram_user_id", fresh).single();
    expect(freshRow).toEqual({ document_number: doc(5), date_of_birth: "2001-02-03" });
    expect((await post(status, fresh)).body.data).toMatchObject({ profile: { complete: true } });

    // A finished lookup cannot be replayed.
    expect((await post(details, fresh, { lookupId: fid, fullName: "Boshqa" })).body.code).toBe("lookup_expired");
  });

  it("only the sender's own contact counts; a forwarded one is ignored", async () => {
    const victim = await card({ full_name: `Qurbon ${suffix}`, document_number: doc(6), date_of_birth: "1980-08-08", phone: phoneOf(6) });
    const attacker = newTg();
    const r = await post(lookup, attacker, { consent: true, document: doc(6), dateOfBirth: "1980-08-08" });
    const lookupId = r.body.data!.lookupId as string;
    // The victim's contact card forwarded by the attacker: user_id is the victim's account, not the sender's.
    vi.mocked(sendTelegramMessage).mockClear();
    await share(attacker, phoneOf(6), attacker + 1);
    expect(vi.mocked(sendTelegramMessage).mock.calls[0][0].text).toMatch(/o‘zingizning/);
    expect((await post(phone, attacker, { lookupId })).body.data).toMatchObject({ next: "phone_needed" });
    expect(await row(victim)).toMatchObject({ telegram_user_id: null });
    // A non-Uzbek number is not taken either.
    await share(attacker, "+7 912 345 67 89");
    expect((await post(phone, attacker, { lookupId })).body.data).toMatchObject({ next: "phone_needed" });
  });

  it("three wrong dates of birth for a document stop the comparison for the day", async () => {
    await card({ full_name: `Himoyalangan ${suffix}`, document_number: doc(7), date_of_birth: "1970-07-07", phone: phoneOf(7) });
    for (const d of ["1970-07-01", "1970-07-02", "1970-07-03"]) {
      const wrong = await post(lookup, newTg(), { consent: true, document: doc(7), dateOfBirth: d });
      expect(wrong.status, JSON.stringify(wrong.body)).toBe(200);
    }
    const tg = newTg();
    const r = await post(lookup, tg, { consent: true, document: doc(7), dateOfBirth: "1970-07-07" }); // right date, too late
    await share(tg, phoneOf(7)); // even with the card's own phone
    expect((await post(phone, tg, { lookupId: r.body.data!.lookupId as string })).body.data).toMatchObject({ next: "details" });
  });

  it("a Telegram record with its own history is never relinked silently — reception joins the two", async () => {
    const deskCard = await card({ full_name: `Ikki Karta ${suffix}`, document_number: doc(8), date_of_birth: "1965-06-06", phone: phoneOf(8) });
    const tg = newTg();
    await post(status, tg); // creates the Telegram record
    await admin.from("patients").update({ pinfl: `3${String(seed).padStart(13, "1").slice(-13)}` }).eq("clinic_id", clinic).eq("telegram_user_id", tg);
    const r = await post(lookup, tg, { consent: true, document: doc(8), dateOfBirth: "1965-06-06" });
    await share(tg, phoneOf(8));
    expect((await post(phone, tg, { lookupId: r.body.data!.lookupId as string })).body.data).toEqual({ next: "reception" });
    expect(await row(deskCard)).toMatchObject({ telegram_user_id: null });
  });

  it("no passport or date of birth is processed without the patient's consent on the first screen", async () => {
    const tg = newTg();
    const r = await post(lookup, tg, { document: doc(10), dateOfBirth: "1990-10-10" }); // no consent
    expect(r.status).toBe(400);
    const { count } = await admin.from("online_identity_lookups").select("id", { count: "exact", head: true }).eq("clinic_id", clinic).eq("telegram_user_id", tg);
    expect(count).toBe(0);
    // With consent, the patient's own record records it.
    await post(lookup, tg, { consent: true, document: doc(10), dateOfBirth: "1990-10-10" });
    const { data } = await admin.from("patients").select("consent_given").eq("clinic_id", clinic).eq("telegram_user_id", tg).single();
    expect(data).toEqual({ consent_given: true });
  });

  it("another user's lookup id is refused; bad input is refused", async () => {
    const a = newTg();
    const r = await post(lookup, a, { consent: true, document: doc(9), dateOfBirth: "1999-09-09" });
    expect((await post(phone, newTg(), { lookupId: r.body.data!.lookupId as string })).body.code).toBe("lookup_expired");
    expect((await post(lookup, a, { consent: true, document: "12345", dateOfBirth: "1999-09-09" })).body.code).toBe("invalid_identity");
    expect((await post(lookup, a, { consent: true, document: doc(9), dateOfBirth: "2999-01-01" })).body.code).toBe("invalid_identity");
    expect((await post(lookup, a, { consent: true, document: doc(9), dateOfBirth: "1999-02-30" })).body.code).toBe("invalid_identity");
  });

  it("a JSHSHIR is accepted only with the date of birth it carries (digits 2–7), and a malformed one is named as such", async () => {
    const tg = newTg();
    // 3 = male, 1900s; 14.03.87 — an illustrative number built from the published structure.
    const pinfl = `3140387${String(seed).padStart(7, "0").slice(-7)}`;
    const wrongDate = await post(lookup, tg, { consent: true, document: pinfl, dateOfBirth: "1987-04-14" });
    expect(wrongDate).toMatchObject({ status: 400, body: { code: "pinfl_birth_date_mismatch" } });
    const impossible = await post(lookup, tg, { consent: true, document: `9${pinfl.slice(1)}`, dateOfBirth: "1987-03-14" });
    expect(impossible.body.code).toBe("pinfl_invalid");
    const right = await post(lookup, tg, { consent: true, document: pinfl, dateOfBirth: "1987-03-14" });
    expect(right.body.data).toMatchObject({ next: "phone" });
  });

  it("when the clinic requires it, a Mini App booking without a completed identity is refused on the server", async () => {
    await admin.from("clinics").update({ online_identity_required: true }).eq("id", clinic);
    const tg = newTg();
    const res = await read(
      await book(
        new NextRequest(`http://localhost/api/bookings?clinic=${clinic}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": `10.8.${seed % 250}.1` },
          body: JSON.stringify({
            initData: signInitData(BOT, tg), doctorId: randomUUID(), serviceId: randomUUID(),
            startAt: new Date(Date.now() + 86_400_000).toISOString(), patientName: "Ali Valiyev", phone: "+998901234567", consent: true,
          }),
        }),
      ),
    );
    expect(res).toMatchObject({ status: 409, body: { code: "identity_required" } });
    expect((await post(status, tg)).body.data).toMatchObject({ required: true, profile: null });
    await admin.from("clinics").update({ online_identity_required: false }).eq("id", clinic);
  });
});

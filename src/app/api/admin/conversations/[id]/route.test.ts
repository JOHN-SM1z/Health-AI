import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { localDbAvailable } from "@/test/local-db";

/**
 * Conversation takeover/release CAS (Phase 4: real-time conversation
 * system), read tracking (audit finding, Phase 8), and operator replies
 * (Phase 4 PUT). Regression tests run the real route against the local
 * database with a mocked staff session.
 *
 * Requires: `npm run db:reset-local`. Skips cleanly when the stack is down.
 */

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

const staffMock = vi.hoisted(() => ({ impl: async () => null as unknown }));

vi.mock("@/lib/auth/guards", () => ({
  requireRoles: () => staffMock.impl(),
}));

// Defaults to "no delivery" (matches the real behavior for a clinic with no
// clinic_telegram_integrations row, which none of these fixtures create) so
// existing tests — whose fixture patients have no telegram_user_id and
// never reach this call at all — are unaffected. Individual PUT tests below
// override it per-case to exercise both the delivered and failed paths.
vi.mock("@/lib/telegram/bot", () => ({
  sendTelegramMessage: vi.fn(async () => null),
}));

import { POST, PUT } from "./route";
import { sendTelegramMessage } from "@/lib/telegram/bot";

const sendMock = vi.mocked(sendTelegramMessage);

const describeDb = describe.skipIf(!localDbAvailable());

describeDb("conversation mark_seen (real DB, mocked session)", () => {
  let admin: SupabaseClient;
  let clinicId: string;
  let otherClinicId: string;
  let patientId: string;
  let convId: string;
  let otherConvId: string;
  let actorProfileId: string;
  const suffix = Date.now().toString(36);

  const staffCtx = () => ({
    profileId: actorProfileId,
    clinicId,
    clinicName: "Conv Clinic",
    clinicTimezone: "Asia/Tashkent",
    roles: ["admin"] as const,
    platformAdmin: false,
  });

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });

    const { data: authUser, error: authError } = await admin.auth.admin.createUser({
      email: `conv-actor-${suffix}@test.local`,
      password: "TestPass123!",
      email_confirm: true,
    });
    expect(authError).toBeNull();
    if (!authUser?.user) throw new Error("actor auth user creation failed");
    actorProfileId = authUser.user.id;
    await admin.from("profiles").insert({ id: actorProfileId, full_name: `Conv Actor ${suffix}` });

    const { data: clinic } = await admin
      .from("clinics")
      .insert({ name: `Conv Clinic ${suffix}`, slug: `conv-${suffix}`, timezone: "Asia/Tashkent", currency: "UZS" })
      .select("id")
      .single();
    clinicId = clinic!.id;
    const { data: other } = await admin
      .from("clinics")
      .insert({ name: `Conv Other ${suffix}`, slug: `conv-o-${suffix}`, timezone: "Asia/Tashkent", currency: "UZS" })
      .select("id")
      .single();
    otherClinicId = other!.id;

    const { data: patient } = await admin
      .from("patients")
      .insert({ clinic_id: clinicId, full_name: "Conv Patient", phone: `+99896${suffix.slice(0, 7)}`, consent_given: true })
      .select("id")
      .single();
    patientId = patient!.id;

    const { data: conv } = await admin
      .from("conversations")
      .insert({ clinic_id: clinicId, patient_id: patientId, status: "open", ai_enabled: true, channel: "telegram" })
      .select("id")
      .single();
    convId = conv!.id;

    const { data: otherPatient } = await admin
      .from("patients")
      .insert({ clinic_id: otherClinicId, full_name: "Conv Other Patient", phone: `+99897${suffix.slice(0, 7)}`, consent_given: true })
      .select("id")
      .single();
    const { data: otherConv } = await admin
      .from("conversations")
      .insert({ clinic_id: otherClinicId, patient_id: otherPatient!.id, status: "open", ai_enabled: true, channel: "telegram" })
      .select("id")
      .single();
    otherConvId = otherConv!.id;

    staffMock.impl = async () => staffCtx();
  });

  afterAll(async () => {
    await admin.from("conversations").delete().in("id", [convId, otherConvId]);
    await admin.from("patients").delete().eq("clinic_id", clinicId);
    await admin.from("patients").delete().eq("clinic_id", otherClinicId);
    await admin.from("clinics").delete().in("id", [clinicId, otherClinicId]);
    await admin.from("profiles").delete().eq("id", actorProfileId);
    await admin.auth.admin.deleteUser(actorProfileId);
  });

  beforeEach(() => {
    staffMock.impl = async () => staffCtx();
    sendMock.mockClear();
    sendMock.mockResolvedValue(null);
  });

  function put(id: string, body: unknown): Promise<Response> {
    return PUT(
      new NextRequest(`http://localhost/api/admin/conversations/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );
  }

  function post(id: string, body: unknown): Promise<Response> {
    return POST(
      new NextRequest(`http://localhost/api/admin/conversations/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );
  }

  it("marks the conversation as seen and persists admin_seen_at", async () => {
    const res = await post(convId, { action: "mark_seen" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: { updated?: boolean } };
    expect(body.data!.updated).toBe(true);

    const { data: conv } = await admin.from("conversations").select("admin_seen_at").eq("id", convId).single();
    expect(conv!.admin_seen_at).not.toBeNull();
  });

  it("does not leak read state across clinics (404 for foreign conversation)", async () => {
    const res = await post(otherConvId, { action: "mark_seen" });
    expect(res.status).toBe(404);
    const { data: conv } = await admin.from("conversations").select("admin_seen_at").eq("id", otherConvId).single();
    expect(conv!.admin_seen_at).toBeNull();
  });

  it("rejects unknown actions before touching the row (400)", async () => {
    const res = await post(convId, { action: "garbage" });
    expect(res.status).toBe(400);
  });

  it("takeover still works after mark_seen (CAS not weakened)", async () => {
    const res = await post(convId, { action: "takeover" });
    expect(res.status).toBe(200);
    const { data: conv } = await admin.from("conversations").select("status, taken_over_by").eq("id", convId).single();
    expect(conv!.status).toBe("assigned");
    expect(conv!.taken_over_by).not.toBeNull();
  });

  it("simultaneous takeovers: exactly one wins, the other gets 409 (CAS)", async () => {
    const { data: racePatient } = await admin
      .from("patients")
      .insert({ clinic_id: clinicId, full_name: "Race Patient", phone: `+99899${suffix.slice(0, 7)}`, consent_given: true })
      .select("id")
      .single();
    const { data: fresh } = await admin
      .from("conversations")
      .insert({ clinic_id: clinicId, patient_id: racePatient!.id, status: "open", ai_enabled: true, channel: "telegram" })
      .select("id")
      .single();
    const freshId = fresh!.id;
    const [a, b] = await Promise.all([
      post(freshId, { action: "takeover" }),
      post(freshId, { action: "takeover" }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const { data: conv } = await admin.from("conversations").select("status, taken_over_by").eq("id", freshId).single();
    expect(conv!.status).toBe("assigned");
    expect(conv!.taken_over_by).not.toBeNull();
    await admin.from("conversations").delete().eq("id", freshId);
    await admin.from("patients").delete().eq("id", racePatient!.id);
  });

  it("full workflow: take over, reply, release — AI can resume after release", async () => {
    const { data: patient } = await admin
      .from("patients")
      .insert({
        clinic_id: clinicId,
        full_name: "Workflow Patient",
        phone: `+99891${suffix.slice(0, 7)}`,
        telegram_user_id: 900_000_001,
        consent_given: true,
      })
      .select("id")
      .single();
    const { data: conv } = await admin
      .from("conversations")
      .insert({ clinic_id: clinicId, patient_id: patient!.id, status: "open", ai_enabled: true, channel: "telegram" })
      .select("id")
      .single();
    const convId2 = conv!.id;

    const { conversationIsHeld } = await import("@/lib/telegram/store");

    // AI would currently be allowed to respond.
    expect(await conversationIsHeld(convId2)).toBe(false);

    // Take over.
    const takeoverRes = await post(convId2, { action: "takeover" });
    expect(takeoverRes.status).toBe(200);
    expect(await conversationIsHeld(convId2)).toBe(true);

    // Operator replies; delivery succeeds.
    sendMock.mockResolvedValueOnce(55555);
    const replyRes = await put(convId2, { text: "Salom, sizga qanday yordam bera olaman?" });
    expect(replyRes.status).toBe(200);
    const replyBody = (await replyRes.json()) as { data: { sent: boolean; delivered: boolean; telegramMessageId: number | null } };
    expect(replyBody.data.delivered).toBe(true);
    expect(replyBody.data.telegramMessageId).toBe(55555);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 900_000_001, text: "Salom, sizga qanday yordam bera olaman?" }),
      clinicId,
    );

    const { data: storedMsg } = await admin
      .from("messages")
      .select("telegram_message_id, metadata")
      .eq("conversation_id", convId2)
      .eq("role", "admin")
      .eq("type", "text")
      .single();
    expect(storedMsg!.telegram_message_id).toBe(55555);
    expect((storedMsg!.metadata as Record<string, unknown>)?.telegram_delivery_failed).toBeUndefined();

    // Release back to AI.
    const releaseRes = await post(convId2, { action: "release" });
    expect(releaseRes.status).toBe(200);
    const { data: released } = await admin
      .from("conversations")
      .select("status, ai_enabled, taken_over_by, taken_over_at, released_at")
      .eq("id", convId2)
      .single();
    expect(released!.status).toBe("open");
    expect(released!.ai_enabled).toBe(true);
    expect(released!.taken_over_by).toBeNull();
    expect(released!.taken_over_at).toBeNull();
    expect(released!.released_at).not.toBeNull();

    // AI is allowed to respond again — this is the exact gate
    // handleTelegramMessage checks before every automated reply.
    expect(await conversationIsHeld(convId2)).toBe(false);

    await admin.from("conversations").delete().eq("id", convId2);
    await admin.from("patients").delete().eq("id", patient!.id);
  });

  it("PUT records a failed Telegram delivery instead of masking it as sent", async () => {
    // Regression test: the operator-reply endpoint used to persist the
    // message and report success regardless of whether Telegram actually
    // accepted it, and the frontend never inspected the response — a
    // failed delivery looked identical to a successful one everywhere.
    const { data: patient } = await admin
      .from("patients")
      .insert({
        clinic_id: clinicId,
        full_name: "Undelivered Patient",
        phone: `+99892${suffix.slice(0, 7)}`,
        telegram_user_id: 900_000_002,
        consent_given: true,
      })
      .select("id")
      .single();
    const { data: conv } = await admin
      .from("conversations")
      .insert({
        clinic_id: clinicId,
        patient_id: patient!.id,
        status: "assigned",
        ai_enabled: false,
        taken_over_by: actorProfileId,
        taken_over_at: new Date().toISOString(),
        channel: "telegram",
      })
      .select("id")
      .single();
    const convId3 = conv!.id;

    sendMock.mockResolvedValueOnce(null); // Telegram rejected it / send failed.
    const res = await put(convId3, { text: "Bu xabar yetib bormaydi" });
    expect(res.status).toBe(200); // the write itself succeeded — only delivery failed
    const body = (await res.json()) as { data: { sent: boolean; delivered: boolean; telegramMessageId: number | null } };
    expect(body.data.delivered).toBe(false);
    expect(body.data.telegramMessageId).toBeNull();

    const { data: storedMsg } = await admin
      .from("messages")
      .select("telegram_message_id, metadata, content")
      .eq("conversation_id", convId3)
      .eq("role", "admin")
      .single();
    // The message is still saved (the operator's text is never lost)...
    expect(storedMsg!.content).toBe("Bu xabar yetib bormaydi");
    // ...but is clearly marked as not delivered, not silently equivalent to
    // a successfully sent message.
    expect(storedMsg!.telegram_message_id).toBeNull();
    expect((storedMsg!.metadata as Record<string, unknown>).telegram_delivery_failed).toBe(true);

    await admin.from("conversations").delete().eq("id", convId3);
    await admin.from("patients").delete().eq("id", patient!.id);
  });

  it("PUT is rejected (409) when the conversation is not held, and nothing is persisted or sent", async () => {
    const { data: patient } = await admin
      .from("patients")
      .insert({ clinic_id: clinicId, full_name: "Unheld Patient", phone: `+99893${suffix.slice(0, 7)}`, consent_given: true })
      .select("id")
      .single();
    const { data: conv } = await admin
      .from("conversations")
      .insert({ clinic_id: clinicId, patient_id: patient!.id, status: "open", ai_enabled: true, channel: "telegram" })
      .select("id")
      .single();
    const convId4 = conv!.id;

    const res = await put(convId4, { text: "Operator hali qabul qilmagan" });
    expect(res.status).toBe(409);
    expect(sendMock).not.toHaveBeenCalled();
    const { count } = await admin
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", convId4);
    expect(count).toBe(0);

    await admin.from("conversations").delete().eq("id", convId4);
    await admin.from("patients").delete().eq("id", patient!.id);
  });

  it("PUT does not leak into another clinic's conversation (404)", async () => {
    const res = await put(otherConvId, { text: "Boshqa klinika suhbatiga yozish" });
    expect(res.status).toBe(404);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
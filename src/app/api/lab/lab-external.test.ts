import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";

/**
 * External laboratory integration (Phase 15) with the mock provider, through
 * the real routes, worker and database: request and response mapping,
 * retries, idempotency, duplicate prevention, provider errors and status
 * mapping, webhooks, review flags, concurrency, audit, and access.
 */

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

const session = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/staff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/staff")>();
  return { ...actual, getStaffContext: async () => session.ctx };
});

import { GET as listProvidersRoute, POST as createProviderRoute } from "../admin/lab/providers/route";
import { PATCH as updateProviderRoute } from "../admin/lab/providers/[id]/route";
import { PUT as setCodesRoute } from "../admin/lab/providers/[id]/codes/route";
import { POST as sendOutRoute } from "./items/[id]/send-out/route";
import { GET as sendOutsRoute } from "./send-outs/route";
import { POST as cancelRoute } from "./send-outs/[id]/route";
import { POST as webhookRoute } from "./providers/[id]/webhook/route";
import { POST as processRoute } from "./providers/process/route";
import { POST as resultAction } from "./results/[id]/route";
import { PUT as saveResult } from "./items/[id]/result/route";
import { processExternalLabRequests } from "@/lib/labs/providers/service";
import { mockProviderOrders, mockSignature, resetMockProvider } from "@/lib/labs/providers/mock";
import { idFree } from "@/test/id-free";

const describeDb = describe.skipIf(!localDbAvailable());

type Body = { ok: boolean; data?: Record<string, unknown>; code?: string };
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Body });
const SECRET = `s3cret-${randomUUID()}`;
process.env.LAB_PROVIDER_MOCK_TEST = SECRET;
process.env.LAB_PROVIDER_MOCK_WRONG = "wrong";

describeDb("external laboratory integration (mock provider, real database)", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const clinicA: string = randomUUID();
  const clinicB: string = randomUUID();
  const passwords = { tech: `Pw-${randomUUID()}` };
  const people = { owner: randomUUID(), reception: randomUUID(), doctor: randomUUID(), tech: randomUUID(), reviewer: randomUUID(), labB: randomUUID(), ownerB: randomUUID() };
  const ids = { cbc: "", hgb: "", wbc: "", glu: "", gluP: "" };

  const as = (profileId: string, role: string, clinicId = clinicA) => {
    session.ctx = { profileId, clinicId, clinicName: "Ext", clinicTimezone: "Asia/Tashkent", roles: [role], platformAdmin: false };
  };
  const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await admin.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };

  /** A provider configured through the admin API, with codes for CBC (HB, LEU) and GLU. */
  async function provider(config: Record<string, unknown> = {}, opts: { credentialRef?: string | null; clinic?: string } = {}) {
    as(opts.clinic === clinicB ? people.ownerB : people.owner, "owner", opts.clinic ?? clinicA);
    const created = await read(
      await createProviderRoute(
        new NextRequest("http://localhost/api/admin/lab/providers", json("POST", {
          code: `mock-${randomUUID().slice(0, 8)}`,
          name: `Mock lab ${suffix}`,
          adapter: "mock",
          config: { pollSeconds: 0, results: { "CBC-X": [{ code: "HB", value: 128, unit: "g/L" }, { code: "LEU", value: 6.4, unit: "10^9/L" }], "GLU-X": [{ code: "G", value: 5.2 }] }, ...config },
          credentialRef: opts.credentialRef === undefined ? "LAB_PROVIDER_MOCK_TEST" : opts.credentialRef,
        })),
      ),
    );
    expect(created.status).toBe(201);
    const id = created.body.data!.id as string;
    if (!opts.clinic) {
      const codes = await read(
        await setCodesRoute(
          new NextRequest(`http://localhost/api/admin/lab/providers/${id}/codes`, json("PUT", {
            codes: [
              { kind: "test", internalId: ids.cbc, externalCode: "CBC-X" },
              { kind: "test", internalId: ids.glu, externalCode: "GLU-X" },
              { kind: "parameter", internalId: ids.hgb, externalCode: "HB" },
              { kind: "parameter", internalId: ids.wbc, externalCode: "LEU" },
              { kind: "parameter", internalId: ids.gluP, externalCode: "G" },
            ],
          })),
          { params: Promise.resolve({ id }) },
        ),
      );
      expect(codes.status).toBe(200);
    }
    as(people.tech, "lab");
    return id;
  }

  /** A test whose sample the lab has received (item status processing). */
  async function receivedItem(test = ids.cbc) {
    const { data: patient } = await admin.from("patients").insert({ clinic_id: clinicA, full_name: `Ext bemor ${suffix}`, date_of_birth: "1985-05-05", sex: "female" }).select("id").single();
    const o = (await rpc("create_lab_order", { p_clinic_id: clinicA, p_patient_id: patient!.id, p_ordered_by: people.reception, p_source: "walk_in", p_test_ids: [test], p_panel_ids: [] })) as Array<{ lab_order_id: string }>;
    const { data: item } = await admin.from("lab_order_items").select("id").eq("order_id", o[0].lab_order_id).single();
    const s = (await rpc("collect_lab_sample", { p_clinic_id: clinicA, p_order_id: o[0].lab_order_id, p_item_ids: [item!.id], p_collected_by: people.reception })) as Array<{ lab_sample_id: string }>;
    await rpc("receive_lab_sample", { p_clinic_id: clinicA, p_sample_id: s[0].lab_sample_id, p_received_by: people.tech });
    return { itemId: item!.id as string, patientId: patient!.id as string, orderId: o[0].lab_order_id };
  }
  const sendOut = async (itemId: string, providerId: string) =>
    read(await sendOutRoute(new NextRequest(`http://localhost/api/lab/items/${itemId}/send-out`, json("POST", { providerId })), { params: Promise.resolve({ id: itemId }) }));
  const request = async (itemId: string) => {
    const { data } = await admin.from("lab_external_requests").select("*").eq("order_item_id", itemId).order("requested_at", { ascending: false }).limit(1).single();
    return data!;
  };
  const due = (id: string) => admin.from("lab_external_requests").update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("id", id);
  const webhook = async (providerId: string, body: unknown, signature?: string) => {
    const raw = JSON.stringify(body);
    return read(
      await webhookRoute(new NextRequest(`http://localhost/api/lab/providers/${providerId}/webhook`, { method: "POST", body: raw, headers: { "x-mock-signature": signature ?? mockSignature(SECRET, raw) } }), {
        params: Promise.resolve({ id: providerId }),
      }),
    );
  };

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    await admin.from("clinics").insert([
      { id: clinicA, name: `Ext A ${suffix}`, slug: `ext-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Ext B ${suffix}`, slug: `ext-b-${suffix}`, timezone: "Asia/Tashkent" },
    ]);
    for (const [name, id] of Object.entries(people)) {
      const { error } = await admin.auth.admin.createUser({ id, email: `ext-${name}-${suffix}@test.local`, email_confirm: true, password: (passwords as Record<string, string>)[name] ?? `Pw-${randomUUID()}` });
      if (error) throw new Error(error.message);
      await admin.from("profiles").insert({ id, full_name: name });
    }
    await admin.from("staff_roles").insert([
      { clinic_id: clinicA, profile_id: people.owner, role: "owner" },
      { clinic_id: clinicA, profile_id: people.reception, role: "receptionist" },
      { clinic_id: clinicA, profile_id: people.doctor, role: "doctor" },
      { clinic_id: clinicA, profile_id: people.tech, role: "lab" },
      { clinic_id: clinicA, profile_id: people.reviewer, role: "lab" },
      { clinic_id: clinicB, profile_id: people.labB, role: "lab" },
      { clinic_id: clinicB, profile_id: people.ownerB, role: "owner" },
    ]);
    const { data: tests } = await admin
      .from("lab_tests")
      .insert([
        { clinic_id: clinicA, code: `XCBC${suffix}`, name: "Umumiy qon (tashqi)", sample_type: "Qon", price: 1000 },
        { clinic_id: clinicA, code: `XGLU${suffix}`, name: "Glyukoza (tashqi)", sample_type: "Qon", price: 1000 },
      ])
      .select("id, code");
    ids.cbc = tests!.find((t) => t.code.startsWith("XCBC"))!.id;
    ids.glu = tests!.find((t) => t.code.startsWith("XGLU"))!.id;
    const { data: params } = await admin
      .from("lab_test_parameters")
      .insert([
        { clinic_id: clinicA, test_id: ids.cbc, code: "HGB", name: "Gemoglobin", value_type: "numeric", unit: "g/L", decimals: 0, sort_order: 1 },
        { clinic_id: clinicA, test_id: ids.cbc, code: "WBC", name: "Leykotsit", value_type: "numeric", unit: "10^9/L", decimals: 1, sort_order: 2 },
        { clinic_id: clinicA, test_id: ids.glu, code: "GLU", name: "Glyukoza", value_type: "numeric", unit: "mmol/L", decimals: 1, sort_order: 1 },
      ])
      .select("id, code");
    ids.hgb = params!.find((p) => p.code === "HGB")!.id;
    ids.wbc = params!.find((p) => p.code === "WBC")!.id;
    ids.gluP = params!.find((p) => p.code === "GLU")!.id;
    await admin.from("lab_reference_ranges").insert({ clinic_id: clinicA, parameter_id: ids.hgb, low: 120, high: 160 });
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.from("clinics").delete().in("id", [clinicA, clinicB]);
    for (const id of Object.values(people)) await admin.auth.admin.deleteUser(id);
  });

  beforeEach(() => {
    resetMockProvider();
    as(people.tech, "lab");
  });

  it("sends a test out, polls it, and records the provider's result for a second person's verification", async () => {
    const providerId = await provider();
    const { itemId } = await receivedItem();

    const sent = await sendOut(itemId, providerId);
    expect(sent.status).toBe(201);
    let req = await request(itemId);
    expect(req).toMatchObject({ status: "sent", requested_by: people.tech, attempts: 0, last_error_code: null });
    expect(req.external_order_id).toMatch(/^MOCK-/);
    // Request mapping: the provider's test code, the specimen, minimum patient data (no name, no record id).
    expect(mockProviderOrders()).toEqual([expect.objectContaining({ requestId: req.id, testCode: "CBC-X" })]);

    // While it is out, nobody enters a manual result.
    const manual = await read(await saveResult(new NextRequest(`http://localhost/api/lab/items/${itemId}/result`, json("PUT", { values: [{ parameterId: ids.hgb, value: "130" }] })), { params: Promise.resolve({ id: itemId }) }));
    expect(manual.body.code).toBe("sent_out");

    // The worker polls: completed → result fetched, mapped and submitted.
    await processExternalLabRequests();
    req = await request(itemId);
    expect(req).toMatchObject({ status: "resulted", external_result_id: `${req.external_order_id}-R1`, review_reason: null });
    const { data: result } = await admin
      .from("lab_results")
      .select("id, source, status, entered_by, submitted_by, verified_by, lab_result_values(parameter_id, value_numeric, flag, unit_snapshot)")
      .eq("id", req.result_id!)
      .single();
    expect(result).toMatchObject({ source: "external", status: "submitted", entered_by: people.tech, submitted_by: people.tech, verified_by: null });
    expect((result!.lab_result_values as Array<Record<string, unknown>>).sort((a, b) => String(a.parameter_id).localeCompare(String(b.parameter_id)))).toEqual(
      [
        { parameter_id: ids.hgb, value_numeric: 128, flag: "normal", unit_snapshot: "g/L" },
        { parameter_id: ids.wbc, value_numeric: 6.4, flag: "not_evaluated", unit_snapshot: "10^9/L" },
      ].sort((a, b) => a.parameter_id.localeCompare(b.parameter_id)),
    );

    // Nothing a provider sends is final: the requester cannot verify, a second person does.
    const self = await read(await resultAction(new NextRequest(`http://localhost/api/lab/results/${result!.id}`, json("POST", { action: "verify" })), { params: Promise.resolve({ id: result!.id }) }));
    expect(self.body.code).toBe("second_person_required");
    as(people.reviewer, "lab");
    const verified = await read(await resultAction(new NextRequest(`http://localhost/api/lab/results/${result!.id}`, json("POST", { action: "verify" })), { params: Promise.resolve({ id: result!.id }) }));
    expect(verified.status).toBe(200);

    // Audit: ids, statuses and codes only.
    const { data: audit } = await admin.from("audit_events").select("action, new_values").eq("entity_id", req.id).order("created_at");
    expect(audit!.map((a) => a.action)).toEqual(["lab_external_requested", "lab_external_sent", "lab_external_resulted"]);
    expect(idFree(audit)).not.toMatch(/128|6\.4|Ext bemor/);

    // Status for the queue (no values).
    as(people.reception, "receptionist");
    const status = await read(await sendOutsRoute(new NextRequest(`http://localhost/api/lab/send-outs?items=${itemId}`)));
    expect(status.body.data!.sendOuts).toEqual([expect.objectContaining({ itemId, status: "resulted", providerName: `Mock lab ${suffix}` })]);
    expect(idFree(status.body)).not.toContain("128");
  });

  it("is idempotent: the same send-out once, a lost response never makes a second order, retries back off", async () => {
    const providerId = await provider({ failCreateTimes: 1, lostResponse: true });
    const other = await provider();
    const { itemId } = await receivedItem();

    const first = await sendOut(itemId, providerId);
    expect(first.status).toBe(201);
    let req = await request(itemId);
    // The provider created the order but the response was lost: a retryable failure, backed off.
    expect(req).toMatchObject({ status: "queued", attempts: 1, last_error_code: "network_error", external_order_id: null });
    expect(new Date(req.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    expect(mockProviderOrders()).toHaveLength(1);

    // Pressing again replays; another laboratory is refused.
    const again = await sendOut(itemId, providerId);
    expect(again).toMatchObject({ status: 200, body: { data: { requestId: req.id, replayed: true } } });
    expect((await sendOut(itemId, other)).body.code).toBe("already_sent");

    // Not due yet: the worker leaves it. Due: the retry finds the order the provider already has.
    await processExternalLabRequests();
    expect((await request(itemId)).status).toBe("queued");
    await due(req.id);
    await processExternalLabRequests();
    req = await request(itemId);
    expect(req).toMatchObject({ status: "sent", attempts: 0, last_error_code: null });
    expect(mockProviderOrders()).toHaveLength(1);
    expect(req.external_order_id).toBe(mockProviderOrders()[0].externalOrderId);

    // A provider order id belongs to one send-out of that provider only.
    const { itemId: item2 } = await receivedItem();
    await rpc("request_external_lab", { p_clinic_id: clinicA, p_order_item_id: item2, p_provider_id: providerId, p_actor: people.tech });
    const { error: dup } = await admin.from("lab_external_requests").update({ external_order_id: req.external_order_id }).eq("id", (await request(item2)).id);
    expect(dup?.code).toBe("23505");
  });

  it("gives up after the retry limit, and the test can be sent again", async () => {
    const providerId = await provider({ failCreateTimes: 10 });
    const { itemId } = await receivedItem();
    await sendOut(itemId, providerId);
    for (let i = 0; i < 6; i++) {
      await due((await request(itemId)).id);
      await processExternalLabRequests();
    }
    const failed = await request(itemId);
    expect(failed).toMatchObject({ status: "failed", attempts: 6, last_error_code: "network_error" });
    const retry = await sendOut(itemId, await provider());
    expect(retry.status).toBe(201);
    expect((await request(itemId)).status).toBe("sent");
  });

  it("maps provider errors: rejection, missing or refused credentials, unreadable answers", async () => {
    const rejecting = await provider({ rejectTests: ["GLU-X"] });
    const a = await receivedItem(ids.glu);
    await sendOut(a.itemId, rejecting);
    expect(await request(a.itemId)).toMatchObject({ status: "rejected", last_error_code: "test_not_offered" });

    const noSecret = await provider({ requireCredential: true }, { credentialRef: "LAB_PROVIDER_NOT_SET" });
    const b = await receivedItem();
    await sendOut(b.itemId, noSecret);
    expect(await request(b.itemId)).toMatchObject({ status: "failed", last_error_code: "credential_missing" });

    const refused = await provider({ requireCredential: true }, { credentialRef: "LAB_PROVIDER_MOCK_WRONG" });
    const c = await receivedItem();
    await sendOut(c.itemId, refused);
    expect(await request(c.itemId)).toMatchObject({ status: "failed", last_error_code: "credential_refused" });

    const garbled = await provider({ invalidStatus: true });
    const d = await receivedItem();
    await sendOut(d.itemId, garbled);
    await processExternalLabRequests();
    expect(await request(d.itemId)).toMatchObject({ status: "sent", attempts: 1, last_error_code: "unreadable_status" });

    // The provider cancels or rejects an order it accepted (status mapping through the webhook).
    const hook = await provider();
    const e = await receivedItem();
    await sendOut(e.itemId, hook);
    const ext = (await request(e.itemId)).external_order_id!;
    expect((await webhook(hook, { events: [{ type: "status", externalOrderId: ext, status: "in_progress" }] })).status).toBe(200);
    expect((await request(e.itemId)).status).toBe("in_progress");
    expect((await webhook(hook, { events: [{ type: "status", externalOrderId: ext, status: "rejected" }] })).status).toBe(200);
    expect(await request(e.itemId)).toMatchObject({ status: "rejected", last_error_code: "provider_rejected" });
  });

  it("never records what does not map cleanly: unknown codes, other units, bad values; incomplete results stay drafts", async () => {
    const cases: Array<[Array<{ code: string; value: number | string; unit?: string }>, string]> = [
      [[{ code: "HB", value: 128 }, { code: "XYZ", value: 1 }], "unmapped_parameter"],
      [[{ code: "HB", value: 12.8, unit: "g/dL" }, { code: "LEU", value: 6.4 }], "unit_mismatch"],
      [[{ code: "HB", value: "high" }, { code: "LEU", value: 6.4 }], "invalid_value"],
      [[{ code: "HB", value: 128.5 }, { code: "LEU", value: 6.4 }], "invalid_value"],
    ];
    for (const [values, reason] of cases) {
      const providerId = await provider({ results: { "CBC-X": values } });
      const { itemId } = await receivedItem();
      await sendOut(itemId, providerId);
      await processExternalLabRequests();
      const req = await request(itemId);
      expect(req).toMatchObject({ status: "in_progress", review_reason: reason, result_id: null });
      expect(new Date(req.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 3_600_000); // held for a person
      const { count } = await admin.from("lab_results").select("id", { count: "exact", head: true }).eq("order_item_id", itemId);
      expect(count).toBe(0);
    }
    const partial = await provider({ results: { "CBC-X": [{ code: "HB", value: 128 }] } });
    const { itemId } = await receivedItem();
    await sendOut(itemId, partial);
    await processExternalLabRequests();
    const req = await request(itemId);
    expect(req).toMatchObject({ status: "resulted", review_reason: "result_incomplete" });
    const { data: draft } = await admin.from("lab_results").select("status, entered_by, source").eq("id", req.result_id!).single();
    expect(draft).toEqual({ status: "draft", entered_by: people.tech, source: "external" });
  });

  it("accepts signed webhooks only, records a pushed result once, and flags a conflicting second result", async () => {
    const providerId = await provider();
    const { itemId } = await receivedItem(ids.glu);
    await sendOut(itemId, providerId);
    const ext = (await request(itemId)).external_order_id!;
    const result = { externalResultId: "R-1", performedAt: "2026-10-05T08:00:00Z", values: [{ code: "G", value: 5.6 }] };

    expect((await webhook(providerId, { events: [{ type: "result", externalOrderId: ext, result }] }, "0".repeat(64))).status).toBe(401);
    expect((await webhook(randomUUID(), { events: [] })).status).toBe(404);
    expect((await webhook(providerId, { events: [{ type: "result", externalOrderId: ext, result: { values: "x" } }] })).status).toBe(400);
    expect((await webhook(providerId, { nope: true })).status).toBe(400);

    const ok1 = await webhook(providerId, { events: [{ type: "result", externalOrderId: ext, result }] });
    expect(ok1.body.data).toMatchObject({ applied: 1 });
    const ok2 = await webhook(providerId, { events: [{ type: "result", externalOrderId: ext, result }] });
    expect(ok2.body.data).toMatchObject({ duplicate: 1 });
    const { count } = await admin.from("lab_results").select("id", { count: "exact", head: true }).eq("order_item_id", itemId);
    expect(count).toBe(1);
    const req = await request(itemId);
    expect(req).toMatchObject({ status: "resulted", external_result_id: "R-1" });
    const { data: stored } = await admin.from("lab_results").select("performed_at, lab_result_values(value_numeric)").eq("id", req.result_id!).single();
    expect(stored).toMatchObject({ performed_at: "2026-10-05T08:00:00+00:00", lab_result_values: [{ value_numeric: 5.6 }] });

    // A different result for the same order is never applied over the first.
    const conflict = await webhook(providerId, { events: [{ type: "result", externalOrderId: ext, result: { ...result, externalResultId: "R-2", values: [{ code: "G", value: 9.9 }] } }] });
    expect(conflict.status).toBe(200);
    const { data: still } = await admin.from("lab_results").select("lab_result_values(value_numeric)").eq("id", req.result_id!).single();
    expect(still).toMatchObject({ lab_result_values: [{ value_numeric: 5.6 }] });
    // Unknown provider orders are ignored.
    expect((await webhook(providerId, { events: [{ type: "status", externalOrderId: "MOCK-unknown", status: "completed" }] })).body.data).toMatchObject({ unknown: 1 });
  });

  it("two workers at once never act on the same send-out twice; the scheduler endpoint needs its secret", async () => {
    const providerId = await provider({ pollSeconds: 3600 });
    const items = await Promise.all(Array.from({ length: 6 }, () => receivedItem()));
    for (const { itemId } of items) {
      const { error } = await admin.rpc("request_external_lab", { p_clinic_id: clinicA, p_order_item_id: itemId, p_provider_id: providerId, p_actor: people.tech });
      expect(error).toBeNull();
    }
    const [r1, r2] = await Promise.all([processExternalLabRequests(), processExternalLabRequests()]);
    expect(r1.claimed + r2.claimed).toBeGreaterThanOrEqual(6);
    const mine = mockProviderOrders().filter((o) => o.testCode === "CBC-X");
    expect(mine).toHaveLength(6);
    expect(new Set(mine.map((o) => o.requestId)).size).toBe(6);

    expect((await processRoute(new NextRequest("http://localhost/api/lab/providers/process", { method: "POST" }))).status).toBe(401);
    expect((await processRoute(new NextRequest("http://localhost/api/lab/providers/process", { method: "POST", headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
  });

  it("lab staff can stop a send-out, after which the lab enters the result itself", async () => {
    const providerId = await provider();
    const { itemId } = await receivedItem();
    await sendOut(itemId, providerId);
    const req = await request(itemId);
    as(people.reception, "receptionist");
    expect((await cancelRoute(new NextRequest(`http://localhost/api/lab/send-outs/${req.id}`, json("POST", { action: "cancel" })), { params: Promise.resolve({ id: req.id }) })).status).toBe(403);
    as(people.tech, "lab");
    const cancelled = await read(await cancelRoute(new NextRequest(`http://localhost/api/lab/send-outs/${req.id}`, json("POST", { action: "cancel" })), { params: Promise.resolve({ id: req.id }) }));
    expect(cancelled.status).toBe(200);
    expect(await request(itemId)).toMatchObject({ status: "cancelled", cancelled_by: people.tech });
    expect((await read(await cancelRoute(new NextRequest(`http://localhost/api/lab/send-outs/${req.id}`, json("POST", { action: "cancel" })), { params: Promise.resolve({ id: req.id }) }))).body.code).toBe("not_live");
    // A late provider result for a cancelled send-out is not recorded.
    const late = await webhook(providerId, { events: [{ type: "result", externalOrderId: req.external_order_id, result: { externalResultId: "late", values: [{ code: "HB", value: 130 }, { code: "LEU", value: 5 }] } }] });
    expect(late.status).toBe(200);
    const { count } = await admin.from("lab_results").select("id", { count: "exact", head: true }).eq("order_item_id", itemId);
    expect(count).toBe(0);
    // The lab enters it manually now.
    const manual = await read(await saveResult(new NextRequest(`http://localhost/api/lab/items/${itemId}/result`, json("PUT", { values: [{ parameterId: ids.hgb, value: "130" }] })), { params: Promise.resolve({ id: itemId }) }));
    expect(manual.status).toBeLessThan(300);
  });

  it("is lab work in one clinic; configuration is management's; secrets never leave the server", async () => {
    const providerId = await provider();
    const { itemId } = await receivedItem();
    for (const [who, role] of [[people.reception, "receptionist"], [people.doctor, "doctor"], [people.owner, "owner"]] as const) {
      as(who, role);
      expect((await sendOut(itemId, providerId)).status).toBe(403);
    }
    as(people.labB, "lab", clinicB);
    expect((await sendOut(itemId, providerId)).status).toBe(404);
    const otherClinicProvider = await provider({}, { clinic: clinicB });
    as(people.tech, "lab");
    expect((await sendOut(itemId, otherClinicProvider)).body.code).toBe("provider_not_found");
    // Not received yet / imported / already has a result.
    const { data: p } = await admin.from("patients").insert({ clinic_id: clinicA, full_name: "x", date_of_birth: "1990-01-01" }).select("id").single();
    const o = (await rpc("create_lab_order", { p_clinic_id: clinicA, p_patient_id: p!.id, p_ordered_by: people.reception, p_source: "walk_in", p_test_ids: [ids.cbc], p_panel_ids: [] })) as Array<{ lab_order_id: string }>;
    const { data: fresh } = await admin.from("lab_order_items").select("id").eq("order_id", o[0].lab_order_id).single();
    expect((await sendOut(fresh!.id, providerId)).body.code).toBe("item_not_ready");

    // Configuration: management only; adapters and credential names are checked; secrets never returned.
    as(people.tech, "lab");
    expect((await read(await listProvidersRoute())).status).toBe(403);
    as(people.owner, "owner");
    const list = await read(await listProvidersRoute());
    expect(list.body.data!.adapters).toContain("mock");
    expect(JSON.stringify(list.body)).not.toContain(SECRET);
    expect((list.body.data!.providers as Array<{ id: string; credentialPresent: boolean }>).find((x) => x.id === providerId)!.credentialPresent).toBe(true);
    const badAdapter = await read(await createProviderRoute(new NextRequest("http://localhost/api/admin/lab/providers", json("POST", { code: "nope-1", name: "x", adapter: "medplus" }))));
    expect(badAdapter.body.code).toBe("unknown_adapter");
    const badRef = await read(await createProviderRoute(new NextRequest("http://localhost/api/admin/lab/providers", json("POST", { code: "nope-2", name: "x", adapter: "mock", credentialRef: "SUPABASE_SERVICE_ROLE_KEY" }))));
    expect(badRef.status).toBe(400);
    const badConfig = await read(await updateProviderRoute(new NextRequest(`http://localhost/api/admin/lab/providers/${providerId}`, json("PATCH", { name: "x", adapter: "mock", config: { failCreateTimes: 99 } })), { params: Promise.resolve({ id: providerId }) }));
    expect(badConfig.body.code).toBe("bad_config_bad_fail_create_times");
    const foreignCode = await read(await setCodesRoute(new NextRequest(`http://localhost/api/admin/lab/providers/${providerId}/codes`, json("PUT", { codes: [{ kind: "test", internalId: randomUUID(), externalCode: "Q" }] })), { params: Promise.resolve({ id: providerId }) }));
    expect(foreignCode.body.code).toBe("unknown_reference");
    const { count: codesLeft } = await admin.from("lab_provider_codes").select("id", { count: "exact", head: true }).eq("provider_id", providerId);
    expect(codesLeft).toBe(5); // a bad request never wipes the table

    // Signed-in and anonymous clients: no tables, no functions.
    const anon = createClient(URL, ANON_KEY, { auth: { persistSession: false } });
    const signed = createClient(URL, ANON_KEY, { auth: { persistSession: false } });
    expect((await signed.auth.signInWithPassword({ email: `ext-tech-${suffix}@test.local`, password: passwords.tech })).error).toBeNull();
    for (const client of [anon, signed]) {
      for (const table of ["lab_providers", "lab_provider_codes", "lab_external_requests"]) {
        const { data } = await client.from(table).select("*").limit(1);
        expect(data ?? []).toEqual([]);
      }
      for (const [fn, args] of [
        ["request_external_lab", { p_clinic_id: clinicA, p_order_item_id: itemId, p_provider_id: providerId, p_actor: people.tech }],
        ["claim_external_lab_requests", {}],
        ["record_external_lab_result", { p_clinic_id: clinicA, p_request_id: randomUUID(), p_external_result_id: "x", p_values: [] }],
      ] as const) {
        expect((await client.rpc(fn, args)).error).not.toBeNull();
      }
    }
  });
});

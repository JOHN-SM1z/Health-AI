import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";

/**
 * Dashboard conversation oversight (audit finding, Phase 8): the dashboard
 * now reports live (active) and attention-needed conversation counts —
 * derived from the DB, not the browser. Regression tests run the real route
 * against the local database with a mocked staff session.
 *
 * Requires: `npm run db:reset-local`. Skips cleanly when the stack is down.
 */

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

const staffMock = vi.hoisted(() => ({ impl: async () => null as unknown }));

vi.mock("@/lib/auth/guards", () => ({
  requireRoles: () => staffMock.impl(),
}));

vi.mock("@/lib/auth/staff", () => ({
  canViewPaymentDynamics: (ctx: { roles: string[] }) => ctx.roles.includes("owner") || ctx.roles.includes("admin"),
}));

import { GET } from "./route";

const describeDb = describe.skipIf(!localDbAvailable());

describeDb("dashboard conversation counts (real DB, mocked session)", () => {
  let admin: SupabaseClient;
  let clinicId: string;
  let otherClinicId: string;
  let patientA: string;
  let patientB: string;
  let patientC: string;
  let patientOther: string;
  const suffix = Date.now().toString(36);

  const staffCtx = (roles: readonly string[] = ["owner"]) => ({
    profileId: "00000000-0000-4000-8000-000000000001",
    clinicId,
    clinicName: "Dash Clinic",
    clinicTimezone: "Asia/Tashkent",
    roles,
    platformAdmin: false,
  });

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });

    const { data: clinic } = await admin
      .from("clinics")
      .insert({ name: `Dash Clinic ${suffix}`, slug: `dash-${suffix}`, timezone: "Asia/Tashkent", currency: "UZS" })
      .select("id")
      .single();
    clinicId = clinic!.id;
    const { data: other } = await admin
      .from("clinics")
      .insert({ name: `Dash Other ${suffix}`, slug: `dash-o-${suffix}`, timezone: "Asia/Tashkent", currency: "UZS" })
      .select("id")
      .single();
    otherClinicId = other!.id;

    const { data: p1 } = await admin
      .from("patients")
      .insert({ clinic_id: clinicId, full_name: "P1", phone: `+99893${suffix.slice(0, 7)}`, consent_given: true })
      .select("id")
      .single();
    patientA = p1!.id;
    const { data: p2 } = await admin
      .from("patients")
      .insert({ clinic_id: clinicId, full_name: "P2", phone: `+99894${suffix.slice(0, 7)}`, consent_given: true })
      .select("id")
      .single();
    patientB = p2!.id;
    const { data: p3 } = await admin
      .from("patients")
      .insert({ clinic_id: clinicId, full_name: "P3", phone: `+99895${suffix.slice(0, 7)}`, consent_given: true })
      .select("id")
      .single();
    patientC = p3!.id;

    const { data: p4 } = await admin
      .from("patients")
      .insert({ clinic_id: otherClinicId, full_name: "P4", phone: `+99896${suffix.slice(0, 7)}`, consent_given: true })
      .select("id")
      .single();
    patientOther = p4!.id;

    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const now = new Date().toISOString();
    const { error } = await admin.from("conversations").insert([
      // Attention-needed and urgent: open + ai off, urgent wording nobody took over.
      { clinic_id: clinicId, patient_id: patientA, status: "open", ai_enabled: false, channel: "telegram", urgent_at: now, taken_over_at: null },
      // Live: assigned (operator holds it) — urgent an hour ago, taken over since: no longer urgent.
      { clinic_id: clinicId, patient_id: patientB, status: "assigned", ai_enabled: false, channel: "telegram", urgent_at: hourAgo, taken_over_at: now },
      // Live: bot active.
      { clinic_id: clinicId, patient_id: patientC, status: "open", ai_enabled: true, channel: "telegram", urgent_at: null, taken_over_at: null },
      // Closed: not counted, even if it was urgent.
      { clinic_id: clinicId, patient_id: patientA, status: "closed", ai_enabled: true, channel: "telegram", urgent_at: now, taken_over_at: null },
      // Other clinic: must NOT leak into counts.
      { clinic_id: otherClinicId, patient_id: patientOther, status: "open", ai_enabled: false, channel: "telegram", urgent_at: now, taken_over_at: null },
    ]);
    expect(error).toBeNull();
  });

  afterAll(async () => {
    await admin.from("conversations").delete().eq("clinic_id", clinicId);
    await admin.from("conversations").delete().eq("clinic_id", otherClinicId);
    await admin.from("patients").delete().in("id", [patientA, patientB, patientC, patientOther]);
    await admin.from("clinics").delete().in("id", [clinicId, otherClinicId]);
  });

  beforeEach(() => {
    staffMock.impl = async () => staffCtx();
  });

  function get(): Promise<Response> {
    return GET();
  }

  it("reports live and attention-needed conversations scoped to the clinic", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: { active_conversations?: number; attention_conversations?: number; urgent_conversations?: number } };
    expect(body.data!.active_conversations).toBe(3);
    expect(body.data!.attention_conversations).toBe(1);
    // Only the urgent chat nobody has taken over since.
    expect(body.data!.urgent_conversations).toBe(1);
  });

  it("serves receptionist sessions too (view-level oversight)", async () => {
    staffMock.impl = async () => staffCtx(["receptionist"]);
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: { active_conversations?: number } };
    expect(body.data!.active_conversations).toBe(3);
  });

  it("counts only the clinic's own conversations", async () => {
    staffMock.impl = async () => ({ ...staffCtx(), clinicId: otherClinicId });
    const res = await get();
    const body = (await res.json()) as { data?: { active_conversations?: number; attention_conversations?: number; urgent_conversations?: number } };
    // The other clinic sees only its own conversation.
    expect(body.data!.active_conversations).toBe(1);
    expect(body.data!.attention_conversations).toBe(1);
    expect(body.data!.urgent_conversations).toBe(1);
  });
});

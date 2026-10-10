import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";
import { ApiError } from "@/lib/api/errors";

/**
 * The passport in hand at the desk (20261010000004): the document typed from the patient's passport is compared with
 * the card on the server; the answer is only whether it matches, a match marks the card confirmed, and the stored
 * values never come back. Guessing is limited per card.
 */

const URL_ = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const session = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/lib/auth/guards", () => ({
  requireRoles: async (...roles: string[]) => {
    const ctx = session.ctx as { roles: string[] } | null;
    if (!ctx || !ctx.roles.some((r) => roles.includes(r))) throw new ApiError(403, "Ruxsat yo‘q", "forbidden");
    return ctx;
  },
}));

import { POST } from "./patients/[id]/verify-identity/route";

describe.skipIf(!localDbAvailable())("desk identity check (real database)", () => {
  let admin: SupabaseClient;
  const clinic = randomUUID();
  const seed = Date.now() % 1_000_000;
  let receptionist = "";
  let cashier = "";
  const doc = (n: number) => `AB${String(seed * 10 + n).padStart(7, "0").slice(-7)}`;

  const verify = async (patientId: string, body: Record<string, unknown>) => {
    const res = await POST(
      new NextRequest(`http://localhost/api/operations/patients/${patientId}/verify-identity`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: patientId }) },
    );
    return { status: res.status, body: (await res.json()) as { ok: boolean; data?: { outcome: string }; code?: string } };
  };
  const card = async (fields: Record<string, unknown>) =>
    (await admin.from("patients").insert({ clinic_id: clinic, full_name: "Desk Card", ...fields }).select("id").single()).data!.id as string;
  const asStaff = (profileId: string, role: string) => {
    session.ctx = { profileId, clinicId: clinic, clinicName: "Desk", clinicTimezone: "Asia/Tashkent", roles: [role], platformAdmin: false };
  };

  beforeAll(async () => {
    admin = createClient(URL_, SERVICE_KEY, { auth: { persistSession: false } });
    await admin.from("clinics").insert({ id: clinic, name: `Desk ${seed}`, slug: `desk-${seed}` });
    for (const role of ["receptionist", "cashier"]) {
      const { data } = await admin.auth.admin.createUser({ email: `${role}-${seed}@desk.test`, password: `Pw-${randomUUID()}`, email_confirm: true });
      await admin.from("profiles").upsert({ id: data.user!.id, full_name: role });
      await admin.from("staff_roles").insert({ clinic_id: clinic, profile_id: data.user!.id, role });
      if (role === "receptionist") receptionist = data.user!.id;
      else cashier = data.user!.id;
    }
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.from("clinics").delete().eq("id", clinic);
    for (const id of [receptionist, cashier]) if (id) await admin.auth.admin.deleteUser(id);
  });

  it("the passport in hand matches the card: confirmed by reception, audited without values, nothing stored is returned", async () => {
    const id = await card({ document_number: doc(1), date_of_birth: "1987-03-14" });
    asStaff(receptionist, "receptionist");
    const res = await verify(id, { document: doc(1).toLowerCase(), dateOfBirth: "1987-03-14" });
    expect(res).toEqual({ status: 200, body: { ok: true, data: { outcome: "verified" } } });
    const { data } = await admin.from("patients").select("identity_verified_by, identity_verified_at").eq("id", id).single();
    expect(data!.identity_verified_by).toBe("reception");
    expect(data!.identity_verified_at).not.toBeNull();
    const { data: audit } = await admin.from("audit_events").select("actor_id, action, metadata, old_values, new_values").eq("patient_id", id);
    expect(audit).toEqual([{ actor_id: receptionist, action: "patient_identity_verified", metadata: { method: "reception", outcome: "verified" }, old_values: null, new_values: null }]);
  });

  it("a different passport or date of birth is a mismatch — the card is not confirmed and nothing says which value differed", async () => {
    const id = await card({ document_number: doc(2), date_of_birth: "1990-01-01" });
    asStaff(receptionist, "receptionist");
    expect((await verify(id, { document: doc(3), dateOfBirth: "1990-01-01" })).body.data).toEqual({ outcome: "mismatch" });
    expect((await verify(id, { document: doc(2), dateOfBirth: "1990-01-02" })).body.data).toEqual({ outcome: "mismatch" });
    expect((await admin.from("patients").select("identity_verified_by").eq("id", id).single()).data!.identity_verified_by).toBeNull();
    // Guessing is limited per card: five attempts an hour.
    for (let i = 0; i < 3; i++) await verify(id, { document: doc(4 + i), dateOfBirth: "1990-01-01" });
    expect((await verify(id, { document: doc(2), dateOfBirth: "1990-01-01" })).status).toBe(429);
  });

  it("a card with no document yet takes it from the desk; a document already on another card is not copied", async () => {
    const telegramOnly = await card({ telegram_user_id: 700_000_000 + seed });
    asStaff(receptionist, "receptionist");
    expect((await verify(telegramOnly, { document: doc(8), dateOfBirth: "1975-05-05" })).body.data).toEqual({ outcome: "verified" });
    const { data } = await admin.from("patients").select("document_number, date_of_birth, identity_verified_by").eq("id", telegramOnly).single();
    expect(data).toEqual({ document_number: doc(8), date_of_birth: "1975-05-05", identity_verified_by: "reception" });

    const empty = await card({});
    expect((await verify(empty, { document: doc(8), dateOfBirth: "1975-05-05" })).body.data).toEqual({ outcome: "document_in_use" });
    expect((await admin.from("patients").select("document_number").eq("id", empty).single()).data!.document_number).toBeNull();
  });

  it("a JSHSHIR is checked against the date of birth it carries; a card holding the other document asks for that one", async () => {
    const id = await card({ document_number: doc(9), date_of_birth: "1987-03-14" });
    asStaff(receptionist, "receptionist");
    const pinfl = `3140387${String(seed).padStart(7, "0").slice(-7)}`;
    expect((await verify(id, { document: pinfl, dateOfBirth: "1987-03-15" })).body.code).toBe("pinfl_birth_date_mismatch");
    expect((await verify(id, { document: pinfl, dateOfBirth: "1987-03-14" })).body.data).toEqual({ outcome: "other_document" });
  });

  it("only desk roles check documents; another clinic's card is not found", async () => {
    const id = await card({ document_number: doc(10), date_of_birth: "1980-08-08" });
    asStaff(cashier, "cashier");
    expect((await verify(id, { document: doc(10), dateOfBirth: "1980-08-08" })).status).toBe(403);
    asStaff(receptionist, "receptionist");
    expect((await verify(randomUUID(), { document: doc(10), dateOfBirth: "1980-08-08" })).status).toBe(404);
  });
});

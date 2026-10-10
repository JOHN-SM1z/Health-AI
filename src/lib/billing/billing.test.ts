import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";
import { effectiveStatus } from "@/lib/billing/status";
import { changePlan, requestInvoice } from "@/lib/billing/invoices";
import { getClinicSubscription } from "@/lib/billing/subscription";

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

describe("effectiveStatus", () => {
  const now = new Date("2026-10-10T12:00:00Z");
  it("reads trial, trial over, paid, overdue and pilot", () => {
    expect(effectiveStatus("trialing", "2026-10-15T12:00:00Z", null, now)).toEqual({ status: "trialing", daysLeft: 5 });
    expect(effectiveStatus("trialing", "2026-10-09T12:00:00Z", null, now)).toEqual({ status: "trial_ended", daysLeft: -1 });
    expect(effectiveStatus("active", null, "2026-11-10T12:00:00Z", now)).toEqual({ status: "active", daysLeft: 31 });
    expect(effectiveStatus("active", null, "2026-10-01T00:00:00Z", now).status).toBe("past_due");
    expect(effectiveStatus("active", null, null, now)).toEqual({ status: "active", daysLeft: null });
  });
});

describe.skipIf(!localDbAvailable())("subscriptions and invoices (real database)", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const clinicId = randomUUID();
  let platformAdmin = "";
  let owner = "";
  const users: string[] = [];

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    for (const who of ["platform", "owner"]) {
      const { data } = await admin.auth.admin.createUser({ email: `${who}-${suffix}@billing.test`, password: `Pw-${randomUUID()}`, email_confirm: true });
      users.push(data.user!.id);
      await admin.from("profiles").insert({ id: data.user!.id, full_name: who });
    }
    [platformAdmin, owner] = users;
    await admin.from("platform_admins").insert({ profile_id: platformAdmin });
    await admin.from("clinics").insert({ id: clinicId, name: `Billing ${suffix}`, slug: `billing-${suffix}`, is_active: false });
    await admin.from("staff_roles").insert({ clinic_id: clinicId, profile_id: owner, role: "owner" });
    const { data: start } = await admin.from("subscription_plans").select("id").eq("code", "start").single();
    const trialEnd = new Date(Date.now() + 5 * 86_400_000).toISOString();
    await admin.from("clinic_subscriptions").insert({ clinic_id: clinicId, plan_id: start!.id, status: "trialing", trial_ends_at: trialEnd });
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.from("clinics").delete().eq("id", clinicId);
    await admin.from("platform_admins").delete().eq("profile_id", platformAdmin);
    for (const id of users) await admin.auth.admin.deleteUser(id);
  });

  it("an owner gets one open invoice at a time; asking for more months replaces it", async () => {
    const first = await requestInvoice(clinicId, owner, 1);
    expect(await requestInvoice(clinicId, owner, 1)).toBe(first);
    const three = await requestInvoice(clinicId, owner, 3);
    expect(three).not.toBe(first);
    const { data } = await admin.from("subscription_invoices").select("id, status, months, amount_uzs").eq("clinic_id", clinicId).order("issued_at");
    const { data: plan } = await admin.from("subscription_plans").select("monthly_price_uzs").eq("code", "start").single();
    expect(data).toEqual([
      { id: first, status: "void", months: 1, amount_uzs: plan!.monthly_price_uzs },
      { id: three, status: "issued", months: 3, amount_uzs: plan!.monthly_price_uzs * 3 },
    ]);
  });

  it("switching plans reprices the open invoice; a plan smaller than the clinic is refused", async () => {
    await changePlan(clinicId, owner, "klinika");
    const { data: open } = await admin.from("subscription_invoices").select("months, amount_uzs, subscription_plans(code)").eq("clinic_id", clinicId).eq("status", "issued").single();
    const { data: klinika } = await admin.from("subscription_plans").select("monthly_price_uzs").eq("code", "klinika").single();
    expect(open).toMatchObject({ months: 3, amount_uzs: klinika!.monthly_price_uzs * 3, subscription_plans: { code: "klinika" } });

    const { data: tiny } = await admin
      .from("subscription_plans")
      .insert({ code: `zero-${suffix}`, name: "Zero", monthly_price_uzs: 0, max_staff: 1, is_public: true })
      .select("id")
      .single();
    await admin.from("staff_roles").insert({ clinic_id: clinicId, profile_id: platformAdmin, role: "receptionist" });
    await expect(changePlan(clinicId, owner, `zero-${suffix}`)).rejects.toMatchObject({ code: "plan_too_small" });
    await admin.from("staff_roles").delete().eq("clinic_id", clinicId).eq("profile_id", platformAdmin);
    await admin.from("subscription_plans").delete().eq("id", tiny!.id);
  });

  it("only a platform admin confirms a transfer: paid once, period extended from the trial end, clinic switched on", async () => {
    const { data: open } = await admin.from("subscription_invoices").select("id").eq("clinic_id", clinicId).eq("status", "issued").single();

    // Neither the owner nor a signed-in browser session can confirm a payment.
    const ownerTry = await admin.rpc("confirm_subscription_invoice", { p_invoice_id: open!.id, p_admin_id: owner, p_reference: "x" });
    expect(ownerTry.error?.code).toBe("42501");
    const anon = createClient(URL, ANON_KEY, { auth: { persistSession: false } });
    const browserTry = await anon.rpc("confirm_subscription_invoice", { p_invoice_id: open!.id, p_admin_id: platformAdmin, p_reference: "x" });
    expect(browserTry.error).not.toBeNull();
    expect((await admin.from("subscription_invoices").select("status").eq("id", open!.id).single()).data!.status).toBe("issued");

    const { data, error } = await admin.rpc("confirm_subscription_invoice", { p_invoice_id: open!.id, p_admin_id: platformAdmin, p_reference: "PP-000123" });
    expect(error).toBeNull();
    const periodEnd = Date.parse(data![0].period_end);
    // Five trial days left + three months.
    const expected = new Date(Date.now() + 5 * 86_400_000);
    expected.setMonth(expected.getMonth() + 3);
    expect(Math.abs(periodEnd - expected.getTime())).toBeLessThan(2 * 86_400_000);

    const sub = await getClinicSubscription(clinicId);
    expect(sub).toMatchObject({ status: "active", storedStatus: "active", plan: { code: "klinika" } });
    expect((await admin.from("clinics").select("is_active").eq("id", clinicId).single()).data!.is_active).toBe(true);
    const { data: inv } = await admin.from("subscription_invoices").select("status, payment_reference, confirmed_by").eq("id", open!.id).single();
    expect(inv).toEqual({ status: "paid", payment_reference: "PP-000123", confirmed_by: platformAdmin });

    const again = await admin.rpc("confirm_subscription_invoice", { p_invoice_id: open!.id, p_admin_id: platformAdmin, p_reference: "PP-000123" });
    expect(again.error?.details).toBe("invoice_not_open");
    const { data: audit } = await admin.from("audit_events").select("action").eq("clinic_id", clinicId).eq("action", "subscription_invoice_paid");
    expect(audit).toHaveLength(1);
  });

  it("signed-in staff read nothing of subscriptions, invoices or plans, and cannot switch their clinic on", async () => {
    const email = `owner-${suffix}@billing.test`;
    const password = `Pw-${randomUUID()}`;
    await admin.auth.admin.updateUserById(owner, { password });
    const session = createClient(URL, ANON_KEY, { auth: { persistSession: false } });
    await session.auth.signInWithPassword({ email, password });
    for (const table of ["clinic_subscriptions", "subscription_invoices", "subscription_plans", "platform_billing"]) {
      const { error } = await session.from(table).select("*").limit(1);
      expect(error?.code, table).toBe("42501");
    }
    await admin.from("clinics").update({ is_active: false }).eq("id", clinicId);
    const { error } = await session.from("clinics").update({ is_active: true }).eq("id", clinicId);
    expect(error?.code).toBe("42501");
    expect((await admin.from("clinics").select("is_active").eq("id", clinicId).single()).data!.is_active).toBe(false);
    // Display details stay the owner's to edit.
    expect((await session.from("clinics").update({ phone: "+998 71 000 00 00" }).eq("id", clinicId)).error).toBeNull();
  });
});

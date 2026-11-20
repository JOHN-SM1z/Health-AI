import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";
import { signInEmail } from "@/lib/auth/login";
import { clinicSlug, signUpClinic } from "@/lib/clinics/signup";

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

describe("clinicSlug", () => {
  it("makes a URL-safe address from Latin or Cyrillic names", () => {
    expect(clinicSlug("Shifo Nur klinikasi")).toBe("shifo-nur-klinikasi");
    expect(clinicSlug("O‘zbekiston Med")).toBe("ozbekiston-med");
    expect(clinicSlug("Шифо-Нур")).toBe("shifo-nur");
    expect(clinicSlug("A")).toMatch(/^klinika/);
  });
});

describe.skipIf(!localDbAvailable())("clinic sign-up (real database and auth)", () => {
  let admin: SupabaseClient;
  const suffix = Date.now().toString(36);
  const clinics: string[] = [];
  const input = (over: Partial<Parameters<typeof signUpClinic>[0]> = {}) => ({
    clinicName: `Shifo ${suffix}`,
    city: "Toshkent",
    clinicPhone: "+998 71 200 00 00",
    address: "Chilonzor 1",
    ownerName: "Aziza Rahimova",
    ownerPhone: "+998 90 123 45 67",
    login: `aziza.${suffix}`,
    password: `Signup-${suffix}-password`,
    planCode: "start",
    ...over,
  });

  beforeAll(() => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
  });

  afterAll(async () => {
    if (!admin || clinics.length === 0) return;
    const { data: owners } = await admin.from("staff_roles").select("profile_id").in("clinic_id", clinics);
    await admin.from("clinics").delete().in("id", clinics);
    for (const o of owners ?? []) await admin.auth.admin.deleteUser(o.profile_id);
  });

  it("creates the clinic, its owner, starter departments, a 14-day trial and the first invoice — and the owner signs in by login", async () => {
    const result = await signUpClinic(input());
    clinics.push(result.clinicId);

    const { data: clinic } = await admin.from("clinics").select("name, slug, city, is_active").eq("id", result.clinicId).single();
    expect(clinic).toMatchObject({ name: `Shifo ${suffix}`, slug: clinicSlug(`Shifo ${suffix}`), city: "Toshkent", is_active: true });

    const { data: roles } = await admin.from("staff_roles").select("role, profile_id, departments(kind)").eq("clinic_id", result.clinicId);
    expect(roles).toHaveLength(1);
    expect(roles![0]).toMatchObject({ role: "owner", departments: { kind: "management" } });
    const { data: profile } = await admin.from("profiles").select("login, must_change_password").eq("id", roles![0].profile_id).single();
    // The owner chose their own password: nothing to change on first sign-in.
    expect(profile).toEqual({ login: `aziza.${suffix}`, must_change_password: false });

    const { data: departments } = await admin.from("departments").select("kind").eq("clinic_id", result.clinicId);
    expect(departments!.map((d) => d.kind).sort()).toEqual(["cashier", "clinical", "laboratory", "management", "reception"]);

    const { data: sub } = await admin.from("clinic_subscriptions").select("status, trial_ends_at, subscription_plans(code)").eq("clinic_id", result.clinicId).single();
    expect(sub).toMatchObject({ status: "trialing", subscription_plans: { code: "start" } });
    const trialDays = (Date.parse(sub!.trial_ends_at!) - Date.now()) / 86_400_000;
    expect(trialDays).toBeGreaterThan(13.9);
    expect(trialDays).toBeLessThan(14.1);

    const { data: invoices } = await admin.from("subscription_invoices").select("number, status, amount_uzs").eq("clinic_id", result.clinicId);
    const { data: plan } = await admin.from("subscription_plans").select("monthly_price_uzs").eq("code", "start").single();
    expect(invoices).toEqual([{ number: result.invoiceNumber, status: "issued", amount_uzs: plan!.monthly_price_uzs }]);
    expect(result.invoiceNumber).toMatch(/^HA-\d{4}-\d{5}$/);

    const anon = createClient(URL, ANON_KEY, { auth: { persistSession: false } });
    expect((await anon.auth.signInWithPassword({ email: signInEmail(`Aziza.${suffix}`), password: `Signup-${suffix}-password` })).error).toBeNull();
  });

  it("refuses a taken login, and a second clinic with the same name gets its own address", async () => {
    await expect(signUpClinic(input())).rejects.toMatchObject({ status: 409, code: "login_unavailable" });
    const second = await signUpClinic(input({ login: `aziza2.${suffix}` }));
    clinics.push(second.clinicId);
    const { data } = await admin.from("clinics").select("slug").eq("id", second.clinicId).single();
    expect(data!.slug).toMatch(new RegExp(`^${clinicSlug(`Shifo ${suffix}`)}-[0-9a-f]{4}$`));
  });

  it("leaves nothing behind when provisioning fails (unknown plan): no clinic, no login", async () => {
    await expect(signUpClinic(input({ login: `ghost.${suffix}`, clinicName: `Ghost ${suffix}`, planCode: "nope" }))).rejects.toMatchObject({
      status: 400,
      code: "plan_not_found",
    });
    expect((await admin.from("clinics").select("id").eq("slug", clinicSlug(`Ghost ${suffix}`))).data).toEqual([]);
    expect((await admin.from("profiles").select("id").eq("login", `ghost.${suffix}`)).data).toEqual([]);
    const anon = createClient(URL, ANON_KEY, { auth: { persistSession: false } });
    expect((await anon.auth.signInWithPassword({ email: signInEmail(`ghost.${suffix}`), password: `Signup-${suffix}-password` })).error).not.toBeNull();
  });
});

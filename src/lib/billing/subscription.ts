import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { effectiveStatus, type Plan, type SubscriptionView } from "@/lib/billing/status";

/**
 * Clinic subscriptions (migration 20261010000002): a 14-day trial, then monthly invoices paid by bank transfer and
 * confirmed by a platform admin. Payment status is never taken from a browser.
 */

export async function listPublicPlans(): Promise<Plan[]> {
  const { data, error } = await createAdminClient()
    .from("subscription_plans")
    .select("id, code, name, tagline, monthly_price_uzs, max_staff, max_doctors, features, price_is_draft, sort_order, is_public")
    .eq("is_public", true)
    .order("sort_order");
  if (error) throw new ApiError(500, "Tariflarni o‘qib bo‘lmadi");
  return (data ?? []).map(toPlan);
}

export function toPlan(p: {
  id: string;
  code: string;
  name: string;
  tagline: string;
  monthly_price_uzs: number;
  max_staff: number | null;
  max_doctors: number | null;
  features: string[];
  price_is_draft: boolean;
  is_public: boolean;
  sort_order: number;
}): Plan {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    tagline: p.tagline,
    monthlyPriceUzs: p.monthly_price_uzs,
    maxStaff: p.max_staff,
    maxDoctors: p.max_doctors,
    features: p.features,
    priceIsDraft: p.price_is_draft,
    isPublic: p.is_public,
    sortOrder: p.sort_order,
  };
}

/** The clinic's subscription with its effective status, or null for a clinic that has none (treated as pilot). */
export async function getClinicSubscription(clinicId: string, now = new Date()): Promise<SubscriptionView | null> {
  const { data, error } = await createAdminClient()
    .from("clinic_subscriptions")
    .select(
      "status, trial_ends_at, current_period_end, subscription_plans!inner(id, code, name, tagline, monthly_price_uzs, max_staff, max_doctors, features, price_is_draft, sort_order, is_public)",
    )
    .eq("clinic_id", clinicId)
    .maybeSingle();
  if (error) throw new ApiError(500, "Obunani o‘qib bo‘lmadi");
  if (!data) return null;
  const plan = toPlan(data.subscription_plans as Parameters<typeof toPlan>[0]);
  return {
    plan,
    storedStatus: data.status,
    trialEndsAt: data.trial_ends_at,
    currentPeriodEnd: data.current_period_end,
    ...effectiveStatus(data.status, data.trial_ends_at, data.current_period_end, now),
  };
}

/**
 * Plan limits on staff accounts and doctor accounts. A clinic without a subscription row, or on a plan without a
 * limit, has no limit.
 */
export async function assertStaffCapacity(clinicId: string, role: string): Promise<void> {
  const sub = await getClinicSubscription(clinicId);
  if (!sub) return;
  const db = createAdminClient();
  if (sub.plan.maxStaff !== null) {
    const { count } = await db.from("staff_roles").select("id", { count: "exact", head: true }).eq("clinic_id", clinicId);
    if ((count ?? 0) >= sub.plan.maxStaff) {
      throw new ApiError(
        409,
        `“${sub.plan.name}” tarifida ko‘pi bilan ${sub.plan.maxStaff} ta xodim. Tarifni oshirish uchun “Obuna” bo‘limiga o‘ting.`,
        "plan_staff_limit",
      );
    }
  }
  if (role === "doctor" && sub.plan.maxDoctors !== null) {
    const { count } = await db.from("staff_roles").select("id", { count: "exact", head: true }).eq("clinic_id", clinicId).eq("role", "doctor");
    if ((count ?? 0) >= sub.plan.maxDoctors) {
      throw new ApiError(
        409,
        `“${sub.plan.name}” tarifida ko‘pi bilan ${sub.plan.maxDoctors} ta shifokor. Tarifni oshirish uchun “Obuna” bo‘limiga o‘ting.`,
        "plan_doctor_limit",
      );
    }
  }
}

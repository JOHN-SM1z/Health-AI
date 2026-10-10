import { requirePlatformAdmin } from "@/lib/auth/guards";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { effectiveStatus } from "@/lib/billing/status";
import { getPayee } from "@/lib/billing/invoices";
import { toPlan } from "@/lib/billing/subscription";

export const dynamic = "force-dynamic";

/** Everything the platform console shows: clinics with their subscription, open invoices, plans, payee details. */
export async function GET() {
  try {
    await requirePlatformAdmin();
    const db = createAdminClient();
    const [clinics, invoices, plans, staffCounts, payee] = await Promise.all([
      db
        .from("clinics")
        .select(
          "id, name, slug, city, phone, is_active, created_at, clinic_subscriptions(status, trial_ends_at, current_period_end, subscription_plans(code, name)), clinic_telegram_integrations(status, telegram_username)",
        )
        .order("created_at", { ascending: false }),
      db
        .from("subscription_invoices")
        .select("id, number, amount_uzs, months, status, issued_at, due_at, paid_at, payment_reference, clinic_id, clinics(name), subscription_plans(name)")
        .order("issued_at", { ascending: false })
        .limit(200),
      db.from("subscription_plans").select("*").order("sort_order"),
      db.from("staff_roles").select("clinic_id"),
      getPayee(),
    ]);
    if (clinics.error || invoices.error || plans.error) throw new ApiError(500, "Platforma ma’lumotlarini o‘qib bo‘lmadi");

    const staffByClinic = new Map<string, number>();
    for (const r of staffCounts.data ?? []) staffByClinic.set(r.clinic_id, (staffByClinic.get(r.clinic_id) ?? 0) + 1);

    return ok({
      clinics: (clinics.data ?? []).map((c) => {
        const sub = c.clinic_subscriptions;
        return {
          id: c.id,
          name: c.name,
          slug: c.slug,
          city: c.city,
          phone: c.phone,
          isActive: c.is_active,
          createdAt: c.created_at,
          staff: staffByClinic.get(c.id) ?? 0,
          plan: sub?.subscription_plans?.name ?? null,
          ...(sub ? effectiveStatus(sub.status, sub.trial_ends_at, sub.current_period_end) : { status: null, daysLeft: null }),
          periodEnd: sub?.current_period_end ?? sub?.trial_ends_at ?? null,
          bot: c.clinic_telegram_integrations?.telegram_username ?? null,
          botStatus: c.clinic_telegram_integrations?.status ?? null,
        };
      }),
      invoices: (invoices.data ?? []).map((i) => ({
        id: i.id,
        number: i.number,
        amountUzs: i.amount_uzs,
        months: i.months,
        status: i.status,
        issuedAt: i.issued_at,
        dueAt: i.due_at,
        paidAt: i.paid_at,
        reference: i.payment_reference,
        clinicName: i.clinics?.name ?? "",
        planName: i.subscription_plans?.name ?? "",
      })),
      plans: (plans.data ?? []).map(toPlan),
      payee,
    });
  } catch (e) {
    return handleApiError(e);
  }
}

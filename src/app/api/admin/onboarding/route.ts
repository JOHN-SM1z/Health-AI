import { requireRoles } from "@/lib/auth/guards";
import { handleApiError, ok } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { getClinicSubscription } from "@/lib/billing/subscription";

export const dynamic = "force-dynamic";

/** The owner's setup checklist after sign-up: what is done, read from the clinic's own data. */
export async function GET() {
  try {
    const owner = await requireRoles("owner");
    const db = createAdminClient();
    const count = async (table: "departments" | "staff_roles" | "services" | "doctors") =>
      (await db.from(table).select("id", { count: "exact", head: true }).eq("clinic_id", owner.clinicId)).count ?? 0;
    const [departments, staff, services, doctors, bot, subscription] = await Promise.all([
      count("departments"),
      count("staff_roles"),
      count("services"),
      count("doctors"),
      db.from("clinic_telegram_integrations").select("status").eq("clinic_id", owner.clinicId).maybeSingle(),
      getClinicSubscription(owner.clinicId),
    ]);
    const steps = [
      { key: "departments", title: "Bo‘limlarni sozlang", href: "/admin/departments", done: departments > 0 },
      { key: "services", title: "Xizmatlar va narxlarni kiriting", href: "/admin/services", done: services > 0 },
      { key: "doctors", title: "Shifokorlar va ish vaqtini qo‘shing", href: "/admin/doctors", done: doctors > 0 },
      { key: "staff", title: "Xodimlarga login bering", href: "/admin/staff", done: staff > 1 },
      { key: "bot", title: "Telegram botni ulang", href: "/admin/settings", done: bot.data?.status === "active" },
      { key: "billing", title: "Obunani to‘lang", href: "/admin/billing", done: !subscription || (subscription.status === "active") },
    ];
    return ok({ steps, done: steps.filter((s) => s.done).length });
  } catch (e) {
    return handleApiError(e);
  }
}

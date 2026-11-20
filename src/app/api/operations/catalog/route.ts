import { handleApiError, ok, ApiError } from "@/lib/api/errors";
import { requireRoles } from "@/lib/auth/guards";
import { RECEPTION_ROLES, KASSA_ROLES } from "@/lib/auth/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { getOrderableCatalog } from "@/lib/labs/ordering";

export const dynamic = "force-dynamic";

/**
 * Active doctors with the services each offers and the server's price (a
 * doctor's price override, else the catalogue price) — for display only:
 * the charge is always priced again by the database at registration.
 */
export async function GET() {
  try {
    const staff = await requireRoles(...new Set([...RECEPTION_ROLES, ...KASSA_ROLES]));
    const supabase = createAdminClient();
    const [doctors, services, links, clinic, lab] = await Promise.all([
      supabase.from("doctors").select("id, name, title").eq("clinic_id", staff.clinicId).eq("active", true).order("name"),
      supabase.from("services").select("id, name, price").eq("clinic_id", staff.clinicId).eq("active", true).order("sort_order").order("name"),
      supabase.from("doctor_services").select("doctor_id, service_id, price_override, doctors!inner(clinic_id)").eq("doctors.clinic_id", staff.clinicId),
      supabase.from("clinics").select("currency, operating_mode, queue_after_payment, timezone").eq("id", staff.clinicId).single(),
      getOrderableCatalog(staff.clinicId),
    ]);
    if (doctors.error || services.error || links.error || clinic.error) throw new ApiError(500, "Katalogni yuklab bo‘lmadi");
    const all = services.data ?? [];
    const byDoctor = new Map<string, Array<{ service_id: string; price_override: number | null }>>();
    for (const l of links.data ?? []) byDoctor.set(l.doctor_id, [...(byDoctor.get(l.doctor_id) ?? []), l]);
    return ok({
      clinic: clinic.data,
      // The laboratory catalogue for lab walk-ins (prices from the lab catalogue).
      lab: {
        tests: lab.tests.map((t) => ({ id: t.id, name: t.name, price: t.price })),
        panels: lab.panels.map((p) => ({ id: p.id, name: p.name, price: p.price })),
      },
      doctors: (doctors.data ?? []).map((d) => {
        const own = byDoctor.get(d.id);
        // A doctor with an explicit service list offers only those (same rule as the database).
        const offered = own && own.length > 0 ? all.filter((s) => own.some((o) => o.service_id === s.id)) : all;
        return {
          id: d.id,
          name: d.name,
          title: d.title,
          services: offered.map((s) => ({
            id: s.id,
            name: s.name,
            price: Number(own?.find((o) => o.service_id === s.id)?.price_override ?? s.price),
          })),
        };
      }),
    });
  } catch (e) {
    return handleApiError(e);
  }
}

import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getDefaultClinic } from "@/lib/clinics/context";
import { handleApiError, fail, ok } from "@/lib/api/errors";
import { rateLimit, keyFromIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Public catalog for the Mini App booking flow:
 * active services (with prices), doctors, and specialties.
 * Read-only, no patient data involved.
 */
export async function GET(request: NextRequest) {
  try {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const limit = rateLimit({ key: keyFromIp(ip, "catalog"), limit: 60, windowMs: 10_000 });
    if (!limit.ok) return fail("Juda ko‘p so‘rov", 429, "rate_limited");

    const supabase = createAdminClient();
    const clinic = await getDefaultClinic();

    const [services, doctors, specialties, doctorServices] = await Promise.all([
      supabase
        .from("services")
        .select("id, name, description, price, duration_minutes, preparation_text, specialty_id")
        .eq("clinic_id", clinic.id)
        .eq("active", true)
        .order("sort_order"),
      supabase
        .from("doctors")
        .select("id, name, title, specialty_id")
        .eq("clinic_id", clinic.id)
        .eq("active", true),
      supabase
        .from("specialties")
        .select("id, name")
        .eq("clinic_id", clinic.id)
        .eq("active", true)
        .order("sort_order"),
      supabase.from("doctor_services").select("doctor_id, service_id"),
    ]);

    return ok({
      clinic: {
        id: clinic.id,
        name: clinic.name,
        timezone: clinic.timezone,
        currency: clinic.currency,
        phone: clinic.phone,
        address: clinic.address,
        openingHours: clinic.opening_hours,
      },
      services: (services.data ?? []).map((s) => ({
        ...s,
        price: Number(s.price),
        doctors: (doctors.data ?? [])
          .filter(
            (d) =>
              !doctorServices.data?.length ||
              doctorServices.data.some((ds) => ds.service_id === s.id && ds.doctor_id === d.id),
          )
          .map((d) => d.id),
      })),
      doctors: (doctors.data ?? []).map((d) => ({
        id: d.id,
        name: d.name,
        title: d.title,
        specialtyId: d.specialty_id,
      })),
      specialties: (specialties.data ?? []).map((s) => ({ id: s.id, name: s.name })),
    });
  } catch (e) {
    return handleApiError(e);
  }
}
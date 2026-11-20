import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { parseBody } from "@/lib/api/validate";
import { requireRoles } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordAudit } from "@/lib/audit";
import { activeSmsProvider } from "@/lib/sms/provider";
import { activeOnlineProvider } from "@/lib/payments/online/service";

export const dynamic = "force-dynamic";

/**
 * The owner's switches for the online services (Slices B–D): online identity required for Mini App bookings, and
 * queue SMS. Also says which services the server is configured for (online payment provider, SMS provider), so the
 * owner sees why a switch has no effect yet.
 */
async function read(clinicId: string) {
  const { data, error } = await createAdminClient().from("clinics").select("online_identity_required, sms_enabled").eq("id", clinicId).single();
  if (error || !data) throw new ApiError(500, "Sozlamalarni yuklab bo‘lmadi");
  return {
    onlineIdentityRequired: data.online_identity_required,
    smsEnabled: data.sms_enabled,
    smsProvider: activeSmsProvider()?.name ?? null,
    onlinePaymentProvider: activeOnlineProvider()?.name ?? null,
  };
}

export async function GET() {
  try {
    const staff = await requireRoles("owner");
    return ok(await read(staff.clinicId));
  } catch (e) {
    return handleApiError(e);
  }
}

const schema = z.object({ onlineIdentityRequired: z.boolean().optional(), smsEnabled: z.boolean().optional() }).strict();

export async function PATCH(request: NextRequest) {
  try {
    const staff = await requireRoles("owner");
    const body = await parseBody(request, schema);
    const update = {
      ...(body.onlineIdentityRequired === undefined ? {} : { online_identity_required: body.onlineIdentityRequired }),
      ...(body.smsEnabled === undefined ? {} : { sms_enabled: body.smsEnabled }),
    };
    if (Object.keys(update).length === 0) throw new ApiError(400, "O‘zgarish yo‘q", "validation");
    const { error } = await createAdminClient().from("clinics").update(update).eq("id", staff.clinicId);
    if (error) throw new ApiError(500, "Saqlab bo‘lmadi");
    await recordAudit({
      clinicId: staff.clinicId,
      action: "clinic_online_features_changed",
      entityType: "clinics",
      entityId: staff.clinicId,
      actor: { actorType: "staff", actorId: staff.profileId },
      newValues: update,
    });
    return ok(await read(staff.clinicId));
  } catch (e) {
    return handleApiError(e);
  }
}

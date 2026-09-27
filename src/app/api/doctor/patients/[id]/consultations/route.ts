import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { startConsultation } from "@/lib/clinical-access/consultations";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

// Either the doctor's visit booked for today, or a walk-in for a service.
const startSchema = z
  .object({ appointmentId: uuidSchema.optional(), serviceId: uuidSchema.optional() })
  .refine((b) => !!b.appointmentId !== !!b.serviceId, "Qabul yoki xizmatni tanlang");

/** The calling doctor starts their own consultation with this patient. */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const doctor = await requireLinkedDoctor();
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Bemor topilmadi", "patient_not_found");
    const body = await parseBody(request, startSchema);
    const consultation = await startConsultation(doctor, id, body);
    return ok({ consultation }, { status: consultation.started ? 201 : 200 });
  } catch (e) {
    return handleApiError(e);
  }
}

import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { requireLabCapability, resolveLabResultAccess } from "@/lib/labs/guards";
import { labCan } from "@/lib/labs/permissions";
import { cancelLabOrder, orderPatientId } from "@/lib/labs/collection";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const schema = z.object({ action: z.literal("cancel"), reason: z.string().trim().min(1).max(300) });

/**
 * Cancels a lab order before any of its samples is collected (order.cancel:
 * every staff member of the clinic). The work-queue roles cancel any order of
 * their clinic; a doctor only an order of a patient they may access
 * (doctor_patient_access). The database refuses a collected order.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const staff = await requireLabCapability("order.cancel");
    const { id } = await ctx.params;
    if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Buyurtma topilmadi", "order_not_found");
    const body = await parseBody(request, schema);
    if (!labCan(staff.roles, "queue.read")) {
      const patientId = await orderPatientId(staff, id);
      if (!patientId || (await resolveLabResultAccess(staff, patientId)).kind !== "doctor") {
        throw new ApiError(404, "Buyurtma topilmadi", "order_not_found");
      }
    }
    return ok(await cancelLabOrder(staff, id, body.reason));
  } catch (e) {
    return handleApiError(e);
  }
}

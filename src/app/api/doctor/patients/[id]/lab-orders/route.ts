import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { createDoctorLabOrder, getPatientLabOrders, RECENT_TEST_DAYS } from "@/lib/labs/ordering";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

async function patientIdOf(ctx: RouteContext): Promise<string> {
  const { id } = await ctx.params;
  if (!uuidSchema.safeParse(id).success) throw new ApiError(404, "Bemor topilmadi", "patient_not_found");
  return id;
}

/** The patient's lab orders with each test's status (never result values). */
export async function GET(_request: NextRequest, ctx: RouteContext) {
  try {
    const doctor = await requireLinkedDoctor();
    const orders = await getPatientLabOrders(doctor, await patientIdOf(ctx));
    return ok({ orders, recentTestDays: RECENT_TEST_DAYS });
  } catch (e) {
    return handleApiError(e);
  }
}

// Only ids: clinic, patient, orderer and prices are decided on the server.
const orderSchema = z
  .object({
    idempotencyKey: uuidSchema,
    appointmentId: uuidSchema.nullable().optional(),
    testIds: z.array(uuidSchema).max(50).default([]),
    panelIds: z.array(uuidSchema).max(50).default([]),
  })
  .refine((b) => b.testIds.length + b.panelIds.length > 0, { message: "Kamida bitta tahlil yoki panel tanlang" });

/** The calling doctor orders lab tests for this patient (optionally from their own consultation). */
export async function POST(request: NextRequest, ctx: RouteContext) {
  try {
    const doctor = await requireLinkedDoctor();
    const patientId = await patientIdOf(ctx);
    const body = await parseBody(request, orderSchema);
    const result = await createDoctorLabOrder(doctor, patientId, {
      appointmentId: body.appointmentId ?? null,
      testIds: body.testIds,
      panelIds: body.panelIds,
      creationKey: body.idempotencyKey,
    });
    return ok(result, { status: result.replayed ? 200 : 201 });
  } catch (e) {
    return handleApiError(e);
  }
}

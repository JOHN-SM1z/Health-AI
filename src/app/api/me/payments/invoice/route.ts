import type { NextRequest } from "next/server";
import { z } from "zod";
import { handleApiError, ok } from "@/lib/api/errors";
import { requireMiniAppPatientWith } from "@/lib/patients/mini-app-patient";
import { createOnlineCheckout } from "@/lib/payments/online/service";

export const dynamic = "force-dynamic";

const schema = z.object({ initData: z.string().nullable().optional(), appointmentId: z.string().uuid() });

/** The patient's own booking → a checkout link. The amount is the server's price, never one from the browser. */
export async function POST(request: NextRequest) {
  try {
    const { clinic, patient, body } = await requireMiniAppPatientWith(request, "my-payments", schema);
    return ok(await createOnlineCheckout(clinic.id, patient.id, body.appointmentId));
  } catch (e) {
    return handleApiError(e);
  }
}

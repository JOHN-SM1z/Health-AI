import type { NextRequest } from "next/server";
import { z } from "zod";
import { handleApiError, ok } from "@/lib/api/errors";
import { requireMiniAppPatientWith } from "@/lib/patients/mini-app-patient";
import { onlinePaymentStatus } from "@/lib/payments/online/service";

export const dynamic = "force-dynamic";

const schema = z.object({ initData: z.string().nullable().optional(), appointmentId: z.string().uuid() });

/** Paid? and the queue number — only what the server has verified, never the browser's word. */
export async function POST(request: NextRequest) {
  try {
    const { clinic, patient, body } = await requireMiniAppPatientWith(request, "my-payments", schema);
    return ok(await onlinePaymentStatus(clinic.id, patient.id, body.appointmentId));
  } catch (e) {
    return handleApiError(e);
  }
}

import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { requireMiniAppPatientWith } from "@/lib/patients/mini-app-patient";
import { sharedRateLimit } from "@/lib/rate-limit-shared";
import { detectUrgency, urgentMessage, NOT_DIAGNOSIS_DISCLAIMER } from "@/lib/safety/policy";
import { routeConcern } from "@/lib/booking/router";
import { escalateUrgentFromMiniApp } from "@/lib/telegram/handlers";

export const dynamic = "force-dynamic";

const schema = z.object({ initData: z.string().nullable().optional(), text: z.string().trim().min(2).max(300) });

/**
 * The patient's concern in their own words → which of the clinic's directions to book (a suggestion the patient
 * confirms or changes; never a diagnosis). Urgent wording is escalated to staff and answered with the approved
 * urgent-care message — no booking is offered. The text is not stored here; it travels with the booking as its note.
 */
export async function POST(request: NextRequest) {
  try {
    const { clinic, patient, body } = await requireMiniAppPatientWith(request, "mini-app-concern", schema);
    const limit = await sharedRateLimit({ key: `mini-app-concern:${clinic.id}:${patient.id}`, limit: 20, windowMs: 3_600_000 });
    if (!limit.ok) throw new ApiError(429, "Juda ko‘p so‘rov", "rate_limited");

    if (detectUrgency(body.text) === "urgent") {
      if (patient.telegram_user_id) {
        await escalateUrgentFromMiniApp({
          clinicId: clinic.id,
          patientId: patient.id,
          telegramUserId: patient.telegram_user_id,
          text: body.text,
          patientLabel: patient.telegram_username ? `@${patient.telegram_username}` : String(patient.telegram_user_id),
        });
      }
      return ok({ urgent: true, message: urgentMessage(body.text), clinicPhone: clinic.phone ?? null });
    }
    return ok({ urgent: false, disclaimer: NOT_DIAGNOSIS_DISCLAIMER, ...(await routeConcern(clinic.id, body.text)) });
  } catch (e) {
    return handleApiError(e);
  }
}

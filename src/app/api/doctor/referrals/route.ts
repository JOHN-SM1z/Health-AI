import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { handleApiError, ok } from "@/lib/api/errors";
import { createReferral, listReferralsForDoctor } from "@/lib/referrals/service";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  appointmentId: uuidSchema,
  referredToDoctorId: uuidSchema,
  reason: z.string().trim().min(3, "Yo‘llanma sababini yozing").max(2000),
  handoffNote: z.string().trim().max(4000).optional(),
  priority: z.enum(["routine", "urgent"]).default("routine"),
  validForDays: z.union([z.literal(30), z.literal(60), z.literal(90), z.literal(180)]).optional(),
});

/** The calling doctor's referrals: ?box=incoming (default) or ?box=outgoing. */
export async function GET(request: NextRequest) {
  try {
    const doctor = await requireLinkedDoctor();
    const box = request.nextUrl.searchParams.get("box") === "outgoing" ? "outgoing" : "incoming";
    return ok({ referrals: await listReferralsForDoctor(doctor, box) });
  } catch (e) {
    return handleApiError(e);
  }
}

/** Refers the patient of one of the calling doctor's consultations to a colleague. */
export async function POST(request: NextRequest) {
  try {
    const doctor = await requireLinkedDoctor();
    const body = await parseBody(request, createSchema);
    const referral = await createReferral(doctor, body);
    return ok({ referral }, { status: 201 });
  } catch (e) {
    return handleApiError(e);
  }
}

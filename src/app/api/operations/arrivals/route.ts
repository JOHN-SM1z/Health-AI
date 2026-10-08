import type { NextRequest } from "next/server";
import { z } from "zod";
import { handleApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { requireRoles } from "@/lib/auth/guards";
import { RECEPTION_ROLES, KASSA_ROLES } from "@/lib/auth/staff";
import { listOpenVisits, registerArrival } from "@/lib/operations/outpatient";

export const dynamic = "force-dynamic";

const newPatient = z.object({
  fullName: z.string().trim().min(2, "F.I.Sh. kiriting").max(120),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tug‘ilgan sanani kiriting"),
  sex: z.enum(["female", "male"]).nullish(),
  phone: z.string().trim().max(24).nullish(),
  documentNumber: z.string().trim().max(24).nullish(),
  pinfl: z.string().trim().max(20).nullish(),
});

// No clinic, actor, price, amount or status here: the session and the
// database decide those.
const schema = z
  .object({
    key: uuidSchema,
    patientId: uuidSchema.nullish(),
    newPatient: newPatient.nullish(),
    doctorId: uuidSchema,
    serviceIds: z.array(uuidSchema).min(1, "Xizmatni tanlang").max(10),
  })
  .strict()
  .refine((b) => !!b.patientId !== !!b.newPatient, { message: "Bemorni tanlang yoki yangi bemor kiriting" });

/** The live queue: every unfinished visit, from any day (nobody disappears at midnight). */
export async function GET(request: NextRequest) {
  try {
    const staff = await requireRoles(...new Set([...RECEPTION_ROLES, ...KASSA_ROLES]));
    const doctorId = request.nextUrl.searchParams.get("doctor");
    const visits = await listOpenVisits(staff.clinicId, { doctorId: doctorId && uuidSchema.safeParse(doctorId).success ? doctorId : undefined });
    return ok({ visits, at: new Date().toISOString() });
  } catch (e) {
    return handleApiError(e);
  }
}

/** Registers an arrival (and a new patient when needed) in one database transaction. */
export async function POST(request: NextRequest) {
  try {
    const staff = await requireRoles(...RECEPTION_ROLES);
    const body = await parseBody(request, schema);
    const result = await registerArrival(staff, body);
    return ok(result, { status: result.replayed ? 200 : 201 });
  } catch (e) {
    return handleApiError(e);
  }
}

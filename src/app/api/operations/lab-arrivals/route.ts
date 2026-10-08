import type { NextRequest } from "next/server";
import { z } from "zod";
import { handleApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { requireRoles } from "@/lib/auth/guards";
import { RECEPTION_ROLES } from "@/lib/auth/staff";
import { registerLabArrival } from "@/lib/operations/outpatient";

export const dynamic = "force-dynamic";

const newPatient = z.object({
  fullName: z.string().trim().min(2, "F.I.Sh. kiriting").max(120),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tug‘ilgan sanani kiriting"),
  sex: z.enum(["female", "male"]).nullish(),
  phone: z.string().trim().max(24).nullish(),
  documentNumber: z.string().trim().max(24).nullish(),
  pinfl: z.string().trim().max(20).nullish(),
});

// Tests and panels only: prices, clinic and actor come from the server.
const schema = z
  .object({
    key: uuidSchema,
    patientId: uuidSchema.nullish(),
    newPatient: newPatient.nullish(),
    testIds: z.array(uuidSchema).max(50).default([]),
    panelIds: z.array(uuidSchema).max(50).default([]),
  })
  .strict()
  .refine((b) => !!b.patientId !== !!b.newPatient, { message: "Bemorni tanlang yoki yangi bemor kiriting" })
  .refine((b) => b.testIds.length + b.panelIds.length > 0, { message: "Kamida bitta tahlil tanlang" });

/** Reception registers a laboratory walk-in (tests on the visit's bill; the lab queue number comes with payment). */
export async function POST(request: NextRequest) {
  try {
    const staff = await requireRoles(...RECEPTION_ROLES);
    const body = await parseBody(request, schema);
    const result = await registerLabArrival(staff, body);
    return ok(result, { status: result.replayed ? 200 : 201 });
  } catch (e) {
    return handleApiError(e);
  }
}

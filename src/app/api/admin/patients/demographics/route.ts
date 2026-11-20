import type { NextRequest } from "next/server";
import { requireRoles } from "@/lib/auth/guards";
import { handleApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { atLeastOneDemographic, demographicsFields, updatePatientDemographics } from "@/lib/patients/demographics";

export const dynamic = "force-dynamic";

const schema = demographicsFields
  .extend({ patientId: uuidSchema })
  .refine(atLeastOneDemographic, "Tug‘ilgan sana yoki jinsni kiriting");

/**
 * Records a patient's date of birth and sex (front desk and management, the
 * same roles as the patient card). The date of birth is required before a
 * lab test can be ordered; sex selects sex-specific reference ranges. The
 * clinic comes from the session; the change is audited without its values.
 * Write-only: the answer says whether each value is recorded, never what it is.
 */
export async function PATCH(request: NextRequest) {
  try {
    const staff = await requireRoles("owner", "admin", "manager", "receptionist");
    const { patientId, ...input } = await parseBody(request, schema);
    return ok(await updatePatientDemographics(staff, patientId, input));
  } catch (e) {
    return handleApiError(e);
  }
}

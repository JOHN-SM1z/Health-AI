import { requireStaff } from "@/lib/auth/guards";
import { requirePatientClinicalAccess } from "@/lib/referrals/access";
import { createAdminClient } from "@/lib/supabase/admin";
import { handleApiError, ok, ApiError } from "@/lib/api/errors";
import { uuidSchema } from "@/lib/api/validate";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, { params }: { params: Promise<{id:string}> }) {
  try {
    const ctx = await requireStaff("doctor");
    const id = uuidSchema.parse((await params).id);
    await requirePatientClinicalAccess(ctx, id);
    const { data, error } = await createAdminClient().from("patients")
      .select("id,full_name,phone,patient_number").eq("id", id).eq("clinic_id", ctx.clinicId).single();
    if (error || !data) throw new ApiError(404, "Bemor topilmadi");
    return ok({patient:data});
  } catch (e) { return handleApiError(e); }
}

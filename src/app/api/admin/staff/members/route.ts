import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireRoles } from "@/lib/auth/guards";
import { parseBody, nameSchema, uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { ASSIGNABLE_ROLES, addStaffMember, changeStaffRole, listClinicStaff, removeStaffMember } from "@/lib/staff/manage";

export const dynamic = "force-dynamic";

const roleSchema = z.enum(ASSIGNABLE_ROLES);
const addSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  fullName: nameSchema,
  role: roleSchema,
});
const changeSchema = z.object({ profileId: uuidSchema, role: roleSchema });
const removeSchema = z.object({ profileId: uuidSchema });

/**
 * The clinic owner's staff list (names, sign-in emails, roles). Owner only:
 * emails and account management never reach other roles.
 */
export async function GET() {
  try {
    const owner = await requireRoles("owner");
    return ok({ staff: await listClinicStaff(owner.clinicId, owner.profileId) });
  } catch (e) {
    return handleApiError(e);
  }
}

/** Adds a member. A new account's temporary password is returned this once, to hand over. */
export async function POST(request: NextRequest) {
  try {
    const owner = await requireRoles("owner");
    const body = await parseBody(request, addSchema);
    const added = await addStaffMember({ clinicId: owner.clinicId, actorId: owner.profileId, ...body });
    return ok(added, { status: 201 });
  } catch (e) {
    return handleApiError(e);
  }
}

/** Changes a member's role (never an owner's, never the owner's own). */
export async function PATCH(request: NextRequest) {
  try {
    const owner = await requireRoles("owner");
    const body = await parseBody(request, changeSchema);
    await changeStaffRole({ clinicId: owner.clinicId, actorId: owner.profileId, ...body });
    return ok({ updated: true });
  } catch (e) {
    return handleApiError(e);
  }
}

/** Removes a member's access to this clinic; their sessions lose it on the next request. */
export async function DELETE(request: NextRequest) {
  try {
    const owner = await requireRoles("owner");
    const parsed = removeSchema.safeParse({ profileId: request.nextUrl.searchParams.get("profileId") });
    if (!parsed.success) throw new ApiError(400, "Xodim ko‘rsatilmagan", "validation_error");
    await removeStaffMember({ clinicId: owner.clinicId, actorId: owner.profileId, ...parsed.data });
    return ok({ removed: true });
  } catch (e) {
    return handleApiError(e);
  }
}

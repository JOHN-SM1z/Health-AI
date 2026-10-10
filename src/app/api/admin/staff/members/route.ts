import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireRoles } from "@/lib/auth/guards";
import { parseBody, nameSchema, uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { LOGIN_PATTERN } from "@/lib/auth/login";
import {
  ASSIGNABLE_ROLES,
  addStaffMember,
  changeStaffRole,
  listClinicStaff,
  removeStaffMember,
  resetStaffPassword,
  setStaffDepartment,
} from "@/lib/staff/manage";

export const dynamic = "force-dynamic";

const roleSchema = z.enum(ASSIGNABLE_ROLES);
const loginSchema = z.string().trim().toLowerCase().regex(LOGIN_PATTERN, "Login 3–32 belgi: lotin harflari, raqamlar, nuqta, chiziqcha");
const addSchema = z
  .object({ login: loginSchema, fullName: nameSchema, role: roleSchema, departmentId: uuidSchema.nullable().optional() })
  .strict();
const changeSchema = z.union([
  z.object({ profileId: uuidSchema, role: roleSchema }).strict(),
  z.object({ profileId: uuidSchema, departmentId: uuidSchema.nullable() }).strict(),
  z.object({ profileId: uuidSchema, resetPassword: z.literal(true) }).strict(),
]);
const removeSchema = z.object({ profileId: uuidSchema });

/**
 * The clinic owner's staff list (names, logins, roles, departments). Owner only: account management never reaches
 * other roles.
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

/**
 * Changes a member's role (never an owner's, never the owner's own), moves them to a department, or sets a new
 * temporary password for them (returned this once).
 */
export async function PATCH(request: NextRequest) {
  try {
    const owner = await requireRoles("owner");
    const body = await parseBody(request, changeSchema);
    const base = { clinicId: owner.clinicId, actorId: owner.profileId, profileId: body.profileId };
    if ("role" in body) {
      await changeStaffRole({ ...base, role: body.role });
      return ok({ updated: true });
    }
    if ("departmentId" in body) {
      await setStaffDepartment({ ...base, departmentId: body.departmentId });
      return ok({ updated: true });
    }
    return ok(await resetStaffPassword(base));
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

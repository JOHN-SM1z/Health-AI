import { NextResponse } from "next/server";
import { canViewPaymentDynamics, getStaffContext, isCallCenterStaff } from "@/lib/auth/staff";
import { getPermissions } from "@/lib/auth/permissions";
import { handleApiError, ok } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

/** Current staff identity + roles (no secrets). Used for role-aware UI. */
export async function GET() {
  try {
    const ctx = await getStaffContext();
    if (!ctx) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    return ok({
      profileId: ctx.profileId,
      clinicId: ctx.clinicId,
      clinicName: ctx.clinicName,
      clinicTimezone: ctx.clinicTimezone,
      roles: ctx.roles,
      platformAdmin: ctx.platformAdmin,
      canViewPaymentDynamics: canViewPaymentDynamics(ctx),
      isCallCenterStaff: isCallCenterStaff(ctx),
      permissions: [...getPermissions(ctx.roles)],
    });
  } catch (e) {
    return handleApiError(e);
  }
}

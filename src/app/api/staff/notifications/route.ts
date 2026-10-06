import type { NextRequest } from "next/server";
import { z } from "zod";
import { handleApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { requireRoles } from "@/lib/auth/guards";
import { listStaffNotifications, markStaffNotificationsRead } from "@/lib/labs/staff-notifications";

export const dynamic = "force-dynamic";

const ANY_STAFF = ["owner", "manager", "admin", "receptionist", "doctor", "lab"] as const;

/** The signed-in staff member's own lab notifications (no values, no clinical text). */
export async function GET() {
  try {
    const staff = await requireRoles(...ANY_STAFF);
    return ok(await listStaffNotifications(staff));
  } catch (e) {
    return handleApiError(e);
  }
}

const schema = z.object({ action: z.literal("read"), ids: z.array(uuidSchema).max(200).nullable().default(null) });

/** Marks the caller's own notifications read (the given ones, or all). */
export async function POST(request: NextRequest) {
  try {
    const staff = await requireRoles(...ANY_STAFF);
    const body = await parseBody(request, schema);
    return ok(await markStaffNotificationsRead(staff, body.ids));
  } catch (e) {
    return handleApiError(e);
  }
}

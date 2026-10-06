import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireRoles } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { labCommand } from "@/lib/laboratory/contracts";
import type { Json } from "@/lib/supabase/database.types";

async function execute(action: string, payload: Json) {
  const ctx = await requireRoles("doctor");
  const { data, error } = await createAdminClient().rpc("lab_workbench", {
    p_clinic: ctx.clinicId, p_actor: ctx.profileId, p_action: action, p_payload: payload,
  });
  if (error) throw new ApiError(error.code === "42501" ? 403 : 409,
    error.code === "42501" ? "Bemor laboratoriya ma’lumotlariga ruxsat yo‘q" : "Amal bajarilmadi. Holatni yangilang va ma’lumotlarni tekshiring.");
  return ok(data, { headers: { "Cache-Control": "private, no-store" } });
}
export async function GET(request: NextRequest) {
  try {
    const orderId = request.nextUrl.searchParams.get("orderId");
    if (orderId) return await execute("read", { orderId: uuidSchema.parse(orderId) });
    const page = z.coerce.number().int().min(0).max(10000).parse(request.nextUrl.searchParams.get("page") ?? 0);
    return await execute("list", { page });
  } catch (e) { return handleApiError(e); }
}
export async function POST(request: NextRequest) {
  try {
    const { action, ...payload } = await parseBody(request, labCommand);
    return await execute(action, payload);
  } catch (e) { return handleApiError(e); }
}

import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireRoles } from "@/lib/auth/guards";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const KINDS = ["clinical", "laboratory", "reception", "cashier", "management", "other"] as const;
const nameSchema = z.string().trim().min(2, "Bo‘lim nomi kamida 2 belgi").max(80);
const createSchema = z.object({ name: nameSchema, kind: z.enum(KINDS).default("clinical") }).strict();
const updateSchema = z.object({ id: uuidSchema, name: nameSchema.optional(), kind: z.enum(KINDS).optional() }).strict();

/**
 * The clinic's departments (bo‘limlar): they organise staff; access stays by role. Management reads them; the owner
 * and administrators change them.
 */
export async function GET() {
  try {
    const staff = await requireRoles("owner", "admin", "manager");
    const db = createAdminClient();
    const [{ data: departments, error }, { data: members }] = await Promise.all([
      db.from("departments").select("id, name, kind, sort_order").eq("clinic_id", staff.clinicId).order("sort_order").order("name"),
      db.from("staff_roles").select("department_id").eq("clinic_id", staff.clinicId).not("department_id", "is", null),
    ]);
    if (error) throw new ApiError(500, "Bo‘limlarni o‘qib bo‘lmadi");
    const counts = new Map<string, number>();
    for (const m of members ?? []) counts.set(m.department_id!, (counts.get(m.department_id!) ?? 0) + 1);
    return ok({
      departments: (departments ?? []).map((d) => ({ id: d.id, name: d.name, kind: d.kind, members: counts.get(d.id) ?? 0 })),
    });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function POST(request: NextRequest) {
  try {
    const staff = await requireRoles("owner", "admin");
    const body = await parseBody(request, createSchema);
    const db = createAdminClient();
    const { count } = await db.from("departments").select("id", { count: "exact", head: true }).eq("clinic_id", staff.clinicId);
    const { data, error } = await db
      .from("departments")
      .insert({ clinic_id: staff.clinicId, name: body.name, kind: body.kind, sort_order: (count ?? 0) + 1 })
      .select("id")
      .single();
    if (error?.code === "23505") throw new ApiError(409, "Bunday nomli bo‘lim bor", "department_exists");
    if (error || !data) throw new ApiError(500, "Bo‘limni saqlab bo‘lmadi");
    await recordAudit({
      clinicId: staff.clinicId,
      action: "department_created",
      entityType: "departments",
      entityId: data.id,
      actor: { actorId: staff.profileId, actorType: "staff" },
      newValues: { kind: body.kind },
    });
    return ok({ id: data.id }, { status: 201 });
  } catch (e) {
    return handleApiError(e);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const staff = await requireRoles("owner", "admin");
    const body = await parseBody(request, updateSchema);
    const update = { ...(body.name ? { name: body.name } : {}), ...(body.kind ? { kind: body.kind } : {}) };
    if (Object.keys(update).length === 0) throw new ApiError(400, "O‘zgarish yo‘q", "validation");
    const { data, error } = await createAdminClient()
      .from("departments")
      .update(update)
      .eq("id", body.id)
      .eq("clinic_id", staff.clinicId)
      .select("id");
    if (error?.code === "23505") throw new ApiError(409, "Bunday nomli bo‘lim bor", "department_exists");
    if (error) throw new ApiError(500, "Bo‘limni saqlab bo‘lmadi");
    if (!data?.length) throw new ApiError(404, "Bo‘lim topilmadi", "department_not_found");
    return ok({ updated: true });
  } catch (e) {
    return handleApiError(e);
  }
}

/** Deleting a department keeps its members; they are left without a department. */
export async function DELETE(request: NextRequest) {
  try {
    const staff = await requireRoles("owner", "admin");
    const parsed = uuidSchema.safeParse(request.nextUrl.searchParams.get("id"));
    if (!parsed.success) throw new ApiError(400, "Bo‘lim ko‘rsatilmagan", "validation");
    const { data, error } = await createAdminClient()
      .from("departments")
      .delete()
      .eq("id", parsed.data)
      .eq("clinic_id", staff.clinicId)
      .select("id");
    if (error) throw new ApiError(500, "Bo‘limni o‘chirib bo‘lmadi");
    if (!data?.length) throw new ApiError(404, "Bo‘lim topilmadi", "department_not_found");
    await recordAudit({
      clinicId: staff.clinicId,
      action: "department_deleted",
      entityType: "departments",
      entityId: parsed.data,
      actor: { actorId: staff.profileId, actorType: "staff" },
    });
    return ok({ deleted: true });
  } catch (e) {
    return handleApiError(e);
  }
}

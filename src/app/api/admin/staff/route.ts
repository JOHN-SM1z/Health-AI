import { randomBytes } from "node:crypto";
import { z } from "zod";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaff } from "@/lib/auth/guards";
import { handleApiError, ApiError, ok } from "@/lib/api/errors";
import type { StaffRole } from "@/lib/auth/staff";

export const dynamic = "force-dynamic";

const SELECTABLE_ROLES: StaffRole[] = ["owner", "admin", "manager", "doctor", "receptionist"];

/**
 * Minimal staff directory for privileged clinic configuration screens.
 * It intentionally exposes only the selected role and name — never emails,
 * auth metadata, or staff from another clinic.
 */
export async function GET(request: NextRequest) {
  try {
    const staff = await requireStaff("admin");
    const requestedRole = request.nextUrl.searchParams.get("role") as StaffRole | null;
    const role = requestedRole && SELECTABLE_ROLES.includes(requestedRole) ? requestedRole : null;
    const supabase = createAdminClient();

    let query = supabase
      .from("staff_roles")
      .select("profile_id, role, profiles!inner(full_name)")
      .eq("clinic_id", staff.clinicId)
      .order("created_at", { ascending: true });
    if (role) query = query.eq("role", role);
    const { data, error } = await query;
    if (error) throw error;

    return ok({
      staff: (data ?? []).map((member) => ({
        profileId: member.profile_id,
        fullName: member.profiles?.full_name?.trim() || "Nomsiz xodim",
        role: member.role,
      })),
    });
  } catch (e) {
    return handleApiError(e);
  }
}

const roleSchema = z.enum(["owner", "admin", "manager", "doctor", "receptionist"]);
const createSchema = z.object({email:z.email(),fullName:z.string().trim().min(2).max(120),role:roleSchema,password:z.string().min(12).max(128).optional()}).strict();
export async function POST(request: NextRequest) {
  try {
    const staff = await requireStaff("owner");
    const body = await parseBody(request, createSchema);
    const supabase = createAdminClient();
    const initialPassword = body.password ?? randomBytes(24).toString("base64url");
    const {data, error} = await supabase.auth.admin.createUser({email:body.email,password:initialPassword,email_confirm:true});
    if (error || !data.user) throw new ApiError(409,"Hisob yaratilmadi. Email band bo‘lishi mumkin");
    const id = data.user.id;
    try {
      const {error:profileError} = await supabase.from("profiles").upsert({id,full_name:body.fullName});
      if (profileError) throw new Error("profile failed");
      const {error:roleError} = await supabase.rpc("manage_clinic_staff",{p_clinic:staff.clinicId,p_actor:staff.profileId,p_target:id,p_role:body.role,p_action:"add"});
      if (roleError) throw new Error("membership failed");
    } catch {
      await supabase.auth.admin.deleteUser(id);
      throw new ApiError(500,"Xodim a’zoligi saqlanmadi");
    }
    return ok({profileId:id,oneTimePassword:body.password?null:initialPassword}, {headers:{"Cache-Control":"no-store"}});
  } catch(e) {return handleApiError(e);}
}
export async function PATCH(request: NextRequest) {
  try {
    const staff = await requireStaff("owner");
    const body = await parseBody(request,z.object({profileId:uuidSchema,role:roleSchema}).strict());
    if (body.profileId===staff.profileId) throw new ApiError(400,"O‘z rolingizni o‘zgartira olmaysiz");
    const {error} = await createAdminClient().rpc("manage_clinic_staff",{p_clinic:staff.clinicId,p_actor:staff.profileId,p_target:body.profileId,p_role:body.role,p_action:"change"});
    if (error) throw new ApiError(409,"Rol o‘zgarmadi. A’zolikni yangilang");
    return ok({updated:true});
  } catch(e) {return handleApiError(e);}
}
export async function DELETE(request: NextRequest) {
  try {
    const staff = await requireStaff("owner");
    const id = uuidSchema.parse(request.nextUrl.searchParams.get("profileId"));
    if (id===staff.profileId) throw new ApiError(400,"O‘zingizni o‘chira olmaysiz");
    const {error} = await createAdminClient().rpc("manage_clinic_staff",{p_clinic:staff.clinicId,p_actor:staff.profileId,p_target:id,p_role:null,p_action:"remove"});
    if (error) throw new ApiError(409,"A’zolik o‘zgarmadi. Ro‘yxatni yangilang");
    return ok({removed:true});
  } catch(e) {return handleApiError(e);}
}

import "server-only";
import { randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import type { StaffRole } from "@/lib/auth/staff";

/**
 * The clinic owner's staff management: who may sign in to this clinic's
 * panels, and in which role. Accounts are created here with a temporary
 * password the owner hands over once (never stored, never logged); the
 * member changes it after signing in.
 *
 * The owner role is not managed here — it is assigned when a clinic is set
 * up — and an owner never changes or removes their own access.
 */

export const ASSIGNABLE_ROLES = ["admin", "manager", "receptionist", "cashier", "doctor", "lab"] as const satisfies readonly StaffRole[];
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export type StaffMember = {
  profileId: string;
  fullName: string;
  email: string | null;
  role: StaffRole;
  isSelf: boolean;
  /** For doctors: the doctor record this account is linked to, if any. */
  linkedDoctorName: string | null;
};

const MEMBER_NOT_FOUND = () => new ApiError(404, "Xodim topilmadi", "staff_not_found");

function temporaryPassword(): string {
  // 18 random bytes → 24 URL-safe characters: well above the 12-character minimum.
  return randomBytes(18).toString("base64url");
}

export async function listClinicStaff(clinicId: string, selfId: string): Promise<StaffMember[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("staff_roles")
    .select("profile_id, role, profiles!inner(full_name)")
    .eq("clinic_id", clinicId)
    .order("created_at", { ascending: true });
  if (error) throw error;

  const { data: doctors } = await supabase.from("doctors").select("name, profile_id").eq("clinic_id", clinicId).not("profile_id", "is", null);
  const doctorByProfile = new Map((doctors ?? []).map((d) => [d.profile_id as string, d.name]));

  return Promise.all(
    (data ?? []).map(async (m) => {
      const { data: user } = await supabase.auth.admin.getUserById(m.profile_id);
      return {
        profileId: m.profile_id,
        fullName: m.profiles?.full_name?.trim() || "Nomsiz xodim",
        email: user?.user?.email ?? null,
        role: m.role,
        isSelf: m.profile_id === selfId,
        linkedDoctorName: doctorByProfile.get(m.profile_id) ?? null,
      };
    }),
  );
}

/** The auth account registered with this email, if any (the admin API has no lookup by email). */
async function findUserByEmail(email: string): Promise<{ id: string } | null> {
  const supabase = createAdminClient();
  const wanted = email.toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 500 });
    if (error) throw new ApiError(500, "Hisoblarni tekshirib bo‘lmadi", "auth_unavailable");
    const match = data.users.find((u) => u.email?.toLowerCase() === wanted);
    if (match) return { id: match.id };
    if (data.users.length < 500) return null;
  }
  throw new ApiError(500, "Hisoblarni tekshirib bo‘lmadi", "auth_unavailable");
}

export async function addStaffMember(opts: {
  clinicId: string;
  actorId: string;
  email: string;
  fullName: string;
  role: AssignableRole;
}): Promise<{ profileId: string; temporaryPassword: string | null }> {
  const supabase = createAdminClient();
  const existing = await findUserByEmail(opts.email);
  let profileId: string;
  let password: string | null = null;

  if (existing) {
    // An account that already works somewhere (another clinic, the platform)
    // is never attached to this clinic from here; a former member of this
    // clinic, with no access anywhere, may be added back.
    const [{ data: roles }, { data: platform }] = await Promise.all([
      supabase.from("staff_roles").select("clinic_id").eq("profile_id", existing.id),
      supabase.from("platform_admins").select("profile_id").eq("profile_id", existing.id).maybeSingle(),
    ]);
    if ((roles ?? []).some((r) => r.clinic_id === opts.clinicId)) {
      throw new ApiError(409, "Bu xodim klinikada allaqachon bor", "already_member");
    }
    if ((roles ?? []).length > 0 || platform) {
      throw new ApiError(409, "Bu email bilan xodim qo‘shib bo‘lmaydi. Boshqa email kiriting.", "email_unavailable");
    }
    profileId = existing.id;
  } else {
    password = temporaryPassword();
    const { data: created, error } = await supabase.auth.admin.createUser({
      email: opts.email,
      password,
      email_confirm: true,
      user_metadata: { full_name: opts.fullName },
    });
    if (error || !created.user) {
      logger.error("staff account creation failed", { code: error?.code ?? error?.status });
      throw new ApiError(500, "Hisob yaratib bo‘lmadi", "account_create_failed");
    }
    profileId = created.user.id;
  }

  const { error: profileError } = await supabase.from("profiles").upsert({ id: profileId, full_name: opts.fullName }, { onConflict: "id" });
  if (profileError) throw new ApiError(500, "Profilni saqlab bo‘lmadi", "profile_save_failed");

  const { error: roleError } = await supabase.from("staff_roles").insert({ clinic_id: opts.clinicId, profile_id: profileId, role: opts.role });
  if (roleError) {
    if (roleError.code === "23505") throw new ApiError(409, "Bu xodim klinikada allaqachon bor", "already_member");
    throw new ApiError(500, "Rolni saqlab bo‘lmadi", "role_save_failed");
  }

  await recordAudit({
    clinicId: opts.clinicId,
    action: "staff_added",
    entityType: "staff_roles",
    entityId: profileId,
    actor: { actorId: opts.actorId, actorType: "staff" },
    newValues: { role: opts.role, account: existing ? "existing" : "created" },
  });
  return { profileId, temporaryPassword: password };
}

/** The member's current role in this clinic; owners and the acting owner themself are off limits. */
async function managedMember(clinicId: string, actorId: string, profileId: string): Promise<StaffRole> {
  if (profileId === actorId) throw new ApiError(409, "O‘z hisobingizni bu yerda o‘zgartirib bo‘lmaydi", "self_change");
  const { data } = await createAdminClient()
    .from("staff_roles")
    .select("role")
    .eq("clinic_id", clinicId)
    .eq("profile_id", profileId)
    .maybeSingle();
  if (!data) throw MEMBER_NOT_FOUND();
  if (data.role === "owner") throw new ApiError(409, "Klinika egasining huquqlari bu yerda o‘zgarmaydi", "owner_protected");
  return data.role;
}

/** A doctor account that loses the doctor role no longer speaks for its doctor record. */
async function unlinkDoctorRecord(clinicId: string, profileId: string) {
  const { error } = await createAdminClient().from("doctors").update({ profile_id: null }).eq("clinic_id", clinicId).eq("profile_id", profileId);
  if (error) throw new ApiError(500, "Shifokor yozuvini ajratib bo‘lmadi", "doctor_unlink_failed");
}

export async function changeStaffRole(opts: { clinicId: string; actorId: string; profileId: string; role: AssignableRole }): Promise<void> {
  const current = await managedMember(opts.clinicId, opts.actorId, opts.profileId);
  if (current === opts.role) return;
  if (current === "doctor") await unlinkDoctorRecord(opts.clinicId, opts.profileId);
  const { data, error } = await createAdminClient()
    .from("staff_roles")
    .update({ role: opts.role })
    .eq("clinic_id", opts.clinicId)
    .eq("profile_id", opts.profileId)
    .eq("role", current)
    .select("id");
  if (error) throw new ApiError(500, "Rolni o‘zgartirib bo‘lmadi", "role_save_failed");
  if (!data?.length) throw new ApiError(409, "Xodim ma’lumotlari o‘zgargan, sahifani yangilang", "staff_changed");
  await recordAudit({
    clinicId: opts.clinicId,
    action: "staff_role_changed",
    entityType: "staff_roles",
    entityId: opts.profileId,
    actor: { actorId: opts.actorId, actorType: "staff" },
    oldValues: { role: current },
    newValues: { role: opts.role },
  });
}

export async function removeStaffMember(opts: { clinicId: string; actorId: string; profileId: string }): Promise<void> {
  const current = await managedMember(opts.clinicId, opts.actorId, opts.profileId);
  if (current === "doctor") await unlinkDoctorRecord(opts.clinicId, opts.profileId);
  const { error } = await createAdminClient()
    .from("staff_roles")
    .delete()
    .eq("clinic_id", opts.clinicId)
    .eq("profile_id", opts.profileId)
    .neq("role", "owner");
  if (error) throw new ApiError(500, "Xodimni olib tashlab bo‘lmadi", "staff_remove_failed");
  await recordAudit({
    clinicId: opts.clinicId,
    action: "staff_removed",
    entityType: "staff_roles",
    entityId: opts.profileId,
    actor: { actorId: opts.actorId, actorType: "staff" },
    oldValues: { role: current },
  });
}

import "server-only";
import { randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import type { StaffRole } from "@/lib/auth/staff";
import { isValidLogin, loginFromEmail, loginToEmail, normalizeLogin } from "@/lib/auth/login";
import { assertStaffCapacity } from "@/lib/billing/subscription";

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
  /** The sign-in login; null for an older account that signs in with its email. */
  login: string | null;
  /** The sign-in email of an older account; null for login accounts (their internal address is never shown). */
  email: string | null;
  role: StaffRole;
  departmentId: string | null;
  departmentName: string | null;
  /** Still on the temporary password the owner handed over. */
  passwordPending: boolean;
  isSelf: boolean;
  /** For doctors: the doctor record this account is linked to, if any. */
  linkedDoctorName: string | null;
};

const MEMBER_NOT_FOUND = () => new ApiError(404, "Xodim topilmadi", "staff_not_found");

function temporaryPassword(): string {
  // 12 random bytes → 16 URL-safe characters: above the 12-character minimum, short enough to type from a note.
  return randomBytes(12).toString("base64url");
}

export async function listClinicStaff(clinicId: string, selfId: string): Promise<StaffMember[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("staff_roles")
    .select("profile_id, role, department_id, departments(name), profiles!inner(full_name, login, must_change_password)")
    .eq("clinic_id", clinicId)
    .order("created_at", { ascending: true });
  if (error) throw error;

  const { data: doctors } = await supabase.from("doctors").select("name, profile_id").eq("clinic_id", clinicId).not("profile_id", "is", null);
  const doctorByProfile = new Map((doctors ?? []).map((d) => [d.profile_id as string, d.name]));

  return Promise.all(
    (data ?? []).map(async (m) => {
      const login = m.profiles?.login ?? null;
      // Older accounts sign in with a real email; look it up only for them.
      const email = login ? null : ((await supabase.auth.admin.getUserById(m.profile_id)).data?.user?.email ?? null);
      return {
        profileId: m.profile_id,
        fullName: m.profiles?.full_name?.trim() || "Nomsiz xodim",
        login,
        email: loginFromEmail(email) ? null : email,
        role: m.role,
        departmentId: m.department_id,
        departmentName: m.departments?.name ?? null,
        passwordPending: m.profiles?.must_change_password === true,
        isSelf: m.profile_id === selfId,
        linkedDoctorName: doctorByProfile.get(m.profile_id) ?? null,
      };
    }),
  );
}

/** A department of this clinic, or a 404 — never another clinic's. */
async function assertDepartment(clinicId: string, departmentId: string | null | undefined): Promise<void> {
  if (!departmentId) return;
  const { data } = await createAdminClient().from("departments").select("id").eq("id", departmentId).eq("clinic_id", clinicId).maybeSingle();
  if (!data) throw new ApiError(404, "Bo‘lim topilmadi", "department_not_found");
}

/**
 * Adds an employee who signs in with a login + password (owner decision 2026-10-10). Logins are unique on the
 * platform. A login that already works somewhere (another clinic, the platform) is never attached here; a former
 * member of this clinic with no access anywhere may be added back. A new account gets a temporary password, shown
 * once, and must set its own on first sign-in.
 */
export async function addStaffMember(opts: {
  clinicId: string;
  actorId: string;
  login: string;
  fullName: string;
  role: AssignableRole;
  departmentId?: string | null;
}): Promise<{ profileId: string; login: string; temporaryPassword: string | null }> {
  const supabase = createAdminClient();
  const login = normalizeLogin(opts.login);
  if (!isValidLogin(login)) throw new ApiError(400, "Login 3–32 belgi: lotin harflari, raqamlar, nuqta, chiziqcha", "invalid_login");
  await assertDepartment(opts.clinicId, opts.departmentId);

  const { data: existing } = await supabase.from("profiles").select("id").eq("login", login).maybeSingle();
  let profileId: string;
  let password: string | null = null;

  if (existing) {
    const [{ data: roles }, { data: platform }] = await Promise.all([
      supabase.from("staff_roles").select("clinic_id").eq("profile_id", existing.id),
      supabase.from("platform_admins").select("profile_id").eq("profile_id", existing.id).maybeSingle(),
    ]);
    if ((roles ?? []).some((r) => r.clinic_id === opts.clinicId)) {
      throw new ApiError(409, "Bu xodim klinikada allaqachon bor", "already_member");
    }
    if ((roles ?? []).length > 0 || platform) {
      throw new ApiError(409, "Bu login band. Boshqa login tanlang.", "login_unavailable");
    }
    await assertStaffCapacity(opts.clinicId, opts.role);
    profileId = existing.id;
  } else {
    await assertStaffCapacity(opts.clinicId, opts.role);
    password = temporaryPassword();
    const { data: created, error } = await supabase.auth.admin.createUser({
      email: loginToEmail(login),
      password,
      email_confirm: true,
      user_metadata: { full_name: opts.fullName },
    });
    if (error || !created.user) {
      // Two owners racing for the same login: the auth email is taken.
      if (error?.code === "email_exists" || error?.status === 422) throw new ApiError(409, "Bu login band. Boshqa login tanlang.", "login_unavailable");
      logger.error("staff account creation failed", { code: error?.code ?? error?.status });
      throw new ApiError(500, "Hisob yaratib bo‘lmadi", "account_create_failed");
    }
    profileId = created.user.id;
  }

  const { error: profileError } = await supabase
    .from("profiles")
    .upsert({ id: profileId, full_name: opts.fullName, login, ...(password ? { must_change_password: true } : {}) }, { onConflict: "id" });
  if (profileError) {
    if (profileError.code === "23505") throw new ApiError(409, "Bu login band. Boshqa login tanlang.", "login_unavailable");
    throw new ApiError(500, "Profilni saqlab bo‘lmadi", "profile_save_failed");
  }

  const { error: roleError } = await supabase
    .from("staff_roles")
    .insert({ clinic_id: opts.clinicId, profile_id: profileId, role: opts.role, department_id: opts.departmentId ?? null });
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
  return { profileId, login, temporaryPassword: password };
}

/** Moves a member to another department of this clinic (or none). Owners may move themselves. */
export async function setStaffDepartment(opts: { clinicId: string; actorId: string; profileId: string; departmentId: string | null }): Promise<void> {
  await assertDepartment(opts.clinicId, opts.departmentId);
  const { data, error } = await createAdminClient()
    .from("staff_roles")
    .update({ department_id: opts.departmentId })
    .eq("clinic_id", opts.clinicId)
    .eq("profile_id", opts.profileId)
    .select("id");
  if (error) throw new ApiError(500, "Bo‘limni saqlab bo‘lmadi", "department_save_failed");
  if (!data?.length) throw MEMBER_NOT_FOUND();
  await recordAudit({
    clinicId: opts.clinicId,
    action: "staff_department_changed",
    entityType: "staff_roles",
    entityId: opts.profileId,
    actor: { actorId: opts.actorId, actorType: "staff" },
    newValues: { department_id: opts.departmentId },
  });
}

/**
 * The owner sets a new temporary password for an employee who forgot theirs (no email recovery for login
 * accounts). Shown once; the employee must replace it on the next sign-in. Never the owner's own or another owner's.
 */
export async function resetStaffPassword(opts: { clinicId: string; actorId: string; profileId: string }): Promise<{ temporaryPassword: string }> {
  await managedMember(opts.clinicId, opts.actorId, opts.profileId);
  const supabase = createAdminClient();
  const password = temporaryPassword();
  const { error } = await supabase.auth.admin.updateUserById(opts.profileId, { password });
  if (error) throw new ApiError(500, "Parolni tiklab bo‘lmadi", "password_reset_failed");
  await supabase.from("profiles").update({ must_change_password: true }).eq("id", opts.profileId);
  await recordAudit({
    clinicId: opts.clinicId,
    action: "staff_password_reset",
    entityType: "profiles",
    entityId: opts.profileId,
    actor: { actorId: opts.actorId, actorType: "staff" },
  });
  return { temporaryPassword: password };
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

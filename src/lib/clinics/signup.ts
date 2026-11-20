import "server-only";
import { randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import { loginToEmail, normalizeLogin } from "@/lib/auth/login";

/**
 * Self-service clinic sign-up from the website (owner decision 2026-10-10): the clinic, its owner account, five
 * starter departments, a 14-day trial and the first invoice. The owner's auth account is created first (the auth
 * API is not reachable from SQL); provision_clinic() does everything else in one transaction, and the account is
 * deleted again if that fails, so a failed sign-up leaves nothing behind.
 */

export type SignupInput = {
  clinicName: string;
  city: string;
  clinicPhone: string;
  address: string;
  ownerName: string;
  ownerPhone: string;
  login: string;
  password: string;
  planCode: string;
};

const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", ғ: "g", д: "d", е: "e", ё: "yo", ж: "j", з: "z", и: "i", й: "y", к: "k", қ: "q",
  л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ў: "o", ф: "f", х: "x", ҳ: "h", ц: "ts",
  ч: "ch", ш: "sh", ъ: "", ь: "", э: "e", ю: "yu", я: "ya",
};

/** "Shifo Nur klinikasi" → "shifo-nur-klinikasi" (Latin or Cyrillic in, URL-safe out). */
export function clinicSlug(name: string): string {
  const latin = name
    .toLowerCase()
    .replace(/[‘’'ʻʼ`]/g, "")
    .split("")
    .map((c) => TRANSLIT[c] ?? c)
    .join("")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");
  const slug = latin.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug.length >= 3 ? slug : `klinika-${slug}`.replace(/-+$/, "");
}

export async function signUpClinic(input: SignupInput): Promise<{ clinicId: string; invoiceNumber: string; login: string }> {
  const db = createAdminClient();
  const login = normalizeLogin(input.login);

  const { data: taken } = await db.from("profiles").select("id").eq("login", login).maybeSingle();
  if (taken) throw new ApiError(409, "Bu login band. Boshqa login tanlang.", "login_unavailable");

  const { data: created, error: createError } = await db.auth.admin.createUser({
    email: loginToEmail(login),
    password: input.password,
    email_confirm: true,
    user_metadata: { full_name: input.ownerName },
  });
  if (createError || !created.user) {
    if (createError?.code === "email_exists" || createError?.status === 422) {
      throw new ApiError(409, "Bu login band. Boshqa login tanlang.", "login_unavailable");
    }
    if (createError?.code === "weak_password") throw new ApiError(400, "Parol juda oddiy. Boshqa parol tanlang.", "weak_password");
    logger.error("clinic signup: owner account failed", { code: createError?.code ?? createError?.status });
    throw new ApiError(500, "Hisob yaratib bo‘lmadi. Birozdan keyin qayta urinib ko‘ring.", "account_create_failed");
  }
  const ownerId = created.user.id;

  const base = clinicSlug(input.clinicName);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${randomBytes(2).toString("hex")}`;
      const { data, error } = await db.rpc("provision_clinic", {
        p_owner_id: ownerId,
        p_owner_name: input.ownerName,
        p_owner_login: login,
        p_owner_phone: input.ownerPhone,
        p_clinic_name: input.clinicName,
        p_slug: slug,
        p_clinic_phone: input.clinicPhone,
        p_city: input.city,
        p_address: input.address,
        p_plan_code: input.planCode,
      });
      if (!error && data?.[0]) {
        return { clinicId: data[0].clinic_id, invoiceNumber: data[0].invoice_number, login };
      }
      // Another clinic already has this address: try once more with a short suffix.
      if (error?.code === "23505" && /slug/.test(error.message)) continue;
      if (error?.details === "plan_not_found") throw new ApiError(400, "Tarif topilmadi", "plan_not_found");
      if (error?.code === "23505" && /login/.test(error.message)) throw new ApiError(409, "Bu login band. Boshqa login tanlang.", "login_unavailable");
      logger.error("clinic signup: provisioning failed", { code: error?.code });
      throw new ApiError(500, "Klinikani ro‘yxatdan o‘tkazib bo‘lmadi. Birozdan keyin qayta urinib ko‘ring.", "provision_failed");
    }
    throw new ApiError(500, "Klinika manzilini tanlab bo‘lmadi. Nomini biroz o‘zgartiring.", "slug_unavailable");
  } catch (e) {
    // Nothing half-made: the owner account goes away with the failed sign-up.
    await db.auth.admin.deleteUser(ownerId).catch(() => undefined);
    throw e;
  }
}

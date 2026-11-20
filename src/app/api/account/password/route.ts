import type { NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { parseBody } from "@/lib/api/validate";
import { createStaffClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sharedRateLimit } from "@/lib/rate-limit-shared";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const MIN_PASSWORD_LENGTH = 12;

const schema = z
  .object({
    current: z.string().min(1).max(200),
    next: z.string().min(MIN_PASSWORD_LENGTH).max(200),
  })
  .strict();

/**
 * A signed-in employee changes their own password — first of all the temporary one the owner handed over, which
 * every panel insists on (profiles.must_change_password). The current password is checked again, so an unattended
 * open session cannot take the account over. Works for login and email accounts alike.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await createStaffClient();
    const {
      data: { user },
    } = await session.auth.getUser();
    if (!user?.email) throw new ApiError(401, "Sessiya tugagan. Qaytadan kiring.", "unauthorized");

    const limit = await sharedRateLimit({ key: `account-password:${user.id}`, limit: 5, windowMs: 15 * 60_000 });
    if (!limit.ok) throw new ApiError(429, "Juda ko‘p urinish. Birozdan keyin qayta urinib ko‘ring.", "rate_limited");

    const body = await parseBody(request, schema);
    if (body.next === body.current) throw new ApiError(400, "Yangi parol joriy paroldan farq qilishi kerak", "same_password");

    // Check the current password on a separate, non-persisted client: the staff session cookie is untouched.
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
    if (!url || !anonKey) throw new ApiError(500, "Server konfiguratsiyasi to‘liq emas", "config_missing");
    const probe = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error: checkError } = await probe.auth.signInWithPassword({ email: user.email, password: body.current });
    if (checkError) throw new ApiError(400, "Joriy parol noto‘g‘ri", "wrong_password");
    await probe.auth.signOut({ scope: "local" });

    // Through the employee's own session, so it stays signed in (an admin-side change would end every session).
    const { error: updateError } = await session.auth.updateUser({ password: body.next });
    if (updateError) throw new ApiError(400, "Parolni o‘zgartirib bo‘lmadi. Boshqa parol tanlang.", "password_rejected");
    const admin = createAdminClient();
    const { error: flagError } = await admin.from("profiles").update({ must_change_password: false }).eq("id", user.id);
    if (flagError) throw new ApiError(500, "Parol o‘zgardi, lekin holatni saqlab bo‘lmadi. Qayta kiring.", "flag_save_failed");

    const { data: membership } = await admin.from("staff_roles").select("clinic_id").eq("profile_id", user.id).limit(1).maybeSingle();
    if (membership) {
      await recordAudit({
        clinicId: membership.clinic_id,
        action: "staff_password_changed",
        entityType: "profiles",
        entityId: user.id,
        actor: { actorId: user.id, actorType: "staff" },
      });
    }
    return ok({ changed: true });
  } catch (e) {
    return handleApiError(e);
  }
}

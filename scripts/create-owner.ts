/**
 * Owner bootstrap script.
 *
 * Creates the first clinic owner (Supabase Auth user + profile + owner role)
 * and — if no clinic exists yet — the default clinic.
 *
 * Usage: npm run create-owner   (loads .env automatically via --env-file)
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env (the service
 * role key, so the script can create auth users — normal staff sessions
 * cannot and never should).
 */
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(10),
  OWNER_EMAIL: z.string().email().default("owner@example.com"),
  OWNER_PASSWORD: z.string().min(12).default("ChangeMe_123456!"),
  OWNER_NAME: z.string().min(2).default("Klinika egasi"),
  CLINIC_NAME: z.string().min(2).default("Mening Klinikam"),
  CLINIC_SLUG: z.string().min(2).default("my-clinic"),
  CLINIC_PHONE: z.string().optional(),
  CLINIC_ADDRESS: z.string().optional(),
});

const env = envSchema.parse(process.env);
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  console.log("Owner bootstrap ishga tushdi…");

  // 1. Find or create the clinic (first run: seed may already have created it).
  let clinic: { id: string; name: string; slug: string } | null = null;
  const { data: foundClinic, error: clinicError } = await supabase
    .from("clinics")
    .select("id, name, slug")
    .eq("slug", env.CLINIC_SLUG)
    .maybeSingle();
  clinic = foundClinic;

  if (!clinic) {
    if (clinicError) {
      console.error("Klinikani qidirishda xatolik:", clinicError.message);
      process.exit(1);
    }
    const { data: created, error: createError } = await supabase
      .from("clinics")
      .insert({
        name: env.CLINIC_NAME,
        slug: env.CLINIC_SLUG,
        phone: env.CLINIC_PHONE ?? null,
        address: env.CLINIC_ADDRESS ?? null,
      })
      .select("id, name, slug")
      .single();
    if (createError) {
      console.error("Klinikani yaratishda xatolik:", createError.message);
      process.exit(1);
    }
    clinic = created;
  }
  console.log(`✓ Klinika: ${clinic.name} (${clinic.id})`);

  // 2. Create the auth user (idempotent — reuse existing user).
  let userId: string;
  const { data: existing } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const match = existing?.users.find((u) => u.email?.toLowerCase() === env.OWNER_EMAIL.toLowerCase());
  if (match) {
    userId = match.id;
    console.log(`✓ Auth user allaqachon mavjud: ${env.OWNER_EMAIL}`);
  } else {
    const { data: created, error: createError } = await supabase.auth.admin.createUser({
      email: env.OWNER_EMAIL,
      password: env.OWNER_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: env.OWNER_NAME },
    });
    if (createError) {
      console.error("Auth foydalanuvchini yaratishda xatolik:", createError.message);
      process.exit(1);
    }
    userId = created.user.id;
    console.log(`✓ Auth user yaratildi: ${env.OWNER_EMAIL}`);
  }

  // 3. Profile (trigger may have created it; upsert to be safe).
  await supabase
    .from("profiles")
    .upsert({ id: userId, full_name: env.OWNER_NAME }, { onConflict: "id" })
    .then(({ error }) => {
      if (error) {
        console.error("Profilni yaratishda xatolik:", error.message);
        process.exit(1);
      }
    });
  console.log("✓ Profil tayyor");

  // 4. Owner role (idempotent).
  const { data: role, error: roleError } = await supabase
    .from("staff_roles")
    .select("id")
    .eq("clinic_id", clinic.id)
    .eq("profile_id", userId)
    .eq("role", "owner")
    .maybeSingle();
  if (roleError) {
    console.error("Rolni qidirishda xatolik:", roleError.message);
    process.exit(1);
  }
  if (!role) {
    const { error: insertError } = await supabase
      .from("staff_roles")
      .insert({ clinic_id: clinic.id, profile_id: userId, role: "owner" });
    if (insertError) {
      console.error("Owner rolini qo‘shishda xatolik:", insertError.message);
      process.exit(1);
    }
  }
  console.log("✓ Owner roli tayyor");

  console.log("\nTayyor! Kirish ma'lumotlari:");
  console.log(`  Email:    ${env.OWNER_EMAIL}`);
  console.log(`  Parol:    ${env.OWNER_PASSWORD}`);
  console.log(`  Panel:    ${env.SUPABASE_URL}/auth/v1  (yoki sizning domeningiz /admin/login)`);
  console.log("\n⚠️  Ushbu parolni darhol o‘zgartirishni unutmang.");
}

main().catch((e) => {
  console.error("Kutilmagan xatolik:", e);
  process.exit(1);
});
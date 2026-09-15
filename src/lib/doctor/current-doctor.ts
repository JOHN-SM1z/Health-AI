import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

export type CurrentDoctor = { id: string; name: string };

/**
 * Resolves the signed-in user's own doctor record. Every /doctor page scopes
 * its queries to this id — but the REAL security boundary is RLS (see
 * "appointments read for staff" / "patients read for operational staff" in
 * supabase/migrations/20260818000024_role_based_rls.sql), which independently
 * restricts a doctor session to rows tied to their own doctor_id. This lookup
 * exists so the UI can show a friendly "account not linked" state and label
 * queries explicitly, not to enforce access by itself.
 */
export async function getCurrentDoctor(supabase: SupabaseClient<Database>): Promise<CurrentDoctor | null> {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth.user?.id;
  if (!uid) return null;
  const { data } = await supabase.from("doctors").select("id, name").eq("profile_id", uid).maybeSingle();
  return data ?? null;
}

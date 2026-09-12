import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { ApiError } from "@/lib/api/errors";
import type { Database } from "./database.types";

/**
 * Supabase client bound to the staff session cookie.
 * RLS policies for authenticated staff apply to this client.
 * Use in server components, server functions, and route handlers
 * that operate on behalf of a logged-in staff member.
 */
export async function createStaffClient() {
  const cookieStore = await cookies();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new ApiError(500, "Server konfiguratsiyasi to‘liq emas: Supabase URL yoki kalit topilmadi", "config_missing");
  }

  return createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component — safe to ignore when middleware
          // (proxy.ts) refreshes sessions instead.
        }
      },
    },
  });
}
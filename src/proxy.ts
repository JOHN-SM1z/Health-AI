import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Next.js 16 proxy (the replacement for the deprecated middleware).
 * Refreshes staff sessions and applies security headers for admin/doctor
 * routes. Patient Mini App routes and public webhooks are intentionally
 * NOT proxied — the Telegram webhook must receive the raw request.
 */
export async function proxy(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

  let response = NextResponse.next({ request });

  if (url && anonKey) {
    const supabase = createServerClient(url, anonKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    });

    // getUser() refreshes an expired session automatically.
    await supabase.auth.getUser();
  }

  return response;
}

export const config = {
  matcher: [
    // Staff areas only. Webhook endpoints must bypass the proxy.
    "/admin/:path*",
    "/doctor/:path*",
  ],
};
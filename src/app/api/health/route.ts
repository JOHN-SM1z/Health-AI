import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET() {
  const dbOk = await checkDatabase();
  const status = dbOk ? "ok" : "degraded";
  const code = dbOk ? 200 : 503;

  logger.info("health check", { status });

  return NextResponse.json(
    {
      status,
      service: "health-ai",
      version: process.env.NEXT_PUBLIC_APP_VERSION ?? "dev",
      time: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
    },
    { status: code, headers: { "Cache-Control": "no-store" } },
  );
}

async function checkDatabase(): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return false;

  try {
    const res = await fetch(`${url}/rest/v1/`, {
      // Probe PostgREST metadata only: no tenant or patient records are read.
      // Hosted projects can require a server key for the OpenAPI root.
      // Keep it server-side and never return the response body or credentials.
      headers: { apikey: key },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(4000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

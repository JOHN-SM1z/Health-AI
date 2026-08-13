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
    { status: code },
  );
}

async function checkDatabase(): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return true; // not configured yet — report ok, not degraded

  try {
    const res = await fetch(`${url}/rest/v1/`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(4000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ ok: true, data }, init);
}

export function fail(message: string, status = 400, code?: string): NextResponse {
  return NextResponse.json({ ok: false, error: message, code }, { status });
}

/**
 * Wraps a route handler so every error path returns a safe JSON response and
 * is logged without leaking internals.
 */
export function handleApiError(e: unknown): NextResponse {
  if (e instanceof ApiError) {
    return fail(e.message, e.status, e.code);
  }
  if (e instanceof SyntaxError) {
    return fail("Noto‘g‘ri so‘rov formati", 400, "bad_json");
  }
  logger.error("unhandled api error", { error: e instanceof Error ? e.message : String(e) });
  return fail("Ichki xatolik yuz berdi", 500, "internal");
}
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { logger } from "@/lib/logger";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    /** Safe, structured extras for the client (never internals). */
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ ok: true, data }, init);
}

export function fail(message: string, status = 400, code?: string, details?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ ok: false, error: message, code, ...(details ? { details } : {}) }, { status });
}

/**
 * Wraps a route handler so every error path returns a safe JSON response and
 * is logged without leaking internals.
 */
export function handleApiError(e: unknown): NextResponse {
  if (e instanceof ApiError) {
    return fail(e.message, e.status, e.code, e.details);
  }
  if (e instanceof ZodError) {
    // Never a 500: a malformed body is the caller's mistake. Pick the first
    // issue and return a safe 400 (same shape as parseBody's ApiError).
    const first = e.issues[0];
    return fail(first?.message ?? "Noto‘g‘ri ma‘lumot", 400, "validation");
  }
  if (e instanceof SyntaxError) {
    return fail("Noto‘g‘ri so‘rov formati", 400, "bad_json");
  }
  // Provider/database errors may embed patient values, request bodies or keys.
  // Safe API responses are insufficient if the same content reaches logs.
  logger.error("unhandled api error");
  return fail("Ichki xatolik yuz berdi", 500, "internal");
}

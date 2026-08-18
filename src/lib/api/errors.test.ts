import { describe, it, expect } from "vitest";
import { z } from "zod";
import { handleApiError, ApiError } from "./errors";

describe("handleApiError (red-team: never leak internals, never 500 on bad input)", () => {
  it("maps a raw ZodError to a safe 400 instead of a 500", async () => {
    const schema = z.object({ initData: z.string() });
    const zodError = schema.safeParse({ initData: null });
    expect(zodError.success).toBe(false);

    const res = handleApiError(zodError.error);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; code: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("validation");
  });

  it("preserves ApiError status and code", async () => {
    const res = handleApiError(new ApiError(409, "Bu vaqt band", "slot_taken"));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("slot_taken");
  });

  it("never leaks the original error message for unknown errors", async () => {
    const res = handleApiError(new Error("SUPABASE_SERVICE_ROLE_KEY=super-secret-value"));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("super-secret-value");
  });
});
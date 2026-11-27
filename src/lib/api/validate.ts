import { z } from "zod";
import { ApiError } from "@/lib/api/errors";
import { assertSameOrigin } from "@/lib/api/same-origin";

/**
 * Parses and validates a JSON request body against a schema.
 *
 * Every state-changing JSON route goes through here, so this is also where a
 * cross-site request is refused (security review F3): a browser always sends
 * Origin on a cross-site POST/PUT/PATCH, and a foreign Origin is rejected
 * before the body is read. Session cookies are SameSite=Lax as well; this is
 * the second, independent layer. Server-to-server callers send no Origin.
 */
export async function parseBody<T extends z.ZodTypeAny>(
  request: Request,
  schema: T,
  options?: { maxBytes: number },
): Promise<z.infer<T>> {
  assertSameOrigin(request);
  let raw: unknown;
  try {
    raw = options ? await readLimitedJson(request, options.maxBytes) : await request.json();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "Noto‘g‘ri so‘rov formati", "bad_json");
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new ApiError(400, first?.message ?? "Noto‘g‘ri ma‘lumot", "validation");
  }
  return result.data;
}

async function readLimitedJson(request: Request, maxBytes: number): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError("Missing JSON body");
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(body + decoder.decode()) as unknown;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new ApiError(413, "So‘rov juda uzun", "body_too_large");
      }
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ()-]{7,20}$/, "Telefon raqam noto‘g‘ri formatda");

export const nameSchema = z
  .string()
  .trim()
  .min(2, "Ism kamida 2 ta belgidan iborat bo‘lishi kerak")
  .max(120);

export const uuidSchema = z.string().uuid("Noto‘g‘ri identifikator");

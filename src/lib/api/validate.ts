import { z } from "zod";
import { ApiError } from "@/lib/api/errors";

/** Parses and validates a JSON request body against a schema. */
export async function parseBody<T extends z.ZodTypeAny>(
  request: Request,
  schema: T,
): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ApiError(400, "Noto‘g‘ri so‘rov formati", "bad_json");
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new ApiError(400, first?.message ?? "Noto‘g‘ri ma‘lumot", "validation");
  }
  return result.data;
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
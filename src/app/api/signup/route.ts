import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { nameSchema, parseBody, phoneSchema } from "@/lib/api/validate";
import { LOGIN_PATTERN } from "@/lib/auth/login";
import { signUpClinic } from "@/lib/clinics/signup";
import { sharedRateLimit } from "@/lib/rate-limit-shared";
import { keyFromIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const schema = z
  .object({
    clinicName: z.string().trim().min(2, "Klinika nomini kiriting").max(120),
    city: z.string().trim().min(2, "Shaharni kiriting").max(80),
    clinicPhone: phoneSchema,
    address: z.string().trim().max(300).default(""),
    ownerName: nameSchema,
    ownerPhone: phoneSchema,
    login: z.string().trim().toLowerCase().regex(LOGIN_PATTERN, "Login 3–32 belgi: lotin harflari, raqamlar, nuqta, chiziqcha"),
    password: z.string().min(12, "Parol kamida 12 belgi").max(200),
    planCode: z.string().regex(/^[a-z0-9_-]{2,32}$/),
    acceptTerms: z.literal(true, { message: "Shartlarga rozilik kerak" }),
    // A field people never see: bots fill it in.
    website: z.string().max(0).optional(),
  })
  .strict();

/** A clinic signs itself up from the landing page: a 14-day trial starts at once; the owner signs in next. */
export async function POST(request: NextRequest) {
  try {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    const limit = await sharedRateLimit({ key: keyFromIp(ip, "clinic-signup"), limit: 5, windowMs: 60 * 60_000 });
    if (!limit.ok) throw new ApiError(429, "Juda ko‘p urinish. Bir soatdan keyin qayta urinib ko‘ring.", "rate_limited");
    const body = await parseBody(request, schema);
    const result = await signUpClinic(body);
    return ok(result, { status: 201 });
  } catch (e) {
    return handleApiError(e);
  }
}

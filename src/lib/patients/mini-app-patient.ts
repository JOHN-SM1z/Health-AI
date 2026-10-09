import "server-only";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getClinicFromRequest } from "@/lib/clinics/context";
import { resolvePatientFromInitData, devIdentityAllowed } from "@/lib/patients/identity";
import { ApiError } from "@/lib/api/errors";
import { rateLimit, keyFromIp } from "@/lib/rate-limit";
import { sharedRateLimit } from "@/lib/rate-limit-shared";

const schema = z.object({ initData: z.string().nullable().optional() });

/**
 * The verified patient of the clinic in the Mini App URL — through the
 * existing Telegram identity (initData signed by that clinic's bot), never
 * an id from the browser. Rate-limited per IP on this instance (cheap,
 * before the signature check) and per verified patient across every
 * instance (sharedRateLimit), since these routes return lab data.
 */
export async function requireMiniAppPatient(request: NextRequest, bucket: string) {
  const { clinic, patient } = await requireMiniAppPatientWith(request, bucket, schema);
  return { clinicId: clinic.id, patientId: patient.id };
}

/** As requireMiniAppPatient, for a body with more fields than initData; returns the clinic, patient and parsed body. */
export async function requireMiniAppPatientWith<S extends z.ZodType<{ initData?: string | null }>>(request: NextRequest, bucket: string, bodySchema: S) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const limit = rateLimit({ key: keyFromIp(ip, bucket), limit: 30, windowMs: 60_000 });
  if (!limit.ok) throw new ApiError(429, "Juda ko‘p so‘rov", "rate_limited");

  let body: z.infer<S>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    throw new ApiError(400, "Noto‘g‘ri so‘rov formati", "bad_json");
  }
  if (body.initData === "dev" && !devIdentityAllowed()) {
    throw new ApiError(403, "Development identity is not allowed", "dev_identity_forbidden");
  }
  const clinic = await getClinicFromRequest(request);
  const resolved = await resolvePatientFromInitData(body.initData, clinic.id);
  if (!resolved) throw new ApiError(401, "Telegram identifikatori tasdiqlanmadi", "invalid_init_data");
  const shared = await sharedRateLimit({ key: `${bucket}:${clinic.id}:${resolved.patient.id}`, limit: 30, windowMs: 60_000 });
  if (!shared.ok) throw new ApiError(429, "Juda ko‘p so‘rov", "rate_limited");
  return { clinic, patient: resolved.patient, body };
}

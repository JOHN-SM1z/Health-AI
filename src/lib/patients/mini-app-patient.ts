import "server-only";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getClinicFromRequest } from "@/lib/clinics/context";
import { resolvePatientFromInitData, devIdentityAllowed } from "@/lib/patients/identity";
import { ApiError } from "@/lib/api/errors";
import { rateLimit, keyFromIp } from "@/lib/rate-limit";

const schema = z.object({ initData: z.string().nullable().optional() });

/**
 * The verified patient of the clinic in the Mini App URL — through the
 * existing Telegram identity (initData signed by that clinic's bot), never
 * an id from the browser. Rate-limited per IP.
 */
export async function requireMiniAppPatient(request: NextRequest, bucket: string) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const limit = rateLimit({ key: keyFromIp(ip, bucket), limit: 30, windowMs: 60_000 });
  if (!limit.ok) throw new ApiError(429, "Juda ko‘p so‘rov", "rate_limited");

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await request.json());
  } catch {
    throw new ApiError(400, "Noto‘g‘ri so‘rov formati", "bad_json");
  }
  if (body.initData === "dev" && !devIdentityAllowed()) {
    throw new ApiError(403, "Development identity is not allowed", "dev_identity_forbidden");
  }
  const clinic = await getClinicFromRequest(request);
  const resolved = await resolvePatientFromInitData(body.initData, clinic.id);
  if (!resolved) throw new ApiError(401, "Telegram identifikatori tasdiqlanmadi", "invalid_init_data");
  return { clinicId: clinic.id, patientId: resolved.patient.id };
}

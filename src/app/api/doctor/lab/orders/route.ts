import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireLinkedDoctor } from "@/lib/auth/guards";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { sharedRateLimit } from "@/lib/rate-limit-shared";
import { createLabOrder } from "@/lib/labs/ordering";

export const dynamic = "force-dynamic";

// Strict: the clinic, the ordering doctor and their login come from the session, and the price from the
// catalog — a body that names any of them is refused, never ignored.
const schema = z
  .object({
    patientId: uuidSchema,
    appointmentId: uuidSchema.optional(),
    testIds: z.array(uuidSchema).max(50).default([]),
    panelIds: z.array(uuidSchema).max(20).default([]),
    priority: z.enum(["routine", "urgent"]).default("routine"),
    notes: z.string().trim().max(1000).nullable().optional(),
    referralId: uuidSchema.nullable().optional(),
    /** One key per ordering attempt (generated when the doctor opens the review step); repeated on retries. */
    idempotencyKey: uuidSchema,
  })
  .strict()
  .refine((b) => b.testIds.length + b.panelIds.length > 0, { message: "Kamida bitta tahlil yoki paket tanlang", path: ["testIds"] });

/**
 * The calling doctor orders tests for a patient, from their own consultation. Atomic and idempotent per
 * idempotencyKey (201 on creation, 200 on a replay of the same order, 409 when the key was used for
 * something else). The patient must be reachable by the clinical access decision (404/410 otherwise,
 * like every patient read) and the order is written as this doctor, with the catalog's prices.
 */
export async function POST(request: NextRequest) {
  try {
    const doctor = await requireLinkedDoctor();
    const limit = await sharedRateLimit({ key: `doctor-lab-order:${doctor.profileId}`, limit: 30, windowMs: 60_000 });
    if (!limit.ok) throw new ApiError(429, "Juda ko‘p so‘rov, birozdan keyin urinib ko‘ring", "rate_limited");
    const body = await parseBody(request, schema);
    const order = await createLabOrder(doctor, body);
    return ok({ order }, { status: order.replayed ? 200 : 201 });
  } catch (e) {
    return handleApiError(e);
  }
}

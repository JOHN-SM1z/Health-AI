import type { NextRequest } from "next/server";
import { z } from "zod";
import { handleApiError, ok } from "@/lib/api/errors";
import { parseBody, uuidSchema } from "@/lib/api/validate";
import { requireLabCapability } from "@/lib/labs/guards";
import { createWalkInOrder } from "@/lib/labs/collection";

export const dynamic = "force-dynamic";

// Only ids: clinic, orderer and prices are decided on the server.
const schema = z
  .object({
    idempotencyKey: uuidSchema,
    patientId: uuidSchema,
    testIds: z.array(uuidSchema).max(50).default([]),
    panelIds: z.array(uuidSchema).max(50).default([]),
  })
  .refine((b) => b.testIds.length + b.panelIds.length > 0, { message: "Kamida bitta tahlil yoki panel tanlang" });

/**
 * A walk-in lab order from the reception / lab desk. Any staff member may
 * order (owner decision 2026-10-05); this desk route is for the roles that
 * work the queue — doctors order from the patient workspace.
 */
export async function POST(request: NextRequest) {
  try {
    const staff = await requireLabCapability("queue.read");
    const body = await parseBody(request, schema);
    const result = await createWalkInOrder(staff, body.patientId, {
      testIds: body.testIds,
      panelIds: body.panelIds,
      creationKey: body.idempotencyKey,
    });
    return ok(result, { status: result.replayed ? 200 : 201 });
  } catch (e) {
    return handleApiError(e);
  }
}

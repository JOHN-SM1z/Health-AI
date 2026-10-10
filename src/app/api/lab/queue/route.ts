import { handleApiError, ok } from "@/lib/api/errors";
import { requireLabCapability } from "@/lib/labs/guards";
import { getWorkQueue, QUEUE_LIMIT } from "@/lib/labs/collection";

export const dynamic = "force-dynamic";

/** The clinic's active lab orders with test status and samples — never result values. */
export async function GET() {
  try {
    const staff = await requireLabCapability("queue.read");
    const orders = await getWorkQueue(staff);
    return ok({ orders, limit: QUEUE_LIMIT });
  } catch (e) {
    return handleApiError(e);
  }
}

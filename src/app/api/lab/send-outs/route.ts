import type { NextRequest } from "next/server";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";
import { uuidSchema } from "@/lib/api/validate";
import { requireLabCapability } from "@/lib/labs/guards";
import { listSendOutProviders, listSendOuts } from "@/lib/labs/providers/service";

export const dynamic = "force-dynamic";

/** Send-out status of the given tests and the laboratories they can go to (status only). */
export async function GET(request: NextRequest) {
  try {
    const staff = await requireLabCapability("queue.read");
    const raw = request.nextUrl.searchParams.get("items") ?? "";
    const items = raw ? raw.split(",").slice(0, 300) : [];
    if (items.some((i) => !uuidSchema.safeParse(i).success)) throw new ApiError(400, "Noto‘g‘ri so‘rov", "validation");
    const [sendOuts, providers] = await Promise.all([listSendOuts(staff, items), listSendOutProviders(staff)]);
    return ok({ sendOuts, providers });
  } catch (e) {
    return handleApiError(e);
  }
}

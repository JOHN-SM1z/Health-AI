import { handleClickWebhook } from "@/lib/payments/click-webhook";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.text();
  return handleClickWebhook(body, true);
}
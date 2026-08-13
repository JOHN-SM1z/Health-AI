import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { env } from "@/lib/env";
import { isWebhookProcessed, markWebhookProcessed } from "@/lib/telegram/idempotency";
import { rateLimit, keyFromIp } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import {
  handleTelegramMessage,
  handleTelegramCommand,
  handleMenuButton,
  handleVoiceConsent,
  handleVoiceCorrect,
  handleVoiceWrong,
  requestHumanHandoff,
} from "@/lib/telegram/handlers";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type TelegramUpdate = {
  update_id?: number;
  message?: {
    message_id?: number;
    text?: string;
    chat?: { id?: number };
    from?: { id?: number; first_name?: string; last_name?: string; username?: string };
    voice?: { file_id: string; file_unique_id?: string; duration?: number; mime_type?: string; file_size?: number };
  };
  callback_query?: {
    id?: string;
    data?: string;
    message?: { chat?: { id?: number } };
    from?: { id?: number; first_name?: string; last_name?: string; username?: string };
  };
};

function clientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

export async function POST(request: NextRequest) {
  const ip = clientIp(request);

  // 1. Reject anything without the secret token. Telegram is the only
  //    legitimate caller and it always sends X-Telegram-Bot-Api-Secret-Token.
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    logger.warn("telegram webhook rejected: missing/invalid secret token", { ip });
    return new NextResponse("Unauthorized", { status: 401 });
  }

  if (!env.TELEGRAM_BOT_TOKEN) {
    // Local development without a real bot: accept nothing, but stay honest
    // about it (never pretend Telegram is connected).
    return NextResponse.json(
      { ok: false, error: "telegram not configured — local dev mode active" },
      { status: 200 },
    );
  }

  // 2. Basic abuse protection.
  const limit = rateLimit({ key: keyFromIp(ip, "tg-webhook"), limit: 30, windowMs: 10_000 });
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, error: "too many requests" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }

  const updateId = update.update_id;
  if (typeof updateId !== "number") {
    logger.warn("telegram webhook: update without update_id", { ip });
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  // 3. Idempotency: duplicate deliveries are dropped.
  const alreadyProcessed = await isWebhookProcessed("telegram", String(updateId));
  if (alreadyProcessed) {
    logger.debug("telegram webhook duplicate dropped", { updateId });
    return NextResponse.json({ ok: true, duplicate: true });
  }

  try {
    await dispatchUpdate(update);
  } catch (e) {
    // Return non-2xx so Telegram retries; the update is only marked
    // processed after a successful run.
    logger.error("telegram update handling failed", {
      updateId,
      error: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  await markWebhookProcessed("telegram", String(updateId));
  return NextResponse.json({ ok: true });
}

async function dispatchUpdate(update: TelegramUpdate) {
  const message = update.message;
  const callback = update.callback_query;

  if (message) {
    const chatId = message.chat?.id;
    const rawFrom = message.from;
    if (!chatId || !rawFrom || !rawFrom.id) return;
    const from = {
      id: rawFrom.id,
      first_name: rawFrom.first_name,
      last_name: rawFrom.last_name,
      username: rawFrom.username,
    };

    const text = message.text?.trim() ?? "";

    if (text.startsWith("/")) {
      const command = text.split(" ")[0];
      if (command === "/start") {
        await handleTelegramCommand({ chatId, from, command });
        return;
      }
      await handleTelegramCommand({ chatId, from, command: "unknown" });
      return;
    }

    // Menu button hits (exact matches) versus free text.
    if (isMenuButton(text)) {
      await handleMenuButton({ chatId, from, button: text });
      return;
    }

    await handleTelegramMessage({ chatId, from, text, updateId: update.update_id ?? 0 });
    return;
  }

  if (callback) {
    const chatId = callback.message?.chat?.id;
    const rawFrom = callback.from;
    const data = callback.data ?? "";
    if (!chatId || !rawFrom || !rawFrom.id) return;
    const from = {
      id: rawFrom.id,
      first_name: rawFrom.first_name,
      last_name: rawFrom.last_name,
      username: rawFrom.username,
    };

    if (data.startsWith("voice_consent_yes:")) {
      await handleVoiceConsent({ chatId, voiceMessageId: data.split(":")[1], consent: true });
      return;
    }
    if (data.startsWith("voice_consent_no:")) {
      await handleVoiceConsent({ chatId, voiceMessageId: data.split(":")[1], consent: false });
      return;
    }
    if (data.startsWith("voice_correct:")) {
      await handleVoiceCorrect({ chatId, voiceMessageId: data.split(":")[1] });
      return;
    }
    if (data.startsWith("voice_wrong:")) {
      await handleVoiceWrong({ chatId, voiceMessageId: data.split(":")[1] });
      return;
    }
    if (data === "contact_operator") {
      await requestHumanHandoffFromCallback(chatId, from);
      return;
    }
  }
}

const MENU_BUTTONS = [
  "Qabulga yozilish",
  "Shifokor tanlashda yordam",
  "Narxlar",
  "Manzil",
  "Operator bilan bog‘lanish",
  "Operator bilan bog`lanish",
];

function isMenuButton(text: string): boolean {
  return MENU_BUTTONS.some((b) => text === b || text.startsWith(b.slice(0, 12)));
}

async function requestHumanHandoffFromCallback(
  chatId: number,
  from: { id: number; first_name?: string; last_name?: string; username?: string },
) {
  const { getDefaultClinic } = await import("@/lib/clinics/context");
  const { getOrCreatePatient } = await import("@/lib/patients/identity");
  const { getOrCreateConversation } = await import("@/lib/telegram/store");
  const clinic = await getDefaultClinic();
  const patient = await getOrCreatePatient({ clinicId: clinic.id, user: from });
  const conversation = await getOrCreateConversation({
    clinicId: clinic.id,
    patientId: patient.id,
    channel: "telegram",
  });
  await requestHumanHandoff({
    clinicId: clinic.id,
    patientId: patient.id,
    conversationId: conversation.id,
    chatId,
    patientLabel: from.username ? `@${from.username}` : String(from.id),
  });
}
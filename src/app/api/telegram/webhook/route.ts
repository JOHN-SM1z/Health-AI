import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { resolveClinicByBotUsername, botWebhookSecret, timingSafeCheck } from "@/lib/telegram/bots";
import { claimWebhookProcessing, finishWebhookProcessing, releaseWebhookProcessing } from "@/lib/telegram/idempotency";
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

  // 1. Routing: the webhook URL identifies WHICH bot (and clinic) this
  //    update belongs to. Unknown bots are rejected outright.
  const botUsername = request.nextUrl.searchParams.get("bot") ?? "";
  const resolved = await resolveClinicByBotUsername(botUsername);
  if (!resolved) {
    logger.warn("telegram webhook rejected: unknown bot", { bot: botUsername, ip });
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const { clinicId, integration } = resolved;

  // 2. Authenticate: Telegram echoes back the secret token set during
  //    webhook registration. It is derived per bot, so a valid token also
  //    proves this bot really was registered by the platform.
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  let expected: string;
  try {
    expected = botWebhookSecret(integration.telegram_bot_token);
  } catch {
    logger.error("telegram webhook rejected: webhook secret env missing", { clinicId, ip });
    return new NextResponse("Unauthorized", { status: 401 });
  }
  if (!timingSafeCheck(secret, expected)) {
    logger.warn("telegram webhook rejected: missing/invalid secret token", { clinicId, bot: botUsername, ip });
    return new NextResponse("Unauthorized", { status: 401 });
  }

  // 3. Basic abuse protection.
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

  // 4. Idempotency: atomically claim this update. The first delivery wins;
  //    duplicates return success without dispatching any work. Claims are
  //    per (bot, update_id) so two clinics' bots never collide.
  let claimed: boolean;
  try {
    claimed = await claimWebhookProcessing(`${botUsername}:${clinicId}`, String(updateId));
  } catch {
    logger.error("telegram webhook: could not claim update", { updateId, clinicId });
    return NextResponse.json({ ok: false }, { status: 500 });
  }
  if (!claimed) {
    logger.debug("telegram webhook duplicate dropped", { updateId, clinicId });
    return NextResponse.json({ ok: true, duplicate: true });
  }

  try {
    await dispatchUpdate(update, clinicId);
  } catch (e) {
    logger.error("telegram update handling failed", {
      updateId,
      clinicId,
      error: e instanceof Error ? e.message : String(e),
    });
    await releaseWebhookProcessing(`${botUsername}:${clinicId}`, String(updateId)).catch(() => {});
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  await finishWebhookProcessing(`${botUsername}:${clinicId}`, String(updateId)).catch(() => {});
  return NextResponse.json({ ok: true });
}

async function dispatchUpdate(update: TelegramUpdate, clinicId: string) {
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
      await handleTelegramCommand({ clinicId, chatId, from, command });
      return;
    }

    // Menu button hits (exact matches) versus free text.
    if (isMenuButton(text)) {
      await handleMenuButton({ clinicId, chatId, from, button: text });
      return;
    }

    await handleTelegramMessage({ clinicId, chatId, from, text, voice: message.voice, updateId: update.update_id ?? 0 });
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
      await requestHumanHandoffFromCallback(clinicId, chatId, from);
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
  "Suhbatni yakunlash",
];

function isMenuButton(text: string): boolean {
  // Reply-keyboard buttons are prefixed with emojis ("💰 Narxlar") while the
  // labels above are bare text. Strip leading non-word characters so taps on
  // the menu reach handleMenuButton instead of the free-text/AI path.
  const normalized = text.replace(/^\W+/, "");
  return MENU_BUTTONS.some((b) => normalized === b || normalized.startsWith(b.slice(0, 12)));
}

async function requestHumanHandoffFromCallback(
  clinicId: string,
  chatId: number,
  from: { id: number; first_name?: string; last_name?: string; username?: string },
) {
  const { getOrCreatePatient } = await import("@/lib/patients/identity");
  const { getOrCreateConversation } = await import("@/lib/telegram/store");
  const patient = await getOrCreatePatient({ clinicId, user: from });
  const conversation = await getOrCreateConversation({
    clinicId,
    patientId: patient.id,
    channel: "telegram",
  });
  await requestHumanHandoff({
    clinicId,
    patientId: patient.id,
    conversationId: conversation.id,
    chatId,
    patientLabel: from.username ? `@${from.username}` : String(from.id),
  });
}
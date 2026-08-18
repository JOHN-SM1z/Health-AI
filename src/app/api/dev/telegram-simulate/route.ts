import { NextResponse } from "next/server";
import { telegramDevModeEnabled, isProduction } from "@/lib/env";
import { handleTelegramMessage, handleTelegramCommand } from "@/lib/telegram/handlers";
import { DEV_TELEGRAM_USER_ID } from "@/lib/patients/identity";
import { getClinicFromRequest } from "@/lib/clinics/context";

export const dynamic = "force-dynamic";

/**
 * LOCAL DEVELOPMENT ONLY — clearly labeled local testing path.
 * Lets you test the bot pipeline without a real Telegram bot.
 * It sends nothing to Telegram; it exercises the same handlers against the
 * local database. NEVER available in production.
 */
export async function POST(request: Request) {
  if (isProduction || !telegramDevModeEnabled()) {
    return NextResponse.json({ ok: false, error: "dev simulation is disabled" }, { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as
    | { text?: string; voice?: boolean; command?: string }
    | null;

  const clinic = await getClinicFromRequest(request);
  if (!clinic) {
    return NextResponse.json({ ok: false, error: "no clinic context" }, { status: 400 });
  }
  const clinicId = clinic.id;

  const from = {
    id: DEV_TELEGRAM_USER_ID,
    first_name: "Local",
    username: "local_dev",
  };
  const chatId = DEV_TELEGRAM_USER_ID;

  if (body?.command === "/start") {
    await handleTelegramCommand({ clinicId, chatId, from, command: "/start" });
    return NextResponse.json({ ok: true, note: "dev-simulated /start" });
  }

  if (body?.voice) {
    await handleTelegramMessage({
      clinicId,
      chatId,
      from,
      updateId: Date.now(),
      voice: { file_id: "dev-voice-file-id", mime_type: "audio/ogg", duration: 5, file_size: 1234 },
    });
    return NextResponse.json({ ok: true, note: "dev-simulated voice message (metadata only)" });
  }

  if (!body?.text) {
    return NextResponse.json({ ok: false, error: "send { text } or { voice: true }" }, { status: 400 });
  }

  await handleTelegramMessage({ clinicId, chatId, from, text: body.text, updateId: Date.now() });
  return NextResponse.json({ ok: true, note: "dev-simulated text message" });
}
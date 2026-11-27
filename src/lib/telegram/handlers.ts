import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { adminChatIds, env } from "@/lib/env";
import { getClinicById } from "@/lib/clinics/context";
import { getClinicContact } from "@/lib/clinics/contact";
import { getOrCreatePatient } from "@/lib/patients/identity";
import { recordSharedContact } from "@/lib/patients/online-identity";
import { getOrCreateConversation, appendMessage, conversationIsHeld, updateConversationState } from "@/lib/telegram/store";
import { sendTelegramMessage, getTelegramFileUrl } from "@/lib/telegram/bot";
import { appUrlCandidates, resolveHttpsAppUrl } from "@/lib/telegram/bots";
import { generateReceptionistReply } from "@/lib/ai/receptionist";
import { startNavigation, suggestNavigation, NAVIGATION_STATE_KEY } from "@/lib/ai/navigation";
import { trackAnalytics } from "@/lib/analytics";
import { recordAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { getHealthTranscriptionProvider } from "@/lib/transcription/provider";
import { detectUrgency, urgentMessage } from "@/lib/safety/policy";
import { listUpcomingAppointments, upcomingAppointmentsText } from "@/lib/appointments/patient-upcoming";

/**
 * Booking link for a clinic, or null when no usable app address is
 * configured (see appUrlCandidates in bots.ts — NEXT_PUBLIC_APP_URL, then
 * Vercel's own platform-provided deployment URL, in that order). Supports
 * the t.me deep-link form — tapping it opens the Mini App inside Telegram
 * with valid initData — as an explicit escape hatch: it only ever comes
 * from a literally-configured NEXT_PUBLIC_APP_URL, never an inferred
 * platform URL, since a Vercel address is never itself a t.me link. The
 * clinic is embedded so the Mini App opens the right tenant. The
 * startapp=booking marker lets the booking page attribute the booking to
 * the bot-chat deep link (appointment_source = telegram_chat) instead of
 * the menu web_app button (telegram_mini_app).
 */
const bookingLink = (clinicId: string): string | null => {
  const configured = env.NEXT_PUBLIC_APP_URL?.trim() ?? "";
  if (configured === "https://t.me" || configured.startsWith("https://t.me/")) return configured;
  for (const base of appUrlCandidates()) {
    const trimmed = base.trim();
    if (!trimmed) continue;
    try {
      const url = new URL(`${trimmed}/book?clinic=${encodeURIComponent(clinicId)}`);
      url.searchParams.set("startapp", "booking");
      if (url.protocol === "https:" || url.protocol === "http:") return url.toString();
    } catch {
      // Malformed candidate — try the next one.
    }
  }
  return null;
};

/**
 * HTTPS Mini App URL for a web_app button of a clinic, or null when
 * unavailable. Telegram rejects the WHOLE message (BUTTON_URL_INVALID) when a
 * web_app button's domain is not whitelisted in @BotFather, so the button is
 * only attached when an HTTPS app URL is configured (never for a t.me
 * deep-link base — excluded by resolveHttpsAppUrl's https-only check).
 * sendTelegramMessage still downgrades it to a plain text (or, for an inline
 * keyboard, a plain link) button if Telegram rejects it anyway, so the menu
 * always renders.
 */
const webAppUrl = (clinicId: string): string | null =>
  resolveHttpsAppUrl(`/book?clinic=${encodeURIComponent(clinicId)}`);

/**
 * Reply keyboard for the main menu of a clinic. The booking button is a
 * web_app button when a whitelisted HTTPS Mini App URL is configured — tapping
 * it opens the booking app directly inside Telegram with valid initData.
 * Otherwise it degrades to a plain text button that routes to
 * handleMenuButton, which replies with the booking link.
 */
export function buildMainKeyboard(clinicId: string) {
  const url = webAppUrl(clinicId);
  const bookingButton = url
    ? { text: "📅 Qabulga yozilish", web_app: { url } }
    : { text: "📅 Qabulga yozilish" };
  return {
    keyboard: [
      [bookingButton],
      [{ text: "📋 Mening qabullarim" }],
      [{ text: "🤖 Shifokor tanlashda yordam" }],
      [{ text: "💰 Narxlar" }],
      [{ text: "📍 Manzil" }],
      [{ text: "👤 Operator bilan bog‘lanish" }],
    ],
    resize_keyboard: true,
  };
}

/**
 * Reply keyboard shown while the conversation is held by a human operator.
 * The only action is leaving the operator chat — the patient must have a way
 * out, since every other tap is blocked while the conversation is held.
 */
export function buildHeldKeyboard() {
  return {
    keyboard: [[{ text: "🚪 Suhbatni yakunlash" }]],
    resize_keyboard: true,
  };
}

export function welcomeText(clinicName: string): string {
  return (
    `Assalomu alaykum! 👋\n` +
    `Bu — ${clinicName}ning rasmiy qabul boti.\n\n` +
    `Men klinika ma‘lumotlari (manzil, narxlar, ish vaqti) va qabulga yozilishda yordam beraman. ` +
    `Bot tibbiy tashxis qo‘ymaydi va davolash tavsiya qilmaydi.\n\n` +
    `Qulay tugmani tanlang 👇`
  );
}

export async function handleTelegramMessage(opts: {
  clinicId: string;
  chatId: number;
  from: { id: number; first_name?: string; last_name?: string; username?: string };
  text?: string;
  voice?: { file_id: string; file_unique_id?: string; duration?: number; mime_type?: string; file_size?: number };
  updateId: number;
}): Promise<void> {
  const text = opts.text?.trim() ?? "";
  const urgent = !opts.voice && detectUrgency(text) === "urgent";
  let context;
  try {
    const clinic = await getClinicById(opts.clinicId);
    const patient = await getOrCreatePatient({
      clinicId: clinic.id,
      user: opts.from,
    });
    const conversation = await getOrCreateConversation({
      clinicId: clinic.id,
      patientId: patient.id,
      channel: "telegram",
    });
    context = { clinic, patient, conversation };
  } catch {
    logger.error("telegram conversation initialization failed", { clinicId: opts.clinicId, updateId: opts.updateId });
    if (!urgent) throw new Error("telegram_conversation_initialization_failed");

    const messageId = await sendTelegramMessage({
      chatId: opts.chatId,
      text: urgentMessage(text),
    }, opts.clinicId);
    if (messageId === null) throw new Error("telegram_urgent_notice_unverified");
    return;
  }

  const { clinic, patient, conversation } = context;
  try {
    // Voice messages take the voice pipeline.
    if (opts.voice) {
      await handleVoiceMessage({
        clinicId: clinic.id,
        patientId: patient.id,
        conversationId: conversation.id,
        chatId: opts.chatId,
        voice: opts.voice,
      });
      return;
    }

    if (!text) return;

    try {
      await appendMessage({
        conversationId: conversation.id,
        clinicId: clinic.id,
        role: "patient",
        type: "text",
        content: text,
        telegramMessageId: opts.updateId,
      });
    } catch (error) {
      if (!urgent) throw error;
      // A transcript write failure must not suppress the urgent-care notice.
      logger.error("urgent message could not be recorded", { conversationId: conversation.id });
    }

    const patientLabel = opts.from.username ? `@${opts.from.username}` : String(opts.from.id);

    // Urgent wording, decided before anything else and without any AI: the
    // approved urgent-care message goes out and the clinic's staff are
    // alerted — also when an operator already holds the conversation (the
    // deterministic safety message is not an automatic reply).
    if (urgent) {
      await escalateUrgent({
        clinicId: clinic.id,
        patientId: patient.id,
        conversationId: conversation.id,
        chatId: opts.chatId,
        text,
        patientLabel,
      });
      return;
    }

    // Conversation under human control: store, do not auto-reply.
    if (await conversationIsHeld(clinic.id, conversation.id)) {
      logger.info("automated reply suppressed", { conversationId: conversation.id });
      return;
    }

    // State-machine: navigation flow.
    const state = (conversation.state ?? {}) as Record<string, unknown>;
    const nav = state[NAVIGATION_STATE_KEY] as { step: number } | undefined;
    if (nav && nav.step === 1) {
      await trackAnalytics({ clinicId: clinic.id, patientId: patient.id, eventType: "navigation_answer" });
      const reply = await suggestNavigation(clinic.id, text);
      await updateConversationState(clinic.id, conversation.id, { ...state, [NAVIGATION_STATE_KEY]: { step: 2 } });
      // The admin may have taken over while we were thinking — never reply
      // over a human. Re-check immediately before sending.
      if (await conversationIsHeld(clinic.id, conversation.id)) return;
      await sendTelegramMessage({ chatId: opts.chatId, text: reply, replyMarkup: buildMainKeyboard(clinic.id) }, clinic.id);
      await appendMessage({
        conversationId: conversation.id,
        clinicId: clinic.id,
        role: "ai",
        type: "text",
        content: reply,
      });
      return;
    }

    const reply = await generateReceptionistReply({ clinicId: clinic.id, userText: text });
    // The admin may have taken over while the AI was generating. One
    // authoritative mode: never send an AI reply over a human operator.
    if (await conversationIsHeld(clinic.id, conversation.id)) return;
    await sendTelegramMessage(
      {
        chatId: opts.chatId,
        text: reply.text,
        replyMarkup: reply.handoff ? buildMainKeyboard(clinic.id) : undefined,
      },
      clinic.id,
    );
    await appendMessage({
      conversationId: conversation.id,
      clinicId: clinic.id,
      role: reply.usedAi ? "ai" : "bot",
      type: "text",
      content: reply.text,
    });

  } catch {
    logger.error("telegram message handling failed", { clinicId: opts.clinicId, updateId: opts.updateId });
  }
}

export async function handleTelegramCommand(opts: {
  clinicId: string;
  chatId: number;
  from: { id: number; first_name?: string; last_name?: string; username?: string };
  command: string;
  text?: string;
}): Promise<void> {
  const clinic = await getClinicById(opts.clinicId);
  const patient = await getOrCreatePatient({
    clinicId: clinic.id,
    user: opts.from,
  });
  const conversation = await getOrCreateConversation({
    clinicId: clinic.id,
    patientId: patient.id,
    channel: "telegram",
  });
  const held = await conversationIsHeld(clinic.id, conversation.id);

  switch (opts.command) {
    case "/start": {
      await appendMessage({
        conversationId: conversation.id,
        clinicId: clinic.id,
        role: "patient",
        type: "system",
        content: "/start",
      });
      if (held) {
        await sendTelegramMessage(
          {
            chatId: opts.chatId,
            text: "Hozir avtomatik javoblar faol emas. Operator javobini kuting.",
            replyMarkup: buildHeldKeyboard(),
          },
          clinic.id,
        );
        return;
      }
      await sendTelegramMessage({ chatId: opts.chatId, text: welcomeText(clinic.name), replyMarkup: buildMainKeyboard(clinic.id) }, clinic.id);
      await trackAnalytics({ clinicId: clinic.id, patientId: patient.id, eventType: "bot_started" });
      break;
    }
    case "/chiqish":
    case "/stop":
    case "/exit": {
      await appendMessage({
        conversationId: conversation.id,
        clinicId: clinic.id,
        role: "patient",
        type: "system",
        content: opts.command,
      });
      await exitOperatorChat({
        clinicId: clinic.id,
        patientId: patient.id,
        conversationId: conversation.id,
        chatId: opts.chatId,
        patientLabel: opts.from.username ? `@${opts.from.username}` : String(opts.from.id),
      });
      break;
    }
    default:
      await sendTelegramMessage(
        { chatId: opts.chatId, text: "Noma‘lum buyruq. Iltimos, tugmalardan foydalaning." },
        clinic.id,
      );
  }
}

/**
 * A contact arrived in the chat (the Mini App's "share my phone" sends it here). Kept as the sender's verified phone
 * only when it is their own; the number itself is never echoed back, logged or audited.
 */
export async function handleContactShared(opts: {
  clinicId: string;
  chatId: number;
  from: { id: number };
  contact: { phone_number?: string; user_id?: number };
}) {
  const outcome = await recordSharedContact(opts.clinicId, opts.from, opts.contact);
  const text =
    outcome === "verified"
      ? "✅ Telefon raqamingiz tasdiqlandi. Ilovaga qayting — yozilishni davom ettiramiz."
      : outcome === "not_own"
        ? "Faqat o‘zingizning Telegram raqamingizni yuboring (“Raqamni ulashish” tugmasi orqali)."
        : "Onlayn tasdiqlash faqat O‘zbekiston raqamlari (+998) uchun ishlaydi. Iltimos, qabulxonaga murojaat qiling.";
  await sendTelegramMessage({ chatId: opts.chatId, text, replyMarkup: { remove_keyboard: true } }, opts.clinicId);
}

/** Menu button handler — the shared text-based commands. */
export async function handleMenuButton(opts: {
  clinicId: string;
  chatId: number;
  from: { id: number; first_name?: string; last_name?: string; username?: string };
  button: string;
}): Promise<void> {
  const clinic = await getClinicById(opts.clinicId);
  const patient = await getOrCreatePatient({
    clinicId: clinic.id,
    user: opts.from,
  });
  const conversation = await getOrCreateConversation({
    clinicId: clinic.id,
    patientId: patient.id,
    channel: "telegram",
  });
  const held = await conversationIsHeld(clinic.id, conversation.id);

  // Leaving the operator chat must work even while the conversation is held.
  if (opts.button.includes("Suhbatni yakunlash")) {
    await exitOperatorChat({
      clinicId: clinic.id,
      patientId: patient.id,
      conversationId: conversation.id,
      chatId: opts.chatId,
      patientLabel: opts.from.username ? `@${opts.from.username}` : String(opts.from.id),
    });
    return;
  }

  if (held) {
    await sendTelegramMessage(
      {
        chatId: opts.chatId,
        text: "Hozir avtomatik javoblar faol emas. Operator javobini kuting.",
        replyMarkup: buildHeldKeyboard(),
      },
      clinic.id,
    );
    return;
  }

  if (opts.button.includes("Qabulga yozilish")) {
    const url = bookingLink(clinic.id);
    const isHttps = url && url.startsWith("https://");
    const replyMarkup = url
      ? {
          inline_keyboard: [
            [
              isHttps
                ? { text: "📅 Qabulga yozilish (Ilovani ochish)", web_app: { url } }
                : { text: "📅 Qabulga yozilish (Havola)", url },
            ],
          ],
        }
      : undefined;

    await sendTelegramMessage(
      {
        chatId: opts.chatId,
        text: url
          ? `Qabulga yozilish uchun quyidagi tugmani bosing:`
          : "Qabulga yozilish hozircha onlayn sozlanmagan. Iltimos, operatorlarimizga murojaat qiling.",
        replyMarkup,
      },
      clinic.id,
    );
    return;
  }

  if (opts.button.includes("Mening qabullarim")) {
    // Answered in the chat itself: the patient is the verified sender of this
    // update, so this works however the Mini App was (or wasn't) opened. The
    // inline web_app button opens the full page with valid initData.
    let text: string;
    try {
      text = upcomingAppointmentsText(await listUpcomingAppointments(clinic.id, patient.id), clinic.timezone);
    } catch {
      text = "Qabullaringizni hozir yuklab bo‘lmadi. Birozdan keyin qayta urinib ko‘ring.";
    }
    const url = resolveHttpsAppUrl(`/my-appointments?clinic=${encodeURIComponent(clinic.id)}`);
    await sendTelegramMessage(
      {
        chatId: opts.chatId,
        text,
        replyMarkup: url ? { inline_keyboard: [[{ text: "📋 Qabullarimni ochish", web_app: { url } }]] } : buildMainKeyboard(clinic.id),
      },
      clinic.id,
    );
    return;
  }

  if (opts.button.includes("Shifokor tanlashda yordam")) {
    await updateConversationState(clinic.id, conversation.id, {
      ...(typeof conversation.state === "object" && conversation.state ? conversation.state as Record<string, unknown> : {}),
      [NAVIGATION_STATE_KEY]: { step: 1 },
    });
    const question = await startNavigation();
    if (await conversationIsHeld(clinic.id, conversation.id)) return;
    await sendTelegramMessage({ chatId: opts.chatId, text: question, replyMarkup: buildMainKeyboard(clinic.id) }, clinic.id);
    await appendMessage({
      conversationId: conversation.id,
      clinicId: clinic.id,
      role: "bot",
      type: "text",
      content: question,
    });
    await trackAnalytics({ clinicId: clinic.id, patientId: patient.id, eventType: "navigation_started" });
    return;
  }

  if (opts.button.includes("Narxlar")) {
    const supabase = createAdminClient();
    const { data: services } = await supabase
      .from("services")
      .select("name, price, duration_minutes")
      .eq("clinic_id", clinic.id)
      .eq("active", true)
      .order("sort_order");
    const text = services && services.length
      ? "💰 Xizmatlar narxlari:\n\n" +
        services.map((s) => `• ${s.name} — ${new Intl.NumberFormat("uz-UZ").format(Number(s.price))} ${clinic.currency}, ${s.duration_minutes} daq.`).join("\n") +
        "\n\nQabulga yozilish uchun “Qabulga yozilish” tugmasini bosing."
      : "Narxlar ro‘yxati hozircha kiritilmagan. Operatorlarimizga murojaat qiling.";
    await sendTelegramMessage({ chatId: opts.chatId, text, replyMarkup: buildMainKeyboard(clinic.id) }, clinic.id);
    return;
  }

  if (opts.button.includes("Manzil")) {
    const contact = await getClinicContact(clinic);
    const lines = [
      contact.address ? `📍 Manzil: ${contact.address}` : "📍 Manzil hozircha kiritilmagan.",
      contact.phone ? `☎️ Telefon: ${contact.phone}` : null,
      contact.openingHours ? `🕘 Ish vaqti: ${contact.openingHours}` : null,
    ].filter(Boolean);
    const text = contact.address || contact.phone
      ? lines.join("\n")
      : "Manzil hozircha kiritilmagan. Operatorlarimizga murojaat qiling.";
    await sendTelegramMessage({ chatId: opts.chatId, text, replyMarkup: buildMainKeyboard(clinic.id) }, clinic.id);
    return;
  }

  if (opts.button.includes("Operator bilan bog‘lanish") || opts.button.includes("Operator bilan bog`lanish")) {
    await requestHumanHandoff({
      clinicId: clinic.id,
      patientId: patient.id,
      conversationId: conversation.id,
      chatId: opts.chatId,
      patientLabel: opts.from.username ? `@${opts.from.username}` : String(opts.from.id),
    });
    return;
  }

  await handleTelegramMessage({
    clinicId: clinic.id,
    chatId: opts.chatId,
    from: opts.from,
    text: opts.button,
    updateId: Date.now(),
  });
}

/** Patient asks for a human: pause automation and notify admins. */
/**
 * Urgent wording reaches the clinic's own staff. The conversation is marked
 * urgent (the conversation center lists it first, flagged, until a staff
 * member takes it over) and automatic replies stop, so a person answers
 * next; the event is audited. The patient receives the approved urgent-care
 * message, and is told the staff were alerted only once that is recorded.
 * Platform admin chats, when configured, are told as before.
 */
async function escalateUrgent(opts: {
  clinicId: string;
  patientId: string;
  conversationId: string;
  chatId: number;
  text: string;
  patientLabel: string;
}): Promise<void> {
  let flaggedForStaff = false;
  try {
    const { data: flagged, error } = await createAdminClient()
      .from("conversations")
      .update({ urgent_at: new Date().toISOString(), ai_enabled: false })
      .eq("id", opts.conversationId)
      .eq("clinic_id", opts.clinicId)
      .select("id");
    flaggedForStaff = !error && !!flagged?.length;
  } catch {
    // Send the approved urgent-care notice even if the database is unavailable.
  }
  let alertRecorded = false;
  if (!flaggedForStaff) {
    logger.error("urgent escalation could not be recorded", { conversationId: opts.conversationId });
  } else {
    try {
      await recordAudit({
        clinicId: opts.clinicId,
        action: "conversation_urgent",
        entityType: "conversations",
        entityId: opts.conversationId,
        actor: { actorType: "telegram" },
        strict: true,
      });
      alertRecorded = true;
    } catch {
      // The flag remains available to staff. Do not claim the alert was recorded.
    }
  }

  const reply = alertRecorded
    ? `${urgentMessage(opts.text)}\n\nKlinika xodimlariga xabar berildi — operator imkon qadar tezroq javob beradi.`
    : urgentMessage(opts.text);
  await sendTelegramMessage({ chatId: opts.chatId, text: reply, replyMarkup: buildHeldKeyboard() }, opts.clinicId);
  try {
    await appendMessage({
      conversationId: opts.conversationId,
      clinicId: opts.clinicId,
      role: "bot",
      type: "text",
      content: reply,
    });
  } catch {
    logger.error("urgent notice could not be recorded", { conversationId: opts.conversationId });
  }
  await trackAnalytics({ clinicId: opts.clinicId, patientId: opts.patientId, eventType: "urgent_flag" });
  await notifyAdmins("⚠️ Suhbatni zudlik bilan ko‘rib chiqish kerak.");
}

/**
 * Urgent wording typed (or spoken) in the Mini App's concern step: the same escalation as in the chat. The patient's
 * conversation with the clinic's bot is flagged urgent for staff, automation stops, and the approved urgent-care
 * message goes to their Telegram chat as well as the Mini App. No booking is offered.
 */
export async function escalateUrgentFromMiniApp(opts: { clinicId: string; patientId: string; telegramUserId: number; text: string; patientLabel: string }) {
  const conversation = await getOrCreateConversation({ clinicId: opts.clinicId, patientId: opts.patientId, channel: "telegram" });
  try {
    await appendMessage({ conversationId: conversation.id, clinicId: opts.clinicId, role: "patient", type: "text", content: opts.text, metadata: { via: "mini_app_concern" } });
  } catch {
    logger.error("urgent message could not be recorded", { conversationId: conversation.id });
  }
  await escalateUrgent({
    clinicId: opts.clinicId,
    patientId: opts.patientId,
    conversationId: conversation.id,
    chatId: opts.telegramUserId,
    text: opts.text,
    patientLabel: opts.patientLabel,
  });
}

export async function requestHumanHandoff(opts: {
  clinicId: string;
  patientId: string;
  conversationId: string;
  chatId: number;
  patientLabel: string;
}): Promise<void> {
  const supabase = createAdminClient();
  const { data: requested, error } = await supabase
    .from("conversations")
    .update({ ai_enabled: false })
    .eq("id", opts.conversationId)
    .eq("clinic_id", opts.clinicId)
    .eq("patient_id", opts.patientId)
    .eq("channel", "telegram")
    .in("status", ["open", "assigned"])
    .select("id")
    .maybeSingle();

  if (error || !requested) {
    logger.error("operator request could not be recorded", { conversationId: opts.conversationId });
    await sendTelegramMessage({
      chatId: opts.chatId,
      text: "Operator so‘rovini hozir yuborib bo‘lmadi. Iltimos, klinika bilan bog‘laning.",
    }, opts.clinicId);
    return;
  }

  await recordAudit({
    clinicId: opts.clinicId,
    action: "conversation_handoff_requested",
    entityType: "conversations",
    entityId: opts.conversationId,
    actor: { actorType: "telegram" },
  });

  const clinic = await getClinicById(opts.clinicId).catch(() => null);
  const contact = clinic ? await getClinicContact(clinic) : null;
  await sendTelegramMessage(
    {
      chatId: opts.chatId,
      text:
        "Operatorlarimiz siz bilan shu yerda bog‘lanadi. Biroz kuting. ⏳\n\nOperator javob berguncha avtomatik xabarlar to‘xtatiladi." +
        (contact?.phone ? `\n\n☎️ Tezroq bog‘lanish uchun qo‘ng‘iroq qiling: ${contact.phone}` : ""),
      replyMarkup: buildHeldKeyboard(),
    },
    opts.clinicId,
  );
  await appendMessage({
    conversationId: opts.conversationId,
    clinicId: opts.clinicId,
    role: "bot",
    type: "text",
    content: "Operator bilan bog‘lanish so‘raldi — avtomatik javoblar to‘xtatildi.",
  });
  await trackAnalytics({ clinicId: opts.clinicId, patientId: opts.patientId, eventType: "human_handoff_requested" });

  await notifyAdmins(`👤 Bemor operator so‘radi: ${opts.patientLabel}`);
}

/**
 * The patient may cancel their pending request for an operator. An urgent
 * hold or a conversation assigned to staff can only be released by staff.
 */
export async function exitOperatorChat(opts: {
  clinicId: string;
  patientId: string;
  conversationId: string;
  chatId: number;
  patientLabel: string;
}): Promise<void> {
  const supabase = createAdminClient();
  const returnUnavailable = {
    chatId: opts.chatId,
    text: "Hozir botga qaytib bo‘lmaydi. Operator javobini kuting.",
    replyMarkup: buildHeldKeyboard(),
  };
  const { data: conv, error: lookupError } = await supabase
    .from("conversations")
    .select("status, ai_enabled, urgent_at")
    .eq("id", opts.conversationId)
    .eq("clinic_id", opts.clinicId)
    .eq("patient_id", opts.patientId)
    .eq("channel", "telegram")
    .maybeSingle();

  if (lookupError || !conv || conv.status !== "open" || (!conv.ai_enabled && conv.urgent_at !== null)) {
    await sendTelegramMessage(returnUnavailable, opts.clinicId);
    return;
  }

  if (conv.ai_enabled) {
    await sendTelegramMessage(
      {
        chatId: opts.chatId,
        text: "Hozir operator bilan faol suhbat yo‘q. Qanday yordam kerak?",
        replyMarkup: buildMainKeyboard(opts.clinicId),
      },
      opts.clinicId,
    );
    return;
  }

  // A staff takeover or urgent escalation may have occurred since the read.
  const { data: released, error } = await supabase
    .from("conversations")
    .update({
      ai_enabled: true,
      released_at: new Date().toISOString(),
    })
    .eq("id", opts.conversationId)
    .eq("clinic_id", opts.clinicId)
    .eq("patient_id", opts.patientId)
    .eq("channel", "telegram")
    .eq("status", "open")
    .eq("ai_enabled", false)
    .is("urgent_at", null)
    .select("id")
    .maybeSingle();
  if (error || !released) {
    await sendTelegramMessage(returnUnavailable, opts.clinicId);
    return;
  }

  await recordAudit({
    clinicId: opts.clinicId,
    action: "conversation_patient_exit",
    entityType: "conversations",
    entityId: opts.conversationId,
    actor: { actorType: "telegram" },
  });

  await sendTelegramMessage(
    {
      chatId: opts.chatId,
      text: "Suhbat yakunlandi. ✅\n\nEndi bot yana javob beradi. Qanday yordam kerak?",
      replyMarkup: buildMainKeyboard(opts.clinicId),
    },
    opts.clinicId,
  );
  await appendMessage({
    conversationId: opts.conversationId,
    clinicId: opts.clinicId,
    role: "bot",
    type: "system",
    content: "Bemor operator bilan suhbatni yakunladi — avtomatik javoblar qayta yoqildi.",
  });
  await trackAnalytics({ clinicId: opts.clinicId, patientId: opts.patientId, eventType: "human_handoff_ended" });

  await notifyAdmins(`🚪 Bemor operator bilan suhbatni yakunladi: ${opts.patientLabel}`);
}

async function notifyAdmins(message: string) {
  const ids = adminChatIds();
  if (ids.length === 0) return;
  for (const id of ids) {
    await sendTelegramMessage({ chatId: id, text: message });
  }
}

// ---------------------------------------------------------------------------
// Voice pipeline
// ---------------------------------------------------------------------------

const VOICE_RETENTION_DAYS = 7;
const VOICE_DAY_MS = 86_400_000;

async function handleVoiceMessage(opts: {
  clinicId: string;
  patientId: string;
  conversationId: string;
  chatId: number;
  voice: { file_id: string; file_unique_id?: string; duration?: number; mime_type?: string; file_size?: number };
}): Promise<void> {
  const supabase = createAdminClient();
  const { voice, clinicId, conversationId, chatId } = opts;

  // 1. Save Telegram file metadata and processing state FIRST.
  const { data: voiceRow, error } = await supabase
    .from("voice_messages")
    .insert({
      clinic_id: clinicId,
      conversation_id: conversationId,
      telegram_file_id: voice.file_id,
      telegram_file_unique_id: voice.file_unique_id ?? null,
      duration_seconds: voice.duration ?? null,
      mime_type: voice.mime_type ?? null,
      size_bytes: voice.file_size ?? null,
      transcription_status: "none",
      retention_days: VOICE_RETENTION_DAYS,
      expires_at: new Date(Date.now() + VOICE_RETENTION_DAYS * VOICE_DAY_MS).toISOString(),
    })
    .select("*")
    .single();
  if (error || !voiceRow) {
    logger.error("voice metadata save failed", { code: error?.code });
    if (await conversationIsHeld(clinicId, conversationId)) return;
    await sendTelegramMessage(
      {
        chatId,
        text: "Ovozli xabarni saqlashda xatolik yuz berdi. Iltimos, qayta yuboring yoki matn shaklida yozing.",
      },
      clinicId,
    );
    return;
  }

  await appendMessage({
    conversationId,
    clinicId,
    role: "patient",
    type: "voice",
    content: "[ovozli xabar]",
    voiceMessageId: voiceRow.id,
  });

  if (await conversationIsHeld(clinicId, conversationId)) return;

  // 2. Transcription must be enabled AND consented before processing.
  if (!getHealthTranscriptionProvider()) {
    await sendTelegramMessage(
      {
        chatId,
        text:
          "Ovozli xabaringiz qabul qilindi. Hozircha uni avtomatik tushunish yoqilmagan, shuning uchun eshitilgan matn sifatida javob bera olmaymiz. " +
          "Iltimos, xabaringizni matn shaklida yozing yoki “Operator bilan bog‘lanish” tugmasini bosing — operatorlar yordam beradi. 📩",
      },
      clinicId,
    );
    return;
  }

  // 3. Ask for consent before downloading/transcribing.
  await sendTelegramMessage(
    {
      chatId,
      text:
        "Ovozli xabaringizni tushunish uchun uni matnga aylantirishimiz kerak. " +
        "Matn faqat qabulga yordam berish uchun ishlatiladi. Ruxsat berasizmi?",
      replyMarkup: {
        inline_keyboard: [
          [
            { text: "Ha, ruxsat", callback_data: `voice_consent_yes:${voiceRow.id}` },
            { text: "Yo‘q", callback_data: `voice_consent_no:${voiceRow.id}` },
          ],
        ],
      },
    },
    clinicId,
  );
}

/**
 * The voice message a button press refers to — only if it belongs to this
 * clinic AND to the Telegram user who pressed the button. Callback data can
 * be sent by a modified client with any value, so the id alone never lets
 * one patient consent to (or correct) another patient's recording.
 */
async function ownVoiceMessage(clinicId: string, voiceMessageId: string, telegramUserId: number) {
  const { data, error } = await createAdminClient()
    .from("voice_messages")
    .select("*, conversations!inner(patients!inner(telegram_user_id))")
    .eq("id", voiceMessageId)
    .eq("clinic_id", clinicId)
    .maybeSingle();
  const owner = (data?.conversations as { patients?: { telegram_user_id?: number | null } } | null)?.patients?.telegram_user_id;
  if (error || !data || owner !== telegramUserId || data.purged_at || voiceExpired(data.expires_at)) return null;
  return data;
}

function voiceExpired(expiresAt: string | null): boolean {
  return expiresAt !== null && Date.parse(expiresAt) <= Date.now();
}

const voiceFailureText =
  "Kechirasiz, ovozli xabaringizni qayta ishlay olmadim va eshitilgan matn sifatida javob bera olmayman. " +
  "Iltimos, xabaringizni matn shaklida yozing yoki operatorlarimizga murojaat qiling — ular yordam beradi.";

export async function handleVoiceConsent(opts: {
  clinicId: string;
  chatId: number;
  /** The Telegram user who pressed the button: consent is theirs to give, for their own recording only. */
  telegramUserId: number;
  voiceMessageId: string;
  consent: boolean;
}): Promise<void> {
  const supabase = createAdminClient();
  const voiceRow = await ownVoiceMessage(opts.clinicId, opts.voiceMessageId, opts.telegramUserId);
  if (!voiceRow) {
    await sendTelegramMessage({ chatId: opts.chatId, text: "Ovozli xabar topilmadi." }, opts.clinicId);
    return;
  }

  const { id, clinic_id: clinicId, conversation_id: conversationId } = voiceRow;
  if (voiceRow.transcription_status !== "none") return;

  if (!opts.consent) {
    const { data: rejected, error } = await supabase.from("voice_messages")
      .update({ consent_given: false, transcription_status: "failed", expires_at: new Date().toISOString() })
      .eq("id", id)
      .eq("clinic_id", clinicId)
      .eq("transcription_status", "none")
      .is("purged_at", null)
      .select("id")
      .maybeSingle();
    if (error) logger.error("voice refusal could not be saved", { code: error.code });
    if (error || !rejected || await conversationIsHeld(clinicId, conversationId)) return;
    await sendTelegramMessage(
      {
        chatId: opts.chatId,
        text:
          "Tushundim, ovozli xabaringizni qayta ishlamaymiz. " +
          "Agar yordam kerak bo‘lsa, matn shaklida yozing yoki operatorlarimiz bilan bog‘laning.",
      },
      clinicId,
    );
    return;
  }

  if (await conversationIsHeld(clinicId, conversationId)) return;
  const provider = getHealthTranscriptionProvider();
  if (!provider || !voiceRow.telegram_file_id || voiceRow.retention_days <= 0) {
    await sendTelegramMessage({ chatId: opts.chatId, text: voiceFailureText }, clinicId);
    return;
  }

  const mimeType = voiceRow.mime_type === "audio/mpeg" || voiceRow.mime_type === "audio/mp4" ? voiceRow.mime_type : "audio/ogg";
  const ext = mimeType === "audio/mpeg" ? "mp3" : mimeType === "audio/mp4" ? "m4a" : "ogg";
  const path = `${clinicId}/${id}.${ext}`;
  const startedAt = new Date();
  const expiresAt = new Date(startedAt.getTime() + voiceRow.retention_days * VOICE_DAY_MS).toISOString();
  // Persist consent and the cleanup pointer together before reading any audio.
  // Only one consent button tap can move the row from none to pending.
  const { data: claimed, error: claimError } = await supabase
    .from("voice_messages")
    .update({ consent_given: true, transcription_status: "pending", storage_path: path, expires_at: expiresAt })
    .eq("id", id)
    .eq("clinic_id", clinicId)
    .eq("transcription_status", "none")
    .is("purged_at", null)
    .or(`expires_at.is.null,expires_at.gt.${startedAt.toISOString()}`)
    .select("id")
    .maybeSingle();
  if (claimError) {
    logger.error("voice consent could not be saved", { code: claimError.code });
    if (!(await conversationIsHeld(clinicId, conversationId))) {
      await sendTelegramMessage({ chatId: opts.chatId, text: voiceFailureText }, clinicId);
    }
    return;
  }
  if (!claimed) return;

  let transcript: string;
  try {
    if (await conversationIsHeld(clinicId, conversationId)) throw new Error("voice held");
    await sendTelegramMessage({ chatId: opts.chatId, text: "Ovozli xabaringizni qayta ishlayapmiz... ⏳" }, clinicId);
    const fileUrl = await getTelegramFileUrl(voiceRow.telegram_file_id, clinicId);
    if (!fileUrl) throw new Error("telegram file unavailable");
    const res = await fetch(fileUrl, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error("voice download failed");
    const buffer = Buffer.from(await res.arrayBuffer());

    if (await conversationIsHeld(clinicId, conversationId)) throw new Error("voice held");
    const result = await provider.transcribe({ file: buffer, mimeType, fileName: `${id}.${ext}` });

    if (await conversationIsHeld(clinicId, conversationId)) throw new Error("voice held");
    const { error: uploadError } = await supabase.storage.from("voice-messages")
      .upload(path, buffer, { contentType: mimeType });
    if (uploadError) throw new Error("voice upload failed");

    const { data: saved, error: saveError } = await supabase
      .from("voice_messages")
      .update({
        transcription: result.text,
        transcription_status: "transcribed",
        transcription_provider: result.provider,
      })
      .eq("id", id)
      .eq("clinic_id", clinicId)
      .eq("transcription_status", "pending")
      .is("purged_at", null)
      .gt("expires_at", new Date().toISOString())
      .select("id")
      .maybeSingle();
    if (saveError || !saved) throw new Error("voice transcript save failed");
    transcript = result.text;
  } catch {
    logger.error("voice transcription failed", { voiceId: id });
    // An upload can succeed even when its response is lost. Keep its pointer
    // and make cleanup due. If this write fails, the original expiry still applies.
    const { error: cleanupError } = await supabase
      .from("voice_messages")
      .update({ transcription_status: "failed", transcription_error: "processing_failed", expires_at: new Date().toISOString() })
      .eq("id", id)
      .eq("clinic_id", clinicId)
      .eq("transcription_status", "pending")
      .is("purged_at", null);
    if (cleanupError) logger.error("voice failure state could not be saved", { code: cleanupError.code });
    if (!(await conversationIsHeld(clinicId, conversationId))) {
      await sendTelegramMessage({ chatId: opts.chatId, text: voiceFailureText }, clinicId);
    }
    return;
  }

  // Confirm success only after the transcript was durably saved.
  if (await conversationIsHeld(clinicId, conversationId)) return;
  await sendTelegramMessage(
    {
      chatId: opts.chatId,
      text: `Siz aytdingiz:\n“${transcript}”\n\nBu to‘g‘rimi?`,
      replyMarkup: {
        inline_keyboard: [[
          { text: "✅ To‘g‘ri", callback_data: `voice_correct:${id}` },
          { text: "✏️ Tuzatish kerak", callback_data: `voice_wrong:${id}` },
        ]],
      },
    },
    clinicId,
  );
}

/** Patient confirmed the transcription — route it through the AI. */
export async function handleVoiceCorrect(opts: { clinicId: string; chatId: number; telegramUserId: number; voiceMessageId: string }) {
  const supabase = createAdminClient();
  const voiceRow = await ownVoiceMessage(opts.clinicId, opts.voiceMessageId, opts.telegramUserId);
  if (!voiceRow?.consent_given || voiceRow.transcription_status !== "transcribed" || !voiceRow.transcription) return;

  const { data: conv } = await supabase
    .from("conversations")
    .select("patient_id")
    .eq("id", voiceRow.conversation_id)
    .eq("clinic_id", voiceRow.clinic_id)
    .maybeSingle();

  // Urgent wording in a confirmed transcription escalates exactly like a
  // typed message — before anything else, held conversation or not.
  if (conv && detectUrgency(voiceRow.transcription) === "urgent") {
    await escalateUrgent({
      clinicId: voiceRow.clinic_id,
      patientId: conv.patient_id,
      conversationId: voiceRow.conversation_id,
      chatId: opts.chatId,
      text: voiceRow.transcription,
      patientLabel: String(opts.telegramUserId),
    });
    return;
  }

  // AI automation must stay silent while the conversation is under human
  // control — the same rule as plain text messages.
  if (await conversationIsHeld(voiceRow.clinic_id, voiceRow.conversation_id)) {
    logger.info("voice transcription confirmed, conversation held by admin — no auto-reply", {
      conversationId: voiceRow.conversation_id,
    });
    return;
  }

  const clinic = await getClinicById(voiceRow.clinic_id);

  const reply = await generateReceptionistReply({ clinicId: clinic.id, userText: voiceRow.transcription });
  // The admin may have taken over while transcribing/thinking — never reply
  // over a human operator.
  if (await conversationIsHeld(voiceRow.clinic_id, voiceRow.conversation_id) || voiceExpired(voiceRow.expires_at)) return;
  await sendTelegramMessage({ chatId: opts.chatId, text: reply.text }, clinic.id);
  if (conv && !voiceExpired(voiceRow.expires_at)) {
    await appendMessage({
      conversationId: voiceRow.conversation_id,
      clinicId: clinic.id,
      role: "patient",
      type: "text",
      content: `[ovozdan transkripsiya] ${voiceRow.transcription}`,
      voiceMessageId: opts.voiceMessageId,
    });
    await appendMessage({
      conversationId: voiceRow.conversation_id,
      clinicId: clinic.id,
      role: reply.usedAi ? "ai" : "bot",
      type: "text",
      content: reply.text,
      voiceMessageId: opts.voiceMessageId,
    });
  }
}

/** Patient wants to correct the transcription — ask them to type it. */
export async function handleVoiceWrong(opts: { clinicId: string; chatId: number; telegramUserId: number; voiceMessageId: string }) {
  const voiceRow = await ownVoiceMessage(opts.clinicId, opts.voiceMessageId, opts.telegramUserId);
  if (!voiceRow?.consent_given || voiceRow.transcription_status !== "transcribed") return;
  if (await conversationIsHeld(voiceRow.clinic_id, voiceRow.conversation_id)) return;
  await sendTelegramMessage(
    {
      chatId: opts.chatId,
      text: "Iltimos, aytmoqchi bo‘lgan narsangizni matn shaklida yozing. Tuzatilgan matn qabulga yordam berishda ishlatiladi.",
    },
    voiceRow.clinic_id,
  );
}

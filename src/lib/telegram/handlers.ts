import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { adminChatIds } from "@/lib/env";
import { getDefaultClinic } from "@/lib/clinics/context";
import { getOrCreatePatient } from "@/lib/patients/identity";
import { getOrCreateConversation, appendMessage, conversationIsHeld, updateConversationState } from "@/lib/telegram/store";
import { sendTelegramMessage, getTelegramFileUrl } from "@/lib/telegram/bot";
import { generateReceptionistReply } from "@/lib/ai/receptionist";
import { startNavigation, suggestNavigation, NAVIGATION_STATE_KEY } from "@/lib/ai/navigation";
import { trackAnalytics } from "@/lib/analytics";
import { recordAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { getTranscriptionProvider } from "@/lib/transcription/provider";

const MINI_APP_URL = () => `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/book`;

const mainKeyboard = {
  keyboard: [
    [{ text: "📅 Qabulga yozilish", web_app: { url: MINI_APP_URL() } }],
    [{ text: "🤖 Shifokor tanlashda yordam" }],
    [{ text: "💰 Narxlar" }],
    [{ text: "📍 Manzil" }],
    [{ text: "👤 Operator bilan bog‘lanish" }],
  ],
  resize_keyboard: true,
};

export const WELCOME_UZ =
  `Assalomu alaykum! 👋\n` +
  `Bu — ${"klinikamiz"}ning rasmiy qabul boti.\n\n` +
  `Men klinika ma‘lumotlari (manzil, narxlar, ish vaqti) va qabulga yozilishda yordam beraman. ` +
  `Bot tibbiy tashxis qo‘ymaydi va davolash tavsiya qilmaydi.\n\n` +
  `Qulay tugmani tanlang 👇`;

export async function handleTelegramMessage(opts: {
  chatId: number;
  from: { id: number; first_name?: string; last_name?: string; username?: string };
  text?: string;
  voice?: { file_id: string; file_unique_id?: string; duration?: number; mime_type?: string; file_size?: number };
  updateId: number;
}): Promise<void> {
  try {
    const clinic = await getDefaultClinic();
    const patient = await getOrCreatePatient({
      clinicId: clinic.id,
      user: opts.from,
    });
    const conversation = await getOrCreateConversation({
      clinicId: clinic.id,
      patientId: patient.id,
      channel: "telegram",
    });

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

    const text = opts.text?.trim() ?? "";
    if (!text) return;

    await appendMessage({
      conversationId: conversation.id,
      clinicId: clinic.id,
      role: "patient",
      type: "text",
      content: text,
      telegramMessageId: opts.updateId,
    });

    // Conversation under human control: store, do not auto-reply.
    if (await conversationIsHeld(conversation.id)) {
      logger.info("message stored, conversation held by admin", { conversationId: conversation.id });
      return;
    }

    // State-machine: navigation flow.
    const state = (conversation.state ?? {}) as Record<string, unknown>;
    const nav = state[NAVIGATION_STATE_KEY] as { step: number } | undefined;
    if (nav && nav.step === 1) {
      await trackAnalytics({ clinicId: clinic.id, patientId: patient.id, eventType: "navigation_answer" });
      const reply = await suggestNavigation(clinic.id, text);
      await updateConversationState(conversation.id, { ...state, [NAVIGATION_STATE_KEY]: { step: 2 } });
      await sendTelegramMessage({ chatId: opts.chatId, text: reply, replyMarkup: mainKeyboard });
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
    await sendTelegramMessage({
      chatId: opts.chatId,
      text: reply.text,
      replyMarkup: reply.handoff ? mainKeyboard : undefined,
    });
    await appendMessage({
      conversationId: conversation.id,
      clinicId: clinic.id,
      role: reply.usedAi ? "ai" : "bot",
      type: "text",
      content: reply.text,
    });

    if (reply.urgent) {
      await notifyAdmins(`⚠️ Shoshilinch holat ehtimoli: bemor ${opts.from.first_name ?? ""} (@${opts.from.username ?? "-"})`);
      await trackAnalytics({ clinicId: clinic.id, patientId: patient.id, eventType: "urgent_flag" });
    }
  } catch (e) {
    logger.error("telegram message handling failed", {
      chatId: opts.chatId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

export async function handleTelegramCommand(opts: {
  chatId: number;
  from: { id: number; first_name?: string; last_name?: string; username?: string };
  command: string;
  text?: string;
}): Promise<void> {
  const clinic = await getDefaultClinic();
  const patient = await getOrCreatePatient({
    clinicId: clinic.id,
    user: opts.from,
  });
  const conversation = await getOrCreateConversation({
    clinicId: clinic.id,
    patientId: patient.id,
    channel: "telegram",
  });
  const held = await conversationIsHeld(conversation.id);

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
        await sendTelegramMessage({
          chatId: opts.chatId,
          text: "Hozir operator bilan suhbatlashyapsiz. Operator javobini kuting.",
        });
        return;
      }
      await sendTelegramMessage({ chatId: opts.chatId, text: WELCOME_UZ, replyMarkup: mainKeyboard });
      await trackAnalytics({ clinicId: clinic.id, patientId: patient.id, eventType: "bot_started" });
      break;
    }
    default:
      await sendTelegramMessage({ chatId: opts.chatId, text: "Noma‘lum buyruq. Iltimos, tugmalardan foydalaning." });
  }
}

/** Menu button handler — the shared text-based commands. */
export async function handleMenuButton(opts: {
  chatId: number;
  from: { id: number; first_name?: string; last_name?: string; username?: string };
  button: string;
}): Promise<void> {
  const clinic = await getDefaultClinic();
  const patient = await getOrCreatePatient({
    clinicId: clinic.id,
    user: opts.from,
  });
  const conversation = await getOrCreateConversation({
    clinicId: clinic.id,
    patientId: patient.id,
    channel: "telegram",
  });
  const held = await conversationIsHeld(conversation.id);

  if (held) {
    await sendTelegramMessage({
      chatId: opts.chatId,
      text: "Hozir operator bilan suhbatlashyapsiz. Operator javobini kuting.",
    });
    return;
  }

  if (opts.button.includes("Qabulga yozilish")) {
    // Button is a web_app button; text fallback when web_app unsupported.
    await sendTelegramMessage({
      chatId: opts.chatId,
      text: `Qabulga yozilish uchun ilovani oching: ${MINI_APP_URL()}`,
    });
    return;
  }

  if (opts.button.includes("Shifokor tanlashda yordam")) {
    await updateConversationState(conversation.id, {
      ...(typeof conversation.state === "object" && conversation.state ? conversation.state as Record<string, unknown> : {}),
      [NAVIGATION_STATE_KEY]: { step: 1 },
    });
    const question = await startNavigation();
    await sendTelegramMessage({ chatId: opts.chatId, text: question, replyMarkup: mainKeyboard });
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
    await sendTelegramMessage({ chatId: opts.chatId, text, replyMarkup: mainKeyboard });
    return;
  }

  if (opts.button.includes("Manzil")) {
    const text = clinic.address
      ? `📍 Manzil: ${clinic.address}\n\n☎️ Telefon: ${clinic.phone ?? "ko‘rsatilmagan"}\n\nIsh vaqti haqida ma‘lumot uchun operatorlarga murojaat qiling.`
      : "Manzil hozircha kiritilmagan. Operatorlarimizga murojaat qiling.";
    await sendTelegramMessage({ chatId: opts.chatId, text, replyMarkup: mainKeyboard });
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
    chatId: opts.chatId,
    from: opts.from,
    text: opts.button,
    updateId: Date.now(),
  });
}

/** Patient asks for a human: pause automation and notify admins. */
export async function requestHumanHandoff(opts: {
  clinicId: string;
  patientId: string;
  conversationId: string;
  chatId: number;
  patientLabel: string;
}): Promise<void> {
  const supabase = createAdminClient();
  await supabase
    .from("conversations")
    .update({ ai_enabled: false })
    .eq("id", opts.conversationId);

  await recordAudit({
    clinicId: opts.clinicId,
    action: "conversation_handoff_requested",
    entityType: "conversations",
    entityId: opts.conversationId,
    actor: { actorType: "telegram" },
  });

  await sendTelegramMessage({
    chatId: opts.chatId,
    text: "Operatorlarimiz siz bilan bog‘lanadi. Biroz kuting. ⏳\n\nOperator javob berguncha avtomatik xabarlar to‘xtatiladi.",
  });
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
    })
    .select("*")
    .single();
  if (error || !voiceRow) {
    logger.error("voice metadata save failed", { error: error?.message });
    await sendTelegramMessage({
      chatId,
      text: "Ovozli xabarni saqlashda xatolik yuz berdi. Iltimos, qayta yuboring yoki matn shaklida yozing.",
    });
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

  // 2. Transcription must be enabled AND consented before processing.
  if (!getTranscriptionProvider()) {
    await sendTelegramMessage({
      chatId,
      text:
        "Ovozli xabaringiz qabul qilindi. Hozircha uni avtomatik tushunish yoqilmagan, shuning uchun eshitilgan matn sifatida javob bera olmaymiz. " +
        "Iltimos, xabaringizni matn shaklida yozing yoki “Operator bilan bog‘lanish” tugmasini bosing — operatorlar yordam beradi. 📩",
    });
    return;
  }

  // 3. Ask for consent before downloading/transcribing.
  await sendTelegramMessage({
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
  });
}

export async function handleVoiceConsent(opts: {
  chatId: number;
  voiceMessageId: string;
  consent: boolean;
}): Promise<void> {
  const supabase = createAdminClient();
  const { data: voiceRow } = await supabase
    .from("voice_messages")
    .select("*")
    .eq("id", opts.voiceMessageId)
    .maybeSingle();
  if (!voiceRow) {
    await sendTelegramMessage({ chatId: opts.chatId, text: "Ovozli xabar topilmadi." });
    return;
  }

  if (!opts.consent) {
    await supabase.from("voice_messages").update({ consent_given: false }).eq("id", voiceRow.id);
    await sendTelegramMessage({
      chatId: opts.chatId,
      text:
        "Tushundim, ovozli xabaringizni qayta ishlamaymiz. " +
        "Agar yordam kerak bo‘lsa, matn shaklida yozing yoki operatorlarimiz bilan bog‘laning.",
    });
    return;
  }

  // 4. Consent given: download server-side, store privately, transcribe.
  await supabase.from("voice_messages").update({ consent_given: true }).eq("id", voiceRow.id);
  await sendTelegramMessage({
    chatId: opts.chatId,
    text: "Ovozli xabaringizni qayta ishlayapmiz... ⏳",
  });

  try {
    const fileUrl = await getTelegramFileUrl(voiceRow.telegram_file_id);
    if (!fileUrl) throw new Error("telegram file url unavailable");

    const res = await fetch(fileUrl, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`file download failed ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());

    // Private storage: <clinic_id>/<voice_message_id>.<ext>
    const ext = (voiceRow.mime_type ?? "audio/ogg").split("/")[1] || "ogg";
    const path = `${voiceRow.clinic_id}/${voiceRow.id}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from("voice-messages")
      .upload(path, buffer, { contentType: voiceRow.mime_type ?? "audio/ogg", upsert: true });
    if (uploadError) throw new Error(`storage upload failed: ${uploadError.message}`);

    const provider = getTranscriptionProvider();
    if (!provider) throw new Error("transcription provider vanished");
    const result = await provider.transcribe({ file: buffer, mimeType: voiceRow.mime_type ?? "audio/ogg", fileName: `${voiceRow.id}.${ext}` });

    const expiresAt = new Date(Date.now() + voiceRow.retention_days * 24 * 60 * 60 * 1000).toISOString();
    await supabase
      .from("voice_messages")
      .update({
        storage_path: path,
        transcription: result.text,
        transcription_status: "transcribed",
        transcription_provider: result.provider,
        expires_at: expiresAt,
      })
      .eq("id", voiceRow.id);

    // 5. Show the transcription so the patient can correct it, then use it
    // for navigation (consent was already given).
    await sendTelegramMessage({
      chatId: opts.chatId,
      text: `Siz aytdingiz:\n“${result.text}”\n\nBu to‘g‘rimi?`,
      replyMarkup: {
        inline_keyboard: [
          [
            { text: "✅ To‘g‘ri", callback_data: `voice_correct:${voiceRow.id}` },
            { text: "✏️ Tuzatish kerak", callback_data: `voice_wrong:${voiceRow.id}` },
          ],
        ],
      },
    });
  } catch (e) {
    logger.error("voice transcription failed", { voiceId: voiceRow.id, error: String(e) });
    await supabase
      .from("voice_messages")
      .update({ transcription_status: "failed", transcription_error: String(e).slice(0, 500) })
      .eq("id", voiceRow.id);
    await sendTelegramMessage({
      chatId: opts.chatId,
      text:
        "Kechirasiz, ovozli xabaringizni qayta ishlay olmadim va eshitilgan matn sifatida javob bera olmayman. " +
        "Iltimos, xabaringizni matn shaklida yozing yoki operatorlarimizga murojaat qiling — ular yordam beradi.",
    });
  }
}

/** Patient confirmed the transcription — route it through the AI. */
export async function handleVoiceCorrect(opts: { chatId: number; voiceMessageId: string }) {
  const supabase = createAdminClient();
  const { data: voiceRow } = await supabase
    .from("voice_messages")
    .select("clinic_id, conversation_id, transcription, transcription_status")
    .eq("id", opts.voiceMessageId)
    .maybeSingle();
  if (!voiceRow || !voiceRow.transcription) return;

  // AI automation must stay silent while the conversation is under human
  // control — the same rule as plain text messages.
  if (await conversationIsHeld(voiceRow.conversation_id)) {
    logger.info("voice transcription confirmed, conversation held by admin — no auto-reply", {
      conversationId: voiceRow.conversation_id,
    });
    return;
  }

  const clinic = await getDefaultClinic();
  const { data: conv } = await supabase
    .from("conversations")
    .select("patient_id")
    .eq("id", voiceRow.conversation_id)
    .maybeSingle();

  const reply = await generateReceptionistReply({ clinicId: clinic.id, userText: voiceRow.transcription });
  await sendTelegramMessage({ chatId: opts.chatId, text: reply.text });
  if (conv) {
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
    });
  }
}

/** Patient wants to correct the transcription — ask them to type it. */
export async function handleVoiceWrong(opts: { chatId: number; voiceMessageId: string }) {
  await sendTelegramMessage({
    chatId: opts.chatId,
    text: "Iltimos, aytmoqchi bo‘lgan narsangizni matn shaklida yozing. Tuzatilgan matn qabulga yordam berishda ishlatiladi.",
  });
}
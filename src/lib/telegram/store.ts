import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";

type Conversation = Database["public"]["Tables"]["conversations"]["Row"];

/**
 * Returns the active conversation for a patient+channel, creating one when
 * missing. At most one open/assigned conversation exists per patient+channel
 * (partial unique index in the database).
 */
export async function getOrCreateConversation(opts: {
  clinicId: string;
  patientId: string;
  channel: "telegram" | "mini_app";
}): Promise<Conversation> {
  const supabase = createAdminClient();

  const { data: existing } = await supabase
    .from("conversations")
    .select("*")
    .eq("patient_id", opts.patientId)
    .eq("channel", opts.channel)
    .in("status", ["open", "assigned"])
    .maybeSingle();

  if (existing) return existing;

  const { data, error } = await supabase
    .from("conversations")
    .insert({
      clinic_id: opts.clinicId,
      patient_id: opts.patientId,
      channel: opts.channel,
      status: "open",
    })
    .select("*")
    .single();

  if (error) throw new Error(`conversation_create_failed: ${error.message}`);
  return data;
}

export async function appendMessage(opts: {
  conversationId: string;
  clinicId: string;
  role: Database["public"]["Enums"]["message_role"];
  type: Database["public"]["Enums"]["message_type"];
  content: string;
  telegramMessageId?: number | null;
  voiceMessageId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const supabase = createAdminClient();
  const { error } = await supabase.from("messages").insert({
    conversation_id: opts.conversationId,
    clinic_id: opts.clinicId,
    role: opts.role,
    type: opts.type,
    content: opts.content,
    telegram_message_id: opts.telegramMessageId ?? null,
    voice_message_id: opts.voiceMessageId ?? null,
    metadata: (opts.metadata ?? {}) as never,
  });
  if (error) throw new Error(`message_insert_failed: ${error.message}`);

  await supabase
    .from("conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", opts.conversationId);
}

export async function updateConversationState(conversationId: string, state: Record<string, unknown>) {
  const supabase = createAdminClient();
  await supabase
    .from("conversations")
    .update({ state: state as never })
    .eq("id", conversationId);
}

/** True when the conversation is under human control (bot must stay silent). */
export async function conversationIsHeld(conversationId: string): Promise<boolean> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("conversations")
    .select("status, ai_enabled")
    .eq("id", conversationId)
    .maybeSingle();
  return !!data && (data.status === "assigned" || data.ai_enabled === false);
}
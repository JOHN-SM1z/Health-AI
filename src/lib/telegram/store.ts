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

  const { data: existing, error: lookupError } = await supabase
    .from("conversations")
    .select("*")
    .eq("clinic_id", opts.clinicId)
    .eq("patient_id", opts.patientId)
    .eq("channel", opts.channel)
    .in("status", ["open", "assigned"])
    .maybeSingle();

  if (lookupError) throw new Error("conversation_lookup_failed");
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

  if (error) throw new Error("conversation_create_failed");
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
  if (error) throw new Error("message_insert_failed");

  await supabase
    .from("conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", opts.conversationId)
    .eq("clinic_id", opts.clinicId);
}

export async function updateConversationState(clinicId: string, conversationId: string, state: Record<string, unknown>) {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("conversations")
    .update({ state: state as never })
    .eq("id", conversationId)
    .eq("clinic_id", clinicId)
    .eq("status", "open")
    .eq("ai_enabled", true);
  if (error) throw new Error("conversation_state_update_failed");
}

/** Automation is allowed only after verifying the conversation is open and enabled. */
export async function conversationIsHeld(clinicId: string, conversationId: string): Promise<boolean> {
  try {
    const { data, error } = await createAdminClient()
      .from("conversations")
      .select("status, ai_enabled")
      .eq("id", conversationId)
      .eq("clinic_id", clinicId)
      .maybeSingle();
    return !!error || data?.status !== "open" || data.ai_enabled !== true;
  } catch {
    return true;
  }
}

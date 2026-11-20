import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { localDbAvailable } from "@/test/local-db";
import { purgeExpiredVoiceMessages, EXPIRED_VOICE_TEXT } from "@/lib/voice/retention";

/** Voice retention against the real database (the query the scheduled job runs). */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const describeDb = describe.skipIf(!localDbAvailable());

describeDb("voice retention — the scheduled purge on the real database", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const clinic = randomUUID();
  const patient = randomUUID();
  const conversation = randomUUID();
  const expired = randomUUID();
  const current = randomUUID();

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 2, onnotice: () => {} });
    await sql`insert into public.clinics (id, name, slug) values (${clinic}, ${`Voice ${suffix}`}, ${`voice-${suffix}`})`;
    await sql`insert into public.patients (id, clinic_id, full_name) values (${patient}, ${clinic}, ${`Voice patient ${suffix}`})`;
    await sql`insert into public.conversations (id, clinic_id, patient_id, channel) values (${conversation}, ${clinic}, ${patient}, 'telegram')`;
    await sql`insert into public.voice_messages ${sql([
      { id: expired, clinic_id: clinic, conversation_id: conversation, telegram_file_id: "tg-file-1", transcription: "Qabulga yozilmoqchiman", corrected_transcription: null, expires_at: new Date(Date.now() - 60_000) },
      { id: current, clinic_id: clinic, conversation_id: conversation, telegram_file_id: "tg-file-2", transcription: "Narxlar qancha", corrected_transcription: null, expires_at: new Date(Date.now() + 86_400_000) },
    ])}`;
    await sql`insert into public.messages ${sql([
      { clinic_id: clinic, conversation_id: conversation, role: "patient", type: "text", content: "[ovozdan transkripsiya] Qabulga yozilmoqchiman", voice_message_id: expired },
      { clinic_id: clinic, conversation_id: conversation, role: "patient", type: "text", content: "[ovozdan transkripsiya] Narxlar qancha", voice_message_id: current },
    ])}`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from public.clinics where id = ${clinic}`;
    await sql.end({ timeout: 5 });
  });

  it("removes an expired transcript and its quote, and leaves one still within retention alone", async () => {
    await purgeExpiredVoiceMessages();
    const rows = await sql<{ id: string; transcription: string | null; telegram_file_id: string | null; purged_at: Date | null }[]>`
      select id, transcription, telegram_file_id, purged_at from public.voice_messages where id in ${sql([expired, current])}`;
    expect(rows.find((r) => r.id === expired)).toMatchObject({ transcription: null, telegram_file_id: null, purged_at: expect.any(Date) });
    expect(rows.find((r) => r.id === current)).toMatchObject({ transcription: "Narxlar qancha", telegram_file_id: "tg-file-2", purged_at: null });
    const quotes = await sql<{ voice_message_id: string; content: string }[]>`
      select voice_message_id, content from public.messages where conversation_id = ${conversation}`;
    expect(quotes.find((q) => q.voice_message_id === expired)?.content).toBe(EXPIRED_VOICE_TEXT);
    expect(quotes.find((q) => q.voice_message_id === current)?.content).toContain("Narxlar qancha");
  });
});

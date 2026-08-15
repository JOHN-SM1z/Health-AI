-- 0019: voice_messages.telegram_file_id is optional.
--
-- telegram_file_id was NOT NULL because the bot flow saves Telegram file
-- metadata before downloading the audio. Admin-recorded replies have no
-- Telegram file, so the client flow had to fabricate a placeholder. The
-- column is now nullable; the check constraint replaces the old NOT NULL
-- guarantee with a weaker but accurate one: every voice message must have
-- SOME audio source (a Telegram file id or a storage path).

alter table public.voice_messages
  alter column telegram_file_id drop not null;

alter table public.voice_messages
  add constraint voice_messages_audio_source_check
  check (telegram_file_id is not null or storage_path is not null);

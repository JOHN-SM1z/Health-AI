import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Voice retention: past expires_at the audio leaves private storage and the
 * transcript leaves the database; a failed deletion is retried, never
 * reported as done.
 */

type Update = { table: string; values: Record<string, unknown>; filters: Array<[string, unknown]> };
const state = vi.hoisted(() => ({
  due: [] as Array<{ id: string; clinic_id: string; storage_path: string | null }>,
  removeError: null as { message: string } | null,
  removed: [] as string[][],
  updates: [] as Update[],
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: () => {
        const q: Record<string, unknown> = {};
        for (const m of ["lte", "is", "order"]) q[m] = () => q;
        q.limit = async () => ({ data: state.due, error: null });
        return q;
      },
      update: (values: Record<string, unknown>) => {
        const u: Update = { table, values, filters: [] };
        state.updates.push(u);
        const chain: Record<string, unknown> = {};
        chain.eq = (col: string, val: unknown) => {
          u.filters.push([col, val]);
          return chain;
        };
        chain.then = (resolve: (v: unknown) => void) => resolve({ error: null });
        return chain;
      },
    }),
    storage: {
      from: () => ({
        remove: async (paths: string[]) => {
          state.removed.push(paths);
          return { error: state.removeError };
        },
      }),
    },
  }),
}));

import { purgeExpiredVoiceMessages, EXPIRED_VOICE_TEXT } from "@/lib/voice/retention";

beforeEach(() => {
  state.due = [];
  state.removeError = null;
  state.removed = [];
  state.updates = [];
});

describe("purgeExpiredVoiceMessages", () => {
  it("deletes the audio, clears the transcripts and redacts the quoted message — within the row's clinic", async () => {
    state.due = [{ id: "vm-1", clinic_id: "clinic-1", storage_path: "clinic-1/vm-1.ogg" }];
    expect(await purgeExpiredVoiceMessages()).toEqual({ purged: 1, failed: 0 });
    expect(state.removed).toEqual([["clinic-1/vm-1.ogg"]]);
    const voice = state.updates.find((u) => u.table === "voice_messages")!;
    expect(voice.values).toMatchObject({ storage_path: null, transcription: null, corrected_transcription: null, telegram_file_id: null, purged_at: expect.any(String) });
    expect(voice.filters).toEqual([["id", "vm-1"], ["clinic_id", "clinic-1"]]);
    const quoted = state.updates.find((u) => u.table === "messages")!;
    expect(quoted.values).toEqual({ content: EXPIRED_VOICE_TEXT });
    expect(quoted.filters).toEqual([["voice_message_id", "vm-1"], ["clinic_id", "clinic-1"]]);
  });

  it("keeps everything for the next run when the audio could not be deleted", async () => {
    state.due = [{ id: "vm-2", clinic_id: "clinic-1", storage_path: "clinic-1/vm-2.ogg" }];
    state.removeError = { message: "storage unavailable" };
    expect(await purgeExpiredVoiceMessages()).toEqual({ purged: 0, failed: 1 });
    expect(state.updates).toEqual([]);
  });

  it("clears a transcript-only row without touching storage", async () => {
    state.due = [{ id: "vm-3", clinic_id: "clinic-1", storage_path: null }];
    expect(await purgeExpiredVoiceMessages()).toEqual({ purged: 1, failed: 0 });
    expect(state.removed).toEqual([]);
  });
});

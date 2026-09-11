import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const supabaseMock = { from: vi.fn() };
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => supabaseMock,
}));

vi.mock("@/lib/env", () => ({
  env: {
    TELEGRAM_WEBHOOK_SECRET: "deployment-secret",
    NEXT_PUBLIC_APP_URL: "https://health.example.com",
  },
}));

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

vi.mock("@/lib/telegram/bots", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    registerBotWebhook: vi.fn(async () => ({ ok: true })),
  };
});

const getMeMock = vi.fn();
const setWebhookMock = vi.fn();

vi.mock("grammy", () => ({
  Bot: class {
    token: string;
    api = { getMe: getMeMock, setWebhook: setWebhookMock };
    constructor(token: string) {
      this.token = token;
    }
  },
}));

import { activateClinicBot, deactivateClinicBot } from "@/lib/telegram/bot-admin";

const updateMock = vi.fn();
const insertMock = vi.fn();

// update(...).eq(...) is awaited directly by deactivateClinicBot, and
// additionally chained with .select(...) by activateClinicBot — the mock
// must satisfy both call shapes, exactly like the real Supabase builder.
function eqChain(result: { data?: unknown; error: unknown }) {
  return Object.assign(Promise.resolve(result), { select: vi.fn(async () => result) });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: an integration row for this clinic already exists — the
  // realistic re-activation case that triggered the production bug.
  updateMock.mockImplementation(() => ({
    eq: vi.fn(() => eqChain({ data: [{ clinic_id: "clinic-a" }], error: null })),
  }));
  insertMock.mockResolvedValue({ error: null });
  supabaseMock.from.mockImplementation((table: string) => {
    if (table === "clinic_telegram_integrations") {
      return {
        update: updateMock,
        insert: insertMock,
        select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: null, error: null })) })) })),
      };
    }
    return {};
  });
  getMeMock.mockResolvedValue({ id: 111, username: "clinic_a_bot", first_name: "Clinic A Bot" });
});

describe("activateClinicBot", () => {
  it("validates the token format before calling Telegram", async () => {
    const result = await activateClinicBot("clinic-a", "not-a-token");
    expect(result.ok).toBe(false);
    expect(getMeMock).not.toHaveBeenCalled();
  });

  it("activates a bot: getMe -> store -> register webhook, never returns the token", async () => {
    const result = await activateClinicBot("clinic-a", "111:VALID_CLINIC_TOKEN_ABCDEFGH");
    expect(result.ok).toBe(true);
    expect(result.username).toBe("clinic_a_bot");
    expect(result.webhookOk).toBe(true);
    expect("telegramBotToken" in result).toBe(false);

    expect(getMeMock).toHaveBeenCalledTimes(1);
    // The token is persisted ONLY server-side.
    type IntegrationPayload = {
      clinic_id: string;
      telegram_bot_token: string;
      telegram_bot_id: number;
      telegram_username: string;
      status: string;
      enabled: boolean;
    };
    const updatePayload = updateMock.mock.calls[0][0] as IntegrationPayload;
    expect(updatePayload.clinic_id).toBe("clinic-a");
    expect(updatePayload.telegram_bot_token).toBe("111:VALID_CLINIC_TOKEN_ABCDEFGH");
    expect(updatePayload.status).toBe("active");
    expect(updatePayload.enabled).toBe(true);
  });

  it("re-activating an existing integration (the common case — a re-pasted or rotated token) updates the row and never attempts an insert", async () => {
    // Regression test for a real production bug: clinic_telegram_integrations
    // also carries UNIQUE constraints on telegram_username and
    // telegram_bot_id (added to stop two clinics sharing a bot identity).
    // An .upsert({onConflict: "clinic_id"}) call always attempts an INSERT
    // first — and re-activating the SAME bot always collides with THOSE
    // other unique indexes (this clinic's own existing row already holds
    // the identical username/bot_id), which Postgres reports as a raw
    // constraint violation rather than falling through to the update,
    // since ON CONFLICT only names clinic_id. Confirmed live: every
    // reactivation attempt failed with a 409 until the write was changed
    // to UPDATE-first. This test locks in that UPDATE-first behavior.
    await activateClinicBot("clinic-a", "111:VALID_CLINIC_TOKEN_ABCDEFGH");
    // Two legitimate updates happen on success (integration data, then the
    // separate webhook-status update) — insert must still never be called.
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("first-time activation (no existing row) falls back to insert when the update matches nothing", async () => {
    updateMock.mockImplementation(() => ({ eq: vi.fn(() => eqChain({ data: [], error: null })) }));
    const result = await activateClinicBot("clinic-a", "111:VALID_CLINIC_TOKEN_ABCDEFGH");
    expect(result.ok).toBe(true);
    expect(insertMock).toHaveBeenCalledTimes(1);
    const insertPayload = insertMock.mock.calls[0][0] as { clinic_id: string; status: string };
    expect(insertPayload.clinic_id).toBe("clinic-a");
    expect(insertPayload.status).toBe("active");
  });

  it("reports a friendly error when the insert path collides with another clinic's bot identity", async () => {
    updateMock.mockImplementation(() => ({ eq: vi.fn(() => eqChain({ data: [], error: null })) }));
    insertMock.mockResolvedValueOnce({ error: { code: "23505", message: "duplicate key value" } });
    const result = await activateClinicBot("clinic-a", "111:VALID_CLINIC_TOKEN_ABCDEFGH");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Bu bot boshqa klinikada allaqachon ulangan");
  });

  it("marks the integration as error and reports failure when getMe fails (bad token)", async () => {
    getMeMock.mockRejectedValueOnce(new Error("Unauthorized"));
    const result = await activateClinicBot("clinic-a", "111:INVALID_TOKEN_ABCDEFGH");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Telegram bilan bog‘lanib bo‘lmadi");
  });

  it("reports a failed webhook registration without failing activation", async () => {
    const { registerBotWebhook } = await import("@/lib/telegram/bots");
    vi.mocked(registerBotWebhook).mockResolvedValueOnce({ ok: false, error: "url not allowed" });
    const result = await activateClinicBot("clinic-a", "111:VALID_CLINIC_TOKEN_ABCDEFGH");
    expect(result.ok).toBe(true);
    expect(result.webhookOk).toBe(false);
    expect(result.webhookError).toBe("url not allowed");
  });
});

describe("deactivateClinicBot", () => {
  it("disables the integration", async () => {
    await deactivateClinicBot("clinic-a");
    const [payload] = updateMock.mock.calls[0];
    expect(payload).toEqual({ enabled: false, status: "disabled" });
    const eqMock = updateMock.mock.results[0]!.value.eq;
    expect(eqMock).toHaveBeenCalledWith("clinic_id", "clinic-a");
  });

  it("does not call deleteWebhook when no integration exists", async () => {
    supabaseMock.from.mockImplementation((table: string) => {
      if (table === "clinic_telegram_integrations") {
        return {
          update: updateMock,
          insert: insertMock,
          select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: null, error: null })) })) })),
        };
      }
      return {};
    });
    await deactivateClinicBot("clinic-a");
    expect(setWebhookMock).not.toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledWith({ enabled: false, status: "disabled" });
  });
});

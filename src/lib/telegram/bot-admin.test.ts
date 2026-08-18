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

const upsertMock = vi.fn();
const updateMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  updateMock.mockImplementation(() => ({ eq: vi.fn(async () => ({ error: null })) }));
  supabaseMock.from.mockImplementation((table: string) => {
    if (table === "clinic_telegram_integrations") {
      return {
        upsert: upsertMock,
        update: updateMock,
        select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: null, error: null })) })) })),
      };
    }
    return {};
  });
  upsertMock.mockResolvedValue({ error: null });
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
    type UpsertPayload = {
      clinic_id: string;
      telegram_bot_token: string;
      telegram_bot_id: number;
      telegram_username: string;
      status: string;
      enabled: boolean;
    };
    const upsertPayload = upsertMock.mock.calls[0][0] as UpsertPayload;
    expect(upsertPayload.clinic_id).toBe("clinic-a");
    expect(upsertPayload.telegram_bot_token).toBe("111:VALID_CLINIC_TOKEN_ABCDEFGH");
    expect(upsertPayload.status).toBe("active");
    expect(upsertPayload.enabled).toBe(true);
    expect(upsertMock.mock.calls[0][1]).toEqual({ onConflict: "clinic_id" });
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
          upsert: upsertMock,
          update: updateMock,
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

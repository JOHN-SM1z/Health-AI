import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const supabaseMock = { from: vi.fn() };
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => supabaseMock,
}));

vi.mock("@/lib/auth/guards", () => ({
  requireRoles: vi.fn(),
}));

vi.mock("@/lib/telegram/bot", () => ({
  sendTelegramMessage: vi.fn(async () => 42),
}));

vi.mock("@/lib/telegram/store", () => ({
  appendMessage: vi.fn(async () => {}),
}));

vi.mock("@/lib/audit", () => ({
  recordAudit: vi.fn(async () => {}),
}));

vi.mock("@/lib/analytics", () => ({
  trackAnalytics: vi.fn(async () => {}),
}));

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { POST, PUT } from "./route";
import { requireRoles } from "@/lib/auth/guards";
import { sendTelegramMessage } from "@/lib/telegram/bot";
import { appendMessage } from "@/lib/telegram/store";
import { recordAudit } from "@/lib/audit";

const sendMock = vi.mocked(sendTelegramMessage);
const appendMock = vi.mocked(appendMessage);
const auditMock = vi.mocked(recordAudit);
const requireMock = vi.mocked(requireRoles);

const CONVERSATION = {
  id: "conv-1",
  clinic_id: "clinic-a",
  patient_id: "patient-1",
  status: "open",
  ai_enabled: true,
};

const HELD_CONVERSATION = { ...CONVERSATION, status: "assigned", ai_enabled: false };

function mockConversationLookup(data: unknown) {
  supabaseMock.from.mockImplementation((table: string) => {
    if (table === "conversations") {
      return {
        select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data, error: null })) })) })) })),
        // CAS takeover: update ... eq(id) eq(status) select(id).maybeSingle()
        update: () => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              select: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({ data: { id: data ? (data as { id?: string }).id : "conv-1" }, error: null })),
              })),
            })),
          })),
        }),
      };
    }
    if (table === "patients") {
      return {
        select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: { telegram_user_id: 777000 }, error: null })) })) })),
      };
    }
    return {};
  });
}

function postReq(body: unknown, id = "conv-1"): Parameters<typeof POST> {
  const request = new NextRequest(`http://localhost/api/admin/conversations/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return [request, { params: Promise.resolve({ id }) }];
}

function putReq(body: unknown, id = "conv-1"): Parameters<typeof PUT> {
  const request = new NextRequest(`http://localhost/api/admin/conversations/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return [request, { params: Promise.resolve({ id }) }];
}

beforeEach(() => {
  vi.clearAllMocks();
  requireMock.mockResolvedValue({
    profileId: "staff-1",
    clinicId: "clinic-a",
    clinicName: "Clinic A",
    clinicTimezone: "Asia/Tashkent",
    platformAdmin: false,
    roles: ["admin"],
  });
  sendMock.mockResolvedValue(42);
  mockConversationLookup(CONVERSATION);
});

describe("admin conversation takeover", () => {
  it("takes over an open conversation and notifies the patient via the CLINIC's own bot", async () => {
    const res = await POST(...postReq({ action: "takeover" }));
    expect(res.status).toBe(200);

    // The notification must go through the conversation's clinic bot,
    // never the shared global bot (Phase 3 multi-clinic contract).
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 777000, text: expect.stringContaining("Operatorlarimiz") }),
      "clinic-a",
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "conversation_takeover", entityId: "conv-1", clinicId: "clinic-a" }),
    );
    expect(appendMock).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-1", clinicId: "clinic-a", role: "admin", type: "system" }),
    );
  });

  it("releases a held conversation without sending a patient notification", async () => {
    mockConversationLookup(HELD_CONVERSATION);
    const res = await POST(...postReq({ action: "release" }));
    expect(res.status).toBe(200);
    expect(sendMock).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "conversation_release" }));
  });

  it("returns 404 for a conversation in another clinic (tenant boundary)", async () => {
    mockConversationLookup(null);
    const res = await POST(...postReq({ action: "takeover" }));
    expect(res.status).toBe(404);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("rejects unknown actions", async () => {
    const res = await POST(...postReq({ action: "explode" }));
    expect(res.status).toBe(400);
  });

  it("only ONE operator can take over: a second takeover on a held conversation loses", async () => {
    // Simulate operator B racing: the CAS update matches zero rows.
    supabaseMock.from.mockImplementation((table: string) => {
      if (table === "conversations") {
        return {
          select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: HELD_CONVERSATION, error: null })) })) })) })),
          update: () => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                select: vi.fn(() => ({
                  maybeSingle: vi.fn(async () => ({ data: null, error: null })),
                })),
              })),
            })),
          }),
        };
      }
      if (table === "patients") {
        return {
          select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: { telegram_user_id: 777000 }, error: null })) })) })),
        };
      }
      return {};
    });

    const res = await POST(...postReq({ action: "takeover" }));
    expect(res.status).toBe(409);
    expect(sendMock).not.toHaveBeenCalled();
    expect(appendMock).not.toHaveBeenCalled();
  });

  it("cannot release a conversation that is not held", async () => {
    // CAS precondition fails: the conversation is open, the update matches 0 rows.
    supabaseMock.from.mockImplementation((table: string) => {
      if (table === "conversations") {
        return {
          select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: CONVERSATION, error: null })) })) })) })),
          update: () => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                select: vi.fn(() => ({
                  maybeSingle: vi.fn(async () => ({ data: null, error: null })),
                })),
              })),
            })),
          }),
        };
      }
      if (table === "patients") {
        return {
          select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: { telegram_user_id: 777000 }, error: null })) })) })),
        };
      }
      return {};
    });
    const res = await POST(...postReq({ action: "release" }));
    expect(res.status).toBe(409);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("admin conversation reply", () => {
  it("stores the message and delivers it via the conversation's clinic bot", async () => {
    mockConversationLookup(HELD_CONVERSATION);
    const res = await PUT(...putReq({ text: "Salom, qabulga keling" }));
    expect(res.status).toBe(200);
    expect(appendMock).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-1", clinicId: "clinic-a", role: "admin", content: "Salom, qabulga keling" }),
    );
    expect(sendMock).toHaveBeenCalledWith(
      { chatId: 777000, text: "Salom, qabulga keling" },
      "clinic-a",
    );
  });

  it("stores the reply even when the patient has no Telegram id", async () => {
    supabaseMock.from.mockImplementation((table: string) => {
      if (table === "conversations") {
        return {
          select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: HELD_CONVERSATION, error: null })) })) })) })),
        };
      }
      if (table === "patients") {
        return {
          select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: { telegram_user_id: null }, error: null })) })) })),
        };
      }
      return {};
    });
    const res = await PUT(...putReq({ text: "Qo‘ng‘iroq qilamiz" }));
    expect(res.status).toBe(200);
    expect(appendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("rejects a reply from a stale session after the takeover ended (not held)", async () => {
    const res = await PUT(...putReq({ text: "Hali ham yozayapman" }));
    expect(res.status).toBe(409);
    expect(appendMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("rejects empty replies", async () => {
    const res = await PUT(...putReq({ text: "   " }));
    expect(res.status).toBe(400);
  });

  it("returns 404 for a foreign-clinic conversation", async () => {
    mockConversationLookup(null);
    const res = await PUT(...putReq({ text: "Hello" }));
    expect(res.status).toBe(404);
  });
});
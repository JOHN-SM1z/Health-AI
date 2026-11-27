import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, equal, select, maybeSingle } = vi.hoisted(() => ({
  from: vi.fn(),
  equal: vi.fn(),
  select: vi.fn(),
  maybeSingle: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from }) }));

import { conversationIsHeld } from "@/lib/telegram/store";

beforeEach(() => {
  vi.clearAllMocks();
  const query = { eq: equal, maybeSingle };
  equal.mockReturnValue(query);
  select.mockReturnValue(query);
  from.mockReturnValue({ select });
});

describe("conversationIsHeld", () => {
  it("allows automation only after finding an open, enabled conversation in its clinic", async () => {
    maybeSingle.mockResolvedValue({ data: { status: "open", ai_enabled: true }, error: null });

    await expect(conversationIsHeld("clinic-1", "conv-1")).resolves.toBe(false);
    expect(equal).toHaveBeenCalledWith("id", "conv-1");
    expect(equal).toHaveBeenCalledWith("clinic_id", "clinic-1");
  });

  it.each([
    ["assigned", { data: { status: "assigned", ai_enabled: true }, error: null }],
    ["paused", { data: { status: "open", ai_enabled: false }, error: null }],
    ["closed", { data: { status: "closed", ai_enabled: true }, error: null }],
    ["unknown enablement", { data: { status: "open", ai_enabled: null }, error: null }],
    ["missing", { data: null, error: null }],
    ["failed lookup", { data: null, error: { code: "57014" } }],
  ])("suppresses automation if the conversation is %s", async (_label, result) => {
    maybeSingle.mockResolvedValue(result);
    await expect(conversationIsHeld("clinic-1", "conv-1")).resolves.toBe(true);
  });

  it("suppresses automation after a thrown database failure", async () => {
    maybeSingle.mockRejectedValue(new Error("synthetic network error"));
    await expect(conversationIsHeld("clinic-1", "conv-1")).resolves.toBe(true);
  });
});

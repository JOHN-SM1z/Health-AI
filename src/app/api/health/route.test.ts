import { describe, expect, it, vi, afterEach } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn() } }));

import { GET } from "./route";

const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const originalKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

afterEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalKey;
  vi.unstubAllGlobals();
});

describe("health endpoint", () => {
  it("checks Supabase with the API-key header only, supporting publishable keys", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "sb_publishable_test";
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://project.supabase.co/rest/v1/",
      expect.objectContaining({ headers: { apikey: "sb_publishable_test" } }),
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty("Authorization");
  });
});

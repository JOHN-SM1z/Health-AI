import { describe, expect, it, vi, afterEach } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn() } }));

import { GET } from "./route";

const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

afterEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
  process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  vi.unstubAllGlobals();
});

describe("health endpoint", () => {
  it("asks the database one trivial question with the server's key, in the API-key header only", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://project.supabase.co/rest/v1/clinics?select=id&limit=1",
      expect.objectContaining({ headers: { apikey: "sb_secret_test" } }),
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty("Authorization");
    // The response says only ok/degraded — never data or keys.
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain("sb_secret_test");
  });

  it("reports degraded (503) when the database does not answer", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: "degraded" });
  });
});

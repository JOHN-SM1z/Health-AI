import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn() } }));
import { GET } from "./route";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function configure() {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("SUPABASE_URL", "");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_synthetic_server_key");
}

describe("health endpoint", () => {
  it("checks database readiness without exposing the credential or response body", async () => {
    configure();
    const fetchMock = vi.fn().mockResolvedValue(new Response("private metadata", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(fetchMock).toHaveBeenCalledWith("https://project.supabase.co/rest/v1/clinics?select=id&limit=1", expect.objectContaining({
      method: "HEAD",
      cache: "no-store",
      redirect: "error",
    }));
    const headers: Headers = fetchMock.mock.calls[0][1].headers;
    expect(headers.get("apikey")).toBe("sb_secret_synthetic_server_key");
    expect(headers.has("Authorization")).toBe(false);
    const body = await res.text();
    expect(body).not.toContain("sb_secret_synthetic_server_key");
    expect(body).not.toContain("private metadata");
  });
  it("authenticates a legacy service-role JWT with both headers", async () => {
    configure();
    const legacyKey = "eyJhbGciOiJIUzI1NiJ9.c3ludGhldGlj.c2lnbmF0dXJl";
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", legacyKey);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await GET()).status).toBe(200);
    const headers: Headers = fetchMock.mock.calls[0][1].headers;
    expect(headers.get("apikey")).toBe(legacyKey);
    expect(headers.get("Authorization")).toBe(`Bearer ${legacyKey}`);
  });
  it.each(["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"])("fails closed without %s", async (name) => {
    configure(); vi.stubEnv(name, "");
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    expect((await GET()).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([401, 500, 503])("reports database HTTP %i as degraded", async (status) => {
    configure(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status })));
    expect((await GET()).status).toBe(503);
  });
  it("reports a timeout without exposing error details", async () => {
    configure(); vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private connection details")));
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("private connection details");
  });
  it("supports the legacy server URL fallback", async () => {
    configure(); vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", ""); vi.stubEnv("SUPABASE_URL", "https://legacy.supabase.co");
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await GET()).status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe("https://legacy.supabase.co/rest/v1/clinics?select=id&limit=1");
  });
});

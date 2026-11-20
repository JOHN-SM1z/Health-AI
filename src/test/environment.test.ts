import { afterEach, describe, expect, it, vi } from "vitest";
import { assertLocalTestEnvironment, loadTestEnvironment } from "./environment";

afterEach(() => vi.unstubAllEnvs());

describe("test database safety", () => {
  it.each(["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_DB_URL"])("rejects hosted %s before fixture tests can run", (key) => {
    vi.stubEnv(key, key === "SUPABASE_DB_URL" ? "postgresql://user:private-password@example.invalid/db" : "https://example.invalid");
    expect(() => loadTestEnvironment()).toThrow("must use a loopback host");
  });
  it("accepts explicit local endpoints", () => {
    expect(() => assertLocalTestEnvironment({ SUPABASE_URL: "http://127.0.0.1:54321", NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
      SUPABASE_DB_URL: "postgresql://postgres:local-only@[::1]:54322/postgres" })).not.toThrow();
  });
  it.each(["http://127.0.0.1.evil.invalid", "https://127.0.0.1@evil.invalid", "file:///tmp/db", "not a URL"])("rejects deceptive or invalid endpoints: %s", (value) => {
    expect(() => assertLocalTestEnvironment({ SUPABASE_URL: value })).toThrow("must use a loopback host");
  });
  it("does not include database credentials in refusal errors", () => {
    try {
      assertLocalTestEnvironment({ SUPABASE_DB_URL: "postgresql://private-user:private-password@remote.invalid/postgres" });
      throw new Error("expected refusal");
    } catch (error) {
      expect(String(error)).toContain("must use a loopback host");
      expect(String(error)).not.toMatch(/private-user|private-password|remote.invalid/);
    }
  });
  it("rejects connection query overrides that could replace the local database host", () => {
    expect(() => assertLocalTestEnvironment({ SUPABASE_DB_URL: "postgresql://postgres@localhost/postgres?host=remote.invalid" })).toThrow("must use a loopback host");
  });
});

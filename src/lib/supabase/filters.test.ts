import { describe, it, expect } from "vitest";
import { ilikeAnyFilter } from "./filters";

describe("ilikeAnyFilter", () => {
  it("quotes a plain term for every column", () => {
    expect(ilikeAnyFilter(["full_name", "phone"], "ali")).toBe('full_name.ilike."%ali%",phone.ilike."%ali%"');
  });

  it("keeps filter punctuation inside the quoted value", () => {
    expect(ilikeAnyFilter(["full_name"], "Karimov, Aziz (Jr.)")).toBe('full_name.ilike."%Karimov, Aziz (Jr.)%"');
  });

  it("cannot be used to add a condition", () => {
    // Raw, this would close the ilike and OR in `phone IS NOT NULL`.
    expect(ilikeAnyFilter(["full_name"], "x%,phone.not.is.null")).toBe('full_name.ilike."%x\\\\%,phone.not.is.null%"');
  });

  it("escapes double quotes and backslashes for PostgREST", () => {
    expect(ilikeAnyFilter(["full_name"], 'a"b')).toBe('full_name.ilike."%a\\"b%"');
    // LIKE-escaped to `\\`, then each backslash escaped again for PostgREST.
    expect(ilikeAnyFilter(["full_name"], "a\\b")).toBe('full_name.ilike."%a\\\\\\\\b%"');
  });

  it("escapes LIKE wildcards so they match literally", () => {
    expect(ilikeAnyFilter(["telegram_username"], "nodira_k")).toBe('telegram_username.ilike."%nodira\\\\_k%"');
    expect(ilikeAnyFilter(["full_name"], "50%")).toBe('full_name.ilike."%50\\\\%%"');
  });
});

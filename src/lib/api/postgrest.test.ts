import { describe, it, expect } from "vitest";
import { anyColumnContains, ilikeContains } from "@/lib/api/postgrest";

describe("ilikeContains", () => {
  it("quotes the value so PostgREST separators are text", () => {
    expect(ilikeContains("x,id.neq.0")).toBe('"%x,id.neq.0%"');
    expect(ilikeContains("a)")).toBe('"%a)%"');
    expect(ilikeContains("or(id.eq.1)")).toBe('"%or(id.eq.1)%"');
  });

  it("drops the characters that could close the quote or act as wildcards", () => {
    expect(ilikeContains('x"),id.neq.0')).toBe('"%x),id.neq.0%"');
    expect(ilikeContains("a\\\"b")).toBe('"%ab%"');
    expect(ilikeContains("full_name.ilike.*RT*%")).toBe('"%full_name.ilike.RT%"');
  });

  it("keeps ordinary names, usernames and phone numbers intact", () => {
    expect(ilikeContains("nodira_k")).toBe('"%nodira_k%"');
    expect(ilikeContains("O‘ktam Karimov")).toBe('"%O‘ktam Karimov%"');
    expect(ilikeContains("+998 90 123-45-67")).toBe('"%+998 90 123-45-67%"');
  });
});

describe("anyColumnContains", () => {
  it("builds one quoted condition per column", () => {
    expect(anyColumnContains(["full_name", "phone"], "a,b")).toBe('full_name.ilike."%a,b%",phone.ilike."%a,b%"');
  });
});

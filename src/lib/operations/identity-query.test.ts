import { describe, expect, it } from "vitest";
import { classifyQuery, formatDob, isIdentityDocument, parseDob } from "./identity-query";

describe("reception lookup rules", () => {
  it("recognises what the receptionist typed", () => {
    expect(classifyQuery("ab 1234567")).toEqual({ kind: "document", value: "AB1234567" });
    expect(classifyQuery("AB-1234567")).toEqual({ kind: "document", value: "AB1234567" });
    expect(classifyQuery("3110 2790 1234 56")).toEqual({ kind: "pinfl", value: "31102790123456" });
    expect(classifyQuery("1042")).toEqual({ kind: "patient_number", value: "1042" });
    expect(classifyQuery("+998 90 123 45 67")).toEqual({ kind: "phone", value: "901234567" });
    expect(classifyQuery("Aliyeva Nodira")).toEqual({ kind: "name", value: "Aliyeva Nodira" });
    expect(isIdentityDocument(classifyQuery("AB1234567"))).toBe(true);
    expect(isIdentityDocument(classifyQuery("31102790123456"))).toBe(true);
    expect(isIdentityDocument(classifyQuery("Aliyeva"))).toBe(false);
  });

  it("reads a date of birth typed as dd.mm.yyyy", () => {
    const today = "2026-10-08";
    expect(parseDob("21.09.1988", today)).toBe("1988-09-21");
    expect(parseDob("1.2.1990", today)).toBe("1990-02-01");
    expect(parseDob("21/09/1988", today)).toBe("1988-09-21");
    expect(parseDob("21-09-1988", today)).toBe("1988-09-21");
    expect(parseDob("21091988", today)).toBe("1988-09-21");
    expect(parseDob(" 21.09.1988 ", today)).toBe("1988-09-21");
  });

  it("refuses dates that do not exist, are in the future or before 1900", () => {
    const today = "2026-10-08";
    expect(parseDob("12.34.5678", today)).toBeNull();
    expect(parseDob("31.02.1990", today)).toBeNull();
    expect(parseDob("09.10.2026", today)).toBeNull();
    expect(parseDob("08.10.2026", today)).toBe("2026-10-08");
    expect(parseDob("31.12.1899", today)).toBeNull();
    expect(parseDob("1988-09-21", today)).toBeNull();
    expect(parseDob("", today)).toBeNull();
  });

  it("shows dates as dd.mm.yyyy", () => {
    expect(formatDob("1988-09-21")).toBe("21.09.1988");
    expect(formatDob(null)).toBe("—");
  });
});

import { describe, expect, it } from "vitest";
import { formatRange, parseParameterValue, type ParameterSpec } from "@/lib/labs/values";

const numeric = (decimals: number | null = 1): ParameterSpec => ({ code: "WBC", valueType: "numeric", decimals, choices: null });
const id = "00000000-0000-4000-8000-000000000001";

describe("parseParameterValue", () => {
  it("accepts numbers with a decimal point or comma and keeps them as exact text", () => {
    expect(parseParameterValue(id, numeric(), "7,2")).toEqual({ ok: true, entry: { parameter_id: id, value_numeric: "7.2" } });
    expect(parseParameterValue(id, numeric(), " 7.2 ")).toEqual({ ok: true, entry: { parameter_id: id, value_numeric: "7.2" } });
    expect(parseParameterValue(id, numeric(null), "-0.000123")).toEqual({ ok: true, entry: { parameter_id: id, value_numeric: "-0.000123" } });
    expect(parseParameterValue(id, numeric(0), "+118")).toEqual({ ok: true, entry: { parameter_id: id, value_numeric: "118" } });
    expect(parseParameterValue(id, numeric(0), "118.0")).toEqual({ ok: true, entry: { parameter_id: id, value_numeric: "118.0" } });
  });

  it("refuses what is not a number, too many decimals, and absurd magnitudes", () => {
    for (const bad of ["abc", "7..2", "1e5", "7,2,3", "12 a", "∞", "0x10"]) {
      expect(parseParameterValue(id, numeric(), bad).ok, bad).toBe(false);
    }
    expect(parseParameterValue(id, numeric(1), "7.25")).toEqual({ ok: false, message: "Ko‘pi bilan 1 ta kasr xona" });
    expect(parseParameterValue(id, numeric(0), "118.5")).toEqual({ ok: false, message: "Butun son kiriting" });
    expect(parseParameterValue(id, numeric(null), "1000000000000").ok).toBe(false);
    expect(parseParameterValue(id, numeric(), true).ok).toBe(false);
  });

  it("clears on empty input", () => {
    for (const empty of ["", "   ", null, undefined]) {
      expect(parseParameterValue(id, numeric(), empty)).toEqual({ ok: true, entry: { parameter_id: id, clear: true } });
    }
  });

  it("handles boolean, choice and text parameters", () => {
    const bool: ParameterSpec = { code: "HIV", valueType: "boolean", decimals: null, choices: null };
    expect(parseParameterValue(id, bool, false)).toEqual({ ok: true, entry: { parameter_id: id, value_boolean: false } });
    expect(parseParameterValue(id, bool, "false").ok).toBe(false);

    const choice: ParameterSpec = { code: "COLOR", valueType: "choice", decimals: null, choices: ["Sariq", "Qizil"] };
    expect(parseParameterValue(id, choice, "Sariq")).toEqual({ ok: true, entry: { parameter_id: id, value_text: "Sariq" } });
    expect(parseParameterValue(id, choice, "Ko‘k").ok).toBe(false);

    const text: ParameterSpec = { code: "NOTE", valueType: "text", decimals: null, choices: null };
    expect(parseParameterValue(id, text, "  bir oz loyqa  ")).toEqual({ ok: true, entry: { parameter_id: id, value_text: "bir oz loyqa" } });
    expect(parseParameterValue(id, text, "x".repeat(501)).ok).toBe(false);
  });
});

describe("formatRange", () => {
  it("shows the configured range only", () => {
    expect(formatRange({ low: 120, high: 150, text: null })).toBe("120–150");
    expect(formatRange({ low: "4.0", high: null, text: null })).toBe("≥ 4");
    expect(formatRange({ low: null, high: 9, text: null })).toBe("≤ 9");
    expect(formatRange({ low: null, high: null, text: "Manfiy" })).toBe("Manfiy");
    expect(formatRange({ low: null, high: null, text: null })).toBeNull();
    expect(formatRange(null)).toBeNull();
  });
});

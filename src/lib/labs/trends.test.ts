import { describe, expect, it } from "vitest";
import { buildSeries, type TrendInput } from "@/lib/labs/trends";

const result = (at: string, values: Array<Partial<TrendInput["values"][number]> & { parameterCode: string }>, test = "CBC"): TrendInput => ({
  testCode: test,
  testName: test === "CBC" ? "Umumiy qon tahlili" : "Biokimyo",
  performedAt: null,
  collectedAt: at,
  verifiedAt: at,
  values: values.map((v) => ({ parameter: v.parameterCode, numeric: null, display: "", unit: "g/L", flag: "normal", rangeLow: null, rangeHigh: null, ...v })),
});

describe("buildSeries", () => {
  it("groups one numeric parameter of one test over time, oldest first (by instant, not by text)", () => {
    const series = buildSeries([
      result("2026-09-01T08:00:00+00:00", [{ parameterCode: "HGB", numeric: 118, display: "118", flag: "low" }]),
      result("2026-07-01T08:00:00+05:00", [{ parameterCode: "HGB", numeric: 130, display: "130" }]),
      result("2026-08-01T08:00:00Z", [{ parameterCode: "HGB", numeric: 125, display: "125" }]),
    ]);
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ title: "HGB — Umumiy qon tahlili", unit: "g/L" });
    expect(series[0].points.map((p) => p.value)).toEqual([130, 125, 118]);
    expect(series[0].points[2].flag).toBe("low");
  });

  it("keeps different tests, parameters and units apart, and skips non-numeric values", () => {
    const series = buildSeries([
      result("2026-07-01T00:00:00Z", [{ parameterCode: "HGB", numeric: 130 }, { parameterCode: "COLOR", numeric: null, display: "Sariq" }]),
      result("2026-08-01T00:00:00Z", [{ parameterCode: "HGB", numeric: 13, unit: "g/dL" }]),
      result("2026-08-01T00:00:00Z", [{ parameterCode: "HGB", numeric: 131 }], "BIO"),
    ]);
    expect(series.map((s) => [s.key, s.points.length]).sort()).toEqual([
      ["BIO|HGB|g/L", 1],
      ["CBC|HGB|g/L", 1],
      ["CBC|HGB|g/dL", 1],
    ]);
  });

  it("dates a point by when the test was performed, else collected, else verified", () => {
    const r = result("2026-08-02T00:00:00Z", [{ parameterCode: "HGB", numeric: 1 }]);
    expect(buildSeries([{ ...r, performedAt: "2026-08-01T00:00:00Z" }])[0].points[0].at).toBe("2026-08-01T00:00:00Z");
    expect(buildSeries([{ ...r, collectedAt: null, verifiedAt: "2026-08-03T00:00:00Z" }])[0].points[0].at).toBe("2026-08-03T00:00:00Z");
  });
});

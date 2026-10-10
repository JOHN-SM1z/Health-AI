/**
 * Trend series for the doctor's lab history (Phase 10): one numeric
 * parameter of one test, in one unit, over time — oldest first. Pure, so the
 * grouping is unit-tested; nothing here interprets a value.
 */

export type TrendInput = {
  testCode: string;
  testName: string;
  performedAt: string | null;
  collectedAt: string | null;
  verifiedAt: string;
  values: Array<{
    parameterCode: string;
    parameter: string;
    numeric: number | null;
    display: string;
    unit: string | null;
    flag: string;
    rangeLow: number | null;
    rangeHigh: number | null;
  }>;
};

export type Point = { at: string; value: number; display: string; flag: string; low: number | null; high: number | null };
export type Series = { key: string; title: string; unit: string | null; points: Point[] };

export function buildSeries(results: TrendInput[]): Series[] {
  const map = new Map<string, Series>();
  for (const r of results) {
    for (const v of r.values) {
      if (v.numeric === null) continue;
      const key = `${r.testCode}|${v.parameterCode}|${v.unit ?? ""}`;
      const series = map.get(key) ?? { key, title: `${v.parameter} — ${r.testName}`, unit: v.unit, points: [] };
      series.points.push({ at: r.performedAt ?? r.collectedAt ?? r.verifiedAt, value: v.numeric, display: v.display, flag: v.flag, low: v.rangeLow, high: v.rangeHigh });
      map.set(key, series);
    }
  }
  return [...map.values()]
    .map((s) => ({ ...s, points: s.points.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()) }))
    .sort((a, b) => b.points.length - a.points.length || a.title.localeCompare(b.title));
}


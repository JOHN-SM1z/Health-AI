/**
 * Laboratory assistance (Phase 18): the FACTS, computed without AI.
 *
 * Input: the patient's VERIFIED results as the authoritative lab model holds
 * them (numbers, units, flags against the clinic's configured ranges, dates,
 * test and parameter names from the clinic's catalog). Output: a list of
 * plain statements, each carrying the exact numbers it may mention.
 *
 * What is never read here, so it can never reach a model: lab comments,
 * correction reasons, free-text values, documents, clinical notes, patient
 * name or identifiers. Only numeric values take part; a free-text or choice
 * value is counted, not quoted.
 *
 * The statements describe and compare recorded values only: higher / lower /
 * similar, inside or outside the configured range, too little data. They
 * never interpret, diagnose, advise, or judge whether a test is needed.
 */

export type FactValue = {
  numeric: number | null;
  unit: string | null;
  flag: string;
  rangeLow: number | null;
  rangeHigh: number | null;
};

export type FactResult = {
  resultId: string;
  testCode: string;
  testName: string;
  /** Clinical time: performed, else collected, else verified. */
  takenAt: string;
  corrected: boolean;
  values: Array<FactValue & { parameterCode: string; parameter: string }>;
};

export type FactPending = { testName: string; status: string; orderedAt: string };

export type StatementKind = "parameter" | "comparable" | "pending" | "notice";
export type Severity = "critical" | "abnormal" | "info";

export type Statement = {
  id: string;
  kind: StatementKind;
  severity: Severity;
  text: string;
  /** The only values (not dates) the statement — and any rewording of it — may contain. */
  numbers: number[];
  /** The only dates (YYYY-MM-DD) it may contain. */
  dates: string[];
};

export type LabFacts = {
  statements: Statement[];
  basis: { results: number; from: string | null; to: string | null; numericValues: number; nonNumericValues: number };
};

/** Relative change at or below which two measurements are called similar. */
export const SIMILAR_WITHIN = 0.05;
/** Same test again within this many days is pointed out. */
export const REPEAT_WINDOW_DAYS = 30;

const FLAG_WORDS: Record<string, string> = {
  normal: "sozlangan me’yor oralig‘ida",
  low: "sozlangan me’yordan past",
  high: "sozlangan me’yordan yuqori",
  critical_low: "kritik chegaradan past",
  critical_high: "kritik chegaradan yuqori",
  abnormal: "kutilgan qiymatdan farq qiladi",
  not_evaluated: "me’yor sozlanmagan",
};
const OUT_OF_RANGE = new Set(["low", "high", "critical_low", "critical_high", "abnormal"]);
const CRITICAL = new Set(["critical_low", "critical_high"]);
const PENDING_WORDS: Record<string, string> = {
  ordered: "buyurtma qilingan",
  ready_for_collection: "namuna kutilmoqda",
  collected: "namuna olingan",
  processing: "laboratoriyada",
  resulted: "natija tasdiqlanmoqda",
};

/**
 * Catalog names are configured by clinic staff, but they are still text:
 * one line, no control characters, quotes or brackets, at most 60 characters.
 */
export function cleanName(name: string): string {
  return (
    name
      .normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g, " ")
      .replace(/[`"<>{}[\]\\|#*_]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60) || "—"
  );
}

const day = (iso: string) => iso.slice(0, 10);
const fmt = (n: number) => String(Number(n.toPrecision(10)));
const unitOf = (u: string | null) => (u ? ` ${cleanName(u)}` : "");
const daysBetween = (a: string, b: string) => Math.round(Math.abs(Date.parse(day(a)) - Date.parse(day(b))) / 86_400_000);

function rangeWords(v: FactValue): { text: string; numbers: number[] } {
  if (v.rangeLow !== null && v.rangeHigh !== null) return { text: `me’yor ${fmt(v.rangeLow)}–${fmt(v.rangeHigh)}`, numbers: [v.rangeLow, v.rangeHigh] };
  if (v.rangeLow !== null) return { text: `me’yor ≥ ${fmt(v.rangeLow)}`, numbers: [v.rangeLow] };
  if (v.rangeHigh !== null) return { text: `me’yor ≤ ${fmt(v.rangeHigh)}`, numbers: [v.rangeHigh] };
  return { text: "", numbers: [] };
}

type Point = { value: number; unit: string | null; flag: string; takenAt: string; source: FactValue };

function parameterStatement(id: string, testName: string, parameter: string, points: Point[]): Statement {
  const label = `${cleanName(testName)} — ${cleanName(parameter)}`;
  const latest = points[points.length - 1];
  const numbers: number[] = [];
  const dates: string[] = [];
  const parts: string[] = [];
  const severity: Severity = CRITICAL.has(latest.flag) ? "critical" : OUT_OF_RANGE.has(latest.flag) ? "abnormal" : "info";

  const describeLatest = () => {
    const r = rangeWords(latest.source);
    numbers.push(latest.value, ...r.numbers);
    dates.push(day(latest.takenAt));
    const flagWords = FLAG_WORDS[latest.flag] ?? "me’yor sozlanmagan";
    return `oxirgi qiymat ${fmt(latest.value)}${unitOf(latest.unit)} (${day(latest.takenAt)}) — ${flagWords}${r.text ? ` (${r.text})` : ""}`;
  };

  // Different units are never compared (no conversion).
  const units = new Set(points.map((p) => p.unit ?? ""));
  if (units.size > 1) {
    parts.push(describeLatest(), "o‘lchov birliklari har xil bo‘lgani uchun avvalgi qiymatlar bilan taqqoslanmadi");
    return { id, kind: "parameter", severity, text: `${label}: ${parts.join("; ")}.`, numbers, dates };
  }

  // Two different values recorded on the same day: say so; no trend is drawn.
  const byDay = new Map<string, number[]>();
  for (const p of points) byDay.set(day(p.takenAt), [...(byDay.get(day(p.takenAt)) ?? []), p.value]);
  const conflict = [...byDay.entries()].find(([, values]) => new Set(values).size > 1);
  if (conflict) {
    const [conflictDay, values] = conflict;
    const distinct = [...new Set(values)].sort((a, b) => a - b);
    numbers.push(...distinct);
    dates.push(conflictDay);
    // When the conflict is on the latest day there is no single "latest value" to state.
    if (conflictDay !== day(latest.takenAt)) parts.push(describeLatest());
    parts.push(`${conflictDay} kuni bir-biridan farq qiluvchi qiymatlar qayd etilgan (${distinct.map(fmt).join(" va ")}) — dinamika baholanmadi, manbani tekshiring`);
    const sameDay = points.filter((p) => day(p.takenAt) === day(latest.takenAt)).map((p) => p.flag);
    const worst: Severity = sameDay.some((f) => CRITICAL.has(f)) ? "critical" : sameDay.some((f) => OUT_OF_RANGE.has(f)) ? "abnormal" : "info";
    return { id, kind: "parameter", severity: worst, text: `${label}: ${parts.join("; ")}.`, numbers, dates };
  }

  parts.push(describeLatest());
  if (points.length === 1) {
    parts.push("dinamikani baholash uchun bitta o‘lchov yetarli emas");
  } else {
    const previous = points[points.length - 2];
    numbers.push(previous.value);
    dates.push(day(previous.takenAt));
    const base = Math.abs(previous.value);
    const change = base === 0 ? (latest.value === 0 ? 0 : Infinity) : Math.abs(latest.value - previous.value) / base;
    const values = points.map((p) => p.value);
    const rising = values.every((v, i) => i === 0 || v > values[i - 1]);
    const falling = values.every((v, i) => i === 0 || v < values[i - 1]);
    if (points.length >= 3 && (rising || falling) && change > SIMILAR_WITHIN) {
      numbers.push(points.length);
      parts.push(`qayd etilgan ${points.length} ta o‘lchovda izchil ${rising ? "oshgan" : "pasaygan"}`);
    } else if (change <= SIMILAR_WITHIN) {
      parts.push(`avvalgi o‘lchovga (${fmt(previous.value)}, ${day(previous.takenAt)}) yaqin`);
    } else {
      parts.push(`avvalgi o‘lchovdan (${fmt(previous.value)}, ${day(previous.takenAt)}) ${latest.value > previous.value ? "yuqori" : "past"}`);
    }
    const flags = points.map((p) => p.flag);
    if (flags.every((f) => f === "normal")) parts.push("barcha o‘lchovlar sozlangan me’yor oralig‘ida");
  }
  return { id, kind: "parameter", severity, text: `${label}: ${parts.join("; ")}.`, numbers, dates };
}

/**
 * The statements for `results` (verified versions only) and `pending` tests,
 * most important first: critical, then outside the range, then the rest.
 */
export function buildLabFacts(results: FactResult[], pending: FactPending[] = [], now = new Date()): LabFacts {
  const sorted = [...results].sort((a, b) => Date.parse(a.takenAt) - Date.parse(b.takenAt));
  let numericValues = 0;
  let nonNumericValues = 0;

  // Series per (test, parameter), in clinical time order.
  const series = new Map<string, { testName: string; parameter: string; points: Point[] }>();
  for (const r of sorted) {
    for (const v of r.values) {
      if (v.numeric === null || !Number.isFinite(v.numeric)) {
        nonNumericValues += 1;
        continue;
      }
      numericValues += 1;
      const key = `${r.testCode}|${v.parameterCode}`;
      const s = series.get(key) ?? { testName: r.testName, parameter: v.parameter, points: [] };
      s.points.push({ value: v.numeric, unit: v.unit, flag: v.flag, takenAt: r.takenAt, source: v });
      series.set(key, s);
    }
  }

  const statements: Statement[] = [];
  let n = 0;
  const nextId = () => `s${++n}`;

  if (results.length === 0) {
    statements.push({ id: nextId(), kind: "notice", severity: "info", text: "Tasdiqlangan laboratoriya natijalari yo‘q — xulosa uchun ma’lumot yetarli emas.", numbers: [], dates: [] });
  } else if (numericValues === 0) {
    statements.push({ id: nextId(), kind: "notice", severity: "info", text: "Tasdiqlangan natijalarda raqamli qiymat yo‘q — dinamika uchun ma’lumot yetarli emas.", numbers: [], dates: [] });
  }

  const parameterStatements = [...series.values()].map((s) => parameterStatement("", s.testName, s.parameter, s.points));
  const rank: Record<Severity, number> = { critical: 0, abnormal: 1, info: 2 };
  parameterStatements.sort((a, b) => rank[a.severity] - rank[b.severity]);
  for (const s of parameterStatements) statements.push({ ...s, id: nextId() });

  if (nonNumericValues > 0) {
    statements.push({
      id: nextId(),
      kind: "notice",
      severity: "info",
      text: `${nonNumericValues} ta matnli yoki tanlovli qiymat xulosaga kiritilmagan — ularni natijaning o‘zida ko‘ring.`,
      numbers: [nonNumericValues],
      dates: [],
    });
  }

  // Comparable tests: the same test recorded more than once.
  const byTest = new Map<string, FactResult[]>();
  for (const r of sorted) byTest.set(r.testCode, [...(byTest.get(r.testCode) ?? []), r]);
  for (const list of byTest.values()) {
    if (list.length < 2) continue;
    const latest = list[list.length - 1];
    const previous = list[list.length - 2];
    const gap = daysBetween(latest.takenAt, previous.takenAt);
    const repeat = gap <= REPEAT_WINDOW_DAYS ? ` — ${REPEAT_WINDOW_DAYS} kun ichida takrorlangan` : "";
    statements.push({
      id: nextId(),
      kind: "comparable",
      severity: "info",
      text: `${cleanName(latest.testName)}: ${list.length} marta qayd etilgan; oxirgisi ${day(latest.takenAt)}, avvalgisi ${day(previous.takenAt)} (${gap} kun oldin)${repeat}.`,
      numbers: [list.length, gap, ...(repeat ? [REPEAT_WINDOW_DAYS] : [])],
      dates: [day(latest.takenAt), day(previous.takenAt)],
    });
  }

  for (const p of pending) {
    const ago = daysBetween(now.toISOString(), p.orderedAt);
    statements.push({
      id: nextId(),
      kind: "pending",
      severity: "info",
      text: `${cleanName(p.testName)}: natija hali tayyor emas (${PENDING_WORDS[p.status] ?? "jarayonda"}, ${day(p.orderedAt)} da buyurtma qilingan, ${ago} kun oldin).`,
      numbers: [ago],
      dates: [day(p.orderedAt)],
    });
  }

  const times = sorted.map((r) => r.takenAt);
  return {
    statements,
    basis: { results: results.length, from: times[0] ?? null, to: times[times.length - 1] ?? null, numericValues, nonNumericValues },
  };
}

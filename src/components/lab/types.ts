/** Shapes of the laboratory configuration API (src/app/api/admin/lab/*), shared by the admin and lab screens. */
export type LabCategory = { id: string; name: string; sort_order: number; active: boolean };
export type LabRange = {
  id: string;
  parameter_id: string;
  age_min_years: number | null;
  age_max_years: number | null;
  low: number | null;
  high: number | null;
  critical_low: number | null;
  critical_high: number | null;
  note: string | null;
  active: boolean;
};
export type LabParameter = {
  id: string;
  test_id: string;
  code: string;
  name: string;
  unit: string | null;
  data_type: "numeric" | "text" | "choice";
  choices: string[] | null;
  display_order: number;
  active: boolean;
  ranges: LabRange[];
};
export type LabTest = {
  id: string;
  code: string;
  name: string;
  category_id: string | null;
  description: string | null;
  price: number;
  sample_type: string | null;
  preparation_text: string | null;
  turnaround_minutes: number | null;
  active: boolean;
  category?: { id: string; name: string } | null;
  parameterCount?: number;
};
export type LabTestDetail = LabTest & { parameters: LabParameter[] };
export type LabPanel = { id: string; code: string; name: string; description: string | null; price: number | null; active: boolean; testIds: string[] };
export type LabSettings = {
  verification: { required: boolean; separateVerifier: boolean };
  collection: { requiresPayment: boolean };
  ordering: { recentTestWindowDays: number };
};

export const DATA_TYPE_LABELS: Record<LabParameter["data_type"], string> = { numeric: "Son", text: "Matn", choice: "Tanlov" };

export function formatTurnaround(minutes: number | null): string {
  if (!minutes) return "—";
  if (minutes < 60) return `${minutes} daq`;
  if (minutes < 1440) return `${Math.round((minutes / 60) * 10) / 10} soat`;
  return `${Math.round((minutes / 1440) * 10) / 10} kun`;
}

export function formatRange(r: LabRange): string {
  const normal = r.low !== null || r.high !== null ? `${r.low ?? "…"} – ${r.high ?? "…"}` : "";
  const critical = r.critical_low !== null || r.critical_high !== null ? `kritik < ${r.critical_low ?? "…"} / > ${r.critical_high ?? "…"}` : "";
  const age = r.age_min_years !== null || r.age_max_years !== null ? `${r.age_min_years ?? 0}–${r.age_max_years ?? "…"} yosh` : "";
  return [normal, critical, age].filter(Boolean).join(" · ");
}

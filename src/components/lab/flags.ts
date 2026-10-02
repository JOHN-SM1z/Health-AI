/**
 * How a stored flag is worded. A flag is the database's comparison of a value with the configured reference range - never an
 * interpretation: the wording says "outside the range", not what it might mean.
 */
export const FLAG_LABELS: Record<string, { label: string; tone: "green" | "amber" | "red" | "gray" }> = {
  normal: { label: "Me‘yorda", tone: "green" },
  low: { label: "Me‘yordan past", tone: "amber" },
  high: { label: "Me‘yordan yuqori", tone: "amber" },
  critical_low: { label: "Kritik past", tone: "red" },
  critical_high: { label: "Kritik yuqori", tone: "red" },
  unclassified: { label: "Me‘yor belgilanmagan", tone: "gray" },
};

export const DOCUMENT_KIND_LABELS: Record<string, string> = { report: "Hisobot", scan: "Skaner", image: "Rasm", imported: "Import qilingan hisobot" };

export function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

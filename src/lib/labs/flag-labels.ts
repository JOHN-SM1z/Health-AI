/**
 * How a value sits against the CONFIGURED reference range, in words for staff
 * and patients alike. Placement only — never a diagnosis or advice.
 */
export const LAB_FLAG_LABELS: Record<string, { label: string; tone: "green" | "amber" | "red" | "gray" }> = {
  normal: { label: "Me’yor oralig‘ida", tone: "green" },
  low: { label: "Me’yordan past", tone: "amber" },
  high: { label: "Me’yordan yuqori", tone: "amber" },
  critical_low: { label: "Kritik chegaradan past", tone: "red" },
  critical_high: { label: "Kritik chegaradan yuqori", tone: "red" },
  abnormal: { label: "Kutilgan qiymatdan farq qiladi", tone: "amber" },
  not_evaluated: { label: "Me’yor sozlanmagan", tone: "gray" },
};

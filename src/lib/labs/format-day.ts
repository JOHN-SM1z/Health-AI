/** dd.MM.yyyy in the viewer's local time — the date format patients know (01.10.2026). */
export function formatDay(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

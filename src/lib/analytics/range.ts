import { z } from "zod";
import { ApiError } from "@/lib/api/errors";
import { localDayWindowForDate } from "@/lib/time/local";

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

/** The analytics period: a rolling `range` of days (default 30) or a clinic-local `from`/`to` pair. */
export const analyticsRangeSchema = z.object({
  range: z.coerce.number().int().min(1).max(365).default(30),
  from: z.string().regex(isoDate, "Sana YYYY-MM-DD formatida bo‘lishi kerak").optional(),
  to: z.string().regex(isoDate, "Sana YYYY-MM-DD formatida bo‘lishi kerak").optional(),
});

export type AnalyticsWindow = { range: number; from: string | null; to: string | null; since: string; until: string | null };

/** Resolves the period in the clinic's own timezone, never the server's. */
export function resolveAnalyticsWindow(searchParams: URLSearchParams, clinicTimezone: string, now = Date.now()): AnalyticsWindow {
  const params = analyticsRangeSchema.parse(Object.fromEntries(searchParams));
  if (params.from && params.to) {
    if (params.from > params.to) {
      throw new ApiError(400, "Boshlanish sanasi tugash sanasidan keyin bo‘lishi mumkin emas", "bad_range");
    }
    const since = localDayWindowForDate(clinicTimezone, params.from).start;
    const until = localDayWindowForDate(clinicTimezone, params.to).end;
    const range = Math.round((new Date(until).getTime() - new Date(since).getTime()) / 86400000);
    return { range, from: params.from, to: params.to, since, until };
  }
  return { range: params.range, from: null, to: null, since: new Date(now - params.range * 86400000).toISOString(), until: null };
}

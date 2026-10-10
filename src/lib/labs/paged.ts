import "server-only";

/**
 * Reads every row of a query in pages (PostgREST returns at most `max_rows`,
 * 1000, per request), up to `max` rows. `page(from, to)` must build a fresh,
 * ordered query each time. `truncated` says whether more rows existed.
 */
export async function readPaged<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { code?: string; message?: string } | null }>,
  max: number,
  pageSize = 1000,
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  for (let from = 0; from <= max; from += pageSize) {
    const to = Math.min(from + pageSize, max + 1) - 1;
    const { data, error } = await page(from, to);
    if (error) throw Object.assign(new Error(error.message ?? "read failed"), { code: error.code });
    const got = (data ?? []) as T[];
    rows.push(...got);
    if (got.length < to - from + 1) return { rows, truncated: false };
  }
  return { rows: rows.slice(0, max), truncated: rows.length > max };
}

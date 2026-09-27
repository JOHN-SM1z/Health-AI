/**
 * Builds a PostgREST `or` filter that matches `term` as literal text,
 * case-insensitively, anywhere in any of `columns`.
 *
 * User text must never be pasted raw into a filter string: PostgREST reads
 * `,` `.` `(` `)` `"` as filter syntax, so a comma adds a whole extra
 * condition and a stray bracket or quote makes the query fail to parse.
 * Each value is therefore double-quoted (with `\` and `"` backslash-escaped),
 * and the LIKE wildcards `%` and `_` in the term are escaped so they match
 * literally.
 *
 * PostgREST maps `*` to `%` in like/ilike values even inside quotes, so a
 * `*` in the term still acts as a wildcard. That only widens the match
 * within the same column; it can never add a condition.
 */
export function ilikeAnyFilter(columns: readonly string[], term: string): string {
  const pattern = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
  const quoted = `"${pattern.replace(/[\\"]/g, "\\$&")}"`;
  return columns.map((column) => `${column}.ilike.${quoted}`).join(",");
}

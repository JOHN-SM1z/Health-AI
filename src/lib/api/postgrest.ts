/**
 * A PostgREST `ilike` value that matches `text` as a literal substring.
 *
 * Search text must never become filter syntax: inside `.or(...)` the
 * characters `, . : ( )` separate or nest conditions, so the value is
 * double-quoted (PostgREST treats a quoted value as one literal), and the
 * characters that would still carry meaning inside it — the quote and
 * backslash that end or escape it, and the `%` / `*` wildcards — are
 * dropped. `_` stays (usernames contain it): as a LIKE wildcard it matches
 * any one character, the literal `_` included, so it can only widen a match
 * by a character, never escape the filter.
 */
export function ilikeContains(text: string): string {
  const literal = text.replace(/["\\%*]/g, "");
  return `"%${literal}%"`;
}

/** `col.ilike."%text%"` for each column, joined for `.or(...)`. */
export function anyColumnContains(columns: string[], text: string): string {
  const value = ilikeContains(text);
  return columns.map((column) => `${column}.ilike.${value}`).join(",");
}

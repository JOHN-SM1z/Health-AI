/**
 * JSON of `value` with ids, hashes and timestamps blanked out, for checks
 * that a short number (a result value such as "135") never appears: a uuid,
 * a sha256 or a timestamp can contain those digits by chance.
 */
export function idFree(value: unknown): string {
  return JSON.stringify(value)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\b[0-9a-f]{32,}\b/gi, "<hash>")
    .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+(Z|[+-]\d{2}(:?\d{2})?)?/g, "<time>");
}

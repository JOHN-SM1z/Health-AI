/**
 * Reading an uploaded import file (Phase 13). Pure: no I/O.
 *
 * Accepts a UTF-8 CSV (comma, semicolon or tab separated — Excel's "CSV
 * UTF-8" export, MedPlus and other systems' exports). Excel workbooks and
 * PDFs are recognised and refused with a clear message: no external format
 * or provider API is assumed, and a PDF report has no reliable table to read.
 *
 * File-level problems (encoding, unterminated quotes, limits, headers) refuse
 * the file. Row-level problems (a row with the wrong number of cells) are kept
 * and reported per row by the analysis, so one malformed row never hides the
 * others.
 */

export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 5000;
export const IMPORT_MAX_COLUMNS = 50;
export const IMPORT_MAX_CELL = 500;

export type CsvTable = { headers: string[]; rows: Array<{ rowNumber: number; cells: string[] }>; delimiter: "," | ";" | "\t" };

export type FileErrorCode =
  | "empty"
  | "too_large"
  | "xlsx_not_supported"
  | "pdf_not_supported"
  | "binary"
  | "encoding"
  | "unterminated_quote"
  | "too_many_rows"
  | "too_many_columns"
  | "cell_too_long"
  | "bad_header"
  | "duplicate_header"
  | "no_rows";

export type CsvResult = { ok: true; table: CsvTable } | { ok: false; code: FileErrorCode; row?: number };

export const FILE_ERROR_MESSAGES: Record<FileErrorCode, string> = {
  empty: "Fayl bo‘sh",
  too_large: "Fayl 2 MB dan katta — uni bir necha qismga bo‘ling",
  xlsx_not_supported: "Excel faylni “CSV UTF-8” sifatida saqlab, CSV faylni yuklang",
  pdf_not_supported: "PDF hisobotdan jadval o‘qilmaydi — ma’lumotni CSV sifatida eksport qiling",
  binary: "Bu matnli CSV fayl emas",
  encoding: "Fayl UTF-8 kodlashida emas — “CSV UTF-8” sifatida saqlang",
  unterminated_quote: "Qo‘shtirnoq yopilmagan — fayl buzilgan",
  too_many_rows: "Bir faylda ko‘pi bilan 5000 qator — faylni qismlarga bo‘ling",
  too_many_columns: "Ko‘pi bilan 50 ustun",
  cell_too_long: "Katak ko‘pi bilan 500 belgi",
  bad_header: "Birinchi qatorda har bir ustunning nomi bo‘lishi kerak",
  duplicate_header: "Ustun nomlari takrorlanmasligi kerak",
  no_rows: "Faylda ma’lumot qatori yo‘q",
};

/** Recognises what the bytes are before decoding them as text. */
export function sniffImportFile(bytes: Uint8Array): FileErrorCode | null {
  if (bytes.length === 0) return "empty";
  if (bytes.length > IMPORT_MAX_BYTES) return "too_large";
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return "xlsx_not_supported";
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return "xlsx_not_supported"; // legacy .xls
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "pdf_not_supported";
  if (bytes.includes(0)) return "binary";
  return null;
}

/** Bytes → text (UTF-8, BOM removed) or a file error. */
export function decodeImportFile(bytes: Uint8Array): { ok: true; text: string } | { ok: false; code: FileErrorCode } {
  const sniffed = sniffImportFile(bytes);
  if (sniffed) return { ok: false, code: sniffed };
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    return { ok: true, text };
  } catch {
    return { ok: false, code: "encoding" };
  }
}

/** The separator used by the header line (outside quotes): the most frequent of , ; and tab. */
function detectDelimiter(text: string): "," | ";" | "\t" {
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && ch in counts) counts[ch as keyof typeof counts]++;
  }
  if (counts[";"] > counts[","] && counts[";"] >= counts["\t"]) return ";";
  if (counts["\t"] > counts[","] && counts["\t"] > counts[";"]) return "\t";
  return ",";
}

/** RFC 4180 records (quoted fields, "" escapes, CRLF / LF / CR line ends). */
function records(text: string, delimiter: string): { ok: true; records: string[][] } | { ok: false } {
  const out: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      i++;
    } else if (ch === delimiter) {
      record.push(field);
      field = "";
      i++;
    } else if (ch === "\n" || ch === "\r") {
      record.push(field);
      out.push(record);
      record = [];
      field = "";
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  if (quoted) return { ok: false };
  if (field !== "" || record.length > 0) {
    record.push(field);
    out.push(record);
  }
  return { ok: true, records: out };
}

export function parseCsv(input: string): CsvResult {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (text.trim() === "") return { ok: false, code: "empty" };
  const delimiter = detectDelimiter(text);
  const parsed = records(text, delimiter);
  if (!parsed.ok) return { ok: false, code: "unterminated_quote" };

  // Fully empty lines (e.g. trailing ones) are not data.
  const lines = parsed.records
    .map((cells, index) => ({ cells, line: index }))
    .filter((r) => r.cells.some((c) => c.trim() !== ""));
  if (lines.length === 0) return { ok: false, code: "empty" };

  const headers = lines[0].cells.map((h) => h.trim());
  if (headers.length > IMPORT_MAX_COLUMNS) return { ok: false, code: "too_many_columns" };
  if (headers.some((h) => h === "" || h.length > 120)) return { ok: false, code: "bad_header" };
  if (new Set(headers.map((h) => h.toLowerCase())).size !== headers.length) return { ok: false, code: "duplicate_header" };

  const data = lines.slice(1);
  if (data.length === 0) return { ok: false, code: "no_rows" };
  if (data.length > IMPORT_MAX_ROWS) return { ok: false, code: "too_many_rows" };

  const rows: CsvTable["rows"] = [];
  for (let n = 0; n < data.length; n++) {
    const cells = data[n].cells.map((c) => c.trim());
    if (cells.length > IMPORT_MAX_COLUMNS) return { ok: false, code: "too_many_columns", row: n + 1 };
    if (cells.some((c) => c.length > IMPORT_MAX_CELL)) return { ok: false, code: "cell_too_long", row: n + 1 };
    rows.push({ rowNumber: n + 1, cells });
  }
  return { ok: true, table: { headers, rows, delimiter } };
}

/** One CSV field for a downloaded report; neutralises spreadsheet formulas. */
export function csvField(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",;\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

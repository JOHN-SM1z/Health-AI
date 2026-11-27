// Loads a reviewed reference file into the shared drug catalogue or the ICD-10 catalogue
// (specification RX-02, DW-02). Run by the operator, never from the application:
//
//   SUPABASE_DB_URL=… node scripts/import-reference-data.mjs \
//     --dataset drug_catalog --file register.csv --source uz-register --source-version 2026-11 [--deactivate-missing] [--dry-run]
//   SUPABASE_DB_URL=… node scripts/import-reference-data.mjs \
//     --dataset icd10 --file icd10.csv --source who-icd10-uz --source-version 2019
//
// The file must come from a named source (the national register of medicines, a licensed database, the official
// ICD-10 list): the source and version given here are what doctors see in the screen footer. Entries are never
// invented or generated — this script only copies what the file says, and refuses the whole file on any bad row.
//
// CSV, UTF-8, comma-separated, first line is the header.
//   drug_catalog: inn, inn_latin, trade_name, form, strength, manufacturer, registration_number, drug_class,
//                 aliases ("|"-separated), rx_only, controlled
//                 inn, rx_only and controlled are required on every row (yes/no, true/false, 1/0, ha/yo'q):
//                 "not prescription-only" and "not controlled" are never assumed.
//   icd10:        code, name_uz, name_ru  (code and at least one name required)
//
// One transaction: either the whole file is loaded or nothing is. Entries missing from a newer file are only
// deactivated, and only with --deactivate-missing; nothing is ever deleted (signed prescriptions point at them).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";

const DATASETS = {
  drug_catalog: {
    rpc: "import_drug_catalog",
    columns: ["inn", "inn_latin", "trade_name", "form", "strength", "manufacturer", "registration_number", "drug_class", "aliases", "rx_only", "controlled"],
    required: ["inn", "rx_only", "controlled"],
  },
  icd10: { rpc: "import_icd10_codes", columns: ["code", "name_uz", "name_ru"], required: ["code"] },
};

function fail(message) {
  console.error(`import-reference-data: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { deactivateMissing: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--deactivate-missing") args.deactivateMissing = true;
    else if (flag === "--dry-run") args.dryRun = true;
    else if (["--dataset", "--file", "--source", "--source-version"].includes(flag)) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) fail(`${flag} needs a value`);
      args[flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    } else fail(`unknown argument ${flag}`);
  }
  return args;
}

/** RFC 4180: quoted fields, doubled quotes, line breaks inside quotes. Returns rows of strings. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && body[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (quoted) throw new Error("unterminated quoted field");
  row.push(field);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
}

const TRUE = new Set(["yes", "true", "1", "ha", "да"]);
const FALSE = new Set(["no", "false", "0", "yo'q", "yo‘q", "yoq", "нет"]);

/** An explicit yes or no; anything else (including blank) is an error, never a default. */
function flag(value) {
  const v = value.trim().toLowerCase();
  if (TRUE.has(v)) return true;
  if (FALSE.has(v)) return false;
  return null;
}

export function toRows(dataset, table) {
  const spec = DATASETS[dataset];
  const [header, ...lines] = table;
  if (!header) throw new Error("the file is empty");
  const names = header.map((h) => h.trim().toLowerCase());
  const unknown = names.filter((n) => !spec.columns.includes(n));
  if (unknown.length) throw new Error(`unknown column(s): ${unknown.join(", ")}. Expected: ${spec.columns.join(", ")}`);
  const missing = spec.required.filter((r) => !names.includes(r));
  if (missing.length) throw new Error(`missing required column(s): ${missing.join(", ")}`);

  const errors = [];
  const rows = [];
  lines.forEach((cells, index) => {
    const line = index + 2;
    const raw = Object.fromEntries(names.map((name, i) => [name, (cells[i] ?? "").trim()]));
    if (dataset === "drug_catalog") {
      const rxOnly = flag(raw.rx_only ?? "");
      const controlled = flag(raw.controlled ?? "");
      if (!raw.inn) errors.push(`line ${line}: inn is empty`);
      if (rxOnly === null) errors.push(`line ${line}: rx_only must be yes or no`);
      if (controlled === null) errors.push(`line ${line}: controlled must be yes or no`);
      rows.push({
        inn: raw.inn,
        inn_latin: raw.inn_latin || null,
        trade_name: raw.trade_name || null,
        form: raw.form || null,
        strength: raw.strength || null,
        manufacturer: raw.manufacturer || null,
        registration_number: raw.registration_number || null,
        drug_class: raw.drug_class || null,
        aliases: (raw.aliases ?? "")
          .split("|")
          .map((a) => a.trim())
          .filter(Boolean),
        rx_only: rxOnly,
        controlled,
      });
    } else {
      const code = (raw.code ?? "").toUpperCase();
      if (!/^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/.test(code)) errors.push(`line ${line}: "${raw.code}" is not an ICD-10 code`);
      if (!raw.name_uz && !raw.name_ru) errors.push(`line ${line}: a name (name_uz or name_ru) is required`);
      rows.push({ code, name_uz: raw.name_uz || null, name_ru: raw.name_ru || null });
    }
  });
  if (errors.length) {
    throw new Error(`${errors.length} invalid row(s); nothing was imported:\n  ${errors.slice(0, 20).join("\n  ")}${errors.length > 20 ? "\n  …" : ""}`);
  }
  if (rows.length === 0) throw new Error("the file has a header but no rows");
  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const spec = DATASETS[args.dataset];
  if (!spec) fail(`--dataset must be one of: ${Object.keys(DATASETS).join(", ")}`);
  if (!args.file) fail("--file is required");
  if (!args.source || !/^[a-z0-9][a-z0-9_.-]{1,62}$/.test(args.source) || args.source === "clinic_formulary") {
    fail("--source must name where the file came from (lower-case letters, digits, . _ -)");
  }
  if (!args.sourceVersion) fail("--source-version is required (the version or date of the source file)");

  const bytes = await readFile(args.file);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  let rows;
  try {
    rows = toRows(args.dataset, parseCsv(bytes.toString("utf8")));
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }

  console.log(`${args.dataset}: ${rows.length} row(s) from ${args.file} (sha256 ${checksum.slice(0, 16)}…), source ${args.source} ${args.sourceVersion}`);
  if (args.dryRun) {
    console.log("dry run: the file is valid; nothing was written.");
    return;
  }

  const url = process.env.SUPABASE_DB_URL;
  if (!url) fail("set SUPABASE_DB_URL to the database to load into (it is never printed)");
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql`
      select * from ${sql(`public.${spec.rpc}`)}(${args.source}, ${args.sourceVersion}, ${checksum}, ${sql.json(rows)}, ${args.deactivateMissing}) as result`;
    console.log("imported:", JSON.stringify(row.result));
  } catch (e) {
    // The database's own message (a constraint name, a row's problem) — never the connection string.
    fail(`the database refused the import; nothing was written. ${e && typeof e === "object" && "message" in e ? e.message : ""}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Only when run as a script: the parser is also imported by its tests.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  await main();
}

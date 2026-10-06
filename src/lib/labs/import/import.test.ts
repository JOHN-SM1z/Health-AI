import { describe, expect, it } from "vitest";
import { csvField, decodeImportFile, parseCsv } from "./csv";
import { checkMapping, suggestMapping } from "./mapping";
import { normalizeName, readDate, readDocumentNumber, readPerformedAt, readPhone, readPinfl, readSex, readValue } from "./fields";
import { matchPatient, type CandidatePatient } from "./matching";
import { analyseRows, readRows, summarise, type CatalogTest, type ExistingResult } from "./analyse";

const TZ = "Asia/Tashkent";
const enc = (s: string) => new TextEncoder().encode(s);

describe("CSV reading", () => {
  it("reads comma, semicolon and tab files with quotes, BOM and CRLF", () => {
    const comma = parseCsv('﻿Name,Value\r\n"Karimov, Ali","1,5"\r\n"He said ""hi""",2\r\n');
    expect(comma.ok && comma.table.headers).toEqual(["Name", "Value"]);
    expect(comma.ok && comma.table.rows.map((r) => r.cells)).toEqual([["Karimov, Ali", "1,5"], ['He said "hi"', "2"]]);
    const semi = parseCsv("a;b\n1;2,5\n\n");
    expect(semi.ok && semi.table.delimiter).toBe(";");
    expect(semi.ok && semi.table.rows).toEqual([{ rowNumber: 1, cells: ["1", "2,5"] }]);
    const tab = parseCsv("a\tb\n1\t2");
    expect(tab.ok && tab.table.rows[0].cells).toEqual(["1", "2"]);
  });

  it("keeps a row with the wrong number of cells for the analysis to report", () => {
    const r = parseCsv("a,b\n1,2\n3\n4,5,6");
    expect(r.ok && r.table.rows.map((x) => x.cells.length)).toEqual([2, 1, 3]);
  });

  it("refuses broken or unsupported files", () => {
    expect(parseCsv('a,b\n"open,1')).toEqual({ ok: false, code: "unterminated_quote" });
    expect(parseCsv("a,a\n1,2")).toEqual({ ok: false, code: "duplicate_header" });
    expect(parseCsv("a,,c\n1,2,3")).toEqual({ ok: false, code: "bad_header" });
    expect(parseCsv("a,b\n")).toEqual({ ok: false, code: "no_rows" });
    expect(parseCsv("   \n ")).toEqual({ ok: false, code: "empty" });
    expect(parseCsv("a\n" + "1\n".repeat(5001))).toEqual({ ok: false, code: "too_many_rows" });
    expect(parseCsv(`a\n${"x".repeat(501)}`)).toMatchObject({ ok: false, code: "cell_too_long", row: 1 });
    expect(decodeImportFile(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1]))).toEqual({ ok: false, code: "xlsx_not_supported" });
    expect(decodeImportFile(enc("%PDF-1.4"))).toEqual({ ok: false, code: "pdf_not_supported" });
    expect(decodeImportFile(new Uint8Array([0x61, 0xff, 0xfe, 0x62]))).toEqual({ ok: false, code: "encoding" });
    expect(decodeImportFile(new Uint8Array([0x61, 0, 0x62]))).toEqual({ ok: false, code: "binary" });
    expect(decodeImportFile(new Uint8Array())).toEqual({ ok: false, code: "empty" });
  });

  it("neutralises spreadsheet formulas in the report", () => {
    expect(csvField("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvField("a;b")).toBe('"a;b"');
    expect(csvField("12")).toBe("12");
  });
});

describe("mapping", () => {
  it("suggests columns by well-known names only", () => {
    expect(suggestMapping(["JShShIR", "F.I.Sh.", "Tug‘ilgan sana", "Tahlil", "Ko‘rsatkich", "Natija", "Birlik", "Sana", "Something"])).toEqual({
      pinfl: 0,
      full_name: 1,
      date_of_birth: 2,
      test_code: 3,
      parameter_code: 4,
      value: 5,
      unit: 6,
      performed_at: 7,
    });
  });

  it("needs the result fields and at least one identifier, each column once", () => {
    expect(checkMapping({ test_code: 0, value: 1, performed_at: 2, pinfl: 3 }, 4)).toBeNull();
    expect(checkMapping({ test_code: 0, value: 1, performed_at: 2, full_name: 3 }, 4)).toBe("no_identity");
    expect(checkMapping({ value: 1, performed_at: 2, pinfl: 3 }, 4)).toBe("missing_required");
    expect(checkMapping({ test_code: 0, value: 0, performed_at: 2, pinfl: 3 }, 4)).toBe("column_reused");
    expect(checkMapping({ test_code: 0, value: 1, performed_at: 2, pinfl: 9 }, 4)).toBe("column_out_of_range");
  });
});

describe("cells", () => {
  it("reads identifiers in the database's canonical form", () => {
    expect(readPinfl(" 3010-1900 123456 ")).toEqual({ ok: true, value: "30101900123456" });
    expect(readPinfl("123")).toEqual({ ok: false });
    expect(readDocumentNumber("aa 1234567")).toEqual({ ok: true, value: "AA1234567" });
    expect(readPhone("+998 (90) 123-45-67")).toEqual({ ok: true, value: "901234567" });
    expect(readPhone("12-34")).toEqual({ ok: false });
    expect(readSex("Erkak")).toEqual({ ok: true, value: "male" });
    expect(readSex("Ж")).toEqual({ ok: true, value: "female" });
    expect(readSex("?")).toEqual({ ok: false });
    expect(normalizeName("KARIMOV  Ali")).toBe(normalizeName("ali karimov"));
  });

  it("reads dates day-first or ISO, refuses impossible ones", () => {
    expect(readDate("05.03.1990")).toEqual({ ok: true, value: "1990-03-05" });
    expect(readDate("1990-03-05")).toEqual({ ok: true, value: "1990-03-05" });
    expect(readDate("31.02.1990")).toEqual({ ok: false });
    expect(readDate("1899-12-31")).toEqual({ ok: false });
    // A date alone is midday in the clinic's time zone (UTC+5).
    expect(readPerformedAt("01.10.2026", TZ)).toEqual({ ok: true, value: "2026-10-01T07:00:00.000Z" });
    expect(readPerformedAt("2026-10-01 08:30", TZ)).toEqual({ ok: true, value: "2026-10-01T03:30:00.000Z" });
    expect(readPerformedAt("2026-10-01T08:30:00Z", TZ)).toEqual({ ok: true, value: "2026-10-01T08:30:00.000Z" });
    expect(readPerformedAt("1/2/26", TZ)).toEqual({ ok: false });
  });

  it("reads values by the parameter's type, never guessing", () => {
    const num = { code: "HGB", valueType: "numeric" as const, decimals: 1, choices: null, unit: "g/L" };
    expect(readValue("13,5", num)).toEqual({ ok: true, value: { numeric: "13.5", text: null, boolean: null } });
    expect(readValue("13.55", num)).toEqual({ ok: false });
    expect(readValue("high", num)).toEqual({ ok: false });
    const choice = { code: "C", valueType: "choice" as const, decimals: null, choices: ["Manfiy", "Musbat"], unit: null };
    expect(readValue("manfiy", choice)).toEqual({ ok: true, value: { numeric: null, text: "Manfiy", boolean: null } });
    expect(readValue("Boshqa", choice)).toEqual({ ok: false });
    const bool = { code: "B", valueType: "boolean" as const, decimals: null, choices: null, unit: null };
    expect(readValue("Ha", bool)).toEqual({ ok: true, value: { numeric: null, text: null, boolean: true } });
    expect(readValue("+", bool)).toEqual({ ok: false });
  });
});

const P = (over: Partial<CandidatePatient> & { id: string }): CandidatePatient => ({
  pinfl: null,
  documentNumber: null,
  phoneKey: null,
  dateOfBirth: null,
  name: null,
  sex: null,
  ...over,
});

describe("patient matching", () => {
  const ali = P({ id: "p-ali", pinfl: "30101900123456", documentNumber: "AA1234567", phoneKey: "901234567", dateOfBirth: "1990-01-30", name: "ali karimov", sex: "male" });
  const vali = P({ id: "p-vali", phoneKey: "901234567", dateOfBirth: "1990-01-30", name: "vali karimov" });
  const twinA = P({ id: "p-a", dateOfBirth: "2000-05-05", name: "aziz rahimov", phoneKey: "935555555" });
  const twinB = P({ id: "p-b", dateOfBirth: "2000-05-05", name: "aziz rahimov", phoneKey: "935555555" });
  const all = [ali, vali, twinA, twinB];

  it("matches exactly by a strong identifier, with name/phone differences as warnings", () => {
    expect(matchPatient({ pinfl: "30101900123456" }, all)).toEqual({ kind: "exact", patientId: "p-ali", via: "pinfl", warnings: [] });
    expect(matchPatient({ documentNumber: "AA1234567", name: "ali karim", phoneKey: "999999999" }, all)).toEqual({
      kind: "exact",
      patientId: "p-ali",
      via: "document_number",
      warnings: ["name_differs", "phone_differs"],
    });
    expect(matchPatient({ patientId: "p-vali" }, all)).toMatchObject({ kind: "exact", patientId: "p-vali", via: "patient_id" });
  });

  it("refuses contradictions and unknown ids", () => {
    expect(matchPatient({ pinfl: "30101900123456", dateOfBirth: "1991-01-30" }, all)).toEqual({ kind: "conflict", reason: "dob_differs", candidates: ["p-ali"] });
    expect(matchPatient({ pinfl: "30101900123456", sex: "female" }, all)).toMatchObject({ kind: "conflict", reason: "sex_differs" });
    expect(matchPatient({ patientId: "p-vali", pinfl: "30101900123456" }, all)).toMatchObject({ kind: "conflict", reason: "identifiers_disagree" });
    expect(matchPatient({ patientId: "nobody" }, all)).toEqual({ kind: "conflict", reason: "patient_id_unknown", candidates: [] });
  });

  it("only suggests a patient on weak identifiers, and reports possible duplicate patients", () => {
    expect(matchPatient({ phoneKey: "901234567", dateOfBirth: "1990-01-30", name: "vali karimov" }, all)).toEqual({
      kind: "possible",
      candidates: ["p-vali"],
      via: "phone_dob",
      warnings: [],
    });
    expect(matchPatient({ name: "aziz rahimov", dateOfBirth: "2000-05-05" }, all)).toEqual({ kind: "conflict", reason: "several_patients", candidates: ["p-a", "p-b"] });
    // A PINFL nobody has: a patient with a different PINFL is not a candidate.
    expect(matchPatient({ pinfl: "99999999999999", phoneKey: "901234567", dateOfBirth: "1990-01-30", name: "ali karimov" }, all)).toMatchObject({
      kind: "possible",
      candidates: ["p-vali"],
    });
  });

  it("never matches by name alone", () => {
    expect(matchPatient({ name: "ali karimov" }, all)).toEqual({ kind: "unmatched", reason: "insufficient_identifiers" });
    expect(matchPatient({ pinfl: "11111111111111" }, all)).toEqual({ kind: "unmatched", reason: "no_candidate" });
  });
});

describe("analysis", () => {
  const catalog: CatalogTest[] = [
    {
      id: "t-cbc",
      code: "CBC",
      name: "Umumiy qon tahlili",
      parameters: [
        { id: "x-hgb", code: "HGB", name: "Gemoglobin", valueType: "numeric", decimals: 1, choices: null, unit: "g/L" },
        { id: "x-wbc", code: "WBC", name: "Leykotsitlar", valueType: "numeric", decimals: 1, choices: null, unit: "10^9/L" },
      ],
    },
    { id: "t-glu", code: "GLU", name: "Glyukoza", parameters: [{ id: "x-glu", code: "GLU", name: "Glyukoza", valueType: "numeric", decimals: 1, choices: null, unit: "mmol/L" }] },
  ];
  const patients = [
    P({ id: "p1", pinfl: "30101900123456", dateOfBirth: "1990-01-30", name: "ali karimov" }),
    P({ id: "p2", pinfl: "30101900654321", dateOfBirth: "1985-06-01", phoneKey: "901112233", name: "nodira saidova" }),
  ];
  const headers = ["PINFL", "Phone", "DOB", "Name", "Test", "Parameter", "Value", "Unit", "Date"];
  const mapping = { pinfl: 0, phone: 1, date_of_birth: 2, full_name: 3, test_code: 4, parameter_code: 5, value: 6, unit: 7, performed_at: 8 };
  const now = new Date("2026-10-06T06:00:00Z");
  const run = (lines: string[][], existing: ExistingResult[] = [], confirmations = new Map()) =>
    analyseRows(readRows(lines.map((cells, i) => ({ rowNumber: i + 1, cells })), headers.length, mapping, catalog, TZ, now), {
      patients,
      confirmations,
      existing,
      timezone: TZ,
    });

  it("makes a ready, grouped result from valid rows", () => {
    const rows = run([
      ["30101900123456", "", "30.01.1990", "Ali Karimov", "CBC", "HGB", "135", "g/L", "01.09.2026"],
      ["30101900123456", "", "30.01.1990", "Ali Karimov", "cbc", "Leykotsitlar", "6,2", "10^9/l", "01.09.2026"],
      ["30101900123456", "", "", "", "GLU", "", "5.4", "", "2026-09-02"],
    ]);
    expect(rows.map((r) => [r.status, r.errors])).toEqual([["ready", []], ["ready", []], ["ready", []]]);
    expect(rows[0].groupKey).toBe(rows[1].groupKey);
    expect(rows[2].groupKey).not.toBe(rows[0].groupKey);
    expect(rows[0]).toMatchObject({ patientId: "p1", matchKind: "pinfl", testId: "t-cbc", parameterId: "x-hgb", performedAt: "2026-09-01T07:00:00.000Z" });
    expect(summarise(rows)).toEqual({ rows: 3, byStatus: { ready: 3 }, readyResults: 2, readyPatients: 1 });
  });

  it("reports malformed and invalid rows, and keeps a result whole", () => {
    const rows = run([
      ["30101900123456", "", "", "", "CBC", "HGB", "135", "g/L", "01.09.2026"],
      ["30101900123456", "", "", "", "CBC", "WBC", "lots", "", "01.09.2026"], // bad value: the whole CBC result waits
      ["30101900123456", "", "", "", "XYZ", "", "1", "", "01.09.2026"],
      ["30101900123456", "", "", "", "GLU", "", "5.4", "mg/dL", "01.09.2026"],
      ["30101900123456", "", "", "", "GLU", "", "5.4", "", "01.09.2099"],
      ["30101900123456", "", ""],
      ["123", "", "", "", "GLU", "", "5.4", "", "01.09.2026"],
      ["", "", "", "Ali Karimov", "GLU", "", "5.4", "", "01.09.2026"],
      ["30101900123456", "", "", "", "CBC", "", "1", "", "02.09.2026"],
      ["30101900123456", "", "", "", "GLU", "", "5.4", "", "01.01.1980"],
    ]);
    expect(rows.map((r) => [r.status, r.errors])).toEqual([
      ["invalid", ["group_has_errors"]],
      ["invalid", ["invalid_value"]],
      ["invalid", ["unknown_test"]],
      ["invalid", ["unit_mismatch"]],
      ["invalid", ["future_date"]],
      ["invalid", ["malformed_row"]],
      ["invalid", ["invalid_pinfl"]],
      ["invalid", ["no_identifiers"]], // a name alone never identifies anyone
      ["invalid", ["missing_parameter"]],
      ["invalid", ["performed_before_birth"]],
    ]);
  });

  it("detects duplicates and conflicts in the file", () => {
    const rows = run([
      ["30101900123456", "", "", "", "GLU", "", "5.4", "", "01.09.2026"],
      ["30101900123456", "", "", "", "GLU", "", "5.40", "", "01.09.2026"],
      ["30101900654321", "", "", "", "GLU", "", "5.4", "", "01.09.2026"],
      ["30101900654321", "", "", "", "GLU", "", "6.1", "", "01.09.2026"],
      ["30101900123456", "", "", "", "CBC", "HGB", "130", "", "03.09.2026 08:00"],
      ["30101900123456", "", "", "", "CBC", "HGB", "131", "", "03.09.2026 15:00"],
    ]);
    expect(rows.map((r) => [r.status, r.errors])).toEqual([
      ["ready", []],
      ["duplicate", ["duplicate_in_file"]],
      ["conflict", ["conflicting_in_file"]],
      ["conflict", ["conflicting_in_file"]],
      ["conflict", ["several_results_same_day"]],
      ["conflict", ["several_results_same_day"]],
    ]);
    expect(rows[1].groupKey).toBeNull();
  });

  it("never imports over the clinic's existing results", () => {
    const existing: ExistingResult[] = [
      { patientId: "p1", testId: "t-glu", at: "2026-09-01T04:00:00Z", values: new Map([["x-glu", { numeric: "5.4", text: null, boolean: null }]]) },
      { patientId: "p2", testId: "t-glu", at: "2026-09-01T10:00:00Z", values: new Map([["x-glu", { numeric: "7", text: null, boolean: null }]]) },
    ];
    const rows = run(
      [
        ["30101900123456", "", "", "", "GLU", "", "5.4", "", "01.09.2026"],
        ["30101900654321", "", "", "", "GLU", "", "5.4", "", "01.09.2026"],
        ["30101900654321", "", "", "", "GLU", "", "5.4", "", "02.09.2026"],
      ],
      existing,
    );
    expect(rows.map((r) => [r.status, r.errors])).toEqual([
      ["duplicate", ["existing_result"]],
      ["conflict", ["existing_result_differs"]],
      ["ready", []],
    ]);
  });

  it("waits for a staff member to confirm a weak match, then imports it", () => {
    const line = ["", "+998 90 111 22 33", "01.06.1985", "Saidova Nodira", "GLU", "", "5.4", "", "01.09.2026"];
    const before = run([line]);
    expect(before[0]).toMatchObject({ status: "possible_match", errors: ["confirm_patient"], candidatePatientIds: ["p2"], patientId: null, groupKey: null });
    const after = run([line], [], new Map([[before[0].patientKey, { patientId: "p2", by: "staff-1" }]]));
    expect(after[0]).toMatchObject({ status: "ready", patientId: "p2", matchKind: "staff_confirmed", matchConfirmedBy: "staff-1" });
    // A confirmation naming a patient that was not suggested is ignored.
    const wrong = run([line], [], new Map([[before[0].patientKey, { patientId: "p1", by: "staff-1" }]]));
    expect(wrong[0].status).toBe("possible_match");
  });
});

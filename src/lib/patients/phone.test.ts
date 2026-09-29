import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";
import { normalizePhone } from "./phone";

/**
 * One phone number, however it is typed: normalizePhone() (the server's
 * lookups) and public.normalize_phone() (the generated
 * patients.phone_normalized column) must agree on every input, or reception
 * would miss a returning patient — or match the wrong one.
 */

const CASES: Array<[label: string, input: string | null, expected: string | null]> = [
  ["international, spaced", "+998 90 123 45 67", "998901234567"],
  ["international, dashed", "+998-90-123-45-67", "998901234567"],
  ["international, parentheses", "+998 (90) 123-45-67", "998901234567"],
  ["12 digits with 998, no plus", "998901234567", "998901234567"],
  ["9-digit local number", "901234567", "998901234567"],
  ["9-digit local, spaced", "90 123 45 67", "998901234567"],
  ["9-digit local, parentheses and dashes", "(90) 123-45-67", "998901234567"],
  ["leading and trailing spaces", "  +998 90 123 45 67  ", "998901234567"],
  ["10 digits: no country code is guessed", "0901234567", "0901234567"],
  ["8 digits: kept as typed", "12345678", "12345678"],
  ["another country's number", "+1 (415) 555-2671", "14155552671"],
  ["very long input: digits only, nothing added", `+${"9".repeat(40)} ext. 12`, `${"9".repeat(40)}12`],
  ["letters around digits", "tel: 90-123-45-67 (uy)", "998901234567"],
  ["full-width digits are not ASCII digits", "９０１２３４５６７", null],
  ["empty", "", null],
  ["only spaces", "   ", null],
  ["punctuation only", "+ ( ) -", null],
  ["no digits", "abc", null],
  ["null", null, null],
];

describe("normalizePhone", () => {
  it.each(CASES)("%s: %j → %j", (_label, input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it("undefined → null", () => {
    expect(normalizePhone(undefined)).toBeNull();
  });

  it("the same number typed four ways is one number", () => {
    const typed = ["+998 90 123 45 67", "998901234567", "90 123 45 67", "+998 (90) 123-45-67"].map(normalizePhone);
    expect(new Set(typed)).toEqual(new Set(["998901234567"]));
  });
});

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

describe.skipIf(!localDbAvailable())("public.normalize_phone() and patients.phone_normalized — local database", () => {
  let admin: SupabaseClient;
  let clinic: string;
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { data, error } = await admin
      .from("clinics")
      .insert({ name: `Phone ${suffix}`, slug: `phone-${suffix}`, timezone: "Asia/Tashkent" })
      .select("id")
      .single();
    expect(error).toBeNull();
    clinic = data!.id;
  });

  afterAll(async () => {
    if (!admin || !clinic) return;
    const patients = await admin.from("patients").delete().eq("clinic_id", clinic);
    expect(patients.error).toBeNull();
    const clinics = await admin.from("clinics").delete().eq("id", clinic);
    expect(clinics.error).toBeNull();
  });

  it.each(CASES)("parity — %s: the database agrees with normalizePhone()", async (_label, input, expected) => {
    const { data, error } = await admin.rpc("normalize_phone", { p_phone: input });
    expect(error).toBeNull();
    expect(data).toBe(expected);
  });

  it("phone_normalized is generated from phone on insert and on update", async () => {
    const { data: created, error } = await admin
      .from("patients")
      .insert({ clinic_id: clinic, full_name: `Telefon Bemor ${suffix}`, phone: "+998 (90) 123-45-67" })
      .select("id, phone, phone_normalized")
      .single();
    expect(error).toBeNull();
    expect(created).toMatchObject({ phone: "+998 (90) 123-45-67", phone_normalized: "998901234567" });

    const { data: changed } = await admin.from("patients").update({ phone: "93 765 43 21" }).eq("id", created!.id).select("phone_normalized").single();
    expect(changed!.phone_normalized).toBe("998937654321");
    const { data: cleared } = await admin.from("patients").update({ phone: null }).eq("id", created!.id).select("phone_normalized").single();
    expect(cleared!.phone_normalized).toBeNull();
  });

  it("phone_normalized cannot be written directly — not even by the service role", async () => {
    const inserted = await admin
      .from("patients")
      .insert({ clinic_id: clinic, full_name: `Soxta Raqam ${suffix}`, phone: "+998901112233", phone_normalized: "998000000000" })
      .select("id");
    expect(inserted.error?.code).toBe("428C9");
    expect(inserted.data).toBeNull();

    const { data: real } = await admin
      .from("patients")
      .insert({ clinic_id: clinic, full_name: `Haqiqiy Raqam ${suffix}`, phone: "+998901112233" })
      .select("id")
      .single();
    const updated = await admin.from("patients").update({ phone_normalized: "998000000000" }).eq("id", real!.id).select("id");
    expect(updated.error?.code).toBe("428C9");
    const { data: row } = await admin.from("patients").select("phone_normalized").eq("id", real!.id).single();
    expect(row!.phone_normalized).toBe("998901112233");
    const { count } = await admin.from("patients").select("id", { count: "exact", head: true }).eq("clinic_id", clinic).eq("phone_normalized", "998000000000");
    expect(count).toBe(0);
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";
import { finishOneId, parseOneIdPerson, startOneId } from "@/lib/identity/oneid";

const URL_ = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

// What OneID returns for a person (field names from the OneID identify response). Illustrative values.
const person = (over: Record<string, unknown> = {}) => ({
  valid: true,
  pin: "31403870120015",
  pport_no: "AD1234567",
  sur_name: "KARIMOV",
  first_name: "ALISHER",
  mid_name: "BAXTIYOROVICH",
  birth_date: "1987-03-14",
  gd: "1",
  per_adr: "Toshkent sh., Chilonzor t., 9-kv",
  ...over,
});

describe("parseOneIdPerson", () => {
  it("keeps only what goes onto a card, in the card's shape", () => {
    expect(parseOneIdPerson(person())).toEqual({
      pinfl: "31403870120015",
      document: "AD1234567",
      dateOfBirth: "1987-03-14",
      sex: "male",
      fullName: "Karimov Alisher Baxtiyorovich",
      address: "Toshkent sh., Chilonzor t., 9-kv",
    });
    expect(parseOneIdPerson(person({ birth_date: "14.03.1987", gd: "" }))).toMatchObject({ dateOfBirth: "1987-03-14", sex: "male" });
  });

  it("uses nothing OneID does not vouch for: unverified profile, a JSHSHIR that does not carry the date of birth, no name", () => {
    expect(parseOneIdPerson(person({ valid: false }))).toBeNull();
    expect(parseOneIdPerson(person({ birth_date: "1988-03-14" }))).toBeNull();
    expect(parseOneIdPerson(person({ sur_name: "", first_name: "", mid_name: "", full_name: "" }))).toBeNull();
    expect(parseOneIdPerson(person({ pport_no: "123" }))).toMatchObject({ document: null });
  });
});

describe.skipIf(!localDbAvailable())("OneID sign-in end to end (real database, OneID stubbed)", () => {
  let admin: SupabaseClient;
  const clinic = randomUUID();
  const seed = Date.now() % 1_000_000;
  const env = { ...process.env };

  beforeAll(async () => {
    admin = createClient(URL_, SERVICE_KEY, { auth: { persistSession: false } });
    await admin.from("clinics").insert({ id: clinic, name: `OneID ${seed}`, slug: `oneid-${seed}` });
    process.env.ONEID_CLIENT_ID = "health_ai";
    process.env.ONEID_CLIENT_SECRET = "test-secret";
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.test";
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    process.env = env;
    if (admin) await admin.from("clinics").delete().eq("id", clinic);
  });

  const realFetch = globalThis.fetch;
  /** OneID's server: the code exchange, then the identify call with the given person. Everything else (the database) is real. */
  const stubOneId = (identity: Record<string, unknown>) => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (!String(url).startsWith("https://sso.egov.uz/")) return realFetch(url, init);
        const params = new URLSearchParams(String(init?.body));
        calls.push(params.get("grant_type") ?? "");
        if (params.get("grant_type") === "one_authorization_code") return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
        return new Response(JSON.stringify(identity), { status: 200 });
      }),
    );
    return calls;
  };
  const telegramPatient = async (tg: number) => {
    const { data } = await admin.from("patients").insert({ clinic_id: clinic, telegram_user_id: tg, telegram_first_name: "Tg" }).select("id").single();
    return data!.id as string;
  };
  const begin = async (tg: number) => {
    const { url } = await startOneId(clinic, { id: "", telegram_user_id: tg });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://sso.egov.uz/sso/oauth/Authorization.do");
    expect(u.searchParams.get("response_type")).toBe("one_code");
    expect(u.searchParams.get("redirect_uri")).toBe("https://app.example.test/api/oneid/callback");
    return u.searchParams.get("state")!;
  };

  it("a patient with no card gets the state's details on their own record, once", async () => {
    const tg = 900_000_000 + seed;
    const own = await telegramPatient(tg);
    const state = await begin(tg);
    const calls = stubOneId(person({ pin: `3140387${String(seed).padStart(7, "0")}` }));

    expect(await finishOneId("code-1", state)).toBe("verified");
    expect(calls).toEqual(["one_authorization_code", "one_access_token_identify"]);
    const { data } = await admin.from("patients").select("full_name, pinfl, document_number, date_of_birth, sex, identity_verified_by").eq("id", own).single();
    expect(data).toEqual({
      full_name: "Karimov Alisher Baxtiyorovich",
      pinfl: `3140387${String(seed).padStart(7, "0")}`,
      document_number: "AD1234567",
      date_of_birth: "1987-03-14",
      sex: "male",
      identity_verified_by: "oneid",
    });
    // The state is single use.
    expect(await finishOneId("code-1", state)).toBe("expired");
    // The audit row carries the outcome, never the values.
    const { data: audit } = await admin.from("audit_events").select("metadata").eq("patient_id", own).eq("action", "patient_identity_verified");
    expect(audit).toEqual([{ metadata: { method: "oneid", outcome: "verified" } }]);
  });

  it("a returning patient's existing card (same JSHSHIR) is linked to their Telegram", async () => {
    const pinfl = `5051201${String(seed + 1).padStart(7, "0")}`;
    const { data: card } = await admin
      .from("patients")
      .insert({ clinic_id: clinic, full_name: "Card at reception", pinfl, date_of_birth: "2001-12-05", phone: "+998901112233" })
      .select("id")
      .single();
    const tg = 910_000_000 + seed;
    await telegramPatient(tg);
    const state = await begin(tg);
    stubOneId(person({ pin: pinfl, birth_date: "2001-12-05", pport_no: "AA7654321", sur_name: "YUSUPOVA", first_name: "MALIKA", mid_name: "", gd: "2" }));

    expect(await finishOneId("code-2", state)).toBe("linked");
    const { data } = await admin.from("patients").select("telegram_user_id, telegram_link_method, full_name, sex, identity_verified_by").eq("id", card!.id).single();
    expect(data).toEqual({ telegram_user_id: tg, telegram_link_method: "oneid", full_name: "Yusupova Malika", sex: "female", identity_verified_by: "oneid" });
  });

  it("an unverified OneID profile, a failed exchange or a forged state change nothing", async () => {
    const tg = 920_000_000 + seed;
    const own = await telegramPatient(tg);
    stubOneId(person({ valid: false }));
    expect(await finishOneId("code-3", await begin(tg))).toBe("invalid");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
        String(url).startsWith("https://sso.egov.uz/") ? new Response("bad", { status: 500 }) : realFetch(url, init),
      ),
    );
    expect(await finishOneId("code-4", await begin(tg))).toBe("failed");
    expect(await finishOneId("code-5", "forged-state")).toBe("expired");
    const { data } = await admin.from("patients").select("pinfl, identity_verified_at").eq("id", own).single();
    expect(data).toEqual({ pinfl: null, identity_verified_at: null });
  });
});

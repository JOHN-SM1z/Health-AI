import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { localDbAvailable } from "@/test/local-db";

/**
 * Patient identity privacy at the DATABASE layer (20261008000005, owner decision 2026-10-08): no employee reads a
 * patient's passport/ID number, JSHSHIR, date of birth, sex or home address with their own login — not through
 * PostgREST, not through GraphQL (both run as `authenticated` with the user's JWT, which is what these tests do), not
 * by filtering on them. Staff keep the name and phone. The values stay in the database for the server.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const describeDb = describe.skipIf(!localDbAvailable());

type Tx = postgres.TransactionSql;
const IDENTITY_COLUMNS = ["document_number", "pinfl", "date_of_birth", "sex", "home_address"] as const;
/** Exactly what a signed-in screen reads today (admin home, appointments, calendar, conversations, doctor home). */
const GRANTED = ["clinic_id", "full_name", "id", "merged_into_patient_id", "patient_number", "phone", "preferred_language", "telegram_first_name", "telegram_username"];

describeDb("patient identity privacy — database layer", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const staff = {
    owner: randomUUID(), admin: randomUUID(), manager: randomUUID(), reception: randomUUID(), cashier: randomUUID(),
    lab: randomUUID(), doctor: randomUUID(), otherDoctor: randomUUID(), ownerB: randomUUID(),
  };
  const roles: Record<keyof typeof staff, string> = {
    owner: "owner", admin: "admin", manager: "manager", reception: "receptionist", cashier: "cashier",
    lab: "lab", doctor: "doctor", otherDoctor: "doctor", ownerB: "owner",
  };
  const doctorIds = { doctor: randomUUID(), otherDoctor: randomUUID() };
  const service = randomUUID();
  const patient = randomUUID();
  const ID = { document: `ZQ${String(Date.now()).slice(-7)}`, pinfl: `3${String(Date.now()).slice(-13).padStart(13, "7")}`, dob: "1977-11-23", address: `Marker ko‘chasi ${suffix}` };

  async function asUser<T>(sub: string | null, run: (tx: Tx) => Promise<T>): Promise<T> {
    return (await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${sub ? "authenticated" : "anon"}`);
      await tx`select set_config('request.jwt.claims', ${JSON.stringify(sub ? { sub, role: "authenticated" } : { role: "anon" })}, true)`;
      return run(tx);
    })) as T;
  }
  async function refusal(run: () => Promise<unknown>): Promise<string> {
    try {
      await run();
    } catch (e) {
      if (e instanceof postgres.PostgresError) return e.code;
      throw e;
    }
    return "allowed";
  }

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 6, onnotice: () => {} });
    await sql`insert into public.clinics ${sql([
      { id: clinicA, name: `Privacy A ${suffix}`, slug: `privacy-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Privacy B ${suffix}`, slug: `privacy-b-${suffix}`, timezone: "Asia/Tashkent" },
    ])}`;
    const users = Object.entries(staff).map(([name, id]) => ({ id, email: `privacy-${name}-${suffix}@test.local` }));
    await sql`insert into auth.users ${sql(users)}`;
    await sql`insert into public.profiles ${sql(users.map((u) => ({ id: u.id, full_name: u.email })))}`;
    await sql`insert into public.staff_roles ${sql(
      (Object.keys(staff) as Array<keyof typeof staff>).map((k) => ({ clinic_id: k === "ownerB" ? clinicB : clinicA, profile_id: staff[k], role: roles[k] })),
    )}`;
    await sql`insert into public.doctors ${sql([
      { id: doctorIds.doctor, clinic_id: clinicA, profile_id: staff.doctor, name: `Dr P ${suffix}`, active: true },
      { id: doctorIds.otherDoctor, clinic_id: clinicA, profile_id: staff.otherDoctor, name: `Dr Q ${suffix}`, active: true },
    ])}`;
    await sql`insert into public.services ${sql({ id: service, clinic_id: clinicA, name: `Privacy consult ${suffix}`, duration_minutes: 30, price: 1 })}`;
    await sql`insert into public.doctor_working_hours ${sql([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinicA, doctor_id: doctorIds.doctor, weekday, start_time: "00:00", end_time: "23:59" })))}`;
    await sql`insert into public.patients ${sql({
      id: patient, clinic_id: clinicA, full_name: `Maxfiy Bemor ${suffix}`, phone: "+998 90 555 44 33",
      document_number: ID.document, pinfl: ID.pinfl, date_of_birth: ID.dob, sex: "female", home_address: ID.address,
    })}`;
    // The doctor has a treating relationship (a completed visit), so the row is visible to them by policy.
    const start = new Date(Date.UTC(2024, 0, 3, 5, 0));
    await sql`insert into public.appointments ${sql({
      clinic_id: clinicA, patient_id: patient, doctor_id: doctorIds.doctor, service_id: service, start_at: start,
      end_at: new Date(start.getTime() + 1_800_000), status: "completed", source: "walk_in",
    })}`;
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from public.clinics where id in ${sql([clinicA, clinicB])}`;
    await sql`delete from auth.users where id in ${sql(Object.values(staff))}`;
    await sql.end({ timeout: 5 });
  });

  it("signed-in roles hold SELECT on exactly the screen columns of patients — no identity column, now or when one is added", async () => {
    const granted = await sql<{ column_name: string }[]>`
      select column_name from information_schema.column_privileges
       where table_schema = 'public' and table_name = 'patients' and grantee = 'authenticated' and privilege_type = 'SELECT'
       order by column_name`;
    expect(granted.map((g) => g.column_name)).toEqual(GRANTED);
    const [{ wide }] = await sql<{ wide: boolean }[]>`select has_table_privilege('authenticated', 'public.patients', 'SELECT') as wide`;
    expect(wide).toBe(false); // no table-wide grant: a future column is invisible until granted on purpose
    // No other public table or view hands an identity column to a signed-in role either.
    const elsewhere = await sql<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.column_privileges
       where table_schema = 'public' and grantee in ('authenticated', 'anon') and privilege_type = 'SELECT'
         and column_name in ('document_number', 'pinfl', 'date_of_birth', 'home_address')`;
    expect(elsewhere).toEqual([]);
    // Copies of identity values (merge history, raw import rows, online lookups, verified phones, identity claims) stay
    // server-only, and the online-identity functions are the server's alone.
    for (const fn of ["online_identity_lookup", "link_card_to_telegram", "complete_online_patient", "record_telegram_verified_phone", "normalize_uz_phone"]) {
      const [{ can }] = await sql<{ can: boolean }[]>`
        select bool_or(has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('anon', p.oid, 'EXECUTE')) as can
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = ${fn}`;
      expect(can, fn).toBe(false);
    }
    for (const table of ["patient_merges", "lab_import_rows", "online_identity_lookups", "telegram_verified_phones", "patient_identity_claims"]) {
      const [{ can }] = await sql<{ can: boolean }[]>`select has_table_privilege('authenticated', ${`public.${table}`}, 'SELECT') as can`;
      expect(can, table).toBe(false);
    }
  });

  it("every staff role is refused the identity columns — by select, by star, and by filtering on them", async () => {
    for (const who of ["owner", "admin", "manager", "reception", "cashier", "lab", "doctor", "otherDoctor", "ownerB"] as const) {
      for (const column of IDENTITY_COLUMNS) {
        expect(await refusal(() => asUser(staff[who], (tx) => tx.unsafe(`select ${column} from public.patients`))), `${who}: ${column}`).toBe("42501");
      }
      expect(await refusal(() => asUser(staff[who], (tx) => tx`select * from public.patients`)), `${who}: *`).toBe("42501");
      // Probing ("does a card with this passport exist?") is refused too: a WHERE on the column needs the privilege.
      expect(await refusal(() => asUser(staff[who], (tx) => tx`select id from public.patients where document_number = ${ID.document}`)), `${who}: where`).toBe("42501");
      expect(await refusal(() => asUser(staff[who], (tx) => tx`select id from public.patients where pinfl = ${ID.pinfl}`)), `${who}: where pinfl`).toBe("42501");
      expect(await refusal(() => asUser(staff[who], (tx) => tx`select id from public.patients order by date_of_birth`)), `${who}: order by`).toBe("42501");
    }
    expect(await refusal(() => asUser(null, (tx) => tx`select full_name from public.patients`))).toBe("42501"); // anonymous: nothing at all
  });

  it("name and phone stay readable where the row policies already allow it — the screens keep working", async () => {
    const visible = async (who: keyof typeof staff) =>
      asUser(staff[who], (tx) => tx<{ id: string; full_name: string; phone: string }[]>`
        select id, clinic_id, patient_number, full_name, phone, telegram_username, telegram_first_name, preferred_language, merged_into_patient_id
          from public.patients where id = ${patient}`);
    for (const who of ["owner", "admin", "manager", "reception", "doctor"] as const) {
      const rows = await visible(who);
      expect(rows, who).toHaveLength(1);
      expect(rows[0]).toMatchObject({ full_name: `Maxfiy Bemor ${suffix}`, phone: "+998 90 555 44 33" });
    }
    // Row policies are unchanged: a doctor without a relationship, the cashier, the lab and another clinic see no row.
    for (const who of ["otherDoctor", "cashier", "lab", "ownerB"] as const) expect(await visible(who), who).toHaveLength(0);
    // The embeds the admin screens use (appointments → patients(full_name, phone)) still resolve.
    const joined = await asUser(staff.reception, (tx) => tx`
      select a.id, p.full_name, p.phone from public.appointments a join public.patients p on p.id = a.patient_id where a.patient_id = ${patient}`);
    expect(joined).toHaveLength(1);
  });

  it("the values are still in our database for the server", async () => {
    const [row] = await sql`select document_number, pinfl, date_of_birth::text as dob, sex, home_address from public.patients where id = ${patient}`;
    expect(row).toEqual({ document_number: ID.document, pinfl: ID.pinfl, dob: ID.dob, sex: "female", home_address: ID.address });
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { cleanupTestClinics } from "@/test/cleanup-clinics";
import { localDbAvailable } from "@/test/local-db";

/**
 * Creating a patient is audited in the same transaction
 * (supabase/migrations/20261002000002_patient_creation_audit.sql): whatever
 * path inserts the row, 'patient_created' is written with the creator and the
 * channel — identifiers only — and a creator from another clinic is refused.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const describeDb = describe.skipIf(!localDbAvailable());

describeDb("patient creation audit — database layer", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const staffA = randomUUID();
  const staffB = randomUUID();

  const auditOf = (patient: string) =>
    sql<{ actor_id: string | null; actor_type: string; clinic_id: string; patient_id: string; new_values: unknown; metadata: Record<string, unknown> }[]>`
      select actor_id, actor_type, clinic_id, patient_id, new_values, metadata
        from public.audit_events where action = 'patient_created' and entity_id = ${patient}`;

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 2, onnotice: () => {} });
    await sql`insert into public.clinics ${sql([
      { id: clinicA, name: `Creation Audit A ${suffix}`, slug: `creation-audit-a-${suffix}` },
      { id: clinicB, name: `Creation Audit B ${suffix}`, slug: `creation-audit-b-${suffix}` },
    ])}`;
    const users = [staffA, staffB].map((id, i) => ({ id, email: `creation-audit-${i}-${suffix}@test.local` }));
    await sql`insert into auth.users ${sql(users)}`;
    await sql`insert into public.profiles ${sql(users.map((u) => ({ id: u.id, full_name: u.email })))}`;
    await sql`insert into public.staff_roles ${sql([
      { clinic_id: clinicA, profile_id: staffA, role: "receptionist" },
      { clinic_id: clinicB, profile_id: staffB, role: "receptionist" },
    ])}`;
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanupTestClinics([clinicA, clinicB]);
    await sql`delete from auth.users where id in ${sql([staffA, staffB])}`;
    await sql.end({ timeout: 5 });
  });

  it("a staff-registered patient is audited with the staff actor and channel — and no personal data", async () => {
    const [{ id }] = await sql<{ id: string }[]>`
      insert into public.patients (clinic_id, full_name, phone, created_by, created_via)
      values (${clinicA}, ${`Audit Name ${suffix}`}, '+998901112233', ${staffA}, 'reception') returning id`;
    const rows = await auditOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: staffA,
      actor_type: "staff",
      clinic_id: clinicA,
      patient_id: id,
      new_values: { created_via: "reception" },
      metadata: { created_via: "reception", has_phone: true, has_telegram_identity: false },
    });
    expect(JSON.stringify(rows)).not.toMatch(/Audit Name|901112233/);
  });

  it("any other insert path is audited too: a Telegram patient, a website visitor, a row with no provenance", async () => {
    const [tg] = await sql<{ id: string }[]>`
      insert into public.patients (clinic_id, telegram_user_id, created_via) values (${clinicA}, ${Date.now()}, 'telegram') returning id`;
    const [web] = await sql<{ id: string }[]>`
      insert into public.patients (clinic_id, full_name, phone, created_via) values (${clinicA}, 'Visitor', '+998901112244', 'website') returning id`;
    const [bare] = await sql<{ id: string }[]>`insert into public.patients (clinic_id, full_name) values (${clinicA}, 'Bare') returning id`;
    expect((await auditOf(tg.id))[0]).toMatchObject({ actor_id: null, actor_type: "telegram", metadata: { created_via: "telegram", has_phone: false, has_telegram_identity: true } });
    expect((await auditOf(web.id))[0]).toMatchObject({ actor_id: null, actor_type: "system", metadata: { created_via: "website", has_phone: true } });
    expect((await auditOf(bare.id))[0]).toMatchObject({ actor_id: null, actor_type: "system", metadata: { created_via: null } });
  });

  it("a creator who is not staff of the patient's clinic is refused, and nothing is created", async () => {
    const id = randomUUID();
    await expect(
      sql`insert into public.patients (id, clinic_id, full_name, created_by, created_via) values (${id}, ${clinicA}, 'Foreign', ${staffB}, 'reception')`,
    ).rejects.toThrow(/not staff of the patient's clinic/);
    expect(await sql`select 1 from public.patients where id = ${id}`).toHaveLength(0);
    expect(await auditOf(id)).toHaveLength(0);
  });

  it("an unknown channel is refused", async () => {
    await expect(
      sql`insert into public.patients (clinic_id, full_name, created_via) values (${clinicA}, 'X', 'carrier_pigeon')`,
    ).rejects.toThrow(/patients_created_via_check/);
  });
});

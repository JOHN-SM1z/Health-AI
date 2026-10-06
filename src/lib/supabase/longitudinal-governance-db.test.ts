import { FIXTURE_RETENTION_TABLES } from "@/test/cleanup-clinics";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Actual PostgreSQL constraints, triggers, grants and RLS. Supabase's auth and
 * storage schemas are minimal stand-ins; this does not test PostgREST or Auth. */
describe("longitudinal care and governance — embedded PostgreSQL", () => {
  let db: PGlite;
  const clinic = randomUUID(), otherClinic = randomUUID(), patient = randomUUID(), service = randomUUID();
  const a = randomUUID(), b = randomUUID(), c = randomUUID(), k = randomUUID(), e = randomUUID(), n = randomUUID();
  const pa = randomUUID(), pb = randomUUID(), pc = randomUUID(), pk = randomUUID(), pe = randomUUID(), pn = randomUUID();
  const visitA = randomUUID(), visitB = randomUUID();
  let v1: string, v2: string, v3: string, referral: string, extra: string;
  const q = (sql: string, values: unknown[] = []) => db.query<Record<string, unknown>>(sql, values);
  async function as(role: "service_role" | "authenticated", sub: string | null, sql: string, values: unknown[] = []) {
    return db.transaction(async (tx) => {
      await tx.exec(`set local role ${role}`);
      await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role, sub })]);
      return tx.query<Record<string, unknown>>(sql, values);
    });
  }
  const write = (author: string, profile: string, visit: string, text: string, corrects: string | null = null) =>
    as("service_role", null, `insert into public.clinical_records
      (clinic_id,patient_id,author_doctor_id,appointment_id,record_type,summary,created_by,corrects_record_id)
      values ($1,$2,$3,$4,'diagnosis',$5,$6,$7) returning id`, [clinic,patient,author,visit,text,profile,corrects]);
  const history = (id: string) => q("select id, version, status, summary, author_doctor_id from public.clinical_record_versions where root_record_id=$1 order by version", [id]);
  const access = async (doctor: string) => (await as("service_role",null,"select * from public.doctor_patient_access($1,$2)",[doctor,patient])).rows[0];
  const refer = async (receiver: string) => (await as("service_role",null, `insert into public.referrals
    (clinic_id,patient_id,referring_doctor_id,referred_to_doctor_id,originating_appointment_id,reason,created_by)
    values ($1,$2,$3,$4,$5,'Synthetic handoff',$6) returning id`, [clinic,patient,a,receiver,visitA,pa])).rows[0].id as string;
  const visit = async (doctor: string, status = "confirmed") => (await q(`insert into public.appointments
    (clinic_id,patient_id,doctor_id,service_id,start_at,end_at,status,source)
    values ($1,$2,$3,$4,now()+interval '1 day',now()+interval '1 day 30 minutes',$5,'walk_in') returning id`,[clinic,patient,doctor,service,status])).rows[0].id as string;
  // Test the real RLS policy as well as the service-only grants. Temporary grants
  // exist only in this isolated transaction and are removed even on a failed assertion.
  async function visible(profile: string) {
    return db.transaction(async (tx) => {
      await tx.exec("grant select on public.clinical_records to authenticated; set local role authenticated");
      try {
        await tx.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:"authenticated",sub:profile})]);
        return (await tx.query<{ id:string }>("select id from public.clinical_records order by id")).rows.map(r=>r.id);
      } finally {
        await tx.exec("reset role; revoke select on public.clinical_records from authenticated");
      }
    });
  }

  beforeAll(async () => {
    db = new PGlite({ extensions: { btree_gist, pgcrypto } });
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key, email text);
      create function auth.uid() returns uuid language sql as $$select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
      create function auth.role() returns text language sql as $$select nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role'$$;
      grant usage on schema auth to anon, authenticated, service_role;
      create schema storage; create table storage.buckets(id text primary key,name text,public boolean);
      create table storage.objects(id uuid primary key,bucket_id text,name text);
      alter table storage.objects enable row level security;
      create function storage.foldername(text) returns text[] language sql as $$select string_to_array($1,'/')$$;
    `);
    const directory = resolve("supabase/migrations");
    for (const file of readdirSync(directory).filter((f) => f.endsWith(".sql")).sort()) {
      await db.exec(readFileSync(resolve(directory, file), "utf8"));
    }
    await q("insert into public.clinics(id,name,slug) values ($1::uuid,'Test A',$1::uuid::text),($2::uuid,'Test B',$2::uuid::text)", [clinic, otherClinic]);
    for (const [id, profile, tenant] of [[a,pa,clinic],[b,pb,clinic],[c,pc,clinic],[k,pk,otherClinic],[e,pe,clinic],[n,pn,clinic]]) {
      await q("insert into auth.users(id) values ($1)", [profile]);
      await q("insert into public.profiles(id) values ($1)", [profile]);
      await q("insert into public.staff_roles(clinic_id,profile_id,role) values ($1,$2,'doctor')", [tenant,profile]);
      await q("insert into public.doctors(id,clinic_id,profile_id,name) values ($1,$2,$3,'Test doctor')", [id,tenant,profile]);
      await q("insert into public.doctor_working_hours(clinic_id,doctor_id,weekday,start_time,end_time) select $1,$2,n,'00:00','23:59' from generate_series(1,7) n", [tenant,id]);
    }
    await q("insert into public.patients(id,clinic_id,full_name) values ($1,$2,'Synthetic patient')", [patient,clinic]);
    await q("insert into public.services(id,clinic_id,name,duration_minutes,price) values ($1,$2,'Consultation',30,0)", [service,clinic]);
    for (const [id,doctor] of [[visitA,a],[visitB,e]]) {
      await q(`insert into public.appointments(id,clinic_id,patient_id,doctor_id,service_id,start_at,end_at,status,source)
        values ($1,$2,$3,$4,$5,'2026-01-05 10:00+00','2026-01-05 10:30+00','completed','walk_in')`, [id,clinic,patient,doctor,service]);
    }
  }, 30000);
  afterAll(async () => { await db?.close(); });


  it("A/H: same author and login append a version, leaving the original immutable", async () => {
    v1 = (await write(a,pa,visitA,"Original")).rows[0].id as string;
    v2 = (await write(a,pa,visitA,"Corrected",v1)).rows[0].id as string;
    extra = (await write(e,pe,visitB,"Another author's history")).rows[0].id as string;
    expect((await history(v1)).rows).toEqual([
      { id:v1, version:1, status:"superseded", summary:"Original", author_doctor_id:a },
      { id:v2, version:2, status:"current", summary:"Corrected", author_doctor_id:a },
    ]);
    await expect(as("service_role",null,"update public.clinical_records set summary='Tamper' where id=$1",[v1])).rejects.toThrow();
    await expect(as("service_role",null,"delete from public.clinical_records where id=$1",[v1])).rejects.toMatchObject({code:"42501"});
  });
  it("same clinic alone grants no clinical or patient access", async () => {
    expect(await access(b)).toMatchObject({own_patient:false,active_referral_ids:[],history_doctor_ids:[]});
    expect(await visible(pb)).toEqual([]);
    expect((await as("authenticated",pb,"select id from public.patients where id=$1",[patient])).rows).toEqual([]);
  });
  it("C: pending referral immediately opens full history, including a third author's records", async () => {
    referral = await refer(b);
    expect(await access(b)).toMatchObject({own_patient:false,active_referral_ids:[referral],history_doctor_ids:expect.arrayContaining([a,e])});
    expect(await visible(pb)).toEqual([v1,v2,extra].sort());
    expect((await as("authenticated",pb,"select id from public.patients where id=$1",[patient])).rows).toEqual([{id:patient}]);
    expect((await q("select status from public.referrals where id=$1",[referral])).rows[0].status).toBe("pending");
  });
  it("B/D/F: no foreign correction, spoofed login, direct clinical read/update/delete, or grant of the service RPC", async () => {
    await expect(write(e,pe,visitB,"Tamper",v2)).rejects.toMatchObject({code:"CRNOT"});
    await expect(write(a,pb,visitA,"Forged")).rejects.toThrow(/author/);
    for (const sql of ["select * from public.clinical_records", "select * from public.clinical_record_versions",
      "update public.clinical_records set summary='Tamper'", "delete from public.clinical_records",
      "select * from public.referrals", "delete from public.audit_events"]) {
      await expect(as("authenticated",pb,sql)).rejects.toMatchObject({code:"42501"});
    }
    await expect(as("authenticated",pb,"select * from public.doctor_patient_access($1,$2)",[a,patient])).rejects.toMatchObject({code:"42501"});
  });
  it("starting B's own consultation acknowledges and links a pending handoff atomically", async () => {
    const appointment = await visit(b);
    await as("service_role",null,"update public.referrals set follow_up_appointment_id=$1 where id=$2",[appointment,referral]);
    expect((await q("select status,accepted_by from public.referrals where id=$1",[referral])).rows[0]).toEqual({status:"pending",accepted_by:null});
    const result = await as("service_role",null,"select public.start_consultation($1,$2,'confirmed',$3,'doctor_workspace',true,$4) as result",[clinic,appointment,pb,b]);
    expect(result.rows[0].result).toEqual({started:true,referral_id:referral});
    expect((await q("select status,accepted_by,started_by,follow_up_appointment_id from public.referrals where id=$1",[referral])).rows[0])
      .toEqual({status:"in_progress",accepted_by:pb,started_by:pb,follow_up_appointment_id:appointment});
    const own = (await write(b,pb,appointment,"Independent assessment")).rows[0].id as string;
    expect((await history(own)).rows[0]).toMatchObject({version:1,status:"current",author_doctor_id:b});
    await as("service_role",null,"update public.referrals set status='completed',completed_by=$1 where id=$2",[pb,referral]);
    expect(await access(b)).toMatchObject({own_patient:true,active_referral_ids:[],history_doctor_ids:expect.arrayContaining([a,e,b])});
    expect(await visible(pb)).toEqual([v1,v2,extra,own].sort());
    expect((await q("select count(*)::int as n from public.patients where id=$1",[patient])).rows[0].n).toBe(1);
  });
  it("future Doctor C sees the same patient's past history after an assigned visit, without another referral", async () => {
    expect(await visible(pc)).toEqual([]);
    await visit(c);
    expect(await access(c)).toMatchObject({own_patient:true,active_referral_ids:[],history_doctor_ids:expect.arrayContaining([a,e,b])});
    expect(await visible(pc)).toEqual(expect.arrayContaining([v1,v2,extra]));
    await expect(write(c,pc,visitA,"Foreign assessment",v2)).rejects.toThrow();
  });
  it("referral-only access ends on revocation, and cancelled/no-show assignments do not reopen it", async () => {
    const r = await refer(n);
    expect(await visible(pn)).toContain(v2);
    await as("service_role",null,"update public.referrals set status='revoked',revoked_by=$1,revoked_reason='Synthetic reason' where id=$2",[pa,r]);
    await visit(n,"cancelled");
    await visit(n,"no_show");
    expect(await visible(pn)).toEqual([]);
    expect(await access(n)).toMatchObject({own_patient:false,active_referral_ids:[],history_doctor_ids:[]});
  });
  it("expired pending handoff releases nothing according to the database clock", async () => {
    const r = await refer(n);
    // Test fixture time travel, never disabling triggers in application code.
    await q("alter table public.referrals disable trigger referrals_validate");
    try { await q("update public.referrals set created_at=now()-interval '2 days',expires_at=now()-interval '1 day' where id=$1",[r]); }
    finally { await q("alter table public.referrals enable trigger referrals_validate"); }
    expect(await visible(pn)).toEqual([]);
  });
  it("G: cross-clinic, inactive, and no-longer-doctor accounts cannot read history", async () => {
    expect(await access(k)).toBeUndefined();
    expect(await visible(pk)).toEqual([]);
    await expect(write(k,pk,visitA,"Cross-clinic forgery")).rejects.toThrow();
    await expect(refer(k)).rejects.toThrow();
    await q("update public.doctors set active=false where id=$1",[c]);
    expect(await access(c)).toBeUndefined();
    expect(await visible(pc)).toEqual([]);
    await q("update public.doctors set active=true where id=$1",[c]);
    await q("delete from public.staff_roles where profile_id=$1",[pc]);
    expect(await access(c)).toBeUndefined();
    expect(await visible(pc)).toEqual([]);
  });
  it("I: a stale correction cannot overwrite the winner; exactly one version stays current", async () => {
    v3 = (await write(a,pa,visitA,"Latest",v2)).rows[0].id as string;
    await expect(write(a,pa,visitA,"Stale",v2)).rejects.toMatchObject({code:"CRVER"});
    expect((await history(v1)).rows.map(r=>[r.version,r.status])).toEqual([[1,"superseded"],[2,"superseded"],[3,"current"]]);
    expect((await q("select id from public.clinical_record_versions where root_record_id=$1 and status='current'",[v1])).rows).toEqual([{id:v3}]);
  });
  it("audit identifies both versions and the author without containing clinical text", async () => {
    const event=(await q("select actor_id,old_values,new_values from public.audit_events where entity_id=$1 and action='clinical_record_corrected'",[v3])).rows[0];
    expect(event).toMatchObject({actor_id:pa,old_values:{record_id:v2,version:2,created_by:pa},new_values:{version:3,root_record_id:v1,author_doctor_id:a}});
    expect(JSON.stringify(event)).not.toContain("Latest");
  });
  it("a doctor with authored history cannot be relinked to another login", async () => {
    await expect(q("update public.doctors set profile_id=$1 where id=$2",[pn,a])).rejects.toMatchObject({code:"CRLNK"});
  });
  it("patient and clinic deletion cannot erase clinical, communication or financial domains", async () => {
    await expect(q("delete from public.patients where id=$1",[patient])).rejects.toMatchObject({code:expect.stringMatching(/23503|23001/)});
    await expect(q("delete from public.clinics where id=$1",[clinic])).rejects.toMatchObject({code:expect.stringMatching(/23503|23001/)});
    const isolated=randomUUID();
    await q("insert into public.patients(id,clinic_id) values ($1,$2)",[isolated,clinic]);
    await q("insert into public.conversations(clinic_id,patient_id) values ($1,$2)",[clinic,isolated]);
    await expect(q("delete from public.patients where id=$1",[isolated])).rejects.toMatchObject({code:expect.stringMatching(/23503|23001/)});
    const appointment=await visit(n,"completed");
    await q("insert into public.payments(clinic_id,patient_id,appointment_id,amount) values ($1,$2,$3,0)",[clinic,patient,appointment]);
    await expect(q("delete from public.appointments where id=$1",[appointment])).rejects.toMatchObject({code:expect.stringMatching(/23503|23001/)});
    expect((await history(v1)).rows).toHaveLength(3);
    expect((await q("select * from public.retention_policies")).rows).toEqual([]);
  });
  it("operational staff and anonymous sessions never gain clinical text", async () => {
    const reception=randomUUID();
    await q("insert into auth.users(id) values ($1)",[reception]);
    await q("insert into public.profiles(id) values ($1)",[reception]);
    await q("insert into public.staff_roles(clinic_id,profile_id,role) values ($1,$2,'receptionist')",[clinic,reception]);
    expect(await visible(reception)).toEqual([]);
    for (const role of ["anon","authenticated"]) {
      const rows=await q("select has_table_privilege($1, 'public.clinical_records', 'select') as clinical, has_table_privilege($1, 'public.referrals', 'select') as referrals",[role]);
      expect(rows.rows[0]).toEqual({clinical:false,referrals:false});
    }
  });
  it("test-owner cleanup must explicitly remove retained domains; another clinic remains intact", async () => {
    for (const table of FIXTURE_RETENTION_TABLES) await q(`delete from public.${table} where clinic_id=$1`,[clinic]);
    await q("delete from public.clinics where id=$1",[clinic]);
    expect((await q("select id from public.clinics where id=$1",[otherClinic])).rows).toEqual([{id:otherClinic}]);
  });

});

// Clean install, canonical upgrade, and SQL-editor bundle equivalence, using
// generated local databases only. Never loads app env files or patient data.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import postgres from "postgres";
const root = new URL("../", import.meta.url);
const raw = process.env.SUPABASE_DB_URL;
let target;
try { target = new URL(raw); } catch { throw new Error("Set a valid disposable local SUPABASE_DB_URL."); }
if (!["postgres:", "postgresql:"].includes(target.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || target.search) throw new Error("Schema rehearsals require a loopback database without query overrides.");
const admin = postgres(raw, { max: 1, onnotice: () => {} });
const created = [];
const clients = [];
const lineage = JSON.parse(await readFile(new URL("supabase/migration-lineage.json", root), "utf8"));
const canonical = new Set(lineage.canonicalMigrations.map((m) => m.file));
const files = (await readdir(new URL("supabase/migrations/", root))).filter((f) => f.endsWith(".sql")).sort();
const bootstrap = (await readFile(new URL("docs/db-audit-evidence-2026-10-05/bootstrap.sql", root), "utf8"))
  .split("\n").filter((l) => !l.startsWith("create role ")).join("\n");
async function make(label) {
  const name = `healthai_${label}_${randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`create database ${name}`); created.push(name);
  const uri = new URL(raw); uri.pathname = `/${name}`;
  const db = postgres(uri.toString(), { max: 1, onnotice: () => {} }); clients.push(db);
  await db.unsafe(bootstrap);
  await db.unsafe(`alter table storage.buckets add column file_size_limit bigint, add column allowed_mime_types text[];
    alter table auth.users add column email text;
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb) $$;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;`);
  return db;
}
async function apply(db, list) {
  for (const file of list) {
    const body = await readFile(new URL(`supabase/migrations/${file}`, root), "utf8");
    try { await db.begin((tx) => tx.unsafe(body)); }
    catch (e) { throw new Error(`Migration ${file} failed (${e.code ?? "unknown"}): ${e.message}`); }
  }
}
async function publicSchema(db) {
  const tables = await db`select c.relname, c.relrowsecurity, a.attname, format_type(a.atttypid,a.atttypmod) as type, a.attnotnull,
    pg_get_expr(d.adbin,d.adrelid) as default_value
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
    left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
    where n.nspname='public' and c.relkind in ('r','p') order by c.relname,a.attnum`;
  const functions = await db`select proname, pg_get_function_identity_arguments(oid) as args, pg_get_functiondef(oid) as definition
    from pg_proc where pronamespace='public'::regnamespace and prokind='f' order by proname, args`;
  const constraints = await db`select c.relname, con.conname, pg_get_constraintdef(con.oid) as definition from pg_constraint con
    join pg_class c on c.oid=con.conrelid where c.relnamespace='public'::regnamespace order by c.relname,con.conname`;
  const policies = await db`select tablename,policyname,roles,cmd,qual,with_check from pg_policies where schemaname='public' order by tablename,policyname`;
  const indexes = await db`select tablename,indexname,indexdef from pg_indexes where schemaname='public' order by tablename,indexname`;
  const triggers = await db`select c.relname,t.tgname,pg_get_triggerdef(t.oid) as definition from pg_trigger t
    join pg_class c on c.oid=t.tgrelid where c.relnamespace='public'::regnamespace and not t.tgisinternal order by c.relname,t.tgname`;
  const grants = await db`select grantee,table_name,privilege_type from information_schema.role_table_grants
    where table_schema='public' and grantee in ('anon','authenticated','service_role','PUBLIC') order by grantee,table_name,privilege_type`;
  const rpcGrants = await db`select p.proname,pg_get_function_identity_arguments(p.oid) as args,r.role,
    has_function_privilege(r.role,p.oid,'execute') as allowed from pg_proc p
    cross join (values ('anon'),('authenticated'),('service_role')) as r(role)
    where p.pronamespace='public'::regnamespace order by p.proname,args,r.role`;
  return { tables, functions, constraints, policies, indexes, triggers, grants, rpcGrants };
}
try {
  await admin.unsafe(`do $$ begin
    if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
    if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
  end $$;`);
  for (const entry of lineage.canonicalMigrations) {
    const bytes = await readFile(new URL(`supabase/migrations/${entry.file}`, root));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, `Canonical migration changed: ${entry.file}`);
  }
  assert.equal(new Set(files.map((f) => f.split("_")[0])).size, files.length, "Duplicate migration versions");
  const fresh = await make("fresh"); await apply(fresh, files);
  console.log(`PASS clean install: ${files.length} ordered migrations`);
  const upgraded = await make("upgrade"); await apply(upgraded, files.filter((f) => canonical.has(f)));
  await apply(upgraded, files.filter((f) => !canonical.has(f)));
  console.log(`PASS canonical upgrade: ${canonical.size} baseline + ${files.length - canonical.size} forward migrations`);
  const reference = await publicSchema(fresh);
  const upgradeSchema = await publicSchema(upgraded);
  const differences = [];
  for (const key of Object.keys(reference)) {
    const rows = reference[key]; const other = upgradeSchema[key];
    for (let i = 0; i < Math.max(rows.length, other.length); i++) {
      if (JSON.stringify(rows[i]) !== JSON.stringify(other[i])) differences.push({ section: key, fresh: rows[i], upgraded: other[i] });
    }
  }
  if (differences.length) {
    await writeFile(new URL("tmp/blocker-repair/schema-differences.json", root), JSON.stringify(differences, null, 2));
    throw new Error(`Upgrade has ${differences.length} schema differences; inspect tmp/blocker-repair/schema-differences.json`);
  }
  console.log("PASS clean-install and upgrade schema equivalence");
  const bundle = await make("bundle");
  await bundle.unsafe(await readFile(new URL("supabase/full-db-setup.sql", root), "utf8"));
  assert.ok(JSON.stringify(await publicSchema(bundle)) === JSON.stringify(reference), "SQL-editor bundle differs from migrations");
  console.log("PASS SQL-editor bundle schema equivalence");
  const blockers = await fresh.unsafe(await readFile(new URL("scripts/release-schema-preflight.sql", root), "utf8"));
  assert.equal(blockers.length, 0, "Release schema preflight returned blockers");
  console.log("PASS release schema preflight");
} finally {
  for (const db of clients) await db.end({ timeout: 2 });
  for (const name of created) await admin.unsafe(`drop database if exists ${name} with (force)`);
  await admin.end({ timeout: 2 });
}

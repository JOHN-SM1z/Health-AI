import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

/**
 * Structured prescribing — the DATABASE guarantees of
 * supabase/migrations/20261126000001_structured_prescribing.sql
 * (specification DW-02, DW-03, RX-01…RX-07 and the drug search checks EV-05):
 *
 *   * nothing is reachable with a browser token: no table grant, no RPC grant;
 *   * drug search finds Latin and Cyrillic prefixes, misspellings, INN and
 *     trade names, shows the prescription-only and controlled flags, keeps one
 *     clinic's own entries away from another, and is fast;
 *   * a prescription is the doctor's own consultation; a controlled or
 *     unavailable medicine cannot be put on it;
 *   * signing writes the doctor-authored clinical record, freezes everything
 *     and audits ids only; a recorded allergy blocks signing until the doctor
 *     gives a reason;
 *   * a signed prescription can only be replaced or cancelled, each with a
 *     reason, and its clinical record cannot be "corrected" around it;
 *   * the verification code reveals clinic, doctor, date and status only.
 *
 * Every medicine and code below is a made-up fixture name ("Qz…", "U98.…"),
 * never a real catalogue entry.
 *
 * Cast: Dr A (patient X's doctor), Dr C (same clinic, no relationship),
 * Dr K (another clinic).
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

async function probeDatabase(): Promise<string | null> {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    const [row] = await probe<{ has_tables: boolean; can_switch_roles: boolean }[]>`
      select
        to_regclass('public.prescriptions') is not null as has_tables,
        pg_has_role(current_user, 'anon', 'MEMBER')
          and pg_has_role(current_user, 'authenticated', 'MEMBER')
          and pg_has_role(current_user, 'service_role', 'MEMBER') as can_switch_roles`;
    if (!row.has_tables) return "prescribing migration not applied — run `npm run db:reset-local`";
    if (!row.can_switch_roles) return "database user cannot switch to anon/authenticated/service_role";
    return null;
  } catch (e) {
    return `database unreachable via SUPABASE_DB_URL — ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    await probe.end({ timeout: 1 });
  }
}

const unavailable = await probeDatabase();
if (unavailable) process.stderr.write(`\n⚠️  prescribing database suite SKIPPED (${unavailable})\n\n`);

const describeDb = describe.skipIf(unavailable !== null);

type Tx = postgres.TransactionSql;
type Result = Record<string, unknown> & { error_code: string | null };
type SearchRow = {
  id: string;
  inn: string;
  trade_name: string | null;
  rx_only: boolean;
  controlled: boolean;
  clinic_owned: boolean;
  in_formulary: boolean;
  recent: boolean;
  match: string;
};

async function pgError(run: () => Promise<unknown>): Promise<postgres.PostgresError> {
  try {
    await run();
  } catch (e) {
    if (e instanceof postgres.PostgresError) return e;
    throw e;
  }
  throw new Error("expected the database to reject the statement");
}

const codeHash = () => createHash("sha256").update(randomUUID()).digest("hex");

describeDb("structured prescribing — database layer", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const source = `test-rx-${suffix}`;
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const serviceA = randomUUID();
  const serviceB = randomUUID();
  const profiles = { a: randomUUID(), c: randomUUID(), k: randomUUID(), owner: randomUUID() };
  const doctors = { a: randomUUID(), c: randomUUID(), k: randomUUID() };
  const drug = { rx: "", otc: "", controlled: "", retired: "", ownB: "" };
  let day = 0;

  async function as<T>(role: "anon" | "authenticated" | "service_role", sub: string | null, run: (tx: Tx) => Promise<T>): Promise<T> {
    return (await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      await tx`select set_config('request.jwt.claims', ${JSON.stringify(sub ? { sub, role } : { role })}, true)`;
      return run(tx);
    })) as T;
  }
  const asServer = <T>(run: (tx: Tx) => Promise<T>) => as("service_role", null, run);

  async function newPatient(clinicId = clinicA) {
    const id = randomUUID();
    await sql`insert into public.patients (id, clinic_id, full_name) values (${id}, ${clinicId}, ${`Rx patient ${suffix}`})`;
    return id;
  }

  async function visit(patient: string, doctor: string, status = "in_progress", clinicId = clinicA) {
    const start = new Date(Date.UTC(2026, 1, 2, 5, 0) + day++ * 86_400_000);
    const [row] = await sql<{ id: string }[]>`insert into public.appointments ${sql({
      clinic_id: clinicId,
      patient_id: patient,
      doctor_id: doctor,
      service_id: clinicId === clinicA ? serviceA : serviceB,
      start_at: start,
      end_at: new Date(start.getTime() + 30 * 60_000),
      status,
      source: "walk_in",
    })} returning id`;
    return row.id;
  }

  const item = (drugId: string, overrides: Record<string, unknown> = {}) => ({
    drug_id: drugId,
    dose: 1,
    dose_unit: "tabletka",
    route: "ichishga",
    frequency: "3×1",
    timing: "after_food",
    days: 7,
    quantity: 21,
    instructions: "Ko‘p suv bilan",
    ...overrides,
  });

  type DraftOptions = { doctor?: keyof typeof doctors; actor?: string; clinic?: string; prescriptionId?: string | null; replacesId?: string | null; key?: string | null };

  function saveDraft(patient: string, appointment: string, items: unknown[], opts: DraftOptions = {}): Promise<Result> {
    const who = opts.doctor ?? "a";
    return asServer(async (tx) => {
      const [row] = await tx<{ r: Result }[]>`
        select public.save_prescription_draft(
          ${opts.clinic ?? clinicA}::uuid, ${doctors[who]}::uuid, ${opts.actor ?? profiles[who]}::uuid,
          ${patient}::uuid, ${appointment}::uuid, ${opts.prescriptionId ?? null}::uuid,
          ${tx.json(items as never)}, ${opts.replacesId ?? null}::uuid, ${opts.key === undefined ? randomUUID() : opts.key}::uuid
        ) as r`;
      return row.r;
    });
  }

  function sign(prescriptionId: string, opts: { doctor?: keyof typeof doctors; reason?: string | null; hash?: string } = {}): Promise<Result> {
    const who = opts.doctor ?? "a";
    return asServer(async (tx) => {
      const [row] = await tx<{ r: Result }[]>`
        select public.sign_prescription(
          ${who === "k" ? clinicB : clinicA}::uuid, ${doctors[who]}::uuid, ${profiles[who]}::uuid,
          ${prescriptionId}::uuid, ${opts.hash ?? codeHash()}, ${opts.reason ?? null}
        ) as r`;
      return row.r;
    });
  }

  /** A signed prescription of Dr A for a fresh patient (or the given one). */
  async function signed(items?: unknown[], patientId?: string, appointmentId?: string) {
    const patient = patientId ?? (await newPatient());
    const appointment = appointmentId ?? (await visit(patient, doctors.a));
    const saved = await saveDraft(patient, appointment, items ?? [item(drug.otc)]);
    expect(saved.error_code).toBeNull();
    const id = String(saved.prescription_id);
    const hash = codeHash();
    const result = await sign(id, { hash });
    expect(result.error_code).toBeNull();
    return { id, patient, appointment, hash, result };
  }

  function allergy(patient: string, substance: string, overrides: Record<string, unknown> = {}) {
    return asServer(async (tx) => {
      const [row] = await tx<{ id: string }[]>`insert into public.patient_allergies ${tx({
        clinic_id: clinicA,
        patient_id: patient,
        substance,
        substance_kind: "inn",
        severity: "severe",
        recorded_by_doctor_id: doctors.a,
        recorded_by: profiles.a,
        ...overrides,
      })} returning id`;
      return row.id;
    });
  }

  function search(query: string, clinic = clinicA, doctor = doctors.a): Promise<SearchRow[]> {
    return asServer((tx) => tx<SearchRow[]>`select * from public.search_drug_catalog(${clinic}::uuid, ${doctor}::uuid, ${query}, 20)`);
  }

  const prescription = async (id: string) => (await sql`select * from public.prescriptions where id = ${id}`)[0];

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 4, onnotice: () => {} });
    await sql`insert into public.clinics ${sql([
      { id: clinicA, name: `Rx Clinic A ${suffix}`, slug: `rx-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Rx Clinic B ${suffix}`, slug: `rx-b-${suffix}`, timezone: "Asia/Tashkent" },
    ])}`;
    const users = Object.entries(profiles).map(([name, id]) => ({ id, email: `rx-${name}-${suffix}@test.local` }));
    await sql`insert into auth.users ${sql(users)}`;
    await sql`insert into public.profiles ${sql(users.map((u) => ({ id: u.id, full_name: u.email })))}`;
    await sql`insert into public.staff_roles ${sql([
      { clinic_id: clinicA, profile_id: profiles.a, role: "doctor" },
      { clinic_id: clinicA, profile_id: profiles.c, role: "doctor" },
      { clinic_id: clinicA, profile_id: profiles.owner, role: "owner" },
      { clinic_id: clinicB, profile_id: profiles.k, role: "doctor" },
    ])}`;
    await sql`insert into public.doctors ${sql(
      (Object.keys(doctors) as Array<keyof typeof doctors>).map((k) => ({
        id: doctors[k],
        clinic_id: k === "k" ? clinicB : clinicA,
        profile_id: profiles[k],
        name: `Dr ${k.toUpperCase()} ${suffix}`,
        active: true,
      })),
    )}`;
    await sql`insert into public.services ${sql([
      { id: serviceA, clinic_id: clinicA, name: `Rx consult A ${suffix}`, duration_minutes: 30, price: 100000 },
      { id: serviceB, clinic_id: clinicB, name: `Rx consult B ${suffix}`, duration_minutes: 30, price: 100000 },
    ])}`;
    await sql`insert into public.doctor_working_hours ${sql(
      (Object.keys(doctors) as Array<keyof typeof doctors>).flatMap((k) =>
        [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          clinic_id: k === "k" ? clinicB : clinicA,
          doctor_id: doctors[k],
          weekday,
          start_time: "00:00",
          end_time: "23:59",
        })),
      ),
    )}`;

    // The shared catalogue, loaded the way an operator loads a reviewed file.
    await asServer(
      (tx) => tx`select public.import_drug_catalog(${source}, 'v1', null, ${tx.json([
        {
          inn: "Qzamoksitsillin",
          inn_latin: "Qzamoxicillin",
          trade_name: "Qzoksil",
          form: "kapsula",
          strength: "500 mg",
          registration_number: `RX-${suffix}`,
          drug_class: "Qzpenitsillinlar",
          aliases: ["Qzflemoksin"],
          rx_only: true,
          controlled: false,
        },
        { inn: "Qzanalgin", trade_name: "Qzalgin", form: "tabletka", strength: "500 mg", rx_only: false, controlled: false },
        { inn: "Qzmorfin", form: "ampula", strength: "10 mg/ml", rx_only: true, controlled: true },
        { inn: "Qzeskirgan", form: "tabletka", strength: "5 mg", rx_only: false, controlled: false },
      ] as never)}, false)`,
    );
    const rows = await sql<{ id: string; inn: string }[]>`select id, inn from public.drug_catalog where source = ${source}`;
    const byInn = (inn: string) => rows.find((r) => r.inn === inn)!.id;
    drug.rx = byInn("Qzamoksitsillin");
    drug.otc = byInn("Qzanalgin");
    drug.controlled = byInn("Qzmorfin");
    drug.retired = byInn("Qzeskirgan");
    await sql`update public.drug_catalog set active = false where id = ${drug.retired}`;
    // Clinic B's own entry: must never be visible or prescribable in clinic A.
    const [own] = await sql<{ id: string }[]>`insert into public.drug_catalog ${sql({
      owner_clinic_id: clinicB,
      inn: "Qzklinikadori",
      form: "tabletka",
      strength: "10 mg",
      rx_only: false,
      controlled: false,
      source: "clinic_formulary",
      source_version: "2026-11-26",
      created_by: profiles.k,
    })} returning id`;
    drug.ownB = own.id;
  });

  afterAll(async () => {
    if (!sql) return;
    // Erasing the clinics removes prescriptions, items, allergies and records with them (and proves it works).
    await sql`delete from public.clinics where id in ${sql([clinicA, clinicB])}`;
    await sql`delete from public.drug_catalog where source = ${source}`;
    await sql`delete from public.reference_data_imports where source = ${source}`;
    await sql`delete from auth.users where id in ${sql(Object.values(profiles))}`;
    await sql.end({ timeout: 5 });
  });

  // -------------------------------------------------------------------------
  // Access
  // -------------------------------------------------------------------------

  it("gives browser roles no table and no function", async () => {
    const tables = [
      "reference_data_imports",
      "drug_catalog",
      "drug_search_terms",
      "clinic_formulary",
      "icd10_codes",
      "patient_allergies",
      "prescriptions",
      "prescription_items",
      "prescription_templates",
    ];
    const grants = await sql<{ relname: string; rls: boolean; exposed: boolean }[]>`
      select c.relname, c.relrowsecurity as rls,
             exists (
               select 1 from unnest(array['anon', 'authenticated']) as r(role), unnest(array['select', 'insert', 'update', 'delete']) as p(privilege)
               where has_table_privilege(r.role, c.oid, p.privilege)
             ) as exposed
      from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relname in ${sql(tables)}`;
    expect(grants).toHaveLength(tables.length);
    for (const g of grants) {
      expect(g.rls, `${g.relname} has RLS`).toBe(true);
      expect(g.exposed, `${g.relname} is not granted to anon/authenticated`).toBe(false);
    }

    const functions = await sql<{ proname: string; anon: boolean; authenticated: boolean; service: boolean }[]>`
      select p.proname,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
             has_function_privilege('service_role', p.oid, 'execute') as service
      from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and p.proname in ('search_drug_catalog', 'search_icd10', 'save_prescription_draft', 'sign_prescription', 'cancel_prescription',
                          'record_national_rx_number', 'verify_prescription_code', 'import_drug_catalog', 'import_icd10_codes',
                          'prescription_allergy_matches', 'prescription_author_check', 'rx_search_key')`;
    expect(functions).toHaveLength(12);
    for (const f of functions) {
      expect(f.anon, `${f.proname} not callable by anon`).toBe(false);
      expect(f.authenticated, `${f.proname} not callable by authenticated`).toBe(false);
      expect(f.service, `${f.proname} callable by the server`).toBe(true);
    }

    // And in practice, with Dr A's own token:
    const { id } = await signed();
    expect((await pgError(() => as("authenticated", profiles.a, (tx) => tx`select id from public.prescriptions where id = ${id}`))).code).toBe("42501");
    expect((await pgError(() => as("authenticated", profiles.a, (tx) => tx`select * from public.patient_allergies`))).code).toBe("42501");
    expect((await pgError(() => as("anon", null, (tx) => tx`select * from public.drug_catalog`))).code).toBe("42501");
    expect(
      (await pgError(() => as("authenticated", profiles.a, (tx) => tx`select * from public.search_drug_catalog(${clinicA}::uuid, ${doctors.a}::uuid, 'qz', 5)`))).code,
    ).toBe("42501");
    expect((await pgError(() => as("anon", null, (tx) => tx`select * from public.verify_prescription_code(${codeHash()})`))).code).toBe("42501");
  });

  // -------------------------------------------------------------------------
  // Search (EV-05)
  // -------------------------------------------------------------------------

  it("writes one search key for Latin and Cyrillic spellings", async () => {
    const [row] = await sql<{ cyr: string; lat: string; two: string; mixed: string }[]>`
      select public.rx_search_key('Амоксициллин') as cyr,
             public.rx_search_key('Amoksitsillin') as lat,
             public.rx_search_key('ан') as two,
             public.rx_search_key(' O‘G‘IL-ҚЎШ   500 mg ') as mixed`;
    expect(row.cyr).toBe(row.lat);
    expect(row.two).toBe("an");
    expect(row.mixed).toBe("ogil qosh 500 mg");
  });

  it("finds a medicine from two letters, by INN or trade name, in Latin or Cyrillic", async () => {
    const two = await search("qz");
    expect(two.map((r) => r.inn)).toEqual(expect.arrayContaining(["Qzamoksitsillin", "Qzanalgin", "Qzmorfin"]));
    expect(two.every((r) => r.match === "prefix")).toBe(true);

    expect((await search("қзамо")).map((r) => r.inn)).toEqual(["Qzamoksitsillin"]);
    expect((await search("QZALG")).map((r) => r.inn)).toEqual(["Qzanalgin"]);
    // The Latin INN spelling and an alias reach the same entry.
    expect((await search("qzamoxi")).map((r) => r.inn)).toEqual(["Qzamoksitsillin"]);
    expect((await search("qzflem")).map((r) => r.inn)).toEqual(["Qzamoksitsillin"]);
    // A single letter, nothing at all, or only punctuation is not a search.
    expect(await search("q")).toEqual([]);
    expect(await search("  ")).toEqual([]);
    expect(await search("%%__")).toEqual([]);
  });

  it("matches misspellings by similarity, after the exact prefixes", async () => {
    const misspelt = await search("qzanalgn");
    expect(misspelt.map((r) => r.inn)).toContain("Qzanalgin");
    expect(misspelt.find((r) => r.inn === "Qzanalgin")!.match).toBe("similar");

    const doubled = await search("qzamoksitsilin"); // one "l": the key folds doubled letters
    expect(doubled[0].inn).toBe("Qzamoksitsillin");
    expect(doubled[0].match).toBe("prefix");
  });

  it("narrows by further words (strength or form) and shows the legal flags", async () => {
    expect((await search("qz 500 tab")).map((r) => r.inn)).toEqual(["Qzanalgin"]);
    expect((await search("qz kaps")).map((r) => r.inn)).toEqual(["Qzamoksitsillin"]);

    const all = await search("qz");
    const flags = Object.fromEntries(all.map((r) => [r.inn, { rx_only: r.rx_only, controlled: r.controlled }]));
    expect(flags.Qzamoksitsillin).toEqual({ rx_only: true, controlled: false });
    expect(flags.Qzanalgin).toEqual({ rx_only: false, controlled: false });
    // A controlled medicine is listed so the screen can say why it cannot be prescribed here.
    expect(flags.Qzmorfin).toEqual({ rx_only: true, controlled: true });
  });

  it("hides retired entries and another clinic's own entries", async () => {
    const inA = (await search("qz")).map((r) => r.inn);
    expect(inA).not.toContain("Qzeskirgan");
    expect(inA).not.toContain("Qzklinikadori");

    const inB = await search("qzklin", clinicB, doctors.k);
    expect(inB.map((r) => r.inn)).toEqual(["Qzklinikadori"]);
    expect(inB[0].clinic_owned).toBe(true);
  });

  it("puts the clinic formulary first, then the doctor's recent choices", async () => {
    // Dr C has prescribed nothing: plain alphabetical order.
    const plain = await search("qz", clinicA, doctors.c);
    expect(plain[0].inn).toBe("Qzamoksitsillin");
    expect(plain.some((r) => r.recent || r.in_formulary)).toBe(false);

    await signed([item(drug.otc)]); // Dr A has a recent choice
    const recent = await search("qz");
    expect(recent[0].inn).toBe("Qzanalgin");
    expect(recent[0].recent).toBe(true);
    // One doctor's choices are not another doctor's recents.
    expect((await search("qz", clinicA, doctors.c))[0].inn).toBe("Qzamoksitsillin");

    await asServer(
      (tx) => tx`insert into public.clinic_formulary ${tx({ clinic_id: clinicA, drug_id: drug.rx, sort_order: 1, added_by: profiles.owner })}`,
    );
    const preferred = await search("qz");
    expect(preferred[0].inn).toBe("Qzamoksitsillin");
    expect(preferred[0].in_formulary).toBe(true);
    await sql`delete from public.clinic_formulary where clinic_id = ${clinicA}`;
  });

  it("refuses a formulary entry that points at another clinic's own medicine", async () => {
    const error = await pgError(() =>
      asServer((tx) => tx`insert into public.clinic_formulary ${tx({ clinic_id: clinicA, drug_id: drug.ownB, added_by: profiles.owner })}`),
    );
    expect(error.message).toContain("belongs to another clinic");
  });

  it("answers within the latency target on a catalogue of thousands", async () => {
    const perfSource = `${source}-perf`;
    const rows = Array.from({ length: 4000 }, (_, i) => ({
      inn: `Qzperf${i.toString(36)}zol`,
      trade_name: `Qztrade${(i * 7).toString(36)}`,
      form: i % 2 ? "tabletka" : "kapsula",
      strength: `${(i % 9) + 1}0 mg`,
      rx_only: i % 3 === 0,
      controlled: false,
    }));
    try {
      await asServer((tx) => tx`select public.import_drug_catalog(${perfSource}, 'v1', null, ${tx.json(rows as never)}, false)`);
      await sql`analyze public.drug_search_terms, public.drug_catalog`;
      const queries = ["qz", "qzp", "qzperf1", "qztr", "qztrade2", "qzperfzzol", "қзпер", "qzperf 30 tab", "qzamo", "qzanalgn"];
      for (const q of queries) await search(q); // warm up
      const times: number[] = [];
      for (let round = 0; round < 6; round++) {
        for (const q of queries) {
          const started = performance.now();
          await search(q);
          times.push(performance.now() - started);
        }
      }
      times.sort((x, y) => x - y);
      const p95 = times[Math.floor(times.length * 0.95)];
      // RX-01 targets 50 ms at p95 for the query. Measured here with the round trip and two test workers
      // sharing the database, so the suite only fails on a clear regression; the strict target can be
      // asserted on a quiet machine with RX_SEARCH_STRICT_LATENCY=true.
      expect(p95).toBeLessThan(process.env.RX_SEARCH_STRICT_LATENCY === "true" ? 50 : 250);
    } finally {
      await sql`delete from public.drug_catalog where source = ${perfSource}`;
      await sql`delete from public.reference_data_imports where source = ${perfSource}`;
    }
  }, 120_000);

  // -------------------------------------------------------------------------
  // Imports
  // -------------------------------------------------------------------------

  it("imports atomically, requires explicit legal flags and never deletes", async () => {
    const importSource = `${source}-imp`;
    const run = (rows: unknown[], deactivate: boolean | null) =>
      asServer(async (tx) => (await tx<{ r: Record<string, number> }[]>`select public.import_drug_catalog(${importSource}, 'v1', null, ${tx.json(rows as never)}, ${deactivate}) as r`)[0].r);
    try {
      // "Not prescription-only" is never assumed: a row without the flags fails the whole import.
      const missing = await pgError(() => run([{ inn: "Qzimportbir", rx_only: true, controlled: false }, { inn: "Qzimportikki" }], false));
      expect(missing.code).toBe("23502");
      expect(await sql`select 1 from public.drug_catalog where source = ${importSource}`).toHaveLength(0);
      expect((await pgError(() => run([{ inn: "Qzimportbir", rx_only: true, controlled: false }], null))).message).toContain("say explicitly");

      const first = await run(
        [
          { inn: "Qzimportbir", registration_number: "REG-1", rx_only: true, controlled: false },
          { inn: "Qzimportikki", form: "tabletka", rx_only: false, controlled: false },
        ],
        false,
      );
      expect(first).toMatchObject({ inserted: 2, updated: 0, deactivated: 0 });

      // A newer file: one entry changed (same registration number), one gone.
      const second = await run([{ inn: "Qzimportbir yangi", registration_number: "REG-1", rx_only: true, controlled: true }], true);
      expect(second).toMatchObject({ inserted: 0, updated: 1, deactivated: 1 });
      const rows = await sql<{ inn: string; active: boolean; controlled: boolean }[]>`
        select inn, active, controlled from public.drug_catalog where source = ${importSource} order by inn`;
      expect(rows).toEqual([
        { inn: "Qzimportbir yangi", active: true, controlled: true },
        { inn: "Qzimportikki", active: false, controlled: false },
      ]);
      // The search terms follow the rename.
      expect((await search("qzimportbir")).map((r) => r.inn)).toEqual(["Qzimportbir yangi"]);
    } finally {
      await sql`delete from public.drug_catalog where source = ${importSource}`;
      await sql`delete from public.reference_data_imports where source = ${importSource}`;
    }
  });

  it("looks up ICD-10 by code prefix or by words of the name, in either script", async () => {
    // Inside a transaction that is rolled back: a loaded catalogue changes how diagnosis codes are
    // checked for everyone, so these fixture codes must never be visible to another suite.
    const ROLLBACK = Symbol("rollback");
    await sql
      .begin(async (tx) => {
        await tx`select public.import_icd10_codes(${source}, 'v1', null, ${tx.json([
          { code: "u98.1", name_uz: "Qzsinov tashxisi birinchi", name_ru: "Кзтестовый диагноз первый" },
          { code: "U98.2", name_uz: "Qzsinov tashxisi ikkinchi", name_ru: "Кзтестовый диагноз второй" },
        ] as never)}, false)`;
        await tx.unsafe("set local role service_role");
        const codes = async (q: string) => (await tx<{ code: string }[]>`select code from public.search_icd10(${q}, 20)`).map((r) => r.code);
        expect(await codes("u98")).toEqual(["U98.1", "U98.2"]);
        expect(await codes("U98.2")).toEqual(["U98.2"]);
        expect(await codes("qzsinov")).toEqual(["U98.1", "U98.2"]);
        expect(await codes("кзтестовый диагноз втор")).toEqual(["U98.2"]);
        expect(await codes("ikkinchi")).toEqual(["U98.2"]);
        expect(await codes("q")).toEqual([]);
        throw ROLLBACK;
      })
      .catch((e) => {
        if (e !== ROLLBACK) throw e;
      });
    expect(await sql`select 1 from public.icd10_codes where source = ${source}`).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Drafts
  // -------------------------------------------------------------------------

  it("saves a draft only in the doctor's own started consultation", async () => {
    const patient = await newPatient();
    const appointment = await visit(patient, doctors.a);

    const saved = await saveDraft(patient, appointment, [item(drug.rx), item(drug.otc, { timing: "any", instructions: "" })]);
    expect(saved.error_code).toBeNull();
    const id = String(saved.prescription_id);
    const rx = await prescription(id);
    expect(rx).toMatchObject({ status: "draft", doctor_id: doctors.a, patient_id: patient, created_by: profiles.a, signed_at: null, clinical_record_id: null });
    const items = await sql`select position, inn_snapshot, trade_name_snapshot, rx_only_snapshot, timing, instructions from public.prescription_items where prescription_id = ${id} order by position`;
    expect(items).toEqual([
      { position: 1, inn_snapshot: "Qzamoksitsillin", trade_name_snapshot: "Qzoksil", rx_only_snapshot: true, timing: "after_food", instructions: "Ko‘p suv bilan" },
      { position: 2, inn_snapshot: "Qzanalgin", trade_name_snapshot: "Qzalgin", rx_only_snapshot: false, timing: "any", instructions: null },
    ]);
    // Nothing is written to the clinical record by a draft.
    expect(await sql`select 1 from public.clinical_records where appointment_id = ${appointment}`).toHaveLength(0);

    // Saving again replaces the items of the same draft.
    const again = await saveDraft(patient, appointment, [item(drug.otc)], { prescriptionId: id });
    expect(again).toMatchObject({ prescription_id: id, error_code: null });
    expect(await sql`select 1 from public.prescription_items where prescription_id = ${id}`).toHaveLength(1);

    // Someone else's consultation, a consultation that has not started, another doctor's draft.
    const other = await newPatient();
    expect((await saveDraft(other, appointment, [item(drug.otc)])).error_code).toBe("consultation_not_found");
    const pending = await visit(patient, doctors.a, "confirmed");
    expect((await saveDraft(patient, pending, [item(drug.otc)])).error_code).toBe("consultation_not_active");
    expect((await saveDraft(patient, appointment, [item(drug.otc)], { doctor: "c" })).error_code).toBe("consultation_not_found");
    expect((await saveDraft(patient, appointment, [], {})).error_code).toBe("items_invalid");

    // The actor must be the doctor's own account: a forged pairing is refused outright.
    const forged = await pgError(() => saveDraft(patient, appointment, [item(drug.otc)], { actor: profiles.c }));
    expect(forged.message).toContain("written by the doctor themselves");
    // A doctor of another clinic cannot write here even with this clinic's ids.
    const foreign = await pgError(() => saveDraft(patient, appointment, [item(drug.otc)], { doctor: "k" }));
    expect(foreign.message).toContain("written by the doctor themselves");
  });

  it("is idempotent per key and refuses a key reused for another consultation", async () => {
    const patient = await newPatient();
    const appointment = await visit(patient, doctors.a);
    const key = randomUUID();
    const first = await saveDraft(patient, appointment, [item(drug.otc)], { key });
    const retry = await saveDraft(patient, appointment, [item(drug.otc)], { key });
    expect(retry.prescription_id).toBe(first.prescription_id);
    expect(await sql`select 1 from public.prescriptions where appointment_id = ${appointment}`).toHaveLength(1);

    const elsewhere = await visit(patient, doctors.a);
    expect((await saveDraft(patient, elsewhere, [item(drug.otc)], { key })).error_code).toBe("idempotency_key_reused");
  });

  it("never puts a controlled, retired or foreign medicine on a prescription", async () => {
    const patient = await newPatient();
    const appointment = await visit(patient, doctors.a);

    const controlled = await pgError(() => saveDraft(patient, appointment, [item(drug.otc), item(drug.controlled)]));
    expect(controlled.message).toContain("prescription_item_rejected:controlled_not_allowed:2");
    const retired = await pgError(() => saveDraft(patient, appointment, [item(drug.retired)]));
    expect(retired.message).toContain("prescription_item_rejected:drug_not_available:1");
    const foreign = await pgError(() => saveDraft(patient, appointment, [item(drug.ownB)]));
    expect(foreign.message).toContain("prescription_item_rejected:drug_not_available:1");
    // The refusal undoes the whole save: no half-written draft is left behind.
    expect(await sql`select 1 from public.prescriptions where appointment_id = ${appointment}`).toHaveLength(0);

    // The same rule below the function: a row written straight into a draft cannot name another clinic's own entry.
    const direct = await saveDraft(patient, appointment, [item(drug.otc)]);
    const smuggled = await pgError(() =>
      asServer((tx) => tx`update public.prescription_items set drug_id = ${drug.ownB} where prescription_id = ${String(direct.prescription_id)}`),
    );
    expect(smuggled.message).toContain("not in this clinic's catalogue");
    await asServer((tx) => tx`delete from public.prescriptions where id = ${String(direct.prescription_id)}`);

    // A medicine that becomes controlled after the draft was saved is caught again at signing.
    const saved = await saveDraft(patient, appointment, [item(drug.otc)]);
    await sql`update public.drug_catalog set controlled = true where id = ${drug.otc}`;
    try {
      const result = await sign(String(saved.prescription_id));
      expect(result.error_code).toBe("items_not_allowed");
      expect(result.items).toEqual([{ position: 1, reason: "controlled_not_allowed" }]);
      expect((await prescription(String(saved.prescription_id))).status).toBe("draft");
    } finally {
      await sql`update public.drug_catalog set controlled = false where id = ${drug.otc}`;
    }
  });

  // -------------------------------------------------------------------------
  // Signing
  // -------------------------------------------------------------------------

  it("signs in one step: clinical record, frozen items, audit without medicines", async () => {
    const { id, patient, appointment, hash, result } = await signed([item(drug.rx), item(drug.otc, { instructions: "Qz-maxfiy-ko‘rsatma" })]);
    expect(result).toMatchObject({ error_code: null, prescription_id: id, national_rx_required: true, replaced_id: null });

    const rx = await prescription(id);
    expect(rx.status).toBe("signed");
    expect(rx.verification_code_hash).toBe(hash);
    expect(rx.signed_at).toBeInstanceOf(Date);

    // DW-01: the signed prescription is a clinical record authored by this doctor in this consultation.
    const [record] = await sql`select * from public.clinical_records where id = ${rx.clinical_record_id}`;
    expect(record).toMatchObject({
      record_type: "prescription",
      author_doctor_id: doctors.a,
      created_by: profiles.a,
      appointment_id: appointment,
      patient_id: patient,
      corrects_record_id: null,
    });
    expect(record.summary).toBe("Retsept: Qzamoksitsillin 500 mg; Qzanalgin 500 mg");
    expect(record.details).toContain("1. Qzamoksitsillin (Qzoksil), kapsula 500 mg — 1 tabletka, ichishga, 3×1, ovqatdan keyin, 7 kun, jami 21");
    expect(record.details).toContain("Qz-maxfiy-ko‘rsatma");

    // The audit trail names ids and counts — never a medicine, dose or instruction.
    const audit = await sql<{ action: string; new_values: Record<string, unknown>; actor_id: string; patient_id: string }[]>`
      select action, new_values, actor_id, patient_id from public.audit_events where entity_type = 'prescriptions' and entity_id = ${id}`;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "prescription_signed", actor_id: profiles.a, patient_id: patient });
    expect(audit[0].new_values).toMatchObject({ item_count: 2, national_rx_required: true, clinical_record_id: rx.clinical_record_id });
    const trail = JSON.stringify(await sql`select * from public.audit_events where clinic_id = ${clinicA} and patient_id = ${patient}`);
    for (const secret of ["Qzamoksitsillin", "Qzanalgin", "Qzoksil", "Qz-maxfiy", "tabletka", "3×1"]) expect(trail).not.toContain(secret);

    // Signing twice, signing someone else's draft, signing without a verification hash.
    expect((await sign(id)).error_code).toBe("not_a_draft");
    const draft = await saveDraft(patient, appointment, [item(drug.otc)]);
    expect((await sign(String(draft.prescription_id), { doctor: "c" })).error_code).toBe("prescription_not_found");
    expect((await pgError(() => sign(String(draft.prescription_id), { hash: "not-a-hash" }))).message).toContain("verification code hash");
  });

  it("freezes a signed prescription and its items", async () => {
    const { id } = await signed([item(drug.rx)]);

    for (const patch of [
      { patient_id: await newPatient() },
      { doctor_id: doctors.c },
      { signed_at: new Date(0) },
      { verification_code_hash: codeHash() },
      { replace_reason: "o‘zgartirildi" },
      { status: "draft" },
    ]) {
      const error = await pgError(() => asServer((tx) => tx`update public.prescriptions set ${tx(patch)} where id = ${id}`));
      expect(error.message, JSON.stringify(Object.keys(patch))).toMatch(/cannot change|cannot be edited|can only be/);
    }
    expect((await pgError(() => asServer((tx) => tx`update public.prescription_items set dose = 99 where prescription_id = ${id}`))).message).toContain(
      "items of a signed prescription cannot change",
    );
    expect((await pgError(() => asServer((tx) => tx`delete from public.prescription_items where prescription_id = ${id}`))).message).toContain(
      "items of a signed prescription cannot change",
    );
    expect(
      (await pgError(() => asServer((tx) => tx`insert into public.prescription_items (prescription_id, clinic_id, position, drug_id, inn_snapshot, rx_only_snapshot, dose, dose_unit, route, frequency, days, quantity)
        values (${id}, ${clinicA}, 2, ${drug.otc}, 'x', false, 1, 'tabletka', 'ichishga', '1×1', 1, 1)`))).message,
    ).toContain("items of a signed prescription cannot change");
    // Retention: a signed prescription is never deleted on its own — not even by the database owner's plain DELETE.
    expect((await pgError(() => sql`delete from public.prescriptions where id = ${id}`)).message).toContain("cannot be deleted");

    // A prescription cannot be created already signed, around sign_prescription().
    const rx = await prescription(id);
    const direct = await pgError(() =>
      asServer(
        (tx) => tx`insert into public.prescriptions ${tx({
          clinic_id: clinicA,
          patient_id: rx.patient_id,
          doctor_id: doctors.a,
          appointment_id: rx.appointment_id,
          status: "signed",
          signed_at: new Date(),
          clinical_record_id: rx.clinical_record_id,
          verification_code_hash: codeHash(),
          created_by: profiles.a,
        })}`,
      ),
    );
    expect(direct.message).toContain("starts as a draft");

    // The doctor's own draft, on the other hand, can be discarded.
    const draft = await saveDraft(rx.patient_id, rx.appointment_id, [item(drug.otc)]);
    await asServer((tx) => tx`delete from public.prescriptions where id = ${String(draft.prescription_id)}`);
    expect(await prescription(String(draft.prescription_id))).toBeUndefined();
  });

  it("does not let the free-text record form correct a structured prescription", async () => {
    const { id, patient, appointment } = await signed();
    const rx = await prescription(id);
    const error = await pgError(() =>
      asServer(
        (tx) => tx`insert into public.clinical_records ${tx({
          clinic_id: clinicA,
          patient_id: patient,
          author_doctor_id: doctors.a,
          appointment_id: appointment,
          record_type: "prescription",
          summary: "Boshqa dori",
          corrects_record_id: rx.clinical_record_id,
          created_by: profiles.a,
        })}`,
      ),
    );
    expect(error.message).toContain("through the prescription itself");
  });

  // -------------------------------------------------------------------------
  // Allergies (DW-03)
  // -------------------------------------------------------------------------

  it("records an allergy only by a doctor who treats the patient, and never edits it", async () => {
    const patient = await newPatient();
    await visit(patient, doctors.a);

    const id = await allergy(patient, "Qzpenitsillin", { reaction: "toshma" });
    const [row] = await sql`select substance_key, recorded_by, inactive_at from public.patient_allergies where id = ${id}`;
    expect(row).toMatchObject({ substance_key: "qzpenitsilin", recorded_by: profiles.a, inactive_at: null });

    // Dr C has no relationship with this patient; Dr K is in another clinic; the recorder must be the doctor's own account.
    expect(
      (await pgError(() => allergy(patient, "Qzyod", { recorded_by_doctor_id: doctors.c, recorded_by: profiles.c }))).message,
    ).toContain("no clinical relationship");
    expect((await pgError(() => allergy(patient, "Qzyod", { recorded_by_doctor_id: doctors.k, recorded_by: profiles.k }))).message).toContain(
      "active doctor of the clinic",
    );
    expect((await pgError(() => allergy(patient, "Qzyod", { recorded_by: profiles.c }))).message).toContain("own account");
    expect((await pgError(() => allergy(patient, "Qzyod", { drug_id: drug.ownB }))).message).toContain("not in this clinic");

    // Editing is refused; marking inactive needs who and why, and happens once.
    expect((await pgError(() => asServer((tx) => tx`update public.patient_allergies set substance = 'Qzboshqa' where id = ${id}`))).message).toContain(
      "cannot be edited",
    );
    expect((await pgError(() => asServer((tx) => tx`update public.patient_allergies set inactive_at = now() where id = ${id}`))).message).toContain(
      "only an active doctor of the clinic can mark an allergy inactive",
    );
    // …and that doctor must give a reason (the row's own constraint).
    expect(
      (await pgError(() => asServer((tx) => tx`update public.patient_allergies set inactive_at = now(), inactivated_by = ${profiles.a} where id = ${id}`))).code,
    ).toBe("23514");
    await asServer(
      (tx) => tx`update public.patient_allergies set inactive_at = now(), inactivated_by = ${profiles.a}, inactive_reason = 'Xato kiritilgan' where id = ${id}`,
    );
    expect(
      (await pgError(() => asServer((tx) => tx`update public.patient_allergies set inactive_reason = 'Yana' where id = ${id}`))).message,
    ).toContain("inactive allergy cannot be changed");
    expect((await pgError(() => asServer((tx) => tx`delete from public.patient_allergies where id = ${id}`))).code).toBe("42501");
    expect((await pgError(() => sql`delete from public.patient_allergies where id = ${id}`)).message).toContain("cannot be deleted");

    // Audited by id — the substance and the reaction stay out of the trail.
    const audit = await sql<{ action: string }[]>`select action from public.audit_events where entity_type = 'patient_allergies' and entity_id = ${id} order by created_at`;
    expect(audit.map((a) => a.action)).toEqual(["patient_allergy_recorded", "patient_allergy_inactivated"]);
    const trail = JSON.stringify(await sql`select * from public.audit_events where entity_type = 'patient_allergies' and entity_id = ${id}`);
    expect(trail).not.toContain("Qzpenitsillin");
    expect(trail).not.toContain("toshma");
  });

  it("blocks signing on a recorded allergy until the doctor gives a reason for that medicine", async () => {
    const patient = await newPatient();
    const appointment = await visit(patient, doctors.a);
    // Recorded in Cyrillic; the medicine is catalogued in Latin. Same substance, same key.
    const byName = await allergy(patient, "Қзамоксициллин");
    const saved = await saveDraft(patient, appointment, [item(drug.otc), item(drug.rx)]);
    const id = String(saved.prescription_id);

    const blocked = await sign(id);
    expect(blocked.error_code).toBe("allergy_conflict");
    expect(blocked.conflicts).toEqual([{ position: 2, drug_id: drug.rx, allergy_ids: [byName] }]);
    expect((await prescription(id)).status).toBe("draft");
    expect(await sql`select 1 from public.clinical_records where appointment_id = ${appointment}`).toHaveLength(0);

    // A reason on the wrong item does not help; a reason on the matched item does.
    await saveDraft(patient, appointment, [item(drug.otc, { allergy_override_reason: "boshqa" }), item(drug.rx)], { prescriptionId: id });
    expect((await sign(id)).error_code).toBe("allergy_conflict");
    await saveDraft(patient, appointment, [item(drug.otc), item(drug.rx, { allergy_override_reason: "Qz-sabab: boshqa tanlov yo‘q" })], { prescriptionId: id });
    const result = await sign(id);
    expect(result.error_code).toBeNull();

    const [line] = await sql`select allergy_ids, allergy_override_reason from public.prescription_items where prescription_id = ${id} and position = 2`;
    expect(line.allergy_ids).toEqual([byName]);
    const [record] = await sql`select details from public.clinical_records where id = ${String(result.clinical_record_id)}`;
    expect(record.details).toContain("Allergiya qayd etilgan — shifokor izohi: Qz-sabab");

    // The override is audited with ids only.
    const audit = await sql<{ new_values: Record<string, unknown> }[]>`
      select new_values from public.audit_events where action = 'prescription_allergy_override' and patient_id = ${patient}`;
    expect(audit).toHaveLength(1);
    expect(audit[0].new_values).toMatchObject({ prescription_id: id, drug_id: drug.rx, allergy_ids: [byName] });
    expect(JSON.stringify(audit)).not.toContain("Qz-sabab");
  });

  it("matches an allergy by class, alias or chosen catalogue entry — and ignores inactive ones", async () => {
    const check = async (record: (patient: string) => Promise<string>, expectBlocked: boolean) => {
      const patient = await newPatient();
      const appointment = await visit(patient, doctors.a);
      await record(patient);
      const saved = await saveDraft(patient, appointment, [item(drug.rx)]);
      expect((await sign(String(saved.prescription_id))).error_code).toBe(expectBlocked ? "allergy_conflict" : null);
    };

    await check((p) => allergy(p, "Qzpenitsillinlar", { substance_kind: "class" }), true); // the medicine's class
    await check((p) => allergy(p, "QZFLEMOKSIN"), true); // an alias, any case
    await check((p) => allergy(p, "Qzamoxicillin"), true); // the Latin INN
    await check((p) => allergy(p, "antibiotik", { substance_kind: "other", drug_id: drug.rx }), true); // the entry the doctor picked
    await check((p) => allergy(p, "Qzanalgin"), false); // another medicine
    await check(async (p) => {
      const id = await allergy(p, "Qzamoksitsillin");
      await asServer((tx) => tx`update public.patient_allergies set inactive_at = now(), inactivated_by = ${profiles.a}, inactive_reason = 'Tasdiqlanmadi' where id = ${id}`);
      return id;
    }, false);
  });

  // -------------------------------------------------------------------------
  // Replace, cancel, national number (RX-05, RX-06)
  // -------------------------------------------------------------------------

  it("replaces a signed prescription with a new one and a reason", async () => {
    const old = await signed([item(drug.rx)]);
    const draft = await saveDraft(old.patient, old.appointment, [item(drug.otc)], { replacesId: old.id });
    const id = String(draft.prescription_id);

    expect((await sign(id)).error_code).toBe("replace_reason_required");
    expect((await sign(id, { reason: " x " })).error_code).toBe("replace_reason_required");
    expect((await prescription(old.id)).status).toBe("signed"); // untouched until the new one is really signed

    const result = await sign(id, { reason: "Bemor dorini ko‘tara olmadi" });
    expect(result).toMatchObject({ error_code: null, replaced_id: old.id });
    const [oldRx, newRx] = [await prescription(old.id), await prescription(id)];
    expect(oldRx.status).toBe("replaced");
    expect(newRx).toMatchObject({ status: "signed", replaces_id: old.id, replace_reason: "Bemor dorini ko‘tara olmadi" });
    // Same consultation: the new clinical record is the correction of the old one.
    const [record] = await sql`select corrects_record_id, details from public.clinical_records where id = ${newRx.clinical_record_id}`;
    expect(record.corrects_record_id).toBe(oldRx.clinical_record_id);
    expect(record.details).toContain("Oldingi retsept o‘rniga. Sabab: Bemor dorini ko‘tara olmadi");
    const audit = await sql<{ action: string }[]>`select action from public.audit_events where entity_type = 'prescriptions' and entity_id = ${id}`;
    expect(audit.map((a) => a.action)).toEqual(["prescription_replaced"]);

    // The replaced prescription is final: no second replacement, no cancellation, no change.
    expect((await saveDraft(old.patient, old.appointment, [item(drug.otc)], { replacesId: old.id })).error_code).toBe("replaced_not_current");
    expect((await pgError(() => asServer((tx) => tx`update public.prescriptions set status = 'signed' where id = ${old.id}`))).message).toContain(
      "replaced or cancelled prescription cannot change",
    );

    // In a later consultation the replacement is a record of its own that still names what it replaces.
    const later = await visit(old.patient, doctors.a);
    const next = await saveDraft(old.patient, later, [item(drug.otc)], { replacesId: id });
    const signedNext = await sign(String(next.prescription_id), { reason: "Keyingi qabulda yangilandi" });
    expect(signedNext.error_code).toBeNull();
    const [nextRecord] = await sql`select corrects_record_id from public.clinical_records where id = ${String(signedNext.clinical_record_id)}`;
    expect(nextRecord.corrects_record_id).toBeNull();
    expect((await prescription(id)).status).toBe("replaced");

    // Another doctor cannot replace this doctor's prescription.
    const theirs = await visit(old.patient, doctors.c);
    expect((await saveDraft(old.patient, theirs, [item(drug.otc)], { doctor: "c", replacesId: String(next.prescription_id) })).error_code).toBe(
      "replaced_not_found",
    );
  });

  it("cancels with a reason, as a correction record, and keeps everything", async () => {
    const { id, patient } = await signed([item(drug.rx)]);
    const cancel = (reason: string | null, doctor: keyof typeof doctors = "a") =>
      asServer(async (tx) => (await tx<{ r: Result }[]>`select public.cancel_prescription(${clinicA}::uuid, ${doctors[doctor]}::uuid, ${profiles[doctor]}::uuid, ${id}::uuid, ${reason}) as r`)[0].r);

    expect((await cancel(null)).error_code).toBe("reason_required");
    expect((await cancel("  ")).error_code).toBe("reason_required");
    expect((await cancel("Boshqa shifokor", "c")).error_code).toBe("prescription_not_found");

    const result = await cancel("Qz-bekor: bemor rad etdi");
    expect(result.error_code).toBeNull();
    const rx = await prescription(id);
    expect(rx).toMatchObject({ status: "cancelled", cancel_reason: "Qz-bekor: bemor rad etdi" });
    const [record] = await sql`select corrects_record_id, summary, author_doctor_id from public.clinical_records where id = ${rx.cancel_record_id}`;
    expect(record).toMatchObject({ corrects_record_id: rx.clinical_record_id, summary: "Retsept bekor qilindi", author_doctor_id: doctors.a });
    expect(await sql`select 1 from public.prescription_items where prescription_id = ${id}`).toHaveLength(1);

    expect((await cancel("Yana")).error_code).toBe("not_current");
    const audit = JSON.stringify(await sql`select action, new_values from public.audit_events where entity_type = 'prescriptions' and entity_id = ${id}`);
    expect(audit).toContain("prescription_cancelled");
    expect(audit).not.toContain("Qz-bekor");
    expect(await sql`select 1 from public.audit_events where action = 'prescription_cancelled' and patient_id = ${patient}`).toHaveLength(1);
  });

  it("records the national e-prescription number on the current prescription only", async () => {
    const record = (id: string, number: string, doctor: keyof typeof doctors = "a") =>
      asServer(async (tx) => (await tx<{ r: Result }[]>`select public.record_national_rx_number(${clinicA}::uuid, ${doctors[doctor]}::uuid, ${profiles[doctor]}::uuid, ${id}::uuid, ${number}) as r`)[0].r);

    const rxOnly = await signed([item(drug.rx)]);
    expect((await record(rxOnly.id, "ab")).error_code).toBe("number_invalid");
    expect((await record(rxOnly.id, "<script>")).error_code).toBe("number_invalid");
    expect((await record(rxOnly.id, "er-2026/000123", "c")).error_code).toBe("prescription_not_found");
    expect((await record(rxOnly.id, "er-2026/000123")).error_code).toBeNull();
    expect(await prescription(rxOnly.id)).toMatchObject({ national_rx_number: "ER-2026/000123", national_rx_recorded_by: profiles.a, status: "signed" });

    // Nothing to record when no item is prescription-only; nothing on a draft.
    const otc = await signed([item(drug.otc)]);
    expect((await record(otc.id, "ER-2026/000124")).error_code).toBe("national_rx_not_required");
    const draft = await saveDraft(rxOnly.patient, rxOnly.appointment, [item(drug.rx)]);
    expect((await record(String(draft.prescription_id), "ER-2026/000125")).error_code).toBe("not_current");
  });

  // -------------------------------------------------------------------------
  // Verification (RX-07)
  // -------------------------------------------------------------------------

  it("verifies a code as genuine and current without revealing medicines or the patient", async () => {
    const verify = (hash: string) => asServer((tx) => tx<Record<string, unknown>[]>`select * from public.verify_prescription_code(${hash})`);
    const { id, hash } = await signed([item(drug.rx)]);

    const [found] = await verify(hash);
    expect(Object.keys(found).sort()).toEqual(["clinic_name", "clinic_timezone", "doctor_name", "signed_at", "status"]);
    expect(found).toMatchObject({ clinic_name: `Rx Clinic A ${suffix}`, doctor_name: `Dr A ${suffix}`, status: "signed", clinic_timezone: "Asia/Tashkent" });

    expect(await verify(codeHash())).toEqual([]);
    expect(await verify("' or 1=1 --")).toEqual([]);

    await asServer((tx) => tx`select public.cancel_prescription(${clinicA}::uuid, ${doctors.a}::uuid, ${profiles.a}::uuid, ${id}::uuid, 'Sinov uchun bekor')`);
    expect((await verify(hash))[0].status).toBe("cancelled");

    // Two prescriptions can never share a code.
    const other = await saveDraft((await prescription(id)).patient_id, (await prescription(id)).appointment_id, [item(drug.otc)]);
    expect((await pgError(() => sign(String(other.prescription_id), { hash }))).code).toBe("23505");
  });

  // -------------------------------------------------------------------------
  // Templates
  // -------------------------------------------------------------------------

  it("keeps templates per doctor and bounded", async () => {
    const insert = (values: Record<string, unknown>) =>
      asServer((tx) => tx`insert into public.prescription_templates ${tx({ clinic_id: clinicA, doctor_id: doctors.a, created_by: profiles.a, ...values })}`);
    const items = sql.json([{ drugId: drug.otc, dose: 1 }]);
    await insert({ name: `Qz shablon ${suffix}`, items });
    expect((await pgError(() => insert({ name: `QZ SHABLON ${suffix}`, items }))).code).toBe("23505");
    expect((await pgError(() => insert({ name: "Qz bo‘sh", items: sql.json([]) }))).code).toBe("23514");
    expect((await pgError(() => insert({ name: "Qz obyekt", items: sql.json({}) }))).code).toBe("23514");
    // A doctor record of another clinic cannot own a template here.
    expect((await pgError(() => insert({ name: "Qz begona", items, doctor_id: doctors.k }))).code).toBe("23503");
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { withoutGlobalSweeps } from "@/test/referral-sweep-lock";

/**
 * Referral data model (Phase 1) — the database-level guarantees of
 * supabase/migrations/20260926000001_referrals.sql, exercised directly
 * against Postgres (no referral API or UI exists yet): valid referrals,
 * cross-clinic rejection, the doctor/patient relationship, required fields,
 * status transitions, RLS/tenant isolation and the audit trail.
 *
 * Staff sessions are simulated the way PostgREST runs every request:
 * `set local role anon|authenticated|service_role` plus the JWT claims in
 * request.jwt.claims (which auth.uid() reads). Server writes run as
 * service_role, exactly like the app's admin client.
 *
 * Connects with SUPABASE_DB_URL (default: the Supabase CLI local database).
 * Requires the migrations (`npm run db:reset-local`); skips with a warning
 * when the database is unreachable or the referrals migration is missing.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

async function probeDatabase(): Promise<string | null> {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    const [row] = await probe<{ has_referrals: boolean; can_switch_roles: boolean }[]>`
      select
        to_regclass('public.referrals') is not null as has_referrals,
        pg_has_role(current_user, 'anon', 'MEMBER')
          and pg_has_role(current_user, 'authenticated', 'MEMBER')
          and pg_has_role(current_user, 'service_role', 'MEMBER') as can_switch_roles`;
    if (!row.has_referrals) return "referrals migration not applied — run `npm run db:reset-local`";
    if (!row.can_switch_roles) return "database user cannot switch to anon/authenticated/service_role";
    return null;
  } catch (e) {
    return `database unreachable via SUPABASE_DB_URL — ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    await probe.end({ timeout: 1 });
  }
}

const unavailable = await probeDatabase();
if (unavailable) {
  process.stderr.write(`\n⚠️  referral database suite SKIPPED (${unavailable})\n\n`);
}

const describeDb = describe.skipIf(unavailable !== null);

type Tx = postgres.TransactionSql;
type Values = Record<string, string | Date | null>;
type Referral = {
  id: string;
  clinic_id: string;
  patient_id: string;
  referring_doctor_id: string;
  referred_to_doctor_id: string;
  originating_appointment_id: string;
  follow_up_appointment_id: string | null;
  creation_key: string | null;
  reason: string;
  handoff_note: string | null;
  priority: string;
  status: string;
  expires_at: Date;
  created_by: string;
  accepted_at: Date | null;
  accepted_by: string | null;
  started_at: Date | null;
  started_by: string | null;
  declined_at: Date | null;
  declined_by: string | null;
  declined_reason: string | null;
  completed_at: Date | null;
  completed_by: string | null;
  revoked_at: Date | null;
  revoked_by: string | null;
  revoked_reason: string | null;
  created_at: Date;
};
type AuditRow = {
  action: string;
  actor_id: string | null;
  actor_type: string;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown>;
};
type Visit = { patientId: string; appointmentId: string };

async function pgError(run: () => Promise<unknown>): Promise<postgres.PostgresError> {
  try {
    await run();
  } catch (e) {
    if (e instanceof postgres.PostgresError) return e;
    throw e;
  }
  throw new Error("expected the database to reject the statement");
}

describeDb("referrals data model (Phase 1)", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const clinicA = randomUUID();
  const clinicB = randomUUID();
  const serviceA = randomUUID();
  const serviceB = randomUUID();

  const profiles = {
    referrer: randomUUID(),
    receiver: randomUUID(),
    bystander: randomUUID(),
    former: randomUUID(),
    sleeper: randomUUID(),
    receptionist: randomUUID(),
    manager: randomUUID(),
    owner: randomUUID(),
    doctorB: randomUUID(),
    ownerB: randomUUID(),
  };

  const doctors = {
    referrer: randomUUID(),
    receiver: randomUUID(),
    bystander: randomUUID(),
    former: randomUUID(),
    unlinked: randomUUID(),
    inactive: randomUUID(),
    roleless: randomUUID(),
    clinicB: randomUUID(),
  };

  let day = 0;

  async function as<T>(
    role: "anon" | "authenticated" | "service_role",
    sub: string | null,
    run: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    return (await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      await tx`select set_config('request.jwt.claims', ${JSON.stringify(sub ? { sub, role } : { role })}, true)`;
      return run(tx);
    })) as T;
  }

  const asServer = <T>(run: (tx: Tx) => Promise<T>) => as("service_role", null, run);
  const asStaff = <T>(profileId: string, run: (tx: Tx) => Promise<T>) => as("authenticated", profileId, run);
  const asAnon = <T>(run: (tx: Tx) => Promise<T>) => as("anon", null, run);

  async function newPatient(clinicId: string = clinicA): Promise<string> {
    const id = randomUUID();
    await sql`insert into public.patients (id, clinic_id, full_name) values (${id}, ${clinicId}, ${`Referral patient ${suffix}`})`;
    return id;
  }

  /** A consultation: an appointment in which `doctor` saw the patient. */
  async function consultation(
    opts: { doctor?: string; clinic?: string; status?: string; patient?: string; createdBy?: string } = {},
  ): Promise<Visit> {
    const clinicId = opts.clinic ?? clinicA;
    const patientId = opts.patient ?? (await newPatient(clinicId));
    const start = new Date(Date.UTC(2026, 0, 5, 5, 0) + day++ * 86_400_000);
    const [row] = await sql<{ id: string }[]>`
      insert into public.appointments ${sql({
        clinic_id: clinicId,
        patient_id: patientId,
        doctor_id: opts.doctor ?? (clinicId === clinicA ? doctors.referrer : doctors.clinicB),
        service_id: clinicId === clinicA ? serviceA : serviceB,
        start_at: start,
        end_at: new Date(start.getTime() + 30 * 60_000),
        status: opts.status ?? "in_progress",
        source: "walk_in",
        created_by: opts.createdBy ?? null,
      })}
      returning id`;
    return { patientId, appointmentId: row.id };
  }

  function referralValues(visit: Visit, overrides: Values = {}): Values {
    return {
      clinic_id: clinicA,
      patient_id: visit.patientId,
      referring_doctor_id: doctors.referrer,
      referred_to_doctor_id: doctors.receiver,
      originating_appointment_id: visit.appointmentId,
      reason: `Recurrent palpitations, please assess for arrhythmia (${suffix})`,
      handoff_note: `Resting ECG recorded at today's visit (${suffix})`,
      priority: "urgent",
      created_by: profiles.referrer,
      ...overrides,
    };
  }

  function insertReferral(values: Values): Promise<Referral> {
    return asServer(async (tx) => {
      const [row] = await tx<Referral[]>`insert into public.referrals ${tx(values)} returning *`;
      return row;
    });
  }

  async function openReferral(overrides: Values = {}): Promise<Referral> {
    return insertReferral(referralValues(await consultation(), overrides));
  }

  function transition(id: string, patch: Values): Promise<Referral> {
    return asServer(async (tx) => {
      const [row] = await tx<Referral[]>`update public.referrals set ${tx(patch)} where id = ${id} returning *`;
      return row;
    });
  }

  const accept = (id: string) => transition(id, { status: "accepted", accepted_by: profiles.receiver });

  /** The receiving doctor's consultation for the referral starts: linked as its follow-up, the referral is in progress. */
  async function startConsultation(referral: Referral): Promise<Referral> {
    const own = await consultation({ doctor: doctors.receiver, patient: referral.patient_id, status: "in_progress" });
    return transition(referral.id, { follow_up_appointment_id: own.appointmentId });
  }

  function auditTrail(referralId: string): Promise<AuditRow[]> {
    return sql<AuditRow[]>`
      select action, actor_id, actor_type, old_values, new_values
      from public.audit_events
      where entity_type = 'referrals' and entity_id = ${referralId}
      order by created_at, action`;
  }

  /**
   * Whether the RLS policy alone lets `profileId` read the referral. Signed-in
   * roles have no SELECT on referrals (reads go through the audited API), so
   * the grant is added inside a transaction that is always rolled back — the
   * policy is checked as the backstop it is.
   */
  const ROLLBACK = Symbol("rollback");
  async function visibleTo(profileId: string, referralId: string, role: "authenticated" | "anon" = "authenticated"): Promise<boolean> {
    let visible = false;
    await sql
      .begin(async (tx) => {
        await tx.unsafe(`grant select on public.referrals to ${role}`);
        await tx.unsafe(`set local role ${role}`);
        await tx`select set_config('request.jwt.claims', ${JSON.stringify(role === "anon" ? { role } : { sub: profileId, role })}, true)`;
        visible = (await tx`select id from public.referrals where id = ${referralId}`).length === 1;
        throw ROLLBACK;
      })
      .catch((e) => {
        if (e !== ROLLBACK) throw e;
      });
    return visible;
  }

  async function setDoctorActive(doctorId: string, active: boolean) {
    await sql`update public.doctors set active = ${active} where id = ${doctorId}`;
  }

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 4, onnotice: () => {} });

    await sql`insert into public.clinics ${sql([
      { id: clinicA, name: `Referral Clinic A ${suffix}`, slug: `referral-a-${suffix}`, timezone: "Asia/Tashkent" },
      { id: clinicB, name: `Referral Clinic B ${suffix}`, slug: `referral-b-${suffix}`, timezone: "Asia/Tashkent" },
    ])}`;

    const users = Object.entries(profiles).map(([name, id]) => ({ id, email: `referral-${name}-${suffix}@test.local` }));
    await sql`insert into auth.users ${sql(users)}`;
    await sql`insert into public.profiles ${sql(users.map((u) => ({ id: u.id, full_name: u.email })))}`;

    await sql`insert into public.staff_roles ${sql([
      { clinic_id: clinicA, profile_id: profiles.referrer, role: "doctor" },
      { clinic_id: clinicA, profile_id: profiles.receiver, role: "doctor" },
      { clinic_id: clinicA, profile_id: profiles.bystander, role: "doctor" },
      { clinic_id: clinicA, profile_id: profiles.former, role: "doctor" },
      { clinic_id: clinicA, profile_id: profiles.sleeper, role: "doctor" },
      { clinic_id: clinicA, profile_id: profiles.receptionist, role: "receptionist" },
      { clinic_id: clinicA, profile_id: profiles.manager, role: "manager" },
      { clinic_id: clinicA, profile_id: profiles.owner, role: "owner" },
      { clinic_id: clinicB, profile_id: profiles.doctorB, role: "doctor" },
      { clinic_id: clinicB, profile_id: profiles.ownerB, role: "owner" },
    ])}`;

    await sql`insert into public.doctors ${sql([
      { id: doctors.referrer, clinic_id: clinicA, profile_id: profiles.referrer, name: `Dr Referrer ${suffix}`, active: true },
      { id: doctors.receiver, clinic_id: clinicA, profile_id: profiles.receiver, name: `Dr Receiver ${suffix}`, active: true },
      { id: doctors.bystander, clinic_id: clinicA, profile_id: profiles.bystander, name: `Dr Bystander ${suffix}`, active: true },
      { id: doctors.former, clinic_id: clinicA, profile_id: profiles.former, name: `Dr Former ${suffix}`, active: true },
      { id: doctors.unlinked, clinic_id: clinicA, profile_id: null, name: `Dr Unlinked ${suffix}`, active: true },
      { id: doctors.inactive, clinic_id: clinicA, profile_id: profiles.sleeper, name: `Dr Inactive ${suffix}`, active: false },
      // Linked to an account that holds no doctor role.
      { id: doctors.roleless, clinic_id: clinicA, profile_id: profiles.receptionist, name: `Dr Roleless ${suffix}`, active: true },
      { id: doctors.clinicB, clinic_id: clinicB, profile_id: profiles.doctorB, name: `Dr Clinic B ${suffix}`, active: true },
    ])}`;

    await sql`insert into public.services ${sql([
      { id: serviceA, clinic_id: clinicA, name: `Referral consult A ${suffix}`, duration_minutes: 30, price: 100000 },
      { id: serviceB, clinic_id: clinicB, name: `Referral consult B ${suffix}`, duration_minutes: 30, price: 100000 },
    ])}`;

    const hours = [doctors.referrer, doctors.receiver, doctors.bystander, doctors.former, doctors.clinicB].flatMap((doctorId) =>
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        clinic_id: doctorId === doctors.clinicB ? clinicB : clinicA,
        doctor_id: doctorId,
        weekday,
        start_time: "00:00",
        end_time: "23:59",
      })),
    );
    await sql`insert into public.doctor_working_hours ${sql(hours)}`;
  });

  afterAll(async () => {
    if (!sql) return;
    const clinics = [clinicA, clinicB];
    // Dependency order: the audit triggers on appointments/staff_roles need
    // their clinic to still exist while those rows are removed.
    await sql`delete from public.referrals where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.appointments where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.staff_roles where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.doctors where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.patients where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.services where clinic_id in ${sql(clinics)}`;
    await sql`delete from public.clinics where id in ${sql(clinics)}`;
    await sql`delete from auth.users where id in ${sql(Object.values(profiles))}`;
    await sql.end({ timeout: 5 });
  });

  // ---------- Valid referral ----------

  describe("valid referral", () => {
    it("is created pending from the referring doctor's consultation, with server-controlled timestamps", async () => {
      const visit = await consultation();
      const referral = await insertReferral(referralValues(visit, { created_at: new Date("2020-01-01T00:00:00Z") }));
      const [{ now }] = await sql<{ now: Date }[]>`select now()`;

      expect(referral).toMatchObject({
        clinic_id: clinicA,
        patient_id: visit.patientId,
        referring_doctor_id: doctors.referrer,
        referred_to_doctor_id: doctors.receiver,
        originating_appointment_id: visit.appointmentId,
        priority: "urgent",
        status: "pending",
        created_by: profiles.referrer,
        accepted_at: null,
        declined_at: null,
        completed_at: null,
        revoked_at: null,
      });
      expect(Math.abs(now.getTime() - referral.created_at.getTime())).toBeLessThan(60_000);
      const validityDays = (referral.expires_at.getTime() - referral.created_at.getTime()) / 86_400_000;
      expect(validityDays).toBeCloseTo(90, 5);
    });

    it("defaults to routine priority, and the handoff note is optional", async () => {
      const visit = await consultation({ status: "completed" });
      const values = referralValues(visit);
      delete values.priority;
      delete values.handoff_note;
      const referral = await insertReferral(values);
      expect(referral.priority).toBe("routine");
      expect(referral.handoff_note).toBeNull();
    });

    it("audits the creation with the referring doctor as actor and without any clinical text", async () => {
      const referral = await openReferral();
      const trail = await auditTrail(referral.id);

      expect(trail).toHaveLength(1);
      expect(trail[0]).toMatchObject({ action: "referral_created", actor_id: profiles.referrer, actor_type: "staff" });
      expect(trail[0].new_values).toMatchObject({
        status: "pending",
        priority: "urgent",
        patient_id: referral.patient_id,
        referring_doctor_id: doctors.referrer,
        referred_to_doctor_id: doctors.receiver,
      });
      const logged = JSON.stringify(trail);
      expect(logged).not.toContain(referral.reason);
      expect(logged).not.toContain(referral.handoff_note!);
    });

    it("indexes clinic, patient, both doctors and status", async () => {
      const rows = await sql<{ leading_column: string }[]>`
        select a.attname as leading_column
        from pg_index i
        join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
        where i.indrelid = 'public.referrals'::regclass`;
      const leading = rows.map((r) => r.leading_column);
      for (const column of ["clinic_id", "patient_id", "referring_doctor_id", "referred_to_doctor_id", "status"]) {
        expect(leading).toContain(column);
      }
    });
  });

  // ---------- Cross-clinic rejection ----------

  const SAME_CLINIC_PATIENT_KEYS = ["referrals_patient_same_clinic_fkey", "referrals_originating_appointment_fkey"];

  describe("cross-clinic referral rejection", () => {
    it("rejects a patient from another clinic", async () => {
      const visit = await consultation();
      const foreignPatient = await newPatient(clinicB);
      const err = await pgError(() => insertReferral(referralValues(visit, { patient_id: foreignPatient })));
      expect(err.code).toBe("23503");
      // The patient key and the consultation key (which also pins the
      // patient) both refuse it; which reports first depends on the order
      // the constraints were created in.
      expect(SAME_CLINIC_PATIENT_KEYS).toContain(err.constraint_name);
    });

    it("rejects a referring doctor from another clinic", async () => {
      const visit = await consultation();
      const err = await pgError(() =>
        insertReferral(referralValues(visit, { referring_doctor_id: doctors.clinicB, created_by: profiles.doctorB })),
      );
      expect(err.code).toBe("23503");
      expect(err.constraint_name).toBe("referrals_referring_doctor_same_clinic_fkey");
    });

    it("rejects a receiving doctor from another clinic", async () => {
      const visit = await consultation();
      const err = await pgError(() => insertReferral(referralValues(visit, { referred_to_doctor_id: doctors.clinicB })));
      expect(err.code).toBe("23503");
      expect(err.constraint_name).toBe("referrals_referred_to_doctor_same_clinic_fkey");
    });

    it("rejects a referral filed under a clinic other than its patient's and doctors'", async () => {
      const visit = await consultation();
      const err = await pgError(() => insertReferral(referralValues(visit, { clinic_id: clinicB })));
      expect(err.code).toBe("23503");
      expect(err.constraint_name).toMatch(/^referrals_.*(same_clinic|originating_appointment)_fkey$/);
    });

    it("rejects a consultation that took place in another clinic", async () => {
      const visit = await consultation();
      const foreignVisit = await consultation({ clinic: clinicB, status: "completed" });
      const err = await pgError(() =>
        insertReferral(referralValues(visit, { originating_appointment_id: foreignVisit.appointmentId })),
      );
      expect(err.code).toBe("23503");
      expect(err.constraint_name).toBe("referrals_originating_appointment_fkey");
    });
  });

  // ---------- Doctor/patient relationship ----------

  describe("invalid doctor/patient relationship", () => {
    it("rejects a referral from a doctor who never saw the patient", async () => {
      const visit = await consultation();
      const err = await pgError(() =>
        insertReferral(referralValues(visit, { referring_doctor_id: doctors.bystander, created_by: profiles.bystander })),
      );
      expect(err.code).toBe("23503");
      expect(err.constraint_name).toBe("referrals_originating_appointment_fkey");
    });

    it("rejects a consultation that belongs to a different patient", async () => {
      const visit = await consultation();
      const otherPatientsVisit = await consultation();
      const err = await pgError(() =>
        insertReferral(referralValues(visit, { originating_appointment_id: otherPatientsVisit.appointmentId })),
      );
      expect(err.code).toBe("23503");
      expect(err.constraint_name).toBe("referrals_originating_appointment_fkey");
    });

    it("rejects a consultation the patient had with a different doctor", async () => {
      const visit = await consultation();
      const withBystander = await consultation({ doctor: doctors.bystander, patient: visit.patientId });
      const err = await pgError(() =>
        insertReferral(referralValues(visit, { originating_appointment_id: withBystander.appointmentId })),
      );
      expect(err.code).toBe("23503");
      expect(err.constraint_name).toBe("referrals_originating_appointment_fkey");
    });

    it.each(["pending", "confirmed", "checked_in", "cancelled", "no_show"])(
      "rejects a consultation that has not taken place (%s)",
      async (status) => {
        const visit = await consultation({ status });
        const err = await pgError(() => insertReferral(referralValues(visit)));
        expect(err.code).toBe("P0001");
        expect(err.message).toMatch(/must be in progress or completed/);
      },
    );

    it("requires created_by to be the referring doctor's own account", async () => {
      for (const impostor of [profiles.receiver, profiles.receptionist, profiles.manager, profiles.owner]) {
        const visit = await consultation();
        const err = await pgError(() => insertReferral(referralValues(visit, { created_by: impostor })));
        expect(err.code).toBe("P0001");
        expect(err.message).toMatch(/created_by must be the referring doctor/);
      }
    });

    it("rejects a referral from a deactivated referring doctor", async () => {
      const visit = await consultation({ doctor: doctors.former });
      await setDoctorActive(doctors.former, false);
      try {
        const err = await pgError(() =>
          insertReferral(referralValues(visit, { referring_doctor_id: doctors.former, created_by: profiles.former })),
        );
        expect(err.message).toMatch(/referring doctor is inactive/);
      } finally {
        await setDoctorActive(doctors.former, true);
      }
    });

    it("rejects a receiving doctor who is inactive or has no doctor account", async () => {
      const visit = await consultation();
      const inactive = await pgError(() => insertReferral(referralValues(visit, { referred_to_doctor_id: doctors.inactive })));
      expect(inactive.message).toMatch(/receiving doctor is inactive/);

      for (const target of [doctors.unlinked, doctors.roleless]) {
        const err = await pgError(() => insertReferral(referralValues(visit, { referred_to_doctor_id: target })));
        expect(err.message).toMatch(/receiving doctor has no linked doctor account/);
      }
    });

    it("rejects self-referral", async () => {
      const visit = await consultation();
      const sameRecord = await pgError(() => insertReferral(referralValues(visit, { referred_to_doctor_id: doctors.referrer })));
      expect(sameRecord.code).toBe("23514");
      expect(sameRecord.constraint_name).toBe("referrals_not_self_referral");
    });

    it("an account can hold only one doctor record per clinic, so self-referral can't hide behind a second record", async () => {
      const err = await pgError(
        () => sql`insert into public.doctors (clinic_id, profile_id, name) values (${clinicA}, ${profiles.referrer}, ${`Dr Twin ${suffix}`})`,
      );
      expect(err.code).toBe("23505");
      expect(err.constraint_name).toBe("doctors_clinic_profile_key");
    });
  });

  // ---------- Required fields ----------

  describe("required fields", () => {
    it.each([
      "clinic_id",
      "patient_id",
      "referring_doctor_id",
      "referred_to_doctor_id",
      "originating_appointment_id",
      "reason",
      "created_by",
    ])("requires %s", async (column) => {
      const values = referralValues(await consultation());
      delete values[column];
      const err = await pgError(() => insertReferral(values));
      expect(err.code).toBe("23502");
      expect(err.column_name).toBe(column);
    });

    it("rejects a blank or oversized reason and handoff note", async () => {
      const cases: Array<[Values, string]> = [
        [{ reason: " \t " }, "referrals_reason_check"],
        [{ reason: "x".repeat(2001) }, "referrals_reason_check"],
        [{ handoff_note: " \n " }, "referrals_handoff_note_check"],
        [{ handoff_note: "x".repeat(4001) }, "referrals_handoff_note_check"],
      ];
      const visit = await consultation();
      for (const [overrides, constraint] of cases) {
        const err = await pgError(() => insertReferral(referralValues(visit, overrides)));
        expect(err.code).toBe("23514");
        expect(err.constraint_name).toBe(constraint);
      }
    });

    it("accepts only the defined priorities", async () => {
      const visit = await consultation();
      const err = await pgError(() => insertReferral(referralValues(visit, { priority: "stat" })));
      expect(err.code).toBe("22P02");
    });

    it("keeps the validity window in the future and at most 180 days long — no open-ended referral", async () => {
      const visit = await consultation();
      for (const expiresAt of [new Date(Date.now() - 86_400_000), new Date(Date.now() + 181 * 86_400_000), new Date(Date.now() + 366 * 86_400_000)]) {
        const err = await pgError(() => insertReferral(referralValues(visit, { expires_at: expiresAt })));
        expect(err.code).toBe("23514");
        expect(err.constraint_name).toBe("referrals_expiry_window_check");
      }
      const longest = await openReferral({ expires_at: new Date(Date.now() + 179 * 86_400_000) });
      expect(longest.status).toBe("pending");
      // Without an explicit expiry it still ends: 90 days by default.
      const byDefault = await openReferral();
      expect(Math.round((byDefault.expires_at.getTime() - byDefault.created_at.getTime()) / 86_400_000)).toBe(90);
      // …and it can never be moved later.
      const extended = await pgError(() => transition(byDefault.id, { expires_at: new Date(Date.now() + 120 * 86_400_000) }));
      expect(extended.message).toMatch(/cannot be edited/);
    });

    it("must start as pending", async () => {
      const visit = await consultation();
      const err = await pgError(() =>
        insertReferral(referralValues(visit, { status: "accepted", accepted_by: profiles.receiver, accepted_at: new Date() })),
      );
      expect(err.message).toMatch(/must be created as pending/);
    });
  });

  // ---------- Status transitions ----------

  describe("status transitions", () => {
    it("pending -> accepted -> in_progress -> completed by the receiving doctor, stamped by the database and audited", async () => {
      const referral = await openReferral();
      const accepted = await transition(referral.id, {
        status: "accepted",
        accepted_by: profiles.receiver,
        accepted_at: new Date("2000-01-01T00:00:00Z"),
      });
      expect(accepted.status).toBe("accepted");
      expect(accepted.accepted_by).toBe(profiles.receiver);
      expect(accepted.accepted_at!.getTime()).toBeGreaterThanOrEqual(referral.created_at.getTime());

      // Linking the receiving doctor's started consultation moves it on.
      const started = await startConsultation(accepted);
      expect(started).toMatchObject({ status: "in_progress", started_by: profiles.receiver });
      expect(started.started_at!.getTime()).toBeGreaterThanOrEqual(accepted.accepted_at!.getTime());

      const completed = await transition(referral.id, { status: "completed", completed_by: profiles.receiver });
      expect(completed.status).toBe("completed");
      expect(completed.completed_at!.getTime()).toBeGreaterThanOrEqual(started.started_at!.getTime());
      expect(completed.accepted_at).toEqual(accepted.accepted_at);
      expect(completed.started_at).toEqual(started.started_at);

      const trail = await auditTrail(referral.id);
      expect(trail.map((t) => [t.action, t.actor_id])).toEqual([
        ["referral_created", profiles.referrer],
        ["referral_accepted", profiles.receiver],
        ["referral_in_progress", profiles.receiver],
        ["referral_completed", profiles.receiver],
      ]);
      expect(trail[1].old_values).toEqual({ status: "pending" });
      expect(trail[2].old_values).toEqual({ status: "accepted", follow_up_appointment_id: null });
      expect(trail[2].new_values).toMatchObject({ status: "in_progress", follow_up_appointment_id: started.follow_up_appointment_id });
      expect(trail[3].old_values).toEqual({ status: "in_progress" });
    });

    it("is in progress only once the receiving doctor's consultation has started — whoever starts it", async () => {
      const referral = await openReferral();
      await accept(referral.id);
      // Not by declaration: there is no consultation yet.
      const early = await pgError(() => transition(referral.id, { status: "in_progress", started_by: profiles.receiver }));
      expect(early.message).toMatch(/in progress only once its follow-up consultation has started/);

      // A booked follow-up that has not started is not enough either.
      const booked = await consultation({ doctor: doctors.receiver, patient: referral.patient_id, status: "confirmed" });
      const linked = await transition(referral.id, { follow_up_appointment_id: booked.appointmentId });
      expect(linked.status).toBe("accepted");
      const stillEarly = await pgError(() => transition(referral.id, { status: "in_progress", started_by: profiles.receiver }));
      expect(stillEarly.message).toMatch(/in progress only once/);

      // The visit starting — from the doctor's queue or the front desk — moves it.
      await sql`update public.appointments set status = 'in_progress' where id = ${booked.appointmentId}`;
      const [row] = await sql<Referral[]>`select * from public.referrals where id = ${referral.id}`;
      expect(row).toMatchObject({ status: "in_progress", started_by: profiles.receiver });
      expect((await auditTrail(referral.id)).at(-1)).toMatchObject({ action: "referral_in_progress", actor_id: profiles.receiver });

      // Checking in is not starting. And a visit always starts — even when the
      // referral can't follow (receiving doctor deactivated meanwhile), it
      // simply stays accepted; afterwards only the receiving doctor moves it.
      const other = await openReferral();
      await accept(other.id);
      const otherVisit = await consultation({ doctor: doctors.receiver, patient: other.patient_id, status: "confirmed" });
      await transition(other.id, { follow_up_appointment_id: otherVisit.appointmentId });
      await sql`update public.appointments set status = 'checked_in' where id = ${otherVisit.appointmentId}`;
      expect((await sql`select status from public.referrals where id = ${other.id}`)[0].status).toBe("accepted");
      await setDoctorActive(doctors.receiver, false);
      try {
        await sql`update public.appointments set status = 'in_progress' where id = ${otherVisit.appointmentId}`;
        expect((await sql`select status from public.appointments where id = ${otherVisit.appointmentId}`)[0].status).toBe("in_progress");
        expect((await sql`select status from public.referrals where id = ${other.id}`)[0].status).toBe("accepted");
      } finally {
        await setDoctorActive(doctors.receiver, true);
      }
      for (const actor of [profiles.bystander, profiles.referrer, profiles.manager]) {
        const err = await pgError(() => transition(other.id, { status: "in_progress", started_by: actor }));
        expect(err.message).toMatch(/only the receiving doctor can mark the referral in_progress/);
      }
      expect(await transition(other.id, { status: "in_progress", started_by: profiles.receiver })).toMatchObject({ status: "in_progress" });
    });

    it("a consultation that took place replaces a booked follow-up that has not started", async () => {
      const referral = await openReferral();
      await accept(referral.id);
      const booked = await consultation({ doctor: doctors.receiver, patient: referral.patient_id, status: "confirmed" });
      await transition(referral.id, { follow_up_appointment_id: booked.appointmentId });

      // Seen earlier than booked: the walk-in becomes the follow-up.
      const started = await startConsultation(referral);
      expect(started.status).toBe("in_progress");
      expect(started.follow_up_appointment_id).not.toBe(booked.appointmentId);

      // A second, not-started booking can't take the place of a started one.
      const fresh = await openReferral();
      await accept(fresh.id);
      const walkIn = await startConsultation(fresh);
      const later = await consultation({ doctor: doctors.receiver, patient: fresh.patient_id, status: "confirmed" });
      const err = await pgError(() => transition(fresh.id, { follow_up_appointment_id: later.appointmentId }));
      expect(err.message).toMatch(/only be booked once the referral is accepted/);
      expect(walkIn.status).toBe("in_progress");
    });

    it("an in-progress referral can be revoked or expire, is still one open referral per pair, and never goes back", async () => {
      const referral = await openReferral();
      await accept(referral.id);
      await startConsultation(referral);
      const duplicate = await pgError(async () =>
        insertReferral(referralValues({ patientId: referral.patient_id, appointmentId: referral.originating_appointment_id })),
      );
      expect(duplicate.constraint_name).toBe("referrals_one_open_per_pair");
      for (const patch of [{ status: "accepted" }, { status: "pending" }] as Values[]) {
        const err = await pgError(() => transition(referral.id, patch));
        expect(err.message).toMatch(/invalid status transition in_progress -> /);
      }
      const early = await pgError(() => transition(referral.id, { status: "expired" }));
      expect(early.message).toMatch(/does not expire until/);
      const revoked = await transition(referral.id, { status: "revoked", revoked_by: profiles.referrer, revoked_reason: "Patient transferred" });
      expect(revoked.status).toBe("revoked");
    });

    it("pending -> declined by the receiving doctor is final", async () => {
      const referral = await openReferral();
      const declined = await transition(referral.id, {
        status: "declined",
        declined_by: profiles.receiver,
        declined_reason: "Outside my specialty",
      });
      expect(declined).toMatchObject({ status: "declined", declined_by: profiles.receiver });
      expect(declined.declined_at).not.toBeNull();

      const err = await pgError(() => transition(referral.id, { status: "accepted", accepted_by: profiles.receiver }));
      expect(err.message).toMatch(/invalid status transition declined -> accepted/);
    });

    it("rejects skipped, reversed and post-terminal transitions", async () => {
      const skip = await openReferral();
      const skipped = await pgError(() => transition(skip.id, { status: "completed", completed_by: profiles.receiver }));
      expect(skipped.message).toMatch(/invalid status transition pending -> completed/);

      const done = await openReferral();
      await transition(done.id, { status: "accepted", accepted_by: profiles.receiver });
      const reversed = await pgError(() => transition(done.id, { status: "pending" }));
      expect(reversed.message).toMatch(/invalid status transition accepted -> pending/);
      // Completed only after the receiving doctor's consultation started.
      const unseen = await pgError(() => transition(done.id, { status: "completed", completed_by: profiles.receiver }));
      expect(unseen.message).toMatch(/invalid status transition accepted -> completed/);

      await startConsultation(done);
      await transition(done.id, { status: "completed", completed_by: profiles.receiver });
      const afterCompletion: Values[] = [
        { status: "revoked", revoked_by: profiles.referrer, revoked_reason: "Too late" },
        { status: "expired" },
        { status: "accepted" },
      ];
      for (const patch of afterCompletion) {
        const err = await pgError(() => transition(done.id, patch));
        expect(err.message).toMatch(/invalid status transition completed -> /);
      }
    });

    it("only the receiving doctor can accept, decline or complete", async () => {
      const referral = await openReferral();
      for (const actor of [profiles.referrer, profiles.bystander, profiles.manager, null]) {
        const err = await pgError(() => transition(referral.id, { status: "accepted", accepted_by: actor }));
        expect(err.message).toMatch(/only the receiving doctor can mark the referral accepted/);
      }
      const decline = await pgError(() =>
        transition(referral.id, { status: "declined", declined_by: profiles.owner }),
      );
      expect(decline.message).toMatch(/only the receiving doctor can mark the referral declined/);

      await setDoctorActive(doctors.receiver, false);
      try {
        const inactive = await pgError(() =>
          transition(referral.id, { status: "accepted", accepted_by: profiles.receiver }),
        );
        expect(inactive.message).toMatch(/only the receiving doctor/);
      } finally {
        await setDoctorActive(doctors.receiver, true);
      }
    });

    it("revocation: by the referring doctor or clinic management, always with a reason", async () => {
      const referral = await openReferral();
      for (const actor of [profiles.receptionist, profiles.receiver, profiles.bystander, profiles.ownerB]) {
        const err = await pgError(() =>
          transition(referral.id, { status: "revoked", revoked_by: actor, revoked_reason: "Not needed" }),
        );
        expect(err.message).toMatch(/only the referring doctor or clinic management can revoke/);
      }
      const reasonless = await pgError(() => transition(referral.id, { status: "revoked", revoked_by: profiles.referrer }));
      expect(reasonless.code).toBe("23514");
      expect(reasonless.constraint_name).toBe("referrals_revoked_state_check");

      const revoked = await transition(referral.id, {
        status: "revoked",
        revoked_by: profiles.referrer,
        revoked_reason: "Patient referred to the wrong specialty",
      });
      expect(revoked.status).toBe("revoked");
      expect(revoked.revoked_at).not.toBeNull();

      const accepted = await openReferral();
      await transition(accepted.id, { status: "accepted", accepted_by: profiles.receiver });
      const byManagement = await transition(accepted.id, {
        status: "revoked",
        revoked_by: profiles.manager,
        revoked_reason: "Duplicate of an in-house request",
      });
      expect(byManagement.status).toBe("revoked");
      expect(byManagement.accepted_at).not.toBeNull();

      const trail = await auditTrail(accepted.id);
      expect(trail.at(-1)).toMatchObject({ action: "referral_revoked", actor_id: profiles.manager, actor_type: "staff" });
      expect(JSON.stringify(trail)).not.toContain("Duplicate of an in-house request");
    });

    it("keeps the referral content, parties and provenance immutable", async () => {
      const referral = await openReferral();
      const edits: Values[] = [
        { reason: "Edited reason" },
        { handoff_note: "Edited note" },
        { priority: "routine" },
        { referred_to_doctor_id: doctors.bystander },
        { patient_id: await newPatient() },
        { expires_at: new Date(Date.now() + 10 * 86_400_000) },
        { created_by: profiles.receiver },
        { clinic_id: clinicB },
      ];
      for (const patch of edits) {
        const err = await pgError(() => transition(referral.id, patch));
        expect(err.message).toMatch(/cannot be edited/);
      }

      const smuggled = await pgError(() =>
        transition(referral.id, { status: "accepted", accepted_by: profiles.receiver, reason: "Edited reason" }),
      );
      expect(smuggled.message).toMatch(/accepted transition may only set its own fields/);

      await transition(referral.id, { status: "accepted", accepted_by: profiles.receiver });
      const rewritten = await pgError(() => transition(referral.id, { accepted_by: profiles.bystander }));
      expect(rewritten.message).toMatch(/cannot be edited/);

      const [unchanged] = await sql<Referral[]>`select * from public.referrals where id = ${referral.id}`;
      expect(unchanged).toMatchObject({ reason: referral.reason, priority: "urgent", accepted_by: profiles.receiver });
      expect((await auditTrail(referral.id)).map((t) => t.action)).toEqual(["referral_created", "referral_accepted"]);
    });

    it("allows one open referral per patient and doctor pair", async () => {
      const visit = await consultation();
      const first = await insertReferral(referralValues(visit));

      const duplicate = await pgError(() => insertReferral(referralValues(visit)));
      expect(duplicate.code).toBe("23505");
      expect(duplicate.constraint_name).toBe("referrals_one_open_per_pair");

      const toAnotherDoctor = await insertReferral(referralValues(visit, { referred_to_doctor_id: doctors.bystander }));
      expect(toAnotherDoctor.status).toBe("pending");

      await transition(first.id, { status: "revoked", revoked_by: profiles.referrer, revoked_reason: "Re-issued" });
      const reissued = await insertReferral(referralValues(visit));
      expect(reissued.status).toBe("pending");
    });

    it(
      "expiry: nothing is accepted after expires_at, expiring early is refused, and the receiving doctor loses access",
      async () => {
        await withoutGlobalSweeps(async () => {
          const visit = await consultation();
          const referral = await asServer(async (tx) => {
            const [{ soon }] = await tx<{ soon: Date }[]>`select now() + interval '2 seconds' as soon`;
            const [row] = await tx<Referral[]>`insert into public.referrals ${tx(referralValues(visit, { expires_at: soon }))} returning *`;
            return row;
          });

          const early = await pgError(() => transition(referral.id, { status: "expired" }));
          expect(early.message).toMatch(/does not expire until/);
          expect(await visibleTo(profiles.receiver, referral.id)).toBe(true);

          await new Promise((resolve) => setTimeout(resolve, 2_100));

          expect(await visibleTo(profiles.receiver, referral.id)).toBe(false);
          expect(await visibleTo(profiles.referrer, referral.id)).toBe(true);

          const late = await pgError(() => transition(referral.id, { status: "accepted", accepted_by: profiles.receiver }));
          expect(late.message).toMatch(/expired at/);

          const expired = await transition(referral.id, { status: "expired" });
          expect(expired.status).toBe("expired");
          const trail = await auditTrail(referral.id);
          expect(trail.at(-1)).toMatchObject({ action: "referral_expired", actor_id: null, actor_type: "system" });
        });
      },
      20_000,
    );
  });

  // ---------- Follow-up booking ----------

  describe("follow-up booking", () => {
    async function acceptedReferral(): Promise<Referral> {
      const referral = await openReferral();
      return transition(referral.id, { status: "accepted", accepted_by: profiles.receiver });
    }

    /** An appointment reception booked for the referral's patient. */
    function followUp(referral: Referral, opts: { doctor?: string; patient?: string; status?: string } = {}) {
      return consultation({
        doctor: opts.doctor ?? doctors.receiver,
        patient: opts.patient ?? referral.patient_id,
        status: opts.status ?? "pending",
        createdBy: profiles.receptionist,
      });
    }

    it("links the appointment booked with the receiving doctor, audited as the staff member who booked it", async () => {
      const referral = await acceptedReferral();
      const booking = await followUp(referral);

      const linked = await transition(referral.id, { follow_up_appointment_id: booking.appointmentId });
      expect(linked.follow_up_appointment_id).toBe(booking.appointmentId);
      expect(linked.status).toBe("accepted");

      const trail = await auditTrail(referral.id);
      expect(trail.at(-1)).toMatchObject({
        action: "referral_follow_up_booked",
        actor_id: profiles.receptionist,
        actor_type: "staff",
        old_values: { follow_up_appointment_id: null },
      });
    });

    it("is only possible once the referral is accepted", async () => {
      const pending = await openReferral();
      const booking = await followUp(pending);
      const early = await pgError(() => transition(pending.id, { follow_up_appointment_id: booking.appointmentId }));
      expect(early.message).toMatch(/only be booked once the referral is accepted/);

      const visit = await consultation();
      const atCreation = await pgError(async () =>
        insertReferral(referralValues(visit, { follow_up_appointment_id: (await followUp(pending)).appointmentId })),
      );
      expect(atCreation.message).toMatch(/only be booked once the referral is accepted/);

      const completed = await acceptedReferral();
      await startConsultation(completed);
      await transition(completed.id, { status: "completed", completed_by: profiles.receiver });
      const late = await pgError(async () =>
        transition(completed.id, { follow_up_appointment_id: (await followUp(completed)).appointmentId }),
      );
      expect(late.message).toMatch(/only be booked once the referral is accepted/);
    });

    it("must be with the receiving doctor, for the referred patient", async () => {
      const referral = await acceptedReferral();
      const withAnotherDoctor = await followUp(referral, { doctor: doctors.bystander });
      const forAnotherPatient = await followUp(referral, { patient: await newPatient() });

      for (const booking of [withAnotherDoctor, forAnotherPatient]) {
        const err = await pgError(() => transition(referral.id, { follow_up_appointment_id: booking.appointmentId }));
        expect(err.code).toBe("23503");
        expect(err.constraint_name).toBe("referrals_follow_up_appointment_fkey");
      }
    });

    it("keeps one active follow-up: no second booking, no unlinking, no cancelled appointment", async () => {
      const referral = await acceptedReferral();
      const first = await followUp(referral);
      await transition(referral.id, { follow_up_appointment_id: first.appointmentId });

      const second = await followUp(referral);
      const duplicate = await pgError(() => transition(referral.id, { follow_up_appointment_id: second.appointmentId }));
      expect(duplicate.message).toMatch(/a follow-up appointment is already booked/);

      const unlink = await pgError(() => transition(referral.id, { follow_up_appointment_id: null }));
      expect(unlink.message).toMatch(/cannot be unlinked/);

      // Once the booked appointment is cancelled, a replacement may be linked.
      await sql`update public.appointments set status = 'cancelled' where id = ${first.appointmentId}`;
      const replaced = await transition(referral.id, { follow_up_appointment_id: second.appointmentId });
      expect(replaced.follow_up_appointment_id).toBe(second.appointmentId);

      const fresh = await acceptedReferral();
      const cancelled = await followUp(fresh, { status: "cancelled" });
      const err = await pgError(() => transition(fresh.id, { follow_up_appointment_id: cancelled.appointmentId }));
      expect(err.message).toMatch(/follow-up appointment is cancelled/);
    });
  });

  // ---------- Doctor accounts ----------

  describe("doctor accounts", () => {
    it("linking an account to a doctor record is server-side only, while other edits keep working", async () => {
      const link = await pgError(() =>
        asStaff(profiles.manager, (tx) => tx`update public.doctors set profile_id = ${profiles.manager} where id = ${doctors.unlinked}`),
      );
      expect(link.message).toMatch(/linking a doctor account is server-side only/);

      const create = await pgError(() =>
        asStaff(
          profiles.manager,
          (tx) => tx`insert into public.doctors (clinic_id, profile_id, name) values (${clinicA}, ${profiles.manager}, ${`Dr Self ${suffix}`})`,
        ),
      );
      expect(create.message).toMatch(/linking a doctor account is server-side only/);

      const edited = await asStaff(
        profiles.manager,
        (tx) => tx`update public.doctors set bio = ${`Edited ${suffix}`} where id = ${doctors.unlinked} returning id`,
      );
      expect(edited).toHaveLength(1);
    });
  });

  // ---------- Tenant isolation, RLS and privileges ----------

  describe("creation key (idempotency)", () => {
    it("is unique per referring doctor, so a repeated creation cannot slip through", async () => {
      const key = randomUUID();
      const first = await openReferral({ creation_key: key });
      expect(first.creation_key).toBe(key);

      // The same doctor reusing the key — even for another patient — is rejected.
      const repeat = await pgError(() => openReferral({ creation_key: key }));
      expect(repeat.code).toBe("23505");
      expect(repeat.message).toMatch(/referrals_creation_key_key/);

      // Another doctor's keys are a separate space.
      const other = await insertReferral(
        referralValues(await consultation({ doctor: doctors.bystander }), {
          referring_doctor_id: doctors.bystander,
          created_by: profiles.bystander,
          creation_key: key,
        }),
      );
      expect(other.creation_key).toBe(key);
    });

    it("cannot be changed or cleared once set", async () => {
      const referral = await openReferral({ creation_key: randomUUID() });
      for (const creation_key of [randomUUID(), null]) {
        const err = await pgError(() => transition(referral.id, { creation_key }));
        expect(err.message).toMatch(/cannot be edited/);
      }
    });

    it("is never copied into the audit trail", async () => {
      const key = randomUUID();
      const referral = await openReferral({ creation_key: key });
      expect(JSON.stringify(await auditTrail(referral.id))).not.toContain(key);
    });
  });

  describe("tenant isolation and access", () => {
    it("only the two doctors on the referral can read it — not other staff, other clinics or anonymous callers", async () => {
      const referral = await openReferral();

      expect(await visibleTo(profiles.referrer, referral.id)).toBe(true);
      expect(await visibleTo(profiles.receiver, referral.id)).toBe(true);
      for (const outsider of [
        profiles.bystander,
        profiles.sleeper,
        profiles.receptionist,
        profiles.manager,
        profiles.owner,
        profiles.doctorB,
        profiles.ownerB,
      ]) {
        expect(await visibleTo(outsider, referral.id)).toBe(false);
      }

      const anon = await pgError(() => asAnon((tx) => tx`select id from public.referrals`));
      expect(anon.code).toBe("42501");
    });

    it("the receiving doctor loses access once the referral is revoked or declined, but keeps a completed one", async () => {
      const revoked = await openReferral();
      await transition(revoked.id, { status: "revoked", revoked_by: profiles.referrer, revoked_reason: "Not needed" });
      expect(await visibleTo(profiles.receiver, revoked.id)).toBe(false);
      expect(await visibleTo(profiles.referrer, revoked.id)).toBe(true);

      const declined = await openReferral();
      await transition(declined.id, { status: "declined", declined_by: profiles.receiver });
      expect(await visibleTo(profiles.receiver, declined.id)).toBe(false);
      expect(await visibleTo(profiles.referrer, declined.id)).toBe(true);

      const completed = await openReferral();
      await transition(completed.id, { status: "accepted", accepted_by: profiles.receiver });
      const inProgress = await startConsultation(completed);
      expect(await visibleTo(profiles.receiver, inProgress.id)).toBe(true);
      await transition(completed.id, { status: "completed", completed_by: profiles.receiver });
      expect(await visibleTo(profiles.receiver, completed.id)).toBe(true);
    });

    it("a deactivated doctor loses access", async () => {
      const referral = await openReferral();
      await setDoctorActive(doctors.receiver, false);
      try {
        expect(await visibleTo(profiles.receiver, referral.id)).toBe(false);
      } finally {
        await setDoctorActive(doctors.receiver, true);
      }
      expect(await visibleTo(profiles.receiver, referral.id)).toBe(true);
    });

    it("browser sessions cannot write referrals, even as a doctor on the referral", async () => {
      const referral = await openReferral();
      const values = referralValues(await consultation());

      const insert = await pgError(() => asStaff(profiles.referrer, (tx) => tx`insert into public.referrals ${tx(values)}`));
      const update = await pgError(() =>
        asStaff(profiles.receiver, (tx) => tx`update public.referrals set status = 'accepted' where id = ${referral.id}`),
      );
      const remove = await pgError(() =>
        asStaff(profiles.referrer, (tx) => tx`delete from public.referrals where id = ${referral.id}`),
      );
      for (const err of [insert, update, remove]) expect(err.code).toBe("42501");
    });

    it("no one deletes a referral directly, and deleting the patient does not take it along", async () => {
      const referral = await openReferral();
      const direct = await pgError(() => asServer((tx) => tx`delete from public.referrals where id = ${referral.id}`));
      expect(direct.code).toBe("42501");

      // A referral has its own lifecycle: the patient cannot be deleted from
      // under it (20261001000001_clinical_record_governance.sql).
      const erase = await pgError(() => asServer((tx) => tx`delete from public.patients where id = ${referral.patient_id}`));
      expect(erase.code).toBe("23503");
      const [{ count }] = await sql<{ count: number }[]>`select count(*)::int as count from public.referrals where id = ${referral.id}`;
      expect(count).toBe(1);
    });

    it("the originating consultation and the authoring account cannot be deleted from under a referral", async () => {
      const referral = await openReferral();

      const consultationDelete = await pgError(() =>
        asServer((tx) => tx`delete from public.appointments where id = ${referral.originating_appointment_id}`),
      );
      expect(consultationDelete.code).toBe("23503");
      expect(consultationDelete.constraint_name).toBe("referrals_originating_appointment_fkey");

      const accountDelete = await pgError(() => sql`delete from auth.users where id = ${profiles.referrer}`);
      expect(accountDelete.code).toBe("23503");
      expect(accountDelete.constraint_name).toBe("referrals_created_by_fkey");
    });

    it("is_linked_doctor answers only for the signed-in doctor and is not callable anonymously", async () => {
      const [mine] = await asStaff(profiles.receiver, (tx) => tx<{ linked: boolean }[]>`select public.is_linked_doctor(${doctors.receiver}) as linked`);
      const [theirs] = await asStaff(profiles.receiver, (tx) => tx<{ linked: boolean }[]>`select public.is_linked_doctor(${doctors.referrer}) as linked`);
      expect(mine.linked).toBe(true);
      expect(theirs.linked).toBe(false);

      const anon = await pgError(() => asAnon((tx) => tx`select public.is_linked_doctor(${doctors.receiver})`));
      expect(anon.code).toBe("42501");
    });
  });
});

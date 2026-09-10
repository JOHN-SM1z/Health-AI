import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";

/**
 * Multi-tenant isolation integration tests against the LOCAL Supabase stack.
 *
 * Covers the Phase 1 tenancy contract:
 *   Clinic A user -> Clinic A data ✅
 *   Clinic A user -> Clinic B data ❌
 *   Clinic A API request -> Clinic B appointment ❌
 *   Clinic A patient -> Clinic B patient ❌
 *   Clinic A Telegram -> Clinic B conversations ❌
 *   Bot tokens (clinic_telegram_integrations) never readable via SQL clients ❌
 *
 * Requires: `npm run db:reset-local` (migrations + seed) and a `.env` with
 * the real local keys. Skips cleanly when the stack is unavailable.
 */

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

const CLINIC_A = "11111111-1111-4111-8111-111111111111"; // seed clinic
const TZ = "Asia/Tashkent";

const describeDb = describe.skipIf(!localDbAvailable());

function nextWeekdayAt10(weekday: number, minDaysAhead = 2): string {
  const now = new Date();
  const target = new Date(now.getTime() + minDaysAhead * 86400000);
  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(target);
  const day = new Date(`${localDate}T00:00:00Z`);
  const localWeekday = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
  const diff = ((weekday - localWeekday) % 7 + 7) % 7;
  target.setUTCDate(target.getUTCDate() + diff);
  const startUtc = new Date(target.toISOString().slice(0, 10) + "T05:00:00Z");
  return startUtc.toISOString();
}

describeDb("multi-tenant isolation (Phase 1)", () => {
  let admin: SupabaseClient;
  let clinicB: string;
  let doctorB: string;
  let serviceB: string;
  let patientB: string;
  let appointmentB: string;
  let conversationB: string;
  let paymentB: string;
  let userAId: string;
  let userBId: string;
  let receptionistAId: string;
  let doctorAId: string;
  let clientA: SupabaseClient;
  let clientB: SupabaseClient;
  let receptionistA: SupabaseClient;
  let doctorA: SupabaseClient;
  let serviceA: string;

  const suffix = Date.now().toString(36);
  const emailA = `staff-a-${suffix}@test.local`;
  const emailB = `staff-b-${suffix}@test.local`;
  const emailReceptionistA = `staff-a-recep-${suffix}@test.local`;
  const emailDoctorA = `staff-a-doctor-${suffix}@test.local`;
  const password = "TestPassword123!";

  async function makeStaff(
    email: string,
    clinicId: string,
    role: "owner" | "admin" | "manager" | "receptionist" | "doctor",
  ): Promise<SupabaseClient> {
    // Dedicated client so auth ops never attach a staff JWT to the shared
    // service-role client used for fixture writes.
    const authClient = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { data: created, error: createError } = await authClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(createError).toBeNull();
    const userId = created?.user?.id ?? "";
    if (!userId) throw new Error("failed to create staff user");
    const { error: profileError } = await admin
      .from("profiles")
      .insert({ id: userId, full_name: email.split("@")[0] });
    expect(profileError).toBeNull();
    const { error: roleError } = await admin
      .from("staff_roles")
      .insert({ clinic_id: clinicId, profile_id: userId, role });
    expect(roleError).toBeNull();

    const { data: session, error: signInError } = await authClient.auth.signInWithPassword({ email, password });
    expect(signInError).toBeNull();
    const client = createClient(URL, ANON_KEY, { auth: { persistSession: false } });
    await client.auth.setSession(session!.session!);
    return client;
  }

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });

    // ---- Clinic B fixture: doctor, service, patient, conversation ----
    const { data: clinic, error: clinicError } = await admin
      .from("clinics")
      .insert({
        name: `Tenant B Clinic ${suffix}`,
        slug: `tenant-b-${suffix}`,
        timezone: TZ,
        currency: "UZS",
      })
      .select("id")
      .single();
    expect(clinicError).toBeNull();
    clinicB = clinic!.id;

    const { data: doctor } = await admin
      .from("doctors")
      .insert({ clinic_id: clinicB, name: "Doctor B", active: true })
      .select("id")
      .single();
    doctorB = doctor!.id;

    const { data: service } = await admin
      .from("services")
      .insert({ clinic_id: clinicB, name: `Service B ${suffix}`, duration_minutes: 20, price: 50000, active: true })
      .select("id")
      .single();
    serviceB = service!.id;

    const { data: patient } = await admin
      .from("patients")
      .insert({
        clinic_id: clinicB,
        telegram_user_id: 777200,
        full_name: "Patient B",
        phone: `+9989${suffix.slice(0, 7)}`,
      })
      .select("id")
      .single();
    patientB = patient!.id;

    const { error: whError } = await admin.from("doctor_working_hours").insert(
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        clinic_id: clinicB,
        doctor_id: doctorB,
        weekday,
        start_time: "09:00",
        end_time: "18:00",
      })),
    );
    expect(whError).toBeNull();

    const { data: conv } = await admin
      .from("conversations")
      .insert({ clinic_id: clinicB, patient_id: patientB, channel: "telegram", status: "open" })
      .select("id")
      .single();
    conversationB = conv!.id;

    const { data: appt } = await admin.rpc("book_appointment", {
      p_clinic_id: clinicB,
      p_patient_id: patientB,
      p_doctor_id: doctorB,
      p_service_id: serviceB,
      p_start_at: nextWeekdayAt10(4),
      p_status: "pending",
      p_source: "telegram_mini_app",
      p_notes: null,
      p_created_by: null,
    });
    expect((appt as { error_code: string | null }).error_code).toBeNull();
    appointmentB = (appt as { appointment_id: string }).appointment_id;

    const { data: payment } = await admin
      .from("payments")
      .select("id")
      .eq("appointment_id", appointmentB)
      .single();
    paymentB = payment!.id;

    // ---- Clinic B bot integration row (server-side only) ----
    const { error: integError } = await admin.from("clinic_telegram_integrations").insert({
      clinic_id: clinicB,
      telegram_bot_token: "123456789:SECRET_BOT_TOKEN_B",
      telegram_bot_id: 123456789,
      telegram_username: `tenant_b_bot_${suffix}`,
      status: "active",
      enabled: true,
    });
    expect(integError).toBeNull();

    // ---- Clinic A fixture needed only for the doctor_services trigger test ----
    const { data: svcA } = await admin
      .from("services")
      .insert({ clinic_id: CLINIC_A, name: `Service A ${suffix}`, duration_minutes: 20, price: 40000, active: true })
      .select("id")
      .single();
    serviceA = svcA!.id;

    // ---- Staff users ----
    clientA = await makeStaff(emailA, CLINIC_A, "owner");
    clientB = await makeStaff(emailB, clinicB, "owner");
    receptionistA = await makeStaff(emailReceptionistA, CLINIC_A, "receptionist");
    doctorA = await makeStaff(emailDoctorA, CLINIC_A, "doctor");
    const { data: userA } = await admin.auth.admin.listUsers();
    userAId = userA!.users.find((u) => u.email === emailA)!.id;
    userBId = userA!.users.find((u) => u.email === emailB)!.id;
    receptionistAId = userA!.users.find((u) => u.email === emailReceptionistA)!.id;
    doctorAId = userA!.users.find((u) => u.email === emailDoctorA)!.id;
  });

  afterAll(async () => {
    if (admin) {
      for (const uid of [userAId, userBId, receptionistAId, doctorAId]) {
        if (uid) await admin.auth.admin.deleteUser(uid).catch(() => {});
      }
      if (serviceA) {
        try {
          await admin.from("services").delete().eq("id", serviceA);
        } catch {
          // already gone
        }
      }
      if (clinicB) {
        try {
          await admin.from("clinics").delete().eq("id", clinicB);
        } catch {
          // already gone
        }
      }
    }
  });

  it("Clinic A owner reads Clinic A data (own tenant works)", async () => {
    const { data, error } = await clientA.from("patients").select("id").eq("clinic_id", CLINIC_A).limit(5);
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0);
  });

  it("Clinic A owner cannot read Clinic B doctors/services/patients", async () => {
    for (const table of ["doctors", "services", "patients"] as const) {
      const { data, error } = await clientA.from(table).select("id").eq("clinic_id", clinicB);
      expect(error).toBeNull();
      expect(data ?? []).toHaveLength(0);
    }
  });

  it("Clinic A owner cannot read Clinic B appointments or payments", async () => {
    const { data: appts, error: apptError } = await clientA.from("appointments").select("id").eq("clinic_id", clinicB);
    expect(apptError).toBeNull();
    expect(appts ?? []).toHaveLength(0);

    const { data: payments, error: payError } = await clientA.from("payments").select("id").eq("clinic_id", clinicB);
    expect(payError).toBeNull();
    expect(payments ?? []).toHaveLength(0);
  });

  it("Clinic A owner cannot read Clinic B conversations or messages", async () => {
    const { data: convs, error: convError } = await clientA.from("conversations").select("id").eq("clinic_id", clinicB);
    expect(convError).toBeNull();
    expect(convs ?? []).toHaveLength(0);

    const { data: msgs, error: msgError } = await clientA.from("messages").select("id").eq("clinic_id", clinicB);
    expect(msgError).toBeNull();
    expect(msgs ?? []).toHaveLength(0);
  });

  it("Clinic A owner cannot insert an appointment into Clinic B (RLS write denied)", async () => {
    const { error } = await clientA.from("appointments").insert({
      clinic_id: clinicB,
      patient_id: patientB,
      doctor_id: doctorB,
      service_id: serviceB,
      start_at: nextWeekdayAt10(5),
      end_at: new Date(new Date(nextWeekdayAt10(5)).getTime() + 3600000).toISOString(),
      status: "pending",
      source: "admin",
    });
    expect(error).not.toBeNull();
  });

  it("Clinic A owner cannot create a patient in Clinic B (RLS write denied)", async () => {
    const { error } = await clientA.from("patients").insert({
      clinic_id: clinicB,
      full_name: "Intruder",
      phone: "+998911111111",
    });
    expect(error).not.toBeNull();
  });

  it("Clinic A owner cannot read Clinic B staff roles or audit trail", async () => {
    const { data: roles, error: roleError } = await clientA.from("staff_roles").select("*").eq("clinic_id", clinicB);
    expect(roleError).toBeNull();
    expect(roles ?? []).toHaveLength(0);

    const { data: audit, error: auditError } = await clientA.from("audit_events").select("id").eq("clinic_id", clinicB);
    expect(auditError).toBeNull();
    expect(audit ?? []).toHaveLength(0);
  });

  it("bot tokens are never readable by ANY authenticated SQL client (no RLS policies)", async () => {
    // Even the Clinic B owner cannot read their own integration row via SQL:
    // the table has no policies, so only the service role can access it.
    const { data: fromA } = await clientA.from("clinic_telegram_integrations").select("*");
    expect(fromA ?? []).toHaveLength(0);

    const { data: fromB } = await clientB.from("clinic_telegram_integrations").select("*");
    expect(fromB ?? []).toHaveLength(0);

    const { data: fromAnon } = await createClient(URL, ANON_KEY, { auth: { persistSession: false } })
      .from("clinic_telegram_integrations")
      .select("*");
    expect(fromAnon ?? []).toHaveLength(0);
  });

  it("staff cannot execute the booking RPC directly (service-role only)", async () => {
    const { data, error } = await clientA.rpc("book_appointment", {
      p_clinic_id: CLINIC_A,
      p_patient_id: "00000000-0000-0000-0000-000000000000",
      p_doctor_id: "00000000-0000-0000-0000-000000000000",
      p_service_id: "00000000-0000-0000-0000-000000000000",
      p_start_at: new Date(Date.now() + 86400000).toISOString(),
      p_status: "pending",
      p_source: "telegram_mini_app",
    });
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });

  it("Clinic B owner reads only Clinic B data (symmetric isolation)", async () => {
    const { data: doctorsB, error: errB } = await clientB.from("doctors").select("id").eq("clinic_id", clinicB);
    expect(errB).toBeNull();
    expect(doctorsB).toHaveLength(1);

    const { data: doctorsA, error: errA } = await clientB.from("doctors").select("id").eq("clinic_id", CLINIC_A);
    expect(errA).toBeNull();
    expect(doctorsA ?? []).toHaveLength(0);
  });

  it("service role still has full access (server paths unaffected)", async () => {
    const { data, error } = await admin
      .from("clinic_telegram_integrations")
      .select("telegram_bot_token, telegram_username")
      .eq("clinic_id", clinicB)
      .single();
    expect(error).toBeNull();
    expect(data!.telegram_bot_token).toBe("123456789:SECRET_BOT_TOKEN_B");
  });

  // ---------- ID substitution (Phase 2 audit, section 7) ----------
  // Each case below queries Clinic B's SPECIFIC row by its real id, with
  // NO clinic_id filter at all — the direct simulation of an attacker who
  // has learned/guessed one id (e.g. from a URL) and substitutes it into
  // an otherwise-legitimate request. Distinct from the clinic_id-filter
  // tests above, which prove listing is scoped; these prove a known id
  // grants nothing extra.

  it("ID substitution: Clinic A owner cannot fetch Clinic B's patient/appointment/doctor/conversation/payment by direct id", async () => {
    const checks: Array<[string, string]> = [
      ["patients", patientB],
      ["appointments", appointmentB],
      ["doctors", doctorB],
      ["conversations", conversationB],
      ["payments", paymentB],
    ];
    for (const [table, id] of checks) {
      const { data, error } = await clientA.from(table).select("id").eq("id", id);
      expect(error).toBeNull();
      expect(data ?? []).toHaveLength(0);
    }
  });

  it("ID substitution: Clinic A owner cannot read Clinic B's own clinic row by id", async () => {
    const { data, error } = await clientA.from("clinics").select("id, name").eq("id", clinicB);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("ID substitution: Clinic A doctor cannot read Clinic B's appointment/patient/conversation by direct id", async () => {
    const checks: Array<[string, string]> = [
      ["appointments", appointmentB],
      ["patients", patientB],
      ["conversations", conversationB],
    ];
    for (const [table, id] of checks) {
      const { data, error } = await doctorA.from(table).select("id").eq("id", id);
      expect(error).toBeNull();
      expect(data ?? []).toHaveLength(0);
    }
  });

  it("ID substitution: Clinic A receptionist cannot read Clinic B's appointment/patient/conversation by direct id", async () => {
    const checks: Array<[string, string]> = [
      ["appointments", appointmentB],
      ["patients", patientB],
      ["conversations", conversationB],
    ];
    for (const [table, id] of checks) {
      const { data, error } = await receptionistA.from(table).select("id").eq("id", id);
      expect(error).toBeNull();
      expect(data ?? []).toHaveLength(0);
    }
  });

  // ---------- Cross-tenant mutation: update and delete, not just read ----------

  it("Clinic A owner cannot delete Clinic B's patient", async () => {
    const { error } = await clientA.from("patients").delete().eq("id", patientB);
    expect(error).toBeNull(); // RLS hides the row: 0 rows match, no error
    const { data } = await admin.from("patients").select("id").eq("id", patientB).maybeSingle();
    expect(data).not.toBeNull(); // still exists — the delete affected nothing
  });

  it("Clinic A owner cannot update Clinic B's appointment status", async () => {
    const before = await admin.from("appointments").select("status").eq("id", appointmentB).single();
    const { error } = await clientA.from("appointments").update({ status: "cancelled" }).eq("id", appointmentB);
    expect(error).toBeNull(); // RLS hides the row: 0 rows match, no error
    const after = await admin.from("appointments").select("status").eq("id", appointmentB).single();
    expect(after.data!.status).toBe(before.data!.status);
  });

  // ---------- doctor_services: DB-level cross-tenant consistency trigger ----------

  it("doctor_services rejects a cross-clinic doctor/service pairing (DB trigger, Phase 2)", async () => {
    const { error } = await admin.from("doctor_services").insert({ doctor_id: doctorB, service_id: serviceA });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/same clinic/i);
  });

  it("doctor_services accepts a same-clinic pairing (trigger does not over-block)", async () => {
    const { error } = await admin.from("doctor_services").insert({ doctor_id: doctorB, service_id: serviceB });
    expect(error).toBeNull();
  });
});
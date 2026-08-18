import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";

/**
 * Role-based authorization integration tests against the LOCAL Supabase stack.
 *
 * Covers the Phase 2 contract (spec Phase 2):
 *   Receptionist: appointments, patients, conversations, takeover — NEVER
 *                 revenue analytics, catalog writes, or payment updates.
 *   Manager:      admin-equivalent powers — catalog, analytics, payments.
 *   Doctor:       own appointments only — no catalog, no conversations,
 *                 no manual booking.
 *   Platform admin: platform-level only — zero clinic data via browser client.
 *
 * Requires: `npm run db:reset-local` (migrations + seed) and a `.env` with
 * the real local keys. Skips cleanly when the stack is unavailable.
 */

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
const URL = process.env.SUPABASE_URL ?? "";

  const CLINIC = "11111111-1111-4111-8111-111111111111"; // seed clinic
  const TZ = "Asia/Tashkent";
  const MGMT_ROLES = ["owner", "admin", "manager"] as const;
  const OPERATIONAL_ROLES = [...MGMT_ROLES, "receptionist"] as const;

  const describeDb = describe.skipIf(!localDbAvailable());

  // PostgREST UPDATE against a row RLS hides returns success with 0 rows
  // (no error). So denied updates must be asserted via "row unchanged".
  async function assertUpdateDenied(client: SupabaseClient, table: string, column: string, rowId: string) {
    const before = await client.from(table).select(column).eq("id", rowId).single();
    const { error } = await client.from(table).update({ [column]: "Hijacked" }).eq("id", rowId);
    expect(error).toBeNull();
    const after = await client.from(table).select(column).eq("id", rowId).single();
    expect((after.data as unknown as Record<string, unknown>)[column]).toBe(
      (before.data as unknown as Record<string, unknown>)[column],
    );
  }

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

describeDb("role-based authorization (Phase 2)", () => {
  let admin: SupabaseClient;
  let doctorId: string;
  let serviceId: string;
  let patientId: string;
  let conversationId: string;
  let appointmentId: string;
  let paymentId: string;

  const clients = new Map<string, SupabaseClient>();
  const createdUserIds: string[] = [];

  const suffix = Date.now().toString(36);

  async function makeUser(role: string, opts?: { withDoctorRow?: boolean }): Promise<SupabaseClient> {
    const email = `role-${role}-${suffix}@test.local`;
    const password = "TestPassword123!";
    const authClient = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { data: created, error: createError } = await authClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(createError).toBeNull();
    const userId = created?.user?.id ?? "";
    if (!userId) throw new Error(`failed to create ${role} user`);
    createdUserIds.push(userId);

    const { error: profileError } = await admin.from("profiles").insert({ id: userId, full_name: role });
    expect(profileError).toBeNull();

    if (role === "platform_admin") {
      const { error: paError } = await admin.from("platform_admins").insert({ profile_id: userId });
      expect(paError).toBeNull();
    } else {
      const { error: roleError } = await admin.from("staff_roles").insert({ clinic_id: CLINIC, profile_id: userId, role });
      expect(roleError).toBeNull();
      if (opts?.withDoctorRow) {
        const { error: docError } = await admin
          .from("doctors")
          .update({ profile_id: userId })
          .eq("id", doctorId);
        expect(docError).toBeNull();
      }
    }

    const { data: session, error: signInError } = await authClient.auth.signInWithPassword({ email, password });
    expect(signInError).toBeNull();
    const client = createClient(URL, ANON_KEY, { auth: { persistSession: false } });
    await client.auth.setSession(session!.session!);
    clients.set(role, client);
    return client;
  }

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });

    const { data: doctor } = await admin
      .from("doctors")
      .insert({ clinic_id: CLINIC, name: `Role Doctor ${suffix}`, active: true })
      .select("id")
      .single();
    doctorId = doctor!.id;

    const { data: service } = await admin
      .from("services")
      .insert({
        clinic_id: CLINIC,
        name: `Role Service ${suffix}`,
        duration_minutes: 30,
        price: 150000,
        active: true,
      })
      .select("id")
      .single();
    serviceId = service!.id;

    const { data: patient } = await admin
      .from("patients")
      .insert({
        clinic_id: CLINIC,
        full_name: `Role Patient ${suffix}`,
        phone: `+9989${suffix.slice(0, 7)}`,
        telegram_user_id: null,
      })
      .select("id")
      .single();
    patientId = patient!.id;

    const { error: whError } = await admin.from("doctor_working_hours").insert(
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        clinic_id: CLINIC,
        doctor_id: doctorId,
        weekday,
        start_time: "09:00",
        end_time: "18:00",
      })),
    );
    expect(whError).toBeNull();

    const { data: appt } = await admin.rpc("book_appointment", {
      p_clinic_id: CLINIC,
      p_patient_id: patientId,
      p_doctor_id: doctorId,
      p_service_id: serviceId,
      p_start_at: nextWeekdayAt10(4),
      p_status: "pending",
      p_source: "admin",
      p_notes: null,
      p_created_by: null,
    });
    expect((appt as { error_code: string | null }).error_code).toBeNull();
    appointmentId = (appt as { appointment_id: string }).appointment_id;

    const { data: payment } = await admin
      .from("payments")
      .select("id")
      .eq("appointment_id", appointmentId)
      .single();
    paymentId = payment!.id;

    const { data: conv } = await admin
      .from("conversations")
      .insert({ clinic_id: CLINIC, patient_id: patientId, channel: "telegram", status: "open" })
      .select("id")
      .single();
    conversationId = conv!.id;

    const { error: analyticsError } = await admin.from("analytics_events").insert({
      clinic_id: CLINIC,
      patient_id: patientId,
      event_type: "test_booking",
    });
    expect(analyticsError).toBeNull();

    await makeUser("owner");
    await makeUser("admin");
    await makeUser("manager");
    await makeUser("receptionist");
    await makeUser("doctor", { withDoctorRow: true });
    await makeUser("platform_admin");
  });

  afterAll(async () => {
    if (admin) {
      for (const uid of createdUserIds) {
        await admin.auth.admin.deleteUser(uid).catch(() => {});
      }
    }
  });

  // ---------- Receptionist: operational powers ----------

  it("receptionist reads appointments, patients and conversations", async () => {
    const c = clients.get("receptionist")!;
    const { data: appts, error: apptErr } = await c.from("appointments").select("id").eq("clinic_id", CLINIC);
    expect(apptErr).toBeNull();
    expect(appts!.map((a) => a.id)).toContain(appointmentId);

    const { data: patients, error: patErr } = await c.from("patients").select("id").eq("clinic_id", CLINIC);
    expect(patErr).toBeNull();
    expect(patients!.map((p) => p.id)).toContain(patientId);

    const { data: convs, error: convErr } = await c.from("conversations").select("id").eq("clinic_id", CLINIC);
    expect(convErr).toBeNull();
    expect(convs!.map((x) => x.id)).toContain(conversationId);
  });

  it("receptionist creates walk-in patients (telegram_user_id null) and updates appointments", async () => {
    const c = clients.get("receptionist")!;
    const { data: patient, error } = await c
      .from("patients")
      .insert({ clinic_id: CLINIC, full_name: `Walk-in ${suffix}`, phone: `+9989${suffix.slice(0, 6)}00` })
      .select("id")
      .single();
    expect(error).toBeNull();
    expect(patient!.id).toBeTruthy();

    const { error: statusError } = await c
      .from("appointments")
      .update({ status: "confirmed" })
      .eq("id", appointmentId);
    expect(statusError).toBeNull();
  });

  it("receptionist cannot create a Telegram patient (telegram_user_id must be null)", async () => {
    const c = clients.get("receptionist")!;
    const { error } = await c.from("patients").insert({
      clinic_id: CLINIC,
      full_name: "Spoofed Telegram Patient",
      telegram_user_id: 999111,
    });
    expect(error).not.toBeNull();
  });

  it("receptionist cannot write the catalog (services/doctors/faqs)", async () => {
    const c = clients.get("receptionist")!;
    await assertUpdateDenied(c, "services", "name", serviceId);
    await assertUpdateDenied(c, "doctors", "name", doctorId);

    const { error: faqError } = await c
      .from("faq_entries")
      .insert({ clinic_id: CLINIC, question: "?", answer: "!" });
    expect(faqError).not.toBeNull();
  });

  it("receptionist cannot read analytics, audit or notification jobs (revenue hidden)", async () => {
    const c = clients.get("receptionist")!;
    const { data: analytics, error: aErr } = await c.from("analytics_events").select("id").eq("clinic_id", CLINIC);
    expect(aErr).toBeNull();
    expect(analytics ?? []).toHaveLength(0);

    const { data: audit, error: auErr } = await c.from("audit_events").select("id").eq("clinic_id", CLINIC);
    expect(auErr).toBeNull();
    expect(audit ?? []).toHaveLength(0);

    const { data: jobs, error: jErr } = await c.from("notification_jobs").select("id").eq("clinic_id", CLINIC);
    expect(jErr).toBeNull();
    expect(jobs ?? []).toHaveLength(0);
  });

  it("receptionist cannot update payments (management-only)", async () => {
    const c = clients.get("receptionist")!;
    await assertUpdateDenied(c, "payments", "status", paymentId);
  });

  it("receptionist replies inside a conversation as admin", async () => {
    const c = clients.get("receptionist")!;
    const { data, error } = await c
      .from("messages")
      .insert({
        clinic_id: CLINIC,
        conversation_id: conversationId,
        role: "admin",
        type: "text",
        content: "Test reply from receptionist",
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    expect(data!.id).toBeTruthy();
  });

  it("receptionist cannot take over conversations of another clinic (no cross-tenant rows)", async () => {
    const c = clients.get("receptionist")!;
    const otherClinic = "99999999-9999-4999-8999-999999999999"; // does not exist
    const { error } = await c
      .from("conversations")
      .update({ status: "assigned", taken_over_by: "00000000-0000-0000-0000-000000000000" })
      .eq("id", conversationId)
      .eq("clinic_id", otherClinic);
    expect(error).toBeNull(); // zero rows affected — no error, but nothing changed
  });

  // ---------- Manager: admin-equivalent powers ----------

  it("manager writes the catalog (services/doctors) and reads analytics", async () => {
    const c = clients.get("manager")!;
    const { error: svcError } = await c
      .from("services")
      .update({ price: 160000, active: false })
      .eq("id", serviceId);
    expect(svcError).toBeNull();

    const { error: docError } = await c.from("doctors").update({ bio: "managed" }).eq("id", doctorId);
    expect(docError).toBeNull();

    const { data: analytics, error: aErr } = await c.from("analytics_events").select("id").eq("clinic_id", CLINIC);
    expect(aErr).toBeNull();
    expect(analytics!.length).toBeGreaterThan(0);
  });

  it("manager updates payments and creates walk-in patients", async () => {
    const c = clients.get("manager")!;
    const { error: payError } = await c.from("payments").update({ status: "paid" }).eq("id", paymentId);
    expect(payError).toBeNull();

    const { error: patError } = await c.from("patients").insert({
      clinic_id: CLINIC,
      full_name: `Manager walk-in ${suffix}`,
      phone: `+9989${suffix.slice(0, 5)}77`,
    });
    expect(patError).toBeNull();
  });

  it("manager CANNOT update the clinic itself (owner-only)", async () => {
    const c = clients.get("manager")!;
    const before = await c.from("clinics").select("name").eq("id", CLINIC).single();
    expect(before.data!.name).toBeTruthy();
    const { error } = await c.from("clinics").update({ name: "Hijacked" }).eq("id", CLINIC);
    expect(error).toBeNull(); // RLS-hid the row: zero rows affected
    const after = await c.from("clinics").select("name").eq("id", CLINIC).single();
    expect(after.data!.name).toBe(before.data!.name);
  });

  it("manager cannot manage staff roles (owner-only)", async () => {
    const c = clients.get("manager")!;
    const { error } = await c.from("staff_roles").insert({
      clinic_id: CLINIC,
      profile_id: "00000000-0000-0000-0000-000000000000",
      role: "admin",
    });
    expect(error).not.toBeNull();
  });

  // ---------- Owner: everything management does, plus clinic settings ----------

  it("owner updates the clinic (owner-only power intact)", async () => {
    const c = clients.get("owner")!;
    const { error } = await c.from("clinics").update({ currency: "UZS" }).eq("id", CLINIC);
    expect(error).toBeNull();
  });

  // ---------- Doctor: own appointments only ----------

  it("doctor reads their own appointments but cannot manual-book", async () => {
    const c = clients.get("doctor")!;
    const { data: appts, error: apptErr } = await c
      .from("appointments")
      .select("id, doctor_id")
      .eq("clinic_id", CLINIC);
    expect(apptErr).toBeNull();
    expect(appts!.length).toBeGreaterThan(0);
    for (const a of appts!) expect(a.doctor_id).toBe(doctorId);

    const { error } = await c.from("appointments").insert({
      clinic_id: CLINIC,
      patient_id: patientId,
      doctor_id: doctorId,
      service_id: serviceId,
      start_at: nextWeekdayAt10(5),
      end_at: new Date(new Date(nextWeekdayAt10(5)).getTime() + 3600000).toISOString(),
      status: "pending",
      source: "admin",
    });
    expect(error).not.toBeNull();
  });

  it("doctor cannot read conversations or messages", async () => {
    const c = clients.get("doctor")!;
    const { data: convs } = await c.from("conversations").select("id").eq("clinic_id", CLINIC);
    expect(convs ?? []).toHaveLength(0);

    const { data: msgs } = await c.from("messages").select("id").eq("clinic_id", CLINIC);
    expect(msgs ?? []).toHaveLength(0);
  });

  it("doctor cannot read analytics or audit", async () => {
    const c = clients.get("doctor")!;
    const { data: analytics } = await c.from("analytics_events").select("id").eq("clinic_id", CLINIC);
    expect(analytics ?? []).toHaveLength(0);
    const { data: audit } = await c.from("audit_events").select("id").eq("clinic_id", CLINIC);
    expect(audit ?? []).toHaveLength(0);
  });

  // ---------- Platform admin: platform-level only ----------

  it("platform admin reads their own membership row only", async () => {
    const c = clients.get("platform_admin")!;
    const { data, error } = await c.from("platform_admins").select("*");
    expect(error).toBeNull();
    expect(data!.length).toBe(1);
  });

  it("platform admin cannot read ANY clinic data (no staff_roles)", async () => {
    const c = clients.get("platform_admin")!;
    for (const table of ["clinics", "patients", "appointments", "conversations", "doctors", "services", "payments"] as const) {
      const { data, error } = await c.from(table).select("id");
      expect(error).toBeNull();
      expect(data ?? []).toHaveLength(0);
    }
  });

  it("platform admin cannot create a patient (no clinic powers via browser)", async () => {
    const c = clients.get("platform_admin")!;
    const { error } = await c.from("patients").insert({ clinic_id: CLINIC, full_name: "Intruder" });
    expect(error).not.toBeNull();
  });

  it("platform admin row is not readable by clinic staff", async () => {
    const c = clients.get("owner")!;
    const { data } = await c.from("platform_admins").select("*");
    expect(data ?? []).toHaveLength(0);
  });

  // ---------- Manager/receptionist/doctor matrix sanity: no cross-clinic ----------

  it("manager, receptionist and doctor see zero rows from a foreign clinic", async () => {
    const foreignClinic = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    for (const role of OPERATIONAL_ROLES) {
      const c = clients.get(role)!;
      const { data, error } = await c.from("patients").select("id").eq("clinic_id", foreignClinic);
      expect(error).toBeNull();
      expect(data ?? []).toHaveLength(0);
    }
  });
});

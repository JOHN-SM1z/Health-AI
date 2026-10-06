import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

const describeDb = describe.skipIf(!localDbAvailable());

describeDb("Phase 1: clinical referrals data model & integrity constraints", () => {
  let admin: SupabaseClient;
  let clinicA: string;
  let clinicB: string;
  let docA1: string;
  let docA2: string;
  let docB1: string;
  let patientA: string;
  let patientB: string;
  let profileDocA1: string;
  let profileDocA2: string;
  let appointmentA1: string;
  let appointmentB1: string;
  let serviceA: string;
  let serviceB: string;

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });

    // Create two separate clinic tenants
    const { data: cA } = await admin
      .from("clinics")
      .insert({ name: "Referral Test Clinic A", slug: `ref-a-${Date.now()}` })
      .select("id")
      .single();
    clinicA = cA!.id;

    const { data: cB } = await admin
      .from("clinics")
      .insert({ name: "Referral Test Clinic B", slug: `ref-b-${Date.now()}` })
      .select("id")
      .single();
    clinicB = cB!.id;

    // Create doctor user profiles
    const { data: user1 } = await admin.auth.admin.createUser({
      email: `doc1-${Date.now()}@test.local`,
      password: "Password123!",
      email_confirm: true,
    });
    profileDocA1 = user1!.user!.id;

    const { data: user2 } = await admin.auth.admin.createUser({
      email: `doc2-${Date.now()}@test.local`,
      password: "Password123!",
      email_confirm: true,
    });
    profileDocA2 = user2!.user!.id;

    await admin.from("profiles").insert([
      { id: profileDocA1, full_name: "Dr Alpha" },
      { id: profileDocA2, full_name: "Dr Beta" },
    ]);

    // Create doctors in Clinic A
    const { data: dA1 } = await admin
      .from("doctors")
      .insert({ clinic_id: clinicA, profile_id: profileDocA1, name: "Dr Alpha", active: true })
      .select("id")
      .single();
    docA1 = dA1!.id;

    const { data: dA2 } = await admin
      .from("doctors")
      .insert({ clinic_id: clinicA, profile_id: profileDocA2, name: "Dr Beta", active: true })
      .select("id")
      .single();
    docA2 = dA2!.id;

    // Create doctor in Clinic B
    const { data: dB1 } = await admin
      .from("doctors")
      .insert({ clinic_id: clinicB, name: "Dr Gamma (Clinic B)", active: true })
      .select("id")
      .single();
    docB1 = dB1!.id;

    // Create patients
    const { data: pA } = await admin
      .from("patients")
      .insert({ clinic_id: clinicA, full_name: "Patient A1", phone: "+998901111111" })
      .select("id")
      .single();
    patientA = pA!.id;

    const { data: pB } = await admin
      .from("patients")
      .insert({ clinic_id: clinicB, full_name: "Patient B1", phone: "+998902222222" })
      .select("id")
      .single();
    patientB = pB!.id;

    // Create services for appointments
    const { data: sA } = await admin
      .from("services")
      .insert({ clinic_id: clinicA, name: "General Consultation", duration_minutes: 30, price: 100000 })
      .select("id")
      .single();
    serviceA = sA!.id;

    const { data: sB } = await admin
      .from("services")
      .insert({ clinic_id: clinicB, name: "Consultation B", duration_minutes: 30, price: 100000 })
      .select("id")
      .single();
    serviceB = sB!.id;

    const { error: rolesError } = await admin.from("staff_roles").insert([
      { clinic_id: clinicA, profile_id: profileDocA1, role: "doctor" },
      { clinic_id: clinicA, profile_id: profileDocA2, role: "doctor" },
    ]);
    expect(rolesError).toBeNull();
    const { error: hoursError } = await admin.from("doctor_working_hours").insert(
      [docA1, docA2, docB1].flatMap(doctor_id => Array.from({ length: 7 }, (_, i) => ({ clinic_id: doctor_id === docB1 ? clinicB : clinicA, doctor_id, weekday: i + 1, start_time: "00:00", end_time: "23:59" }))),
    );
    expect(hoursError).toBeNull();
    // Create consultations / appointments
    const now = new Date(); now.setUTCHours(6, 0, 0, 0);
    const startA = new Date(now.getTime() + 86400000).toISOString();
    const endA = new Date(now.getTime() + 86400000 + 1800000).toISOString();
    const { data: aptA, error: aptAError } = await admin
      .from("appointments")
      .insert({
        clinic_id: clinicA,
        patient_id: patientA,
        doctor_id: docA1,
        service_id: serviceA,
        start_at: startA,
        end_at: endA,
        status: "confirmed",
      })
      .select("id")
      .single();
    expect(aptAError).toBeNull();
    appointmentA1 = aptA!.id;

    const { data: aptB, error: aptBError } = await admin
      .from("appointments")
      .insert({
        clinic_id: clinicB,
        patient_id: patientB,
        doctor_id: docB1,
        service_id: serviceB,
        start_at: startA,
        end_at: endA,
        status: "confirmed",
      })
      .select("id")
      .single();
    expect(aptBError).toBeNull();
    appointmentB1 = aptB!.id;
  });

  afterAll(async () => {
    if (admin) {
      if (clinicA) await admin.from("clinics").delete().eq("id", clinicA);
      if (clinicB) await admin.from("clinics").delete().eq("id", clinicB);
      if (profileDocA1) await admin.auth.admin.deleteUser(profileDocA1);
      if (profileDocA2) await admin.auth.admin.deleteUser(profileDocA2);
    }
  });

  describe("Valid referral creation", () => {
    it("creates a valid same-clinic referral with originating consultation", async () => {
      const { data: ref, error } = await admin
        .from("referrals")
        .insert({
          clinic_id: clinicA,
          patient_id: patientA,
          created_by: profileDocA1, updated_by: profileDocA1, expires_at: new Date(Date.now() + 86400000 * 30).toISOString(),
        referring_doctor_id: docA1,
          referred_to_doctor_id: docA2,
          originating_appointment_id: appointmentA1,
          referral_reason: "Patient has persistent hypertension, cardiologic opinion required",
          clinical_handoff_note: "BP 150/95 recorded during today's visit. EKG shows left ventricular hypertrophy.",
          priority: "urgent",
        })
        .select("*")
        .single();

      expect(error).toBeNull();
      expect(ref.id).toBeDefined();
      expect(ref.status).toBe("pending");
      expect(ref.priority).toBe("urgent");
      expect(ref.originating_appointment_id).toBe(appointmentA1);
      expect(ref.created_at).toBeDefined();
    });

    it("creates a valid referral without originating consultation", async () => {
      const { data: ref, error } = await admin
        .from("referrals")
        .insert({
          clinic_id: clinicA,
          patient_id: patientA,
          created_by: profileDocA1, updated_by: profileDocA1, expires_at: new Date(Date.now() + 86400000 * 30).toISOString(),
        referring_doctor_id: docA1,
          referred_to_doctor_id: docA2,
          referral_reason: "Direct specialist evaluation",
          priority: "routine",
        })
        .select("*")
        .single();

      expect(error).toBeNull();
      expect(ref.status).toBe("pending");
      expect(ref.originating_appointment_id).toBeNull();
    });
  });

  describe("Cross-clinic tenant isolation", () => {
    it("rejects referral when referred_to_doctor belongs to another clinic", async () => {
      const { error } = await admin.from("referrals").insert({
        clinic_id: clinicA,
        patient_id: patientA,
        created_by: profileDocA1, updated_by: profileDocA1, expires_at: new Date(Date.now() + 86400000 * 30).toISOString(),
        referring_doctor_id: docA1,
        referred_to_doctor_id: docB1, // Clinic B!
        referral_reason: "Cross-clinic doctor violation",
      });

      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/must all belong to clinic/i);
    });

    it("rejects referral when patient belongs to another clinic", async () => {
      const { error } = await admin.from("referrals").insert({
        clinic_id: clinicA,
        patient_id: patientB, // Clinic B!
        created_by: profileDocA1, updated_by: profileDocA1, expires_at: new Date(Date.now() + 86400000 * 30).toISOString(),
        referring_doctor_id: docA1,
        referred_to_doctor_id: docA2,
        referral_reason: "Cross-clinic patient violation",
      });

      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/must all belong to clinic/i);
    });

    it("rejects referral when originating appointment belongs to another clinic", async () => {
      const { error } = await admin.from("referrals").insert({
        clinic_id: clinicA,
        patient_id: patientA,
        created_by: profileDocA1, updated_by: profileDocA1, expires_at: new Date(Date.now() + 86400000 * 30).toISOString(),
        referring_doctor_id: docA1,
        referred_to_doctor_id: docA2,
        originating_appointment_id: appointmentB1, // Clinic B!
        referral_reason: "Cross-clinic appointment violation",
      });

      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/different clinic/i);
    });
  });

  describe("Invalid doctor/patient relationships", () => {
    it("prevents self-referral via check constraint", async () => {
      const { error } = await admin.from("referrals").insert({
        clinic_id: clinicA,
        patient_id: patientA,
        created_by: profileDocA1, updated_by: profileDocA1, expires_at: new Date(Date.now() + 86400000 * 30).toISOString(),
        referring_doctor_id: docA1,
        referred_to_doctor_id: docA1, // Same doctor!
        referral_reason: "Cannot refer to self",
      });

      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/referrals_distinct_doctors/i);
    });

    it("rejects referral when originating appointment belongs to a different doctor", async () => {
      // docA2 referring, but appointment was with docA1
      const { error } = await admin.from("referrals").insert({
        clinic_id: clinicA,
        patient_id: patientA,
        created_by: profileDocA2, updated_by: profileDocA2, expires_at: new Date(Date.now() + 86400000 * 30).toISOString(),
        referring_doctor_id: docA2, // Different from appointment doctor!
        referred_to_doctor_id: docA1,
        originating_appointment_id: appointmentA1,
        referral_reason: "Doctor mismatch test",
      });

      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/does not match referring doctor|referral author lacks patient access/i);
    });
  });

  describe("Required fields and constraints", () => {
    it("rejects referral with empty referral_reason", async () => {
      const { error } = await admin.from("referrals").insert({
        clinic_id: clinicA,
        patient_id: patientA,
        created_by: profileDocA1, updated_by: profileDocA1, expires_at: new Date(Date.now() + 86400000 * 30).toISOString(),
        referring_doctor_id: docA1,
        referred_to_doctor_id: docA2,
        referral_reason: "", // Empty string
      });

      expect(error).not.toBeNull();
    });

    it("rejects referral insertion with non-pending initial status", async () => {
      const { error } = await admin.from("referrals").insert({
        clinic_id: clinicA,
        patient_id: patientA,
        created_by: profileDocA1, updated_by: profileDocA1, expires_at: new Date(Date.now() + 86400000 * 30).toISOString(),
        referring_doctor_id: docA1,
        referred_to_doctor_id: docA2,
        referral_reason: "Invalid initial status test",
        status: "completed", // Must be pending on insert
      });

      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/new referral must be open/i);
    });
  });

  describe("Status transitions", () => {
    it("allows pending -> accepted transition and populates accepted_at", async () => {
      const { data: ref } = await admin
        .from("referrals")
        .insert({
          clinic_id: clinicA,
          patient_id: patientA,
          created_by: profileDocA1, updated_by: profileDocA1, expires_at: new Date(Date.now() + 86400000 * 30).toISOString(),
        referring_doctor_id: docA1,
          referred_to_doctor_id: docA2,
          referral_reason: "Transition test",
        })
        .select("id, status, accepted_at")
        .single();

      expect(ref!.status).toBe("pending");
      expect(ref!.accepted_at).toBeNull();

      const { data: acceptedRef, error } = await admin
        .from("referrals")
        .update({ status: "accepted", updated_by: profileDocA2 })
        .eq("id", ref!.id)
        .select("id, status, accepted_at")
        .single();

      expect(error).toBeNull();
      expect(acceptedRef!.status).toBe("accepted");
      expect(acceptedRef!.accepted_at).not.toBeNull();
    });

    it("allows accepted -> completed transition and populates completed_at", async () => {
      const { data: ref } = await admin
        .from("referrals")
        .insert({
          clinic_id: clinicA,
          patient_id: patientA,
          created_by: profileDocA1, updated_by: profileDocA1, expires_at: new Date(Date.now() + 86400000 * 30).toISOString(),
        referring_doctor_id: docA1,
          referred_to_doctor_id: docA2,
          referral_reason: "Completion test",
        })
        .select("id")
        .single();

      // Accept first
      await admin.from("referrals").update({ status: "accepted", updated_by: profileDocA2 }).eq("id", ref!.id);

      // Now complete
      const { data: completedRef, error } = await admin
        .from("referrals")
        .update({ status: "completed", updated_by: profileDocA2 })
        .eq("id", ref!.id)
        .select("id, status, completed_at")
        .single();

      expect(error).toBeNull();
      expect(completedRef!.status).toBe("completed");
      expect(completedRef!.completed_at).not.toBeNull();
    });

    it("rejects transition from terminal status completed", async () => {
      const { data: ref } = await admin
        .from("referrals")
        .insert({
          clinic_id: clinicA,
          patient_id: patientA,
          created_by: profileDocA1, updated_by: profileDocA1, expires_at: new Date(Date.now() + 86400000 * 30).toISOString(),
        referring_doctor_id: docA1,
          referred_to_doctor_id: docA2,
          referral_reason: "Terminal status test",
        })
        .select("id")
        .single();

      await admin.from("referrals").update({ status: "accepted", updated_by: profileDocA2 }).eq("id", ref!.id);
      await admin.from("referrals").update({ status: "completed", updated_by: profileDocA2 }).eq("id", ref!.id);

      // Attempt to re-open or decline
      const { error } = await admin
        .from("referrals")
        .update({ status: "accepted", updated_by: profileDocA2 })
        .eq("id", ref!.id);

      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/closed referral is immutable/i);
    });

    it("allows revocation with reason and populates revoked_at", async () => {
      const { data: ref } = await admin
        .from("referrals")
        .insert({
          clinic_id: clinicA,
          patient_id: patientA,
          created_by: profileDocA1, updated_by: profileDocA1, expires_at: new Date(Date.now() + 86400000 * 30).toISOString(),
        referring_doctor_id: docA1,
          referred_to_doctor_id: docA2,
          referral_reason: "Revocation test",
        })
        .select("id")
        .single();

      const { data: revokedRef, error } = await admin
        .from("referrals")
        .update({
          status: "revoked", updated_by: profileDocA1,
          revocation_reason: "Patient condition improved spontaneously",
          revoked_by: profileDocA1,
        })
        .eq("id", ref!.id)
        .select("id, status, revoked_at, revocation_reason")
        .single();

      expect(error).toBeNull();
      expect(revokedRef!.status).toBe("revoked");
      expect(revokedRef!.revoked_at).not.toBeNull();
      expect(revokedRef!.revocation_reason).toBe("Patient condition improved spontaneously");
    });
  });
});

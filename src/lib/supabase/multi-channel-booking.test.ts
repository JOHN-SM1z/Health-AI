import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";

/**
 * End-to-end QA/integration phase: "one coherent platform" claim for
 * booking specifically — Telegram bot, Telegram Mini App, the website, and
 * reception/admin-entered bookings (scheduled admin AND same-day walk_in)
 * must all resolve through the SAME authoritative book_appointment() RPC,
 * for MORE THAN ONE clinic, with each channel's source recorded verbatim
 * and the correct charged amount (a doctor-specific price_override, not
 * just the service's catalog price) persisted to payments.
 *
 * This is deliberately a thin, focused addition: cross-tenant isolation,
 * concurrent-booking-race safety, and the conversation take-over CAS are
 * already covered in depth by tenant-isolation.test.ts, integration.test.ts
 * and admin/conversations/[id]/route.test.ts — this file does not repeat
 * that coverage, it adds the one angle those files test piecemeal rather
 * than as a single explicit "every channel, every clinic, same engine"
 * assertion.
 *
 * Requires: `npm run db:reset-local` (migrations + seed) and a `.env` with
 * the real local keys. Skips cleanly when the stack is unavailable.
 */

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

const CLINIC_A = "11111111-1111-4111-8111-111111111111"; // seed clinic (see integration.test.ts)
const TZ = "Asia/Tashkent";

const describeDb = describe.skipIf(!localDbAvailable());

function nextWeekdayAt10(weekday: number, minDaysAhead: number): string {
  const now = new Date();
  const target = new Date(now.getTime() + minDaysAhead * 86400000);
  const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(target);
  const day = new Date(`${localDate}T00:00:00Z`);
  const localWeekday = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
  const diff = ((weekday - localWeekday) % 7 + 7) % 7;
  target.setUTCDate(target.getUTCDate() + diff);
  return new Date(target.toISOString().slice(0, 10) + "T05:00:00Z").toISOString();
}

const SOURCES = ["telegram_mini_app", "telegram_chat", "web", "admin", "walk_in"] as const;

describeDb("one booking engine serves every channel, for more than one clinic", () => {
  let admin: SupabaseClient;
  let doctorAId: string;
  let serviceAId: string;
  let patientAId: string;

  let clinicBId: string;
  let doctorBId: string;
  let serviceBId: string;
  let patientBId: string;

  const suffix = Date.now().toString(36);

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });

    const [{ data: doctorA }, { data: serviceA }, { data: patientA }] = await Promise.all([
      admin.from("doctors").select("id").eq("name", "Karimov Alisher").single(),
      admin.from("services").select("id").eq("name", "Terapevt qabuli").single(),
      admin.from("patients").select("id").eq("telegram_user_id", 777000).single(),
    ]);
    doctorAId = doctorA!.id;
    serviceAId = serviceA!.id;
    patientAId = patientA!.id;
    await admin.from("appointments").delete().eq("doctor_id", doctorAId).gte("start_at", nextWeekdayAt10(1, 60));

    const { data: clinicB } = await admin
      .from("clinics")
      .insert({ name: `Multi-channel Clinic B ${suffix}`, slug: `mc-clinic-b-${suffix}`, timezone: TZ, currency: "UZS" })
      .select("id")
      .single();
    clinicBId = clinicB!.id;

    const { data: specialtyB } = await admin
      .from("specialties")
      .insert({ clinic_id: clinicBId, name: "Stomatologiya", active: true })
      .select("id")
      .single();

    const { data: doctorB } = await admin
      .from("doctors")
      .insert({ clinic_id: clinicBId, specialty_id: specialtyB!.id, name: `Dr. B ${suffix}`, active: true })
      .select("id")
      .single();
    doctorBId = doctorB!.id;

    const { data: serviceB } = await admin
      .from("services")
      .insert({ clinic_id: clinicBId, specialty_id: specialtyB!.id, name: "Stomatolog qabuli", duration_minutes: 45, price: 150000, active: true })
      .select("id")
      .single();
    serviceBId = serviceB!.id;

    // Doctor B charges more than the catalog price for this service —
    // payments.amount must reflect THIS, never services.price.
    await admin.from("doctor_services").insert({ doctor_id: doctorBId, service_id: serviceBId, price_override: 175000 });

    await admin.from("doctor_working_hours").insert(
      Array.from({ length: 5 }, (_, i) => ({ clinic_id: clinicBId, doctor_id: doctorBId, weekday: i + 1, start_time: "09:00", end_time: "18:00" })),
    );

    const { data: patientB } = await admin
      .from("patients")
      .insert({ clinic_id: clinicBId, telegram_user_id: 888000 + Math.floor(Math.random() * 1000), full_name: `Patient B ${suffix}` })
      .select("id")
      .single();
    patientBId = patientB!.id;
  });

  afterAll(async () => {
    await admin.from("clinics").delete().eq("id", clinicBId); // cascades doctors/services/patients/appointments/payments
    await admin.from("appointments").delete().eq("doctor_id", doctorAId).gte("start_at", nextWeekdayAt10(1, 60));
  });

  it.each(SOURCES)("clinic A: %s books through the same book_appointment() RPC as every other channel", async (source) => {
    const weekday = 1 + SOURCES.indexOf(source); // spread across distinct days to avoid any slot collision
    const startAt = nextWeekdayAt10(((weekday - 1) % 7) + 1, 60 + weekday);
    const { data, error } = await admin.rpc("book_appointment", {
      p_clinic_id: CLINIC_A,
      p_patient_id: patientAId,
      p_doctor_id: doctorAId,
      p_service_id: serviceAId,
      p_start_at: startAt,
      p_status: "confirmed",
      p_source: source,
    });
    expect(error).toBeNull();
    const result = data as { appointment_id: string; error_code: string | null };
    expect(result.error_code).toBeNull();

    const { data: appt } = await admin.from("appointments").select("source, clinic_id").eq("id", result.appointment_id).single();
    expect(appt!.source).toBe(source);
    expect(appt!.clinic_id).toBe(CLINIC_A);
  });

  it.each(SOURCES)("clinic B: %s books through the same RPC and charges doctor B's price_override, not the catalog price", async (source) => {
    const weekday = 1 + SOURCES.indexOf(source);
    const startAt = nextWeekdayAt10(((weekday - 1) % 7) + 1, 80 + weekday);
    const { data, error } = await admin.rpc("book_appointment", {
      p_clinic_id: clinicBId,
      p_patient_id: patientBId,
      p_doctor_id: doctorBId,
      p_service_id: serviceBId,
      p_start_at: startAt,
      p_status: "confirmed",
      p_source: source,
    });
    expect(error).toBeNull();
    const result = data as { appointment_id: string; amount: number; error_code: string | null };
    expect(result.error_code).toBeNull();
    expect(Number(result.amount)).toBe(175000); // override, not the 150000 catalog price

    const { data: appt } = await admin
      .from("appointments")
      .select("source, clinic_id, payments(amount, status)")
      .eq("id", result.appointment_id)
      .single();
    expect(appt!.source).toBe(source);
    expect(appt!.clinic_id).toBe(clinicBId);
    const payment = appt!.payments as unknown as { amount: number; status: string };
    expect(Number(payment.amount)).toBe(175000);
    expect(payment.status).toBe("unpaid"); // never fabricated as paid at booking time
  });

  it("a clinic B appointment can never be booked against a clinic A doctor (tenant boundary enforced inside the engine itself, not just RLS)", async () => {
    const startAt = nextWeekdayAt10(1, 200);
    const { data } = await admin.rpc("book_appointment", {
      p_clinic_id: clinicBId,
      p_patient_id: patientBId,
      p_doctor_id: doctorAId, // Clinic A's doctor
      p_service_id: serviceBId,
      p_start_at: startAt,
      p_status: "confirmed",
      p_source: "admin",
    });
    const result = data as { appointment_id: string | null; error_code: string | null };
    expect(result.error_code).toBe("doctor_not_found");
    expect(result.appointment_id).toBeNull();
  });
});

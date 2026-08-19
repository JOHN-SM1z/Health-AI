import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { localDbAvailable } from "@/test/local-db";
import { aggregateAppointments, type AnalyticsRow } from "@/lib/analytics/aggregate";

/**
 * Analytics integrity (Phase 13 red-team, spec 9): the aggregation used by
 * GET /api/admin/analytics must match known database totals exactly — by
 * source, by status, cancellation reasons, clinic-local daily revenue trend
 * (UTC+5 boundary cases included), and top services/doctors.
 *
 * The aggregation module is the same code path the endpoint executes
 * (route.ts imports aggregateAppointments); here it runs over REAL rows
 * fetched with the endpoint's exact query.
 *
 * Requires: `npm run db:reset-local`. Skips cleanly when the stack is down.
 */

const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const TZ = "Asia/Tashkent";

const describeDb = describe.skipIf(!localDbAvailable());

describeDb("analytics integrity (real DB totals)", () => {
  let admin: SupabaseClient;
  let clinicId: string;
  let doctorId: string;
  let serviceId: string;
  let patientId: string;
  const suffix = Date.now().toString(36);

  beforeAll(async () => {
    admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });

    const { data: clinic } = await admin
      .from("clinics")
      .insert({ name: `Analytics Clinic ${suffix}`, slug: `analytics-${suffix}`, timezone: TZ, currency: "UZS" })
      .select("id")
      .single();
    clinicId = clinic!.id;

    const { data: spec } = await admin
      .from("specialties")
      .insert({ clinic_id: clinicId, name: `Spec ${suffix}`, active: true, sort_order: 1 })
      .select("id")
      .single();
    const { data: doc } = await admin
      .from("doctors")
      .insert({ clinic_id: clinicId, name: `Dr Analytics ${suffix}`, active: true })
      .select("id")
      .single();
    doctorId = doc!.id;
    await admin.from("doctor_working_hours").insert([
      { clinic_id: clinicId, doctor_id: doctorId, weekday: 1, start_time: "09:00", end_time: "18:00" },
      { clinic_id: clinicId, doctor_id: doctorId, weekday: 2, start_time: "09:00", end_time: "18:00" },
      // Wednesday has a night shift so a slot can cross the local midnight:
      // 19:30Z Tuesday == 00:30 local Wednesday.
      { clinic_id: clinicId, doctor_id: doctorId, weekday: 3, start_time: "00:00", end_time: "02:00" },
    ]);
    const { data: svc } = await admin
      .from("services")
      .insert({
        clinic_id: clinicId,
        name: `Konsultatsiya ${suffix}`,
        price: 50_000,
        duration_minutes: 30,
        active: true,
        specialty_id: spec!.id,
        sort_order: 1,
      })
      .select("id")
      .single();
    serviceId = svc!.id;
    const { data: patient } = await admin
      .from("patients")
      .insert({ clinic_id: clinicId, full_name: "Analytics Patient", phone: "+998900000001" })
      .select("id")
      .single();
    patientId = patient!.id;
  });

  afterAll(async () => {
    if (admin && clinicId) await admin.from("clinics").delete().eq("id", clinicId);
  });

  const insertAppt = (startAt: Date, status: string, source: string, reason: string | null = null, noShowReason: string | null = null) =>
    admin.from("appointments").insert({
      clinic_id: clinicId,
      patient_id: patientId,
      doctor_id: doctorId,
      service_id: serviceId,
      start_at: startAt.toISOString(),
      end_at: new Date(startAt.getTime() + 30 * 60000).toISOString(),
      status,
      source,
      cancelled_reason: reason,
      no_show_reason: noShowReason,
    });

  /** Local calendar day in Asia/Tashkent for a UTC instant. */
  const localDay = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

  it("totals match the known fixture set, including UTC+5 day-boundary revenue", async () => {
    // Fixture: fixed UTC instants so expectations are deterministic.
    // 2026-08-17 05:00Z == 10:00 local Mon; 19:30Z == 00:30 local next day.
    const day1 = new Date("2026-08-17T05:00:00Z"); // local Mon 10:00
    const day1Plus = new Date("2026-08-17T05:30:00Z"); // local Mon 10:30
    const day1Late = new Date("2026-08-18T19:30:00Z"); // local Wed 00:30 -> NEXT day bucket
    const day2 = new Date("2026-08-18T05:00:00Z"); // local Tue 10:00
    const day2Noon = new Date("2026-08-18T05:30:00Z"); // local Tue 10:30

    await insertAppt(day1, "completed", "telegram_mini_app"); // revenue 50k, bucket Mon
    await insertAppt(day1Plus, "completed", "walk_in"); // revenue 50k, bucket Mon
    await insertAppt(day1Late, "completed", "walk_in"); // revenue 50k, bucket Wed (00:30 local)
    await insertAppt(day2, "pending", "walk_in"); // no revenue
    await insertAppt(day2Noon, "cancelled", "telegram_mini_app", "Narxi qimmat"); // cancel reason
    await insertAppt(day1Plus, "no_show", "telegram_chat", null, "Bemorga aloqa yo‘q"); // no-show reason
    await insertAppt(day2Noon, "no_show", "telegram_chat", null, "Bemorga aloqa yo‘q"); // no-show reason

    // Fetch exactly what the endpoint queries (clinic-scoped, same columns).
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const { data, error } = await admin
      .from("appointments")
      .select("source, status, cancelled_reason, no_show_reason, start_at, services(name, price), doctors(name)")
      .eq("clinic_id", clinicId)
      .gte("start_at", since);
    expect(error).toBeNull();

    const agg = aggregateAppointments((data ?? []) as unknown as AnalyticsRow[], TZ);

    // Totals.
    expect(agg.total).toBe(7);
    expect(agg.cancelled).toBe(1);
    expect(agg.noShows).toBe(2);
    expect(agg.completed).toBe(3);

    // By source / status.
    const bySource = Object.fromEntries(agg.bySource);
    expect(bySource).toEqual({ telegram_mini_app: 2, telegram_chat: 2, walk_in: 3 });
    const byStatus = Object.fromEntries(agg.byStatus);
    expect(byStatus).toEqual({ completed: 3, pending: 1, cancelled: 1, no_show: 2 });

    // Cancellation and no-show reasons.
    expect(agg.cancelReasons).toEqual([{ reason: "Narxi qimmat", count: 1 }]);
    expect(agg.noShowReasons).toEqual([{ reason: "Bemorga aloqa yo‘q", count: 2 }]);

    // Revenue trend bucketed by CLINIC-LOCAL day: the 19:30Z appointment
    // lands in the NEXT local day (Wednesday), not the UTC day.
    const mon = localDay(day1);
    const wed = "2026-08-19";
    expect(agg.revenueTrend).toEqual([
      { date: mon, revenue: 100_000 }, // two completed on Mon 10:00
      { date: wed, revenue: 50_000 }, // 00:30 local Wednesday
    ]);

    // Weekly and monthly buckets must equal the daily totals' sums.
    const totalRevenue = agg.revenueTrend.reduce((s, d) => s + d.revenue, 0);
    expect(agg.revenueByWeek.reduce((s, d) => s + d.revenue, 0)).toBe(totalRevenue);
    expect(agg.revenueByMonth.reduce((s, d) => s + d.revenue, 0)).toBe(totalRevenue);
    expect(agg.revenueByWeek).toEqual([{ key: "2026-W34", revenue: 150_000 }]);
    expect(agg.revenueByMonth).toEqual([{ key: "2026-08", revenue: 150_000 }]);

    // Top service/doctor: counts + revenue only from completed rows.
    expect(agg.topServices).toEqual([{ name: `Konsultatsiya ${suffix}`, count: 7, revenue: 150_000 }]);
    expect(agg.topDoctors).toEqual([{ name: `Dr Analytics ${suffix}`, count: 7, revenue: 150_000 }]);
  });

  it("partial days and empty ranges aggregate to zero without errors", async () => {
    const { data: none } = await admin
      .from("appointments")
      .select("source, status, cancelled_reason, no_show_reason, start_at, services(name, price), doctors(name)")
      .eq("clinic_id", clinicId)
      .gte("start_at", new Date(Date.now() + 2 * 86400000).toISOString());
    const agg = aggregateAppointments((none ?? []) as unknown as AnalyticsRow[], TZ, 3);
    expect(agg.total).toBe(0);
    expect(agg.revenueTrend).toEqual([]);
    expect(agg.revenueByWeek).toEqual([]);
    expect(agg.revenueByMonth).toEqual([]);
    expect(agg.cancelReasons).toEqual([]);
    expect(agg.noShowReasons).toEqual([]);
    expect(agg.topServices).toEqual([]);
  });
});
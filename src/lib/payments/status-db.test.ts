import { cleanupTestClinics } from "@/test/cleanup-clinics";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { localDbAvailable } from "@/test/local-db";
import { transitionPaymentStatus } from "@/lib/payments/status";

/**
 * Payment integrity against the real database: a provider webhook and a staff
 * action racing on one payment — only one transition may apply, and it must
 * be legal from the state the payment was actually in.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const describeDb = describe.skipIf(!localDbAvailable());

describeDb("payment status transitions — compare-and-set against the real database", () => {
  let sql: postgres.Sql;
  const suffix = Date.now().toString(36);
  const clinic = randomUUID();
  const doctor = randomUUID();
  const service = randomUUID();
  const patient = randomUUID();
  let day = 50 + Math.floor(Math.random() * 3000);

  async function newPayment(): Promise<string> {
    const d = new Date(Date.now() + day++ * 86_400_000);
    const start = `${d.toISOString().slice(0, 10)}T05:00:00Z`;
    const [row] = await sql<{ appointment_id: string | null; error_code: string | null }[]>`
      select appointment_id, error_code from public.book_appointment(
        ${clinic}, ${patient}, ${doctor}, ${service}, ${start}::timestamptz, 'confirmed', 'admin', null, null, null)`;
    if (!row.appointment_id) throw new Error(`book_appointment: ${row.error_code}`);
    const [payment] = await sql<{ id: string }[]>`select id from public.payments where appointment_id = ${row.appointment_id}`;
    return payment.id;
  }
  const outcome = (p: Promise<unknown>) =>
    p.then(
      () => "applied",
      (e: { code?: string }) => e.code ?? "error",
    );

  beforeAll(async () => {
    sql = postgres(DB_URL, { max: 4, onnotice: () => {} });
    await sql`insert into public.clinics (id, name, slug, timezone) values (${clinic}, ${`Payments ${suffix}`}, ${`payments-${suffix}`}, 'Asia/Tashkent')`;
    await sql`insert into public.doctors (id, clinic_id, name, active) values (${doctor}, ${clinic}, ${`Dr Pay ${suffix}`}, true)`;
    await sql`insert into public.services (id, clinic_id, name, duration_minutes, price) values (${service}, ${clinic}, ${`Consult ${suffix}`}, 30, 150000)`;
    await sql`insert into public.patients (id, clinic_id, full_name) values (${patient}, ${clinic}, ${`Payer ${suffix}`})`;
    await sql`insert into public.doctor_working_hours ${sql([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ clinic_id: clinic, doctor_id: doctor, weekday, start_time: "08:00", end_time: "18:00" })))}`;
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanupTestClinics([clinic]);
    await sql.end({ timeout: 5 });
  });

  it("a webhook marking paid and staff marking failed at the same time: exactly one applies, once audited", async () => {
    for (let round = 0; round < 8; round++) {
      const paymentId = await newPayment();
      await transitionPaymentStatus({ clinicId: clinic, paymentId, to: "pending", actorType: "system" });

      const results = await Promise.all([
        outcome(transitionPaymentStatus({ clinicId: clinic, paymentId, to: "paid", actorType: "system", metadata: { provider_event: `evt-${round}` } })),
        outcome(transitionPaymentStatus({ clinicId: clinic, paymentId, to: "failed", actorType: "staff" })),
      ]);
      expect(results.filter((r) => r === "applied")).toHaveLength(1);
      for (const r of results.filter((x) => x !== "applied")) expect(["payment_changed", "invalid_transition"]).toContain(r);

      const [payment] = await sql<{ status: string }[]>`select status from public.payments where id = ${paymentId}`;
      expect(payment.status).toBe(results[0] === "applied" ? "paid" : "failed");
      const audits = await sql<{ n: number }[]>`
        select count(*)::int as n from public.audit_events
         where entity_id = ${paymentId} and action = 'payment_status_changed' and new_values->>'status' in ('paid', 'failed')`;
      expect(audits[0].n).toBe(1);
    }
  });

  it("each transition keeps the provider details recorded before it", async () => {
    const paymentId = await newPayment();
    await transitionPaymentStatus({ clinicId: clinic, paymentId, to: "pending", actorType: "system", metadata: { invoice_id: "inv-1" } });
    await transitionPaymentStatus({ clinicId: clinic, paymentId, to: "paid", actorType: "system", metadata: { provider_event: "evt-paid" } });
    const [row] = await sql<{ metadata: Record<string, unknown> }[]>`select metadata from public.payments where id = ${paymentId}`;
    expect(row.metadata).toMatchObject({ invoice_id: "inv-1", provider_event: "evt-paid" });
  });
});

import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/api/errors";
import { recordAudit } from "@/lib/audit";
import { getClinicSubscription, listPublicPlans } from "@/lib/billing/subscription";

export type Invoice = {
  id: string;
  number: string;
  amountUzs: number;
  months: number;
  status: "issued" | "paid" | "void";
  issuedAt: string;
  dueAt: string;
  paidAt: string | null;
  planName: string;
};

export type Payee = { legalName: string; tin: string; bankName: string; bankAccount: string; mfo: string; contactPhone: string };

export async function getPayee(): Promise<Payee> {
  const { data } = await createAdminClient().from("platform_billing").select("*").eq("id", true).maybeSingle();
  return {
    legalName: data?.legal_name ?? "",
    tin: data?.tin ?? "",
    bankName: data?.bank_name ?? "",
    bankAccount: data?.bank_account ?? "",
    mfo: data?.mfo ?? "",
    contactPhone: data?.contact_phone ?? "",
  };
}

export async function listInvoices(clinicId: string): Promise<Invoice[]> {
  const { data, error } = await createAdminClient()
    .from("subscription_invoices")
    .select("id, number, amount_uzs, months, status, issued_at, due_at, paid_at, subscription_plans(name)")
    .eq("clinic_id", clinicId)
    .order("issued_at", { ascending: false })
    .limit(24);
  if (error) throw new ApiError(500, "Hisob-fakturalarni o‘qib bo‘lmadi");
  return (data ?? []).map((i) => ({
    id: i.id,
    number: i.number,
    amountUzs: i.amount_uzs,
    months: i.months,
    status: i.status as Invoice["status"],
    issuedAt: i.issued_at,
    dueAt: i.due_at,
    paidAt: i.paid_at,
    planName: i.subscription_plans?.name ?? "",
  }));
}

/** The owner's billing page: plan, status, invoices, the payee to transfer to, and the plans to switch to. */
export async function billingOverview(clinicId: string) {
  const [subscription, invoices, payee, plans] = await Promise.all([
    getClinicSubscription(clinicId),
    listInvoices(clinicId),
    getPayee(),
    listPublicPlans(),
  ]);
  return { subscription, invoices, payee, plans };
}

/** An invoice for N months of the current plan (an open one is reused). */
export async function requestInvoice(clinicId: string, actorId: string, months: number): Promise<string> {
  const db = createAdminClient();
  const { data: open } = await db.from("subscription_invoices").select("id, months").eq("clinic_id", clinicId).eq("status", "issued").maybeSingle();
  // A different number of months replaces the open invoice (nothing has been paid on it).
  if (open && open.months !== months) {
    await db.from("subscription_invoices").update({ status: "void" }).eq("id", open.id).eq("status", "issued");
  }
  const { data, error } = await db.rpc("issue_subscription_invoice", { p_clinic_id: clinicId, p_months: months });
  if (error || !data) throw new ApiError(500, "Hisob-faktura yaratib bo‘lmadi");
  await recordAudit({
    clinicId,
    action: "subscription_invoice_requested",
    entityType: "subscription_invoices",
    entityId: data,
    actor: { actorId, actorType: "staff" },
    newValues: { months },
  });
  return data;
}

/**
 * The owner switches plans. The open invoice (unpaid by definition) is replaced by one at the new price; a plan whose
 * limits the clinic already exceeds is refused.
 */
export async function changePlan(clinicId: string, actorId: string, planCode: string): Promise<void> {
  const db = createAdminClient();
  const { data: plan } = await db.from("subscription_plans").select("id, name, max_staff, max_doctors").eq("code", planCode).eq("is_public", true).maybeSingle();
  if (!plan) throw new ApiError(404, "Tarif topilmadi", "plan_not_found");
  const [{ count: staff }, { count: doctors }] = await Promise.all([
    db.from("staff_roles").select("id", { count: "exact", head: true }).eq("clinic_id", clinicId),
    db.from("staff_roles").select("id", { count: "exact", head: true }).eq("clinic_id", clinicId).eq("role", "doctor"),
  ]);
  if ((plan.max_staff !== null && (staff ?? 0) > plan.max_staff) || (plan.max_doctors !== null && (doctors ?? 0) > plan.max_doctors)) {
    throw new ApiError(409, `Klinikada “${plan.name}” tarifi ruxsat beradiganidan ko‘p xodim bor`, "plan_too_small");
  }
  const { data: sub } = await db.from("clinic_subscriptions").select("plan_id").eq("clinic_id", clinicId).maybeSingle();
  if (!sub) throw new ApiError(404, "Obuna topilmadi", "subscription_not_found");
  if (sub.plan_id === plan.id) return;
  const { error } = await db.from("clinic_subscriptions").update({ plan_id: plan.id, updated_at: new Date().toISOString() }).eq("clinic_id", clinicId);
  if (error) throw new ApiError(500, "Tarifni o‘zgartirib bo‘lmadi");
  const { data: open } = await db.from("subscription_invoices").select("id, months").eq("clinic_id", clinicId).eq("status", "issued").maybeSingle();
  if (open) {
    await db.from("subscription_invoices").update({ status: "void" }).eq("id", open.id).eq("status", "issued");
    await db.rpc("issue_subscription_invoice", { p_clinic_id: clinicId, p_months: open.months });
  }
  await recordAudit({
    clinicId,
    action: "subscription_plan_changed",
    entityType: "clinic_subscriptions",
    entityId: clinicId,
    actor: { actorId, actorType: "staff" },
    newValues: { plan: planCode },
  });
}

/** One of the clinic's own invoices, with what a printed invoice shows; null when it is not this clinic's. */
export async function invoiceForPrint(clinicId: string, invoiceId: string) {
  const { data } = await createAdminClient()
    .from("subscription_invoices")
    .select("number, amount_uzs, months, status, issued_at, due_at, paid_at, subscription_plans(name), clinics(name, address, city, phone)")
    .eq("id", invoiceId)
    .eq("clinic_id", clinicId)
    .maybeSingle();
  if (!data) return null;
  return {
    number: data.number,
    amountUzs: data.amount_uzs,
    months: data.months,
    status: data.status as Invoice["status"],
    issuedAt: data.issued_at,
    dueAt: data.due_at,
    paidAt: data.paid_at,
    planName: data.subscription_plans?.name ?? "",
    clinic: {
      name: data.clinics?.name ?? "",
      address: [data.clinics?.city, data.clinics?.address].filter(Boolean).join(", "),
      phone: data.clinics?.phone ?? "",
    },
    payee: await getPayee(),
  };
}

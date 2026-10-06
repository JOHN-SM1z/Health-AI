import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireRoles } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireLinkedDoctor } from "@/lib/referrals/access";
import { parseBody, uuidSchema, nameSchema, phoneSchema } from "@/lib/api/validate";
import { ApiError, handleApiError, ok } from "@/lib/api/errors";

const arrivalSchema = z.object({
  patientId: uuidSchema.optional(), patientName: nameSchema.optional(), phone: phoneSchema.optional(),
  doctorId: uuidSchema, serviceId: uuidSchema, idempotencyKey: uuidSchema,
}).strict().refine((v) => !!v.patientId || !!v.patientName, "Bemorni tanlang yoki ism kiriting");
const transitionSchema = z.object({ id: uuidSchema, expectedStatus: z.string(), status: z.enum(["waiting", "called", "in_progress", "completed", "cancelled"]) }).strict();

export async function GET(request: NextRequest) {
  try {
    const staff = await requireRoles("owner", "admin", "manager", "receptionist", "doctor");
    const db = createAdminClient();
    const date = request.nextUrl.searchParams.get("date") ?? new Intl.DateTimeFormat("en-CA", { timeZone: staff.clinicTimezone }).format(new Date());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError(400, "Sana noto‘g‘ri");
    const page=z.coerce.number().int().min(0).max(10000).parse(request.nextUrl.searchParams.get("page")??0);
    const active=request.nextUrl.searchParams.get("filter")!=="all";
    let query = db.from("visits").select("id,clinic_id,patient_id,doctor_id,service_id,queue_number,queue_date,status,arrived_at, patients(id, full_name, phone, patient_number), doctors(name), services(name), payments(id, amount, currency, status)",{count:"exact"}).eq("clinic_id", staff.clinicId).or(`queue_date.eq.${date},status.in.(waiting,called,in_progress)`).order("queue_date").order("queue_number").range(page*100,page*100+99);
    if(active)query=query.in("status",["waiting","called","in_progress"]);
    const operational=staff.roles.some(role=>["owner","admin","manager","receptionist"].includes(role));
    if (!operational || request.nextUrl.searchParams.get("scope")==="mine") {
      const doctor = await requireLinkedDoctor(staff);
      query = query.eq("doctor_id", doctor.id);
    }
    const { data, error, count } = await query;
    if (error) throw new ApiError(503, "Navbatni yuklab bo‘lmadi. Qayta urinib ko‘ring.");
    return ok({ visits: data ?? [], total:count??0, date, timezone: staff.clinicTimezone, refreshedAt: new Date().toISOString() });
  } catch (e) { return handleApiError(e); }
}
export async function POST(request: NextRequest) {
  try {
    const staff = await requireRoles("owner", "admin", "manager", "receptionist");
    const body = await parseBody(request, arrivalSchema);
    const { data, error } = await createAdminClient().rpc("register_walk_in", {
      p_clinic: staff.clinicId, p_actor: staff.profileId, p_key: body.idempotencyKey,
      p_patient: body.patientId ?? null, p_name: body.patientName ?? null, p_phone: body.phone ?? null,
      p_doctor: body.doctorId, p_service: body.serviceId,
    });
    if (error) throw new ApiError(error.code === "42501" ? 403 : 409, "Bemorni navbatga qo‘shib bo‘lmadi. Tanlangan bemor, shifokor va xizmatni tekshiring.");
    return ok({ visit: data }, { status: 201 });
  } catch (e) { return handleApiError(e); }
}
export async function PATCH(request: NextRequest) {
  try {
    const staff = await requireRoles("owner", "admin", "manager", "receptionist", "doctor");
    const body = await parseBody(request, transitionSchema);
    const { data, error } = await createAdminClient().rpc("transition_visit", { p_clinic: staff.clinicId, p_actor: staff.profileId, p_visit: body.id, p_expected: body.expectedStatus, p_status: body.status });
    if (error) throw new ApiError(error.code === "42501" ? 403 : 409, "Navbat holati o‘zgargan yoki bu amal uchun ruxsat yo‘q. Yangilang.");
    return ok({ visit: data });
  } catch (e) { return handleApiError(e); }
}

import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireRoles } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseBody,uuidSchema } from "@/lib/api/validate";
import { ApiError,handleApiError,ok } from "@/lib/api/errors";
import { isManualPaymentMode } from "@/lib/payments/provider";
export async function GET(request:NextRequest){
 try{
  const ctx=await requireRoles("owner","admin","manager");
  const raw=request.nextUrl.searchParams.get("patientId");
  if(!raw)return ok({payments:[]});
  const id=uuidSchema.parse(raw);
  const {data,error}=await createAdminClient().from("payments").select("id,amount,currency,status,created_at,metadata,patients(full_name,patient_number),visits(queue_number,queue_date,status,services(name),doctors(name))").eq("clinic_id",ctx.clinicId).eq("patient_id",id).not("visit_id","is",null).order("created_at",{ascending:false}).limit(100);
  if(error)throw new ApiError(503,"To‘lovlar yuklanmadi");
  return ok({payments:data??[]});
 }catch(e){return handleApiError(e);}
}
export async function POST(request:NextRequest){
 try{
  const ctx=await requireRoles("owner","admin","manager");
  if(!isManualPaymentMode())throw new ApiError(409,"To‘lov provayderi qo‘lda tasdiqlash rejimida emas");
  const body=await parseBody(request,z.object({id:uuidSchema,expectedStatus:z.enum(["unpaid","paid"]),status:z.enum(["paid","refunded"]),method:z.enum(["cash","terminal"]).optional(),reason:z.string().trim().min(3).max(500).optional()}).strict());
  const {data,error}=await createAdminClient().rpc("set_manual_visit_payment",{p_clinic:ctx.clinicId,p_actor:ctx.profileId,p_payment:body.id,p_expected:body.expectedStatus,p_status:body.status,p_method:body.method??null,p_reason:body.reason??null});
  if(error)throw new ApiError(error.code==="42501"?403:409,"To‘lov saqlanmadi. Holatni yangilang va ma’lumotlarni tekshiring.");
  return ok({payment:data});
 }catch(e){return handleApiError(e);}
}

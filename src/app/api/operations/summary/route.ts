import type {NextRequest} from "next/server";
import {requireRoles} from "@/lib/auth/guards";
import {createAdminClient} from "@/lib/supabase/admin";
import {ApiError,ok,handleApiError} from "@/lib/api/errors";
export async function GET(request:NextRequest){try{const ctx=await requireRoles("owner","admin","manager");const month=request.nextUrl.searchParams.get("month")??new Intl.DateTimeFormat("en-CA",{timeZone:ctx.clinicTimezone}).format(new Date()).slice(0,7);if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw new ApiError(400,"Oy noto‘g‘ri");const {data,error}=await createAdminClient().rpc("operations_summary",{p_clinic:ctx.clinicId,p_actor:ctx.profileId,p_month:month+"-01"});if(error)throw new ApiError(503,"Hisobot yuklanmadi");return ok({summary:data,month});}catch(e){return handleApiError(e);}}

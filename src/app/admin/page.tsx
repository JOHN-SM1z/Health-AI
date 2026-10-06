import {redirect} from "next/navigation";
import {getStaffContext} from "@/lib/auth/staff";
import {getOperationsSettings} from "@/lib/operations/server";
import {LiveQueue} from "@/components/operations/live-queue";
export default async function ReceptionPage(){const ctx=await getStaffContext();if(!ctx?.clinicId)redirect("/login");if((await getOperationsSettings(ctx.clinicId)).mode==="scheduled")redirect("/admin/appointments");return <LiveQueue/>;}

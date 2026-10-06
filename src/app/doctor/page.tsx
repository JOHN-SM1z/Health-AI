import Link from "next/link";
import {redirect} from "next/navigation";
import {getStaffContext} from "@/lib/auth/staff";
import {getOperationsSettings} from "@/lib/operations/server";
import {LiveQueue} from "@/components/operations/live-queue";
import {ScheduledDoctorQueue} from "@/components/operations/scheduled-doctor-queue";
export default async function DoctorQueuePage({searchParams}:{searchParams:Promise<{queue?:string}>}){const ctx=await getStaffContext();if(!ctx?.clinicId)redirect("/login");const mode=(await getOperationsSettings(ctx.clinicId)).mode;const scheduled=mode==="scheduled"||(mode==="mixed"&&(await searchParams).queue==="scheduled");return <>{mode==="mixed"&&<nav className="mb-5 flex gap-4 text-sm"><Link href="/doctor">Jonli navbat</Link><Link href="/doctor?queue=scheduled">Belgilangan qabullar</Link></nav>}{scheduled?<ScheduledDoctorQueue timezone={ctx.clinicTimezone}/>:<LiveQueue doctor/>}</>;}

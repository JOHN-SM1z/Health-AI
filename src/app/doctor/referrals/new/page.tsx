import { NewReferral } from "@/components/operations/referral-views";
export default async function Page({searchParams}:{searchParams:Promise<{patientId?:string}>}){return <NewReferral patientId={(await searchParams).patientId}/>;}

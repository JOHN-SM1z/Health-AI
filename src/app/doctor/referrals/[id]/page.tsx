import { ReferralDetail } from "@/components/operations/referral-views";
export default async function Page({params}:{params:Promise<{id:string}>}){return <ReferralDetail id={(await params).id}/>;}

import Link from "next/link";
import { BookingFlow } from "@/components/mini-app/booking-flow";
import { getClinicById, getDefaultClinic } from "@/lib/clinics/context";
import { getOperationsSettings } from "@/lib/operations/server";
export const dynamic = "force-dynamic";
export default async function BookPage({searchParams}:{searchParams:Promise<{clinic?:string}>}) {
  const {clinic:id}=await searchParams;
  const clinic=id?await getClinicById(id):await getDefaultClinic();
  if ((await getOperationsSettings(clinic.id)).mode==="walk_in") return <div className="mx-auto max-w-md space-y-4 p-6"><h1 className="text-2xl font-semibold">Jonli navbat</h1><p>Bu klinikada oldindan yozilish yo‘q. Kelganingizda registratsiya sizni navbatga qo‘shadi.</p><Link href={`/help?clinic=${clinic.id}`}>Klinika ma’lumotlari →</Link></div>;
  return <BookingFlow/>;
}

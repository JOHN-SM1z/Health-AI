import Link from "next/link";
import { HeartPulse } from "lucide-react";
import { Card, Eyebrow } from "@/components/mini-app/ui";
import { getClinicById, getDefaultClinic } from "@/lib/clinics/context";
import { getOperationsSettings } from "@/lib/operations/server";
export const dynamic = "force-dynamic";
export default async function HomePage({searchParams}:{searchParams:Promise<{clinic?:string}>}) {
  const {clinic:clinicId}=await searchParams;
  let clinic;let scheduled=false;
  try {clinic=clinicId?await getClinicById(clinicId):await getDefaultClinic();scheduled=(await getOperationsSettings(clinic.id)).mode!=="walk_in";} catch { return <div className="mx-auto max-w-md p-8"><h1 className="text-xl font-semibold">Health AI</h1><p className="mt-4">Klinika ma’lumotlari hozir yuklanmadi. Keyinroq qayta urinib ko‘ring.</p></div>; }
  const query=`?clinic=${encodeURIComponent(clinic.id)}`;
  return <div className="mx-auto flex max-w-md flex-col gap-6 px-4 py-10"><div className="text-center"><HeartPulse className="mx-auto mb-4 h-10 w-10 text-pine"/><Eyebrow>{clinic.name}</Eyebrow><h1 className="mt-3 font-display text-3xl font-bold">Klinika ma’lumotlari</h1><p className="mt-3 text-sm text-ink-muted">{scheduled?"Xizmatlar, ish vaqti va qabulga yozilish.":"Klinikada jonli navbat. Kelganingizda registratsiyaga murojaat qiling."}</p></div><Link href={`/help${query}`}><Card><h2 className="font-semibold">Manzil, narxlar va savollar</h2><p className="mt-1 text-sm text-ink-muted">Klinika tasdiqlagan ma’lumotlar</p></Card></Link>{scheduled&&<><Link href={`/book${query}`}><Card>Qabulga yozilish →</Card></Link><Link href={`/my-appointments${query}`}><Card>Mening qabullarim →</Card></Link></>}<p className="text-center text-xs text-ink-muted">AI tibbiy tashxis qo‘ymaydi va davolash tavsiya qilmaydi.</p></div>;
}

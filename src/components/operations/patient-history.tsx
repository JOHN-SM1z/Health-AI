"use client";
import Link from "next/link";
export function PatientHistory({ patientId }: { patientId: string; visitId?: string; referralId?: string }) {
  return <Link href={`/doctor/patients/${encodeURIComponent(patientId)}`} className="text-pine underline">Bemorning klinik kartasini ochish</Link>;
}

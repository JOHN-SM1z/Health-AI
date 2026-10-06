import { PatientHistory } from "@/components/operations/patient-history";
export default async function Page({ params, searchParams }: {params:Promise<{id:string}>;searchParams:Promise<{visit?:string;referral?:string}>}) {
  const {id} = await params; const query = await searchParams;
  return <PatientHistory patientId={id} visitId={query.visit} referralId={query.referral} />;
}

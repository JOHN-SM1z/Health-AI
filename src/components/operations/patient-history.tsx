"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { adminApi, formatDateTime } from "@/lib/admin/client";
import { AButton, AError, AInput, ASelect, Card, PageHeader, LoadingRow } from "@/components/admin/ui";
type Note = {id:string;title:string;content:string;note_type:string;is_private:boolean;created_at:string;doctor:{name:string}|null};
export function PatientHistory({patientId,visitId,referralId}:{patientId:string;visitId?:string;referralId?:string}) {
  const [patient,setPatient]=useState<{full_name:string;patient_number:number}|null>(null);
  const [notes,setNotes]=useState<Note[]>([]); const [error,setError]=useState("");
  const [title,setTitle]=useState(""); const [content,setContent]=useState(""); const [type,setType]=useState("clinical_note");
  const [busy,setBusy]=useState(false); const [saved,setSaved]=useState(false);
  const load=useCallback(async()=>{
    try { const [p,n]=await Promise.all([adminApi.get<{patient: typeof patient}>(`/api/doctor/patients/${patientId}`),adminApi.get<{notes:Note[]}>(`/api/doctor/clinical-notes?patientId=${patientId}`)]);setPatient(p.patient);setNotes(n.notes);setError(""); }
    catch(e){setError(e instanceof Error?e.message:"Tarix yuklanmadi");setPatient(null);}
  },[patientId]);
  useEffect(()=>{void load();},[load]);
  async function save(){setBusy(true);setSaved(false);try{await adminApi.post("/api/doctor/clinical-notes",{patientId,...(visitId?{visitId}:{}),...(referralId?{referralId}:{}),title,content,noteType:type});setTitle("");setContent("");setSaved(true);await load();}catch(e){setError(e instanceof Error?e.message:"Saqlanmadi");}finally{setBusy(false);}}
  return <div><PageHeader title={patient?`${patient.full_name} · №${patient.patient_number}`:"Bemor tarixi"} subtitle="Har bir qayd muallifi va vaqti bilan saqlanadi." action={patient?<Link className="rounded-lg bg-pine px-4 py-2 text-white" href={`/doctor/referrals/new?patientId=${patientId}`}>Boshqa shifokorga yo‘naltirish</Link>:undefined}/>
    {patient&&<Link className="mb-4 inline-block text-sm text-pine underline" href={`/doctor/laboratory?patientId=${patientId}`}>Laboratoriya buyurtmasi</Link>}
    {error&&<AError message={error}/>}
    {!patient?(!error&&<LoadingRow/>):<><Card className="mb-5"><fieldset disabled={busy} className="space-y-4"><h2 className="font-semibold">Yangi shifokor qaydi</h2><p className="text-sm text-ink-muted">Oldingi qayd o‘zgartirilmaydi. Tuzatishni yangi qayd sifatida kiriting.</p><label className="block text-sm">Qayd turi<ASelect value={type} onChange={setType} options={[{value:"clinical_note",label:"Ko‘rik qaydi"},{value:"current_assessment",label:"Joriy baholash"},{value:"new_diagnosis",label:"Shifokor tashxisi"},{value:"prescription",label:"Shifokor retsepti"},{value:"follow_up",label:"Keyingi kuzatuv"}]}/></label><label className="block text-sm">Sarlavha<AInput value={title} onChange={setTitle} maxLength={200}/></label><label className="block text-sm">Mazmun<textarea className="mt-1 block min-h-40 w-full rounded-lg border border-hairline bg-surface p-3" value={content} onChange={e=>setContent(e.target.value)} maxLength={10000}/></label><AButton loading={busy} disabled={!title.trim()||!content.trim()} onClick={()=>void save()}>Qaydni saqlash</AButton>{saved&&<p className="text-sm text-pine">Qayd saqlandi.</p>}</fieldset></Card>
    <div className="print-history space-y-4"><h2 className="text-lg font-semibold">Saqlangan tarix — {patient.full_name} · №{patient.patient_number}</h2>{notes.length===0?<Card>Hozircha elektron qaydlar yo‘q.</Card>:notes.map(n=><Card key={n.id}><h3 className="font-semibold">{n.title}</h3><p className="my-2 text-xs text-ink-muted">{n.doctor?.name??"Shifokor"} · {formatDateTime(n.created_at)}{n.is_private?" · Shaxsiy qayd":""}</p><p className="whitespace-pre-wrap text-sm leading-relaxed">{n.content}</p></Card>)}</div><div className="mt-4"><AButton variant="outline" onClick={()=>window.print()}>Tarixni chop etish</AButton></div></>}
  </div>;
}

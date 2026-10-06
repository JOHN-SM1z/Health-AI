import { Suspense } from "react";
import { LaboratoryWorkbench } from "@/components/operations/laboratory-workbench";
export default function LaboratoryPage() {
  return <Suspense fallback={<p>Laboratoriya yuklanmoqda…</p>}><LaboratoryWorkbench /></Suspense>;
}

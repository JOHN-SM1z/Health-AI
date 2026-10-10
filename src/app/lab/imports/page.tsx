import { redirect } from "next/navigation";
import { getStaffContext } from "@/lib/auth/staff";
import { labCan } from "@/lib/labs/permissions";
import { LabImportList } from "@/components/lab/import-list";

/** Historical lab-result imports (Phase 13). */
export default async function LabImportsPage() {
  const ctx = await getStaffContext();
  if (!ctx) redirect("/login");
  if (!labCan(ctx.roles, "import.manage")) redirect("/lab");
  return <LabImportList />;
}

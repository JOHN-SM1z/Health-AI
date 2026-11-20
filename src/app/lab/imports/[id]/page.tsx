import { notFound, redirect } from "next/navigation";
import { getStaffContext } from "@/lib/auth/staff";
import { labCan } from "@/lib/labs/permissions";
import { LabImportWizard } from "@/components/lab/import-wizard";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One historical import: mapping, preview, dry run, second-person confirmation, report. */
export default async function LabImportPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getStaffContext();
  if (!ctx) redirect("/login");
  if (!labCan(ctx.roles, "import.manage")) redirect("/lab");
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return <LabImportWizard batchId={id} />;
}

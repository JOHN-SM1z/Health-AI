import { redirect } from "next/navigation";
import { getStaffContext } from "@/lib/auth/staff";
import { labCan } from "@/lib/labs/permissions";
import { LabWorkQueue } from "@/components/lab/work-queue";

/**
 * The lab work queue at the reception desk: receptionists collect samples
 * and take walk-in orders; management sees the work status. Processing
 * (receive / reject) stays with the lab.
 */
export default async function AdminLabQueuePage() {
  const ctx = await getStaffContext();
  if (!ctx) redirect("/login");
  if (!labCan(ctx.roles, "queue.read")) redirect("/admin");
  return (
    <LabWorkQueue
      canCollect={labCan(ctx.roles, "sample.collect")}
      canProcess={labCan(ctx.roles, "sample.process")}
      canOrder
    />
  );
}

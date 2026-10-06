import { redirect } from "next/navigation";
import { getStaffContext } from "@/lib/auth/staff";
import { labCan } from "@/lib/labs/permissions";
import { LabWorkQueue } from "@/components/lab/work-queue";

/** Lab work queue: collect, receive and reject samples, take walk-in orders. */
export default async function LabHomePage() {
  const ctx = await getStaffContext();
  if (!ctx) redirect("/login");
  return (
    <LabWorkQueue
      canCollect={labCan(ctx.roles, "sample.collect")}
      canProcess={labCan(ctx.roles, "sample.process")}
      canOrder={labCan(ctx.roles, "queue.read")}
      canEnter={labCan(ctx.roles, "result.enter")}
    />
  );
}

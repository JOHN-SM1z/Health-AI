import { redirect } from "next/navigation";
import { getStaffContext, hasAnyRole } from "@/lib/auth/staff";
import { labCan } from "@/lib/labs/permissions";
import { LabWorkQueue } from "@/components/lab/work-queue";
import { LabLiveQueue } from "@/components/operations/lab-live-queue";

/** Lab work queue: collect, receive and reject samples, take walk-in orders. */
export default async function LabHomePage() {
  const ctx = await getStaffContext();
  if (!ctx) redirect("/login");
  return (
    <>
      <LabLiveQueue canAct={hasAnyRole(ctx.roles, ["lab"])} />
      <LabWorkQueue
      canCollect={labCan(ctx.roles, "sample.collect")}
      canProcess={labCan(ctx.roles, "sample.process")}
      canCancel={labCan(ctx.roles, "order.cancel")}
      canOrder={labCan(ctx.roles, "queue.read")}
      canEnter={labCan(ctx.roles, "result.enter")}
      />
    </>
  );
}

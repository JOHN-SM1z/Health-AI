import { redirect } from "next/navigation";
import { getStaffContext, hasAnyRole } from "@/lib/auth/staff";
import { PatientMerge } from "@/components/admin/patient-merge";

/** Patient merge (owner / administrator). */
export default async function PatientMergePage() {
  const ctx = await getStaffContext();
  if (!ctx) redirect("/login");
  if (!hasAnyRole(ctx.roles, ["owner", "admin"])) redirect("/admin/patients");
  return <PatientMerge />;
}

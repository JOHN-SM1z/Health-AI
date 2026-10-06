import { redirect } from "next/navigation";
import { getStaffContext, hasAnyRole } from "@/lib/auth/staff";
import { StaffManager } from "@/components/admin/staff-manager";

export const metadata = { title: "Xodimlar" };

/** Owner-only screen: add/remove staff and assign clinic roles. */
export default async function StaffPage() {
  const ctx = await getStaffContext();
  if (!ctx) redirect("/login");
  if (!hasAnyRole(ctx.roles, ["owner"])) redirect("/admin");

  return <StaffManager />;
}

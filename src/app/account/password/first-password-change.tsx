"use client";

import { useRouter } from "next/navigation";
import { ChangePasswordForm } from "@/components/account/change-password-form";

/** After the change the employee goes on to their own panel (the admin layout routes each role). */
export function FirstPasswordChange() {
  const router = useRouter();
  return (
    <ChangePasswordForm
      onChanged={() => {
        router.replace("/admin");
        router.refresh();
      }}
    />
  );
}

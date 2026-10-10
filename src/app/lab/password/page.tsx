import { PageHeader } from "@/components/admin/ui";
import { ChangePasswordForm } from "@/components/account/change-password-form";

export default function LabPasswordPage() {
  return (
    <div>
      <PageHeader title="Parolni o‘zgartirish" subtitle="Klinika egasi bergan vaqtinchalik parolni birinchi kirishdayoq almashtiring" />
      <ChangePasswordForm />
    </div>
  );
}

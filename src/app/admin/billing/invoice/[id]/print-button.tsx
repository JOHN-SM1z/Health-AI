"use client";

import { Printer } from "lucide-react";
import { AButton } from "@/components/admin/ui";

export function PrintButton() {
  return (
    <AButton onClick={() => window.print()}>
      <Printer className="h-4 w-4" /> Chop etish yoki PDF saqlash
    </AButton>
  );
}

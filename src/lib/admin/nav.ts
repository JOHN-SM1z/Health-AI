import type { ComponentType } from "react";
import {
  LayoutDashboard,
  ClipboardList,
  CalendarDays,
  MessagesSquare,
  Users,
  Stethoscope,
  Scissors,
  Sparkles,
  BarChart3,
  Wallet,
  Settings,
  History,
  CalendarRange,
} from "lucide-react";
import type { Permission } from "@/lib/auth/permissions";

export type NavItem = { href: string; label: string; icon: ComponentType<{ className?: string }> };

/** Same links, order, icons and per-permission gating as the pre-redesign hardcoded array — reads from Permission instead of two separate ad-hoc booleans (isManagement/financeVisible). */
export function adminNavItems(permissions: Set<Permission>): NavItem[] {
  const items: NavItem[] = [{ href: "/admin", label: "Bugun", icon: LayoutDashboard }];
  if (permissions.has("appointments:manage")) items.push({ href: "/admin/appointments", label: "Qabullar", icon: ClipboardList });
  if (permissions.has("calendar:view")) items.push({ href: "/admin/calendar", label: "Kalendar", icon: CalendarDays });
  if (permissions.has("conversations:manage")) items.push({ href: "/admin/conversations", label: "Suhbatlar", icon: MessagesSquare });
  if (permissions.has("patients:manage")) items.push({ href: "/admin/patients", label: "Bemorlar", icon: Users });
  if (permissions.has("catalog:manage")) {
    items.push({ href: "/admin/doctors", label: "Shifokorlar", icon: Stethoscope });
    items.push({ href: "/admin/services", label: "Xizmatlar", icon: Scissors });
  }
  if (permissions.has("taxonomy:manage")) items.push({ href: "/admin/specialties", label: "Yo‘nalishlar", icon: Sparkles });
  if (permissions.has("content:manage")) items.push({ href: "/admin/faqs", label: "Savol-javoblar", icon: MessagesSquare });
  if (permissions.has("analytics:view")) items.push({ href: "/admin/analytics", label: "Tahlillar", icon: BarChart3 });
  if (permissions.has("finance:view")) items.push({ href: "/admin/finance", label: "Moliya", icon: Wallet });
  if (permissions.has("settings:manage")) items.push({ href: "/admin/settings", label: "Sozlamalar", icon: Settings });
  return items;
}

/**
 * The brief's suggested sidebar also lists "Suhbatlar" — omitted because the
 * backend genuinely has no doctor access to conversations at all (RLS and
 * the API routes both gate conversations/messages to owner/admin/manager/
 * receptionist only; see role_based_rls.sql). "Mening qabullarim" and
 * "Qabul tarixi" are consolidated into one real page (a filterable full
 * appointment list, past and upcoming) rather than two near-duplicates.
 */
export function doctorNavItems(): NavItem[] {
  return [
    { href: "/doctor", label: "Bugun", icon: LayoutDashboard },
    { href: "/doctor/patients", label: "Mening bemorlarim", icon: Users },
    { href: "/doctor/appointments", label: "Qabul tarixi", icon: History },
    { href: "/doctor/schedule", label: "Mening kalendarim", icon: CalendarRange },
  ];
}

import { describe, it, expect } from "vitest";
import { adminNavItems, doctorNavItems } from "@/lib/admin/nav";
import { getPermissions } from "@/lib/auth/permissions";
import type { StaffRole } from "@/lib/auth/staff";

function hrefs(roles: StaffRole[]): string[] {
  return adminNavItems(getPermissions(roles)).map((n) => n.href);
}

describe("adminNavItems", () => {
  it("gives owner and admin the full nav, in the original order", () => {
    const expected = [
      "/admin",
      "/admin/appointments",
      "/admin/calendar",
      "/admin/conversations",
      "/admin/patients",
      "/admin/doctors",
      "/admin/services",
      "/admin/specialties",
      "/admin/faqs",
      "/admin/analytics",
      "/admin/finance",
      "/admin/settings",
    ];
    expect(hrefs(["owner"])).toEqual(expected);
    expect(hrefs(["admin"])).toEqual(expected);
  });

  it("gives manager management links but never finance", () => {
    const links = hrefs(["manager"]);
    expect(links).toContain("/admin/doctors");
    expect(links).toContain("/admin/analytics");
    expect(links).toContain("/admin/settings");
    expect(links).not.toContain("/admin/finance");
  });

  it("gives receptionist only the base operational links", () => {
    expect(hrefs(["receptionist"])).toEqual(["/admin", "/admin/appointments", "/admin/calendar", "/admin/conversations", "/admin/patients"]);
  });

  it("always includes the home link first", () => {
    for (const roles of [["owner"], ["manager"], ["receptionist"]] as StaffRole[][]) {
      expect(adminNavItems(getPermissions(roles))[0].href).toBe("/admin");
    }
  });
});

describe("doctorNavItems", () => {
  it("returns the queue and schedule links", () => {
    expect(doctorNavItems().map((n) => n.href)).toEqual(["/doctor", "/doctor/schedule"]);
  });
});

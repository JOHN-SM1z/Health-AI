import { describe, expect, it } from "vitest";
import { LAB_CAPABILITIES, LAB_CAPABILITY_GROUPS, labCan, labCapabilityGroup, type LabCapability } from "@/lib/labs/permissions";

/**
 * The laboratory decision table (AGENTS.md: minimum necessary access by role
 * and purpose; owner decisions 2026-10-05, O3–O5). Each expectation is a
 * requirement, so a change to the table that widens access fails here first.
 */

const ROLES = ["owner", "manager", "admin", "receptionist", "doctor", "lab"] as const;
type Role = (typeof ROLES)[number];

function holders(capability: LabCapability): Role[] {
  return ROLES.filter((role) => labCan([role], capability));
}

describe("lab permission model", () => {
  it("assigns every capability to exactly one purpose group", () => {
    const grouped = Object.values(LAB_CAPABILITY_GROUPS).flat();
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(grouped.sort()).toEqual(Object.keys(LAB_CAPABILITIES).sort());
    expect(labCapabilityGroup("result.read")).toBe("clinical");
    expect(labCapabilityGroup("catalog.configure")).toBe("configuration");
    expect(labCapabilityGroup("finance.view")).toBe("financial");
    expect(labCapabilityGroup("order.create")).toBe("operational");
  });

  it("lets every staff role of the clinic order and cancel (no per-role ordering restriction)", () => {
    expect(holders("order.create")).toEqual([...ROLES]);
    expect(holders("order.cancel")).toEqual([...ROLES]);
    expect(holders("catalog.read")).toEqual([...ROLES]);
  });

  it("keeps configuration with clinic management", () => {
    expect(holders("catalog.configure")).toEqual(["owner", "manager", "admin"]);
    expect(holders("settings.configure")).toEqual(["owner", "manager", "admin"]);
  });

  it("never gives owner, manager, admin or receptionist result values — status only (O5)", () => {
    for (const role of ["owner", "manager", "admin", "receptionist"] as const) {
      expect(labCan([role], "result.read")).toBe(false);
      expect(labCan([role], "result.enter")).toBe(false);
      expect(labCan([role], "result.verify")).toBe(false);
      expect(labCan([role], "order.status.read")).toBe(true);
    }
  });

  it("lets lab staff and doctors enter and verify (the second person is enforced in the database, O4)", () => {
    expect(holders("result.enter")).toEqual(["doctor", "lab"]);
    expect(holders("result.verify")).toEqual(["doctor", "lab"]);
    expect(holders("result.read")).toEqual(["doctor", "lab"]);
  });

  it("keeps lab staff out of configuration and finance", () => {
    expect(labCan(["lab"], "catalog.configure")).toBe(false);
    expect(labCan(["lab"], "settings.configure")).toBe(false);
    expect(labCan(["lab"], "finance.view")).toBe(false);
  });

  it("keeps doctors out of configuration, finance and specimen processing", () => {
    expect(labCan(["doctor"], "catalog.configure")).toBe(false);
    expect(labCan(["doctor"], "finance.view")).toBe(false);
    expect(labCan(["doctor"], "sample.process")).toBe(false);
    expect(labCan(["doctor"], "sample.collect")).toBe(false);
  });

  it("limits finance to the existing payment-dynamics roles", () => {
    expect(holders("finance.view")).toEqual(["owner", "admin"]);
  });

  it("splits specimen work: reception may collect, only the lab processes", () => {
    expect(holders("sample.collect")).toEqual(["receptionist", "lab"]);
    expect(holders("sample.process")).toEqual(["lab"]);
  });

  it("keeps attaching result documents with the laboratory", () => {
    expect(holders("document.upload")).toEqual(["lab"]);
    expect(labCapabilityGroup("document.upload")).toBe("clinical");
    expect(holders("import.manage")).toEqual(["lab"]);
    expect(labCapabilityGroup("import.manage")).toBe("clinical");
  });

  it("keeps the clinic-wide work queue away from doctors", () => {
    expect(holders("queue.read")).toEqual(["owner", "manager", "admin", "receptionist", "lab"]);
  });

  it("grants nothing without a role", () => {
    for (const capability of Object.keys(LAB_CAPABILITIES) as LabCapability[]) {
      expect(labCan([], capability)).toBe(false);
    }
  });
});

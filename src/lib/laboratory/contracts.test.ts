import { describe, expect, it } from "vitest";
import { labCommand } from "./contracts";
const id = "00000000-0000-4000-8000-000000000001";
describe("laboratory commands", () => {
  it("rejects caller-controlled clinic, actor and release state", () => {
    const command = { action: "create", patientId: id, idempotencyKey: id, specimenType: "Synthetic", tests: ["Test"] };
    expect(labCommand.safeParse(command).success).toBe(true);
    for (const extra of [{ clinicId: id }, { authorId: id }, { released: true }]) expect(labCommand.safeParse({ ...command, ...extra }).success).toBe(false);
    expect(labCommand.safeParse({ action: "release", orderId: id }).success).toBe(false);
  });
  it("requires reasons for rejection and draft corrections", () => {
    expect(labCommand.safeParse({ action: "transition", orderId: id, specimenId: id, expectedVersion: 1, status: "rejected" }).success).toBe(false);
    const draft = { action: "draft", orderId: id, testId: id, expectedRevision: 1, value: "1.5", unit: "unit", referenceText: "" };
    expect(labCommand.safeParse(draft).success).toBe(false);
    expect(labCommand.safeParse({ ...draft, reason: "Transcription correction" }).success).toBe(true);
  });
  it("rejects empty tests and stale/invalid revision inputs", () => {
    expect(labCommand.safeParse({ action: "create", patientId: id, idempotencyKey: id, specimenType: "Synthetic", tests: [] }).success).toBe(false);
    expect(labCommand.safeParse({ action: "recollect", orderId: id, specimenId: id, expectedVersion: 0 }).success).toBe(false);
  });
});

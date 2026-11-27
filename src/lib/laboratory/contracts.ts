import { z } from "zod";
const id = z.string().uuid();
const text = (max: number) => z.string().trim().min(1).max(max);
export const labCommand = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), patientId: id, idempotencyKey: id, specimenType: text(100), tests: z.array(text(160)).min(1).max(50) }).strict(),
  z.object({ action: z.literal("transition"), orderId: id, specimenId: id, expectedVersion: z.number().int().positive(), status: z.enum(["collected", "received", "processing", "rejected"]), reason: z.string().trim().min(3).max(500).optional() }).strict().refine(v => v.status !== "rejected" || !!v.reason, "Rad etish sababini kiriting"),
  z.object({ action: z.literal("recollect"), orderId: id, specimenId: id, expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("draft"), orderId: id, testId: id, expectedRevision: z.number().int().nonnegative(), value: text(2000), unit: z.string().trim().max(80), referenceText: z.string().trim().max(500), reason: z.string().trim().min(3).max(500).optional() }).strict().refine(v => v.expectedRevision === 0 || !!v.reason, "Tuzatish sababini kiriting"),
]);
export type LabCommand = z.infer<typeof labCommand>;
export type LabSummary = { id: string; patient_id: string; full_name: string; patient_number: number; created_at: string; tests_count: number; draft_count: number };
export type LabSpecimen = { id: string; accession: string; specimen_type: string; status: string; version: number; rejection_reason: string | null; replaces_id: string | null };
export type LabTest = { id: string; test_name: string; specimen_id: string };
export type LabDraft = { id: string; test_id: string; specimen_id: string; revision: number; value: string; unit: string; reference_text: string; correction_reason: string | null; author_id: string; created_at: string };
export type LabDetail = { order: { id: string; patient_id: string; created_at: string }; patient: { full_name: string; patient_number: number }; specimens: LabSpecimen[]; tests: LabTest[]; drafts: LabDraft[] };
export const specimenLabels: Record<string, string> = { ordered: "Olinishi kerak", collected: "Namuna olindi", received: "Qabul qilindi", processing: "Tekshirilmoqda", rejected: "Rad etildi" };

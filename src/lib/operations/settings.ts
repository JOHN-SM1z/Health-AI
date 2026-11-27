import { z } from "zod";

/** Clinic choices, not assumptions about hours, clinical urgency or pay rules. */
export const operationsSettingsSchema = z.object({
  mode: z.enum(["walk_in", "mixed", "scheduled"]).default("walk_in"),
  ticketPrinting: z.boolean().default(true),
}).strict();
export type OperationsSettings = z.infer<typeof operationsSettingsSchema>;
export function parseOperationsSettings(value: unknown): OperationsSettings {
  const result = operationsSettingsSchema.safeParse(value);
  return result.success ? result.data : { mode: "walk_in", ticketPrinting: true };
}

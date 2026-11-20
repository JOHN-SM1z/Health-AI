import { z } from "zod";

/** A provider's editable settings (the code is set once, at creation). */
export const providerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  adapter: z.string().regex(/^[a-z0-9_]{2,40}$/),
  active: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).default({}),
  credentialRef: z.string().regex(/^LAB_PROVIDER_[A-Z0-9_]{1,60}$/, "Maxfiy kalit LAB_PROVIDER_… muhit o‘zgaruvchisida saqlanadi").nullable().default(null),
  sendPatientName: z.boolean().default(false),
});

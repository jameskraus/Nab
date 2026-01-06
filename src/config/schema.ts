import { z } from "zod";

export const ConfigSchema = z
  .object({
    tokens: z.array(z.string().min(1)).min(1).optional(),
    budgetId: z.string().min(1).optional(),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

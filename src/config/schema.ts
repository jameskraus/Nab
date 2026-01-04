import { z } from "zod";

export const ConfigSchema = z
  .object({
    token: z.string().min(1).optional(),
    budgetId: z.string().min(1).optional(),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

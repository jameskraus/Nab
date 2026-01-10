import { z } from "zod";

export const ConfigSchema = z
  .object({
    tokens: z.array(z.string().min(1)).min(1).optional(),
    budgetId: z.string().min(1).optional(),
    oauth: z
      .object({
        clientId: z.string().min(1).optional(),
        clientSecret: z.string().min(1).optional(),
        redirectUri: z.string().min(1).optional(),
        scope: z.enum(["full", "read-only"]).optional(),
        token: z
          .object({
            accessToken: z.string().min(1),
            refreshToken: z.string().min(1),
            tokenType: z.string().min(1).optional(),
            expiresAt: z.string().min(1),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    authMethod: z.enum(["pat", "oauth"]).optional(),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

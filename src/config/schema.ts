import { z } from "zod";

const CurrencyFormatSchema = z
  .object({
    iso_code: z.string().min(1),
    example_format: z.string().min(1),
    decimal_digits: z.number().int().min(0).max(3),
    decimal_separator: z.string().min(1),
    symbol_first: z.boolean(),
    group_separator: z.string().min(1),
    currency_symbol: z.string().min(1),
    display_symbol: z.boolean(),
  })
  .strict();

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
    budgetCurrencyFormats: z.record(z.string().min(1), CurrencyFormatSchema).optional(),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

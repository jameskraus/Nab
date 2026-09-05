import { z } from "zod";

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());

const changeSchema = z
  .object({
    id: uuid,
    category_id: uuid.nullable().optional(),
    category_name: z.string().trim().min(1).optional(),
    memo: z
      .string()
      .max(500)
      .nullable()
      .transform((value) => (value === "" ? null : value))
      .optional(),
    approved: z.boolean().optional(),
  })
  .strict()
  .superRefine((change, ctx) => {
    if (change.category_id !== undefined && change.category_name !== undefined) {
      ctx.addIssue({ code: "custom", message: "Use category_id or category_name, not both." });
    }
    if (
      change.category_id === undefined &&
      change.category_name === undefined &&
      change.memo === undefined &&
      change.approved === undefined
    ) {
      ctx.addIssue({ code: "custom", message: "Provide at least one field to change." });
    }
  });

const changesSchema = z
  .object({ transactions: z.array(changeSchema).min(1) })
  .strict()
  .superRefine(({ transactions }, ctx) => {
    const ids = new Set<string>();
    for (const [index, transaction] of transactions.entries()) {
      if (ids.has(transaction.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["transactions", index, "id"],
          message: `Duplicate transaction ID: ${transaction.id}`,
        });
      }
      ids.add(transaction.id);
    }
  });

export function parseTransactionChanges(input: unknown): z.infer<typeof changesSchema> {
  const parsed = changesSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(
      `Invalid changeset: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

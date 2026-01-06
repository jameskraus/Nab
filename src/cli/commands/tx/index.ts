import type { CommandModule } from "yargs";
import type { NewTransaction, Payee, TransactionDetail } from "ynab";

import type { AppContext } from "@/app/createAppContext";
import { normalizeIds, requireApplyConfirmation } from "@/cli/mutations";
import type { CliGlobalArgs } from "@/cli/types";
import { TransactionService } from "@/domain/TransactionService";
import type { TransactionMutationResult } from "@/domain/TransactionService";
import {
  parseAmountToMilliunits,
  parseClearedStatus,
  parseDateOnly,
  parseFlagColor,
} from "@/domain/inputs";
import { resolveAccount, resolveCategory, resolvePayee } from "@/domain/nameResolution";
import {
  type OutputWriterOptions,
  createOutputWriter,
  fieldColumn,
  formatDate,
  parseOutputFormat,
} from "@/io";
import { normalizeArgv } from "@/journal/argv";
import { recordHistoryAction } from "@/journal/history";

type CliArgs = CliGlobalArgs & { appContext?: AppContext };

type TxListArgs = CliArgs & {
  accountId?: string;
  sinceDate?: string;
  uncategorized?: boolean;
};

type TxGetArgs = CliArgs & {
  id: string;
};

type TxCreateArgs = CliArgs & {
  accountId?: string;
  accountName?: string;
  date?: string;
  amount?: string;
  payeeId?: string;
  payeeName?: string;
  categoryId?: string;
  categoryName?: string;
  memo?: string;
  cleared?: string;
  approved?: boolean;
  flagColor?: string;
};

type IdArgs = CliArgs & {
  id: string[] | string;
};

type MemoArgs = CliArgs & {
  id: string[] | string;
  memo?: string;
};

type CategoryArgs = CliArgs & {
  id: string[] | string;
  categoryId?: string;
  categoryName?: string;
};

type PayeeArgs = CliArgs & {
  id: string[] | string;
  payeeId?: string;
  payeeName?: string;
};

type FlagArgs = CliArgs & {
  id: string[] | string;
  color?: string;
};

type ClearedArgs = CliArgs & {
  id: string[] | string;
  status?: string;
};

type DateArgs = CliArgs & {
  id: string[] | string;
  date: string;
};

type AmountArgs = CliArgs & {
  id: string;
  amount: string;
};

type AccountArgs = CliArgs & {
  id: string[] | string;
  accountId?: string;
  accountName?: string;
};

type TransactionListRow = {
  id: string;
  date: string;
  account: string;
  payee: string;
  category: string;
  memo: string;
  amount: number;
};

type TransactionFilters = {
  accountId?: string;
  uncategorized?: boolean;
};

type MutationRow = {
  id: string;
  status: string;
  patch: string;
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

async function recordMutationHistory(
  ctx: AppContext | undefined,
  actionType: string,
  argv: Record<string, unknown>,
  results: TransactionMutationResult[],
): Promise<void> {
  const db = ctx?.db;
  if (!db) return;
  const applied = results.filter((result) => result.status === "updated");
  if (applied.length === 0) return;

  const payload = {
    argv: normalizeArgv(argv),
    txIds: applied.map((result) => result.id),
    patches: applied.map((result) => ({ id: result.id, patch: result.patch })),
  };
  const inversePatch = applied.map((result) => ({
    id: result.id,
    patch: result.inversePatch ?? null,
  }));

  recordHistoryAction(db, actionType, payload, inversePatch);
}

async function finalizeMutation(
  ctx: AppContext | undefined,
  actionType: string,
  argv: Record<string, unknown>,
  results: TransactionMutationResult[],
  format?: string,
): Promise<void> {
  await recordMutationHistory(ctx, actionType, argv, results);
  writeMutationResults(results, format);
}

function transactionRows(transactions: TransactionDetail[]): TransactionListRow[] {
  return transactions.map((transaction) => ({
    id: transaction.id,
    date: formatDate(transaction.date),
    account: transaction.account_name,
    payee: transaction.payee_name ?? "",
    category: transaction.category_id ? (transaction.category_name ?? "") : "Uncategorized",
    memo: transaction.memo ?? "",
    amount: transaction.amount,
  }));
}

function transactionColumns() {
  return [
    fieldColumn("date", { header: "Date" }),
    fieldColumn("account", { header: "Account" }),
    fieldColumn("payee", { header: "Payee" }),
    fieldColumn("category", { header: "Category" }),
    fieldColumn("memo", { header: "Memo" }),
    fieldColumn("amount", { header: "Amount", align: "right" }),
    fieldColumn("id", { header: "Id" }),
  ];
}

export function applyTransactionFilters(
  transactions: TransactionDetail[],
  filters: TransactionFilters,
): TransactionDetail[] {
  const { accountId, uncategorized } = filters;
  return transactions.filter((transaction) => {
    if (accountId && transaction.account_id !== accountId) return false;
    if (uncategorized && transaction.category_id) return false;
    return true;
  });
}

export function writeTransactionList(
  transactions: TransactionDetail[],
  rawFormat?: string,
  options?: OutputWriterOptions,
): void {
  const format = parseOutputFormat(rawFormat, "table");

  if (format === "json") {
    createOutputWriter("json", options).write(transactions);
    return;
  }

  if (format === "ids") {
    createOutputWriter("ids", options).write(transactions.map((transaction) => transaction.id));
    return;
  }

  const rows = transactionRows(transactions);

  if (format === "tsv") {
    createOutputWriter("tsv", options).write(rows);
    return;
  }

  createOutputWriter("table", options).write({
    columns: transactionColumns(),
    rows,
  });
}

export function writeTransactionDetail(
  transaction: TransactionDetail,
  rawFormat?: string,
  options?: OutputWriterOptions,
): void {
  const format = parseOutputFormat(rawFormat, "table");

  if (format === "json") {
    createOutputWriter("json", options).write(transaction);
    return;
  }

  if (format === "ids") {
    createOutputWriter("ids", options).write([transaction.id]);
    return;
  }

  const rows = transactionRows([transaction]);

  if (format === "tsv") {
    createOutputWriter("tsv", options).write(rows);
    return;
  }

  createOutputWriter("table", options).write({
    columns: transactionColumns(),
    rows,
  });
}

function writeMemoResult(
  id: string,
  memo: string | null | undefined,
  rawFormat?: string,
  options?: OutputWriterOptions,
): void {
  const format = parseOutputFormat(rawFormat, "table");
  const normalizedMemo = memo ?? null;

  if (format === "json") {
    createOutputWriter("json", options).write({ id, memo: normalizedMemo });
    return;
  }

  if (format === "ids") {
    createOutputWriter("ids", options).write([id]);
    return;
  }

  const row = { id, memo: normalizedMemo ?? "" };

  if (format === "tsv") {
    createOutputWriter("tsv", options).write([row]);
    return;
  }

  createOutputWriter("table", options).write({
    columns: [fieldColumn("memo", { header: "Memo" }), fieldColumn("id", { header: "Id" })],
    rows: [row],
  });
}

function writeMutationResults(
  results: Array<{ id: string; status: string; patch?: unknown }>,
  rawFormat?: string,
  options?: OutputWriterOptions,
): void {
  const format = parseOutputFormat(rawFormat, "table");

  if (format === "json") {
    createOutputWriter("json", options).write(results);
    return;
  }

  if (format === "ids") {
    createOutputWriter("ids", options).write(results.map((result) => result.id));
    return;
  }

  const rows: MutationRow[] = results.map((result) => ({
    id: result.id,
    status: result.status,
    patch: result.patch ? JSON.stringify(result.patch) : "",
  }));

  if (format === "tsv") {
    createOutputWriter("tsv", options).write(rows);
    return;
  }

  createOutputWriter("table", options).write({
    columns: [
      fieldColumn("status", { header: "Status" }),
      fieldColumn("patch", { header: "Patch" }),
      fieldColumn("id", { header: "Id" }),
    ],
    rows,
  });
}

export const txCommand: CommandModule<CliGlobalArgs> = {
  command: "tx <command>",
  describe: "Query and mutate transactions",
  builder: (y) =>
    y
      .command({
        command: "list",
        describe: "List transactions",
        builder: (yy) =>
          yy
            .option("account-id", {
              type: "string",
              describe: "Filter by account id",
            })
            .option("since-date", {
              type: "string",
              describe: "Only include transactions on/after this date (YYYY-MM-DD)",
            })
            .option("uncategorized", {
              type: "boolean",
              default: false,
              describe: "Only show uncategorized transactions",
            })
            .check((argv) => {
              if (typeof argv.accountId === "string" && argv.accountId.trim().length === 0) {
                throw new Error("Provide a non-empty --account-id value.");
              }
              if (typeof argv.sinceDate === "string" && !DATE_ONLY.test(argv.sinceDate)) {
                throw new Error("Provide --since-date in YYYY-MM-DD format.");
              }
              return true;
            }),
        handler: async (argv) => {
          const { appContext, format, accountId, sinceDate, uncategorized } =
            argv as unknown as TxListArgs;
          const ctx = appContext;
          if (!ctx?.ynab || !ctx.budgetId) {
            throw new Error("Missing budget context for transaction list.");
          }
          const transactions = await ctx.ynab.listTransactions(ctx.budgetId, sinceDate);
          const filtered = applyTransactionFilters(transactions, { accountId, uncategorized });
          writeTransactionList(filtered, format);
        },
      })
      .command({
        command: "get",
        describe: "Get a single transaction",
        builder: (yy) =>
          yy.option("id", { type: "string", demandOption: true, describe: "Transaction id" }),
        handler: async (argv) => {
          const { appContext, format, id } = argv as unknown as TxGetArgs;
          const ctx = appContext;
          if (!ctx?.ynab || !ctx.budgetId) {
            throw new Error("Missing budget context for transaction get.");
          }
          const transaction = await ctx.ynab.getTransaction(ctx.budgetId, id);
          writeTransactionDetail(transaction, format);
        },
      })
      .command({
        command: "create",
        describe: "Create a new transaction",
        builder: (yy) =>
          yy
            .option("account-id", {
              type: "string",
              describe: "Account id",
            })
            .option("account-name", {
              type: "string",
              describe: "Account name (must resolve unambiguously)",
            })
            .option("date", {
              type: "string",
              demandOption: true,
              describe: "Transaction date (YYYY-MM-DD)",
            })
            .option("amount", {
              type: "string",
              demandOption: true,
              describe: "Amount (e.g. -12.34 or 12.34)",
            })
            .option("payee-id", {
              type: "string",
              describe: "Payee id",
            })
            .option("payee-name", {
              type: "string",
              describe: "Payee name (must resolve unambiguously)",
            })
            .option("category-id", {
              type: "string",
              describe: "Category id",
            })
            .option("category-name", {
              type: "string",
              describe: "Category name (must resolve unambiguously)",
            })
            .option("memo", {
              type: "string",
              describe: "Memo text",
            })
            .option("cleared", {
              type: "string",
              choices: ["cleared", "uncleared", "reconciled"] as const,
              describe: "Cleared status",
            })
            .option("approved", {
              type: "boolean",
              describe: "Approved flag (true/false)",
            })
            .option("flag-color", {
              type: "string",
              choices: ["red", "orange", "yellow", "green", "blue", "purple"] as const,
              describe: "Flag color",
            })
            .check((argv) => {
              if (!argv.accountId && !argv.accountName) {
                throw new Error("Provide --account-id or --account-name");
              }
              if (typeof argv.date === "string") {
                parseDateOnly(argv.date);
              }
              if (typeof argv.amount === "string") {
                parseAmountToMilliunits(argv.amount);
              }
              return true;
            }),
        handler: async (argv) => {
          const {
            appContext,
            format,
            dryRun,
            yes,
            accountId,
            accountName,
            date,
            amount,
            payeeId,
            payeeName,
            categoryId,
            categoryName,
            memo,
            cleared,
            approved,
            flagColor,
          } = argv as unknown as TxCreateArgs;
          const ctx = appContext;
          if (!ctx?.ynab || !ctx.budgetId) {
            throw new Error("Missing budget context for transaction create.");
          }

          requireApplyConfirmation(Boolean(dryRun), Boolean(yes));

          let resolvedAccountId = accountId;
          if (!resolvedAccountId && accountName) {
            const accounts = await ctx.ynab.listAccounts(ctx.budgetId);
            resolvedAccountId = resolveAccount(accountName, accounts);
          }
          if (!resolvedAccountId) {
            throw new Error("Provide --account-id or --account-name");
          }

          let resolvedPayeeId = payeeId;
          let payees: Payee[] | undefined;
          if (!resolvedPayeeId && payeeName) {
            payees = await ctx.ynab.listPayees(ctx.budgetId);
            resolvedPayeeId = resolvePayee(payeeName, payees);
          }
          if (resolvedPayeeId) {
            if (!payees) {
              payees = await ctx.ynab.listPayees(ctx.budgetId);
            }
            const payee = payees.find((item) => item.id === resolvedPayeeId);
            if (payee?.transfer_account_id) {
              throw new Error("Transfers are out of scope for v1.");
            }
          }

          let resolvedCategoryId = categoryId;
          if (!resolvedCategoryId && categoryName) {
            const groups = await ctx.ynab.listCategories(ctx.budgetId);
            resolvedCategoryId = resolveCategory(categoryName, groups);
          }
          if (categoryName && !resolvedCategoryId) {
            throw new Error("Provide --category-id or --category-name");
          }

          const parsedDate = date ? parseDateOnly(date) : undefined;
          const milliunits = amount ? parseAmountToMilliunits(amount) : undefined;

          const transaction: NewTransaction = {
            account_id: resolvedAccountId,
            date: parsedDate,
            amount: milliunits,
            payee_id: resolvedPayeeId,
            category_id: resolvedCategoryId,
            memo: memo ?? undefined,
            cleared: cleared ? parseClearedStatus(cleared) : undefined,
            approved: typeof approved === "boolean" ? approved : undefined,
            flag_color: flagColor ? parseFlagColor(flagColor) : undefined,
          };

          if (dryRun) {
            writeMutationResults([{ id: "(new)", status: "dry-run", patch: transaction }], format);
            return;
          }

          const created = await ctx.ynab.createTransaction(ctx.budgetId, transaction);
          if (ctx.db) {
            recordHistoryAction(
              ctx.db,
              "tx.create",
              {
                argv: normalizeArgv(argv as unknown as Record<string, unknown>),
                txIds: [created.id],
                patches: [{ id: created.id, patch: transaction }],
              },
              [{ id: created.id, patch: { delete: true } }],
            );
          }
          writeTransactionDetail(created, format);
        },
      })

      // Approval
      .command({
        command: "approve",
        describe: "Approve one or more transactions",
        builder: (yy) =>
          yy
            .option("id", {
              type: "string",
              array: true,
              demandOption: true,
              describe: "Transaction id (repeatable)",
            })
            .check((argv) => {
              const ids = normalizeIds(argv.id as string[] | string | undefined);
              if (ids.length === 0) {
                throw new Error("Provide at least one non-empty --id value.");
              }
              return true;
            }),
        handler: async (argv) => {
          const { appContext, format, dryRun, yes, id } = argv as unknown as IdArgs;
          const ctx = appContext;
          if (!ctx?.ynab || !ctx.budgetId) {
            throw new Error("Missing budget context for approval.");
          }

          const ids = normalizeIds(id);
          requireApplyConfirmation(Boolean(dryRun), Boolean(yes));

          const service = new TransactionService(ctx.ynab, ctx.budgetId);
          const results = await service.setApproved(ids, true, { dryRun });
          await finalizeMutation(
            ctx,
            "tx.approve",
            argv as Record<string, unknown>,
            results,
            format,
          );
        },
      })
      .command({
        command: "unapprove",
        describe: "Unapprove one or more transactions",
        builder: (yy) =>
          yy
            .option("id", {
              type: "string",
              array: true,
              demandOption: true,
              describe: "Transaction id (repeatable)",
            })
            .check((argv) => {
              const ids = normalizeIds(argv.id as string[] | string | undefined);
              if (ids.length === 0) {
                throw new Error("Provide at least one non-empty --id value.");
              }
              return true;
            }),
        handler: async (argv) => {
          const { appContext, format, dryRun, yes, id } = argv as unknown as IdArgs;
          const ctx = appContext;
          if (!ctx?.ynab || !ctx.budgetId) {
            throw new Error("Missing budget context for unapproval.");
          }

          const ids = normalizeIds(id);
          requireApplyConfirmation(Boolean(dryRun), Boolean(yes));

          const service = new TransactionService(ctx.ynab, ctx.budgetId);
          const results = await service.setApproved(ids, false, { dryRun });
          await finalizeMutation(
            ctx,
            "tx.unapprove",
            argv as Record<string, unknown>,
            results,
            format,
          );
        },
      })

      // Deletion ("reject")
      .command({
        command: "delete",
        describe: "Delete one or more transactions",
        builder: (yy) =>
          yy
            .option("id", {
              type: "string",
              array: true,
              demandOption: true,
              describe: "Transaction id (repeatable)",
            })
            .check((argv) => {
              const ids = normalizeIds(argv.id as string[] | string | undefined);
              if (ids.length === 0) {
                throw new Error("Provide at least one non-empty --id value.");
              }
              return true;
            }),
        handler: async (argv) => {
          const { appContext, format, dryRun, yes, id } = argv as unknown as IdArgs;
          const ctx = appContext;
          if (!ctx?.ynab || !ctx.budgetId) {
            throw new Error("Missing budget context for delete.");
          }

          const ids = normalizeIds(id);
          requireApplyConfirmation(Boolean(dryRun), Boolean(yes));

          const service = new TransactionService(ctx.ynab, ctx.budgetId);
          const results = await service.deleteTransactions(ids, { dryRun });
          await finalizeMutation(
            ctx,
            "tx.delete",
            argv as Record<string, unknown>,
            results,
            format,
          );
        },
      })

      // Category
      .command({
        command: "category <command>",
        describe: "Category updates",
        builder: (yy) =>
          yy
            .command({
              command: "set",
              describe: "Set category on one or more transactions",
              builder: (yyy) =>
                yyy
                  .option("id", {
                    type: "string",
                    array: true,
                    demandOption: true,
                    describe: "Transaction id (repeatable)",
                  })
                  .option("category-id", {
                    type: "string",
                    describe: "Category id",
                  })
                  .option("category-name", {
                    type: "string",
                    describe: "Category name (must resolve unambiguously)",
                  })
                  .check((argv) => {
                    if (!argv.categoryId && !argv.categoryName) {
                      throw new Error("Provide --category-id or --category-name");
                    }
                    const ids = normalizeIds(argv.id as string[] | string | undefined);
                    if (ids.length === 0) {
                      throw new Error("Provide at least one non-empty --id value.");
                    }
                    return true;
                  }),
              handler: async (argv) => {
                const { appContext, format, dryRun, yes, id, categoryId, categoryName } =
                  argv as unknown as CategoryArgs;
                const ctx = appContext;
                if (!ctx?.ynab || !ctx.budgetId) {
                  throw new Error("Missing budget context for category set.");
                }

                const ids = normalizeIds(id);
                requireApplyConfirmation(Boolean(dryRun), Boolean(yes));

                let resolvedId = categoryId;
                if (!resolvedId && categoryName) {
                  const groups = await ctx.ynab.listCategories(ctx.budgetId);
                  resolvedId = resolveCategory(categoryName, groups);
                }
                if (!resolvedId) {
                  throw new Error("Provide --category-id or --category-name");
                }

                const service = new TransactionService(ctx.ynab, ctx.budgetId);
                const results = await service.applyPatch(
                  ids,
                  { category_id: resolvedId },
                  { dryRun },
                );
                await finalizeMutation(
                  ctx,
                  "tx.category.set",
                  argv as Record<string, unknown>,
                  results,
                  format,
                );
              },
            })
            .command({
              command: "clear",
              describe: "Clear category on one or more transactions (set to null)",
              builder: (yyy) =>
                yyy
                  .option("id", {
                    type: "string",
                    array: true,
                    demandOption: true,
                    describe: "Transaction id (repeatable)",
                  })
                  .check((argv) => {
                    const ids = normalizeIds(argv.id as string[] | string | undefined);
                    if (ids.length === 0) {
                      throw new Error("Provide at least one non-empty --id value.");
                    }
                    return true;
                  }),
              handler: async (argv) => {
                const { appContext, format, dryRun, yes, id } = argv as unknown as IdArgs;
                const ctx = appContext;
                if (!ctx?.ynab || !ctx.budgetId) {
                  throw new Error("Missing budget context for category clear.");
                }

                const ids = normalizeIds(id);
                requireApplyConfirmation(Boolean(dryRun), Boolean(yes));

                const service = new TransactionService(ctx.ynab, ctx.budgetId);
                const results = await service.applyPatch(ids, { category_id: null }, { dryRun });
                await finalizeMutation(
                  ctx,
                  "tx.category.clear",
                  argv as Record<string, unknown>,
                  results,
                  format,
                );
              },
            })
            .demandCommand(1, "Specify a category subcommand")
            .strict(),
        handler: () => {},
      })

      // Memo
      .command({
        command: "memo <command>",
        describe: "Memo updates",
        builder: (yy) =>
          yy
            .command({
              command: "get",
              describe: "Get memo for a transaction",
              builder: (yyy) =>
                yyy.option("id", {
                  type: "string",
                  demandOption: true,
                  describe: "Transaction id",
                }),
              handler: async (argv) => {
                const { appContext, format, id } = argv as unknown as TxGetArgs;
                const ctx = appContext;
                if (!ctx?.ynab || !ctx.budgetId) {
                  throw new Error("Missing budget context for memo get.");
                }

                const transaction = await ctx.ynab.getTransaction(ctx.budgetId, id);
                writeMemoResult(transaction.id, transaction.memo ?? null, format);
              },
            })
            .command({
              command: "set",
              describe: "Set memo for one or more transactions",
              builder: (yyy) =>
                yyy
                  .option("id", {
                    type: "string",
                    array: true,
                    demandOption: true,
                    describe: "Transaction id (repeatable)",
                  })
                  .option("memo", {
                    type: "string",
                    demandOption: true,
                    describe: "Memo text",
                  })
                  .check((argv) => {
                    const ids = normalizeIds(argv.id as string[] | string | undefined);
                    if (ids.length === 0) {
                      throw new Error("Provide at least one non-empty --id value.");
                    }
                    return true;
                  }),
              handler: async (argv) => {
                const { appContext, format, dryRun, yes, id, memo } = argv as unknown as MemoArgs;
                const ctx = appContext;
                if (!ctx?.ynab || !ctx.budgetId) {
                  throw new Error("Missing budget context for memo set.");
                }

                const ids = normalizeIds(id);
                requireApplyConfirmation(Boolean(dryRun), Boolean(yes));

                const service = new TransactionService(ctx.ynab, ctx.budgetId);
                const results = await service.applyPatch(ids, { memo: memo ?? "" }, { dryRun });
                await finalizeMutation(
                  ctx,
                  "tx.memo.set",
                  argv as Record<string, unknown>,
                  results,
                  format,
                );
              },
            })
            .command({
              command: "clear",
              describe: "Clear memo for one or more transactions",
              builder: (yyy) =>
                yyy
                  .option("id", {
                    type: "string",
                    array: true,
                    demandOption: true,
                    describe: "Transaction id (repeatable)",
                  })
                  .check((argv) => {
                    const ids = normalizeIds(argv.id as string[] | string | undefined);
                    if (ids.length === 0) {
                      throw new Error("Provide at least one non-empty --id value.");
                    }
                    return true;
                  }),
              handler: async (argv) => {
                const { appContext, format, dryRun, yes, id } = argv as unknown as IdArgs;
                const ctx = appContext;
                if (!ctx?.ynab || !ctx.budgetId) {
                  throw new Error("Missing budget context for memo clear.");
                }

                const ids = normalizeIds(id);
                requireApplyConfirmation(Boolean(dryRun), Boolean(yes));

                const service = new TransactionService(ctx.ynab, ctx.budgetId);
                const results = await service.applyPatch(ids, { memo: null }, { dryRun });
                await finalizeMutation(
                  ctx,
                  "tx.memo.clear",
                  argv as Record<string, unknown>,
                  results,
                  format,
                );
              },
            })
            .demandCommand(1, "Specify a memo subcommand")
            .strict(),
        handler: () => {},
      })

      // Flag
      .command({
        command: "flag <command>",
        describe: "Flag updates",
        builder: (yy) =>
          yy
            .command({
              command: "set",
              describe: "Set flag color on one or more transactions",
              builder: (yyy) =>
                yyy
                  .option("id", {
                    type: "string",
                    array: true,
                    demandOption: true,
                    describe: "Transaction id (repeatable)",
                  })
                  .option("color", {
                    type: "string",
                    demandOption: true,
                    choices: ["red", "orange", "yellow", "green", "blue", "purple"] as const,
                    describe: "Flag color",
                  })
                  .check((argv) => {
                    const ids = normalizeIds(argv.id as string[] | string | undefined);
                    if (ids.length === 0) {
                      throw new Error("Provide at least one non-empty --id value.");
                    }
                    return true;
                  }),
              handler: async (argv) => {
                const { appContext, format, dryRun, yes, id, color } = argv as unknown as FlagArgs;
                const ctx = appContext;
                if (!ctx?.ynab || !ctx.budgetId) {
                  throw new Error("Missing budget context for flag set.");
                }

                const ids = normalizeIds(id);
                requireApplyConfirmation(Boolean(dryRun), Boolean(yes));

                if (!color) {
                  throw new Error("Provide --color.");
                }
                const flag = parseFlagColor(color);

                const service = new TransactionService(ctx.ynab, ctx.budgetId);
                const results = await service.applyPatch(ids, { flag_color: flag }, { dryRun });
                await finalizeMutation(
                  ctx,
                  "tx.flag.set",
                  argv as Record<string, unknown>,
                  results,
                  format,
                );
              },
            })
            .command({
              command: "clear",
              describe: "Clear flag on one or more transactions",
              builder: (yyy) =>
                yyy
                  .option("id", {
                    type: "string",
                    array: true,
                    demandOption: true,
                    describe: "Transaction id (repeatable)",
                  })
                  .check((argv) => {
                    const ids = normalizeIds(argv.id as string[] | string | undefined);
                    if (ids.length === 0) {
                      throw new Error("Provide at least one non-empty --id value.");
                    }
                    return true;
                  }),
              handler: async (argv) => {
                const { appContext, format, dryRun, yes, id } = argv as unknown as IdArgs;
                const ctx = appContext;
                if (!ctx?.ynab || !ctx.budgetId) {
                  throw new Error("Missing budget context for flag clear.");
                }

                const ids = normalizeIds(id);
                requireApplyConfirmation(Boolean(dryRun), Boolean(yes));

                const service = new TransactionService(ctx.ynab, ctx.budgetId);
                const results = await service.applyPatch(ids, { flag_color: null }, { dryRun });
                await finalizeMutation(
                  ctx,
                  "tx.flag.clear",
                  argv as Record<string, unknown>,
                  results,
                  format,
                );
              },
            })
            .demandCommand(1, "Specify a flag subcommand")
            .strict(),
        handler: () => {},
      })

      // Cleared
      .command({
        command: "cleared <command>",
        describe: "Cleared status updates",
        builder: (yy) =>
          yy
            .command({
              command: "set",
              describe: "Set cleared status on one or more transactions",
              builder: (yyy) =>
                yyy
                  .option("id", {
                    type: "string",
                    array: true,
                    demandOption: true,
                    describe: "Transaction id (repeatable)",
                  })
                  .option("status", {
                    type: "string",
                    demandOption: true,
                    choices: ["cleared", "uncleared", "reconciled"] as const,
                    describe: "Cleared status",
                  })
                  .check((argv) => {
                    const ids = normalizeIds(argv.id as string[] | string | undefined);
                    if (ids.length === 0) {
                      throw new Error("Provide at least one non-empty --id value.");
                    }
                    return true;
                  }),
              handler: async (argv) => {
                const { appContext, format, dryRun, yes, id, status } =
                  argv as unknown as ClearedArgs;
                const ctx = appContext;
                if (!ctx?.ynab || !ctx.budgetId) {
                  throw new Error("Missing budget context for cleared set.");
                }

                const ids = normalizeIds(id);
                requireApplyConfirmation(Boolean(dryRun), Boolean(yes));

                if (!status) {
                  throw new Error("Provide --status.");
                }
                const cleared = parseClearedStatus(status);

                const service = new TransactionService(ctx.ynab, ctx.budgetId);
                const results = await service.applyPatch(ids, { cleared }, { dryRun });
                await finalizeMutation(
                  ctx,
                  "tx.cleared.set",
                  argv as Record<string, unknown>,
                  results,
                  format,
                );
              },
            })
            .demandCommand(1, "Specify a cleared subcommand")
            .strict(),
        handler: () => {},
      })

      // Date
      .command({
        command: "date <command>",
        describe: "Date updates",
        builder: (yy) =>
          yy
            .command({
              command: "set <date>",
              describe: "Set date (YYYY-MM-DD) on one or more transactions",
              builder: (yyy) =>
                yyy
                  .positional("date", {
                    type: "string",
                    describe: "New date (YYYY-MM-DD)",
                  })
                  .option("id", {
                    type: "string",
                    array: true,
                    demandOption: true,
                    describe: "Transaction id (repeatable)",
                  })
                  .check((argv) => {
                    const ids = normalizeIds(argv.id as string[] | string | undefined);
                    if (ids.length === 0) {
                      throw new Error("Provide at least one non-empty --id value.");
                    }
                    if (typeof argv.date === "string") {
                      parseDateOnly(argv.date);
                    }
                    return true;
                  }),
              handler: async (argv) => {
                const { appContext, format, dryRun, yes, id, date } = argv as unknown as DateArgs;
                const ctx = appContext;
                if (!ctx?.ynab || !ctx.budgetId) {
                  throw new Error("Missing budget context for date set.");
                }

                const ids = normalizeIds(id);
                requireApplyConfirmation(Boolean(dryRun), Boolean(yes));

                const parsedDate = parseDateOnly(date);

                const service = new TransactionService(ctx.ynab, ctx.budgetId);
                const results = await service.applyPatch(ids, { date: parsedDate }, { dryRun });
                await finalizeMutation(
                  ctx,
                  "tx.date.set",
                  argv as Record<string, unknown>,
                  results,
                  format,
                );
              },
            })
            .demandCommand(1, "Specify a date subcommand")
            .strict(),
        handler: () => {},
      })

      // Payee
      .command({
        command: "payee <command>",
        describe: "Payee updates",
        builder: (yy) =>
          yy
            .command({
              command: "set",
              describe: "Set payee on one or more transactions",
              builder: (yyy) =>
                yyy
                  .option("id", {
                    type: "string",
                    array: true,
                    demandOption: true,
                    describe: "Transaction id (repeatable)",
                  })
                  .option("payee-id", {
                    type: "string",
                    describe: "Payee id",
                  })
                  .option("payee-name", {
                    type: "string",
                    describe: "Payee name (must resolve unambiguously)",
                  })
                  .check((argv) => {
                    if (!argv.payeeId && !argv.payeeName) {
                      throw new Error("Provide --payee-id or --payee-name");
                    }
                    const ids = normalizeIds(argv.id as string[] | string | undefined);
                    if (ids.length === 0) {
                      throw new Error("Provide at least one non-empty --id value.");
                    }
                    return true;
                  }),
              handler: async (argv) => {
                const { appContext, format, dryRun, yes, id, payeeId, payeeName } =
                  argv as unknown as PayeeArgs;
                const ctx = appContext;
                if (!ctx?.ynab || !ctx.budgetId) {
                  throw new Error("Missing budget context for payee set.");
                }

                const ids = normalizeIds(id);
                requireApplyConfirmation(Boolean(dryRun), Boolean(yes));

                let resolvedId = payeeId;
                if (!resolvedId && payeeName) {
                  const payees = await ctx.ynab.listPayees(ctx.budgetId);
                  resolvedId = resolvePayee(payeeName, payees);
                }
                if (!resolvedId) {
                  throw new Error("Provide --payee-id or --payee-name");
                }

                const service = new TransactionService(ctx.ynab, ctx.budgetId);
                const results = await service.applyPatch(ids, { payee_id: resolvedId }, { dryRun });
                await finalizeMutation(
                  ctx,
                  "tx.payee.set",
                  argv as Record<string, unknown>,
                  results,
                  format,
                );
              },
            })
            .demandCommand(1, "Specify a payee subcommand")
            .strict(),
        handler: () => {},
      })

      // Amount
      .command({
        command: "amount <command>",
        describe: "Amount updates",
        builder: (yy) =>
          yy
            .command({
              command: "set",
              describe: "Set transaction amount (single transaction only)",
              builder: (yyy) =>
                yyy
                  .option("id", {
                    type: "string",
                    demandOption: true,
                    describe: "Transaction id",
                  })
                  .option("amount", {
                    type: "string",
                    demandOption: true,
                    describe: "Amount (e.g. -12.34 or 12.34)",
                  })
                  .check((argv) => {
                    const ids = normalizeIds(argv.id as string[] | string | undefined);
                    if (ids.length !== 1) {
                      throw new Error("Provide exactly one --id value for amount set.");
                    }
                    if (typeof argv.amount === "string") {
                      parseAmountToMilliunits(argv.amount);
                    }
                    return true;
                  }),
              handler: async (argv) => {
                const { appContext, format, dryRun, yes, id, amount } =
                  argv as unknown as AmountArgs;
                const ctx = appContext;
                if (!ctx?.ynab || !ctx.budgetId) {
                  throw new Error("Missing budget context for amount set.");
                }

                const ids = normalizeIds(id);
                requireApplyConfirmation(Boolean(dryRun), Boolean(yes));

                const milliunits = parseAmountToMilliunits(amount);

                const service = new TransactionService(ctx.ynab, ctx.budgetId);
                const results = await service.applyPatch(ids, { amount: milliunits }, { dryRun });
                await finalizeMutation(
                  ctx,
                  "tx.amount.set",
                  argv as Record<string, unknown>,
                  results,
                  format,
                );
              },
            })
            .demandCommand(1, "Specify an amount subcommand")
            .strict(),
        handler: () => {},
      })

      // Account
      .command({
        command: "account <command>",
        describe: "Account updates",
        builder: (yy) =>
          yy
            .command({
              command: "set",
              describe: "Move a transaction to another account (non-transfer only)",
              builder: (yyy) =>
                yyy
                  .option("id", {
                    type: "string",
                    array: true,
                    demandOption: true,
                    describe: "Transaction id (repeatable)",
                  })
                  .option("account-id", {
                    type: "string",
                    describe: "Destination account id",
                  })
                  .option("account-name", {
                    type: "string",
                    describe: "Destination account name (must resolve unambiguously)",
                  })
                  .check((argv) => {
                    if (!argv.accountId && !argv.accountName) {
                      throw new Error("Provide --account-id or --account-name");
                    }
                    const ids = normalizeIds(argv.id as string[] | string | undefined);
                    if (ids.length === 0) {
                      throw new Error("Provide at least one non-empty --id value.");
                    }
                    return true;
                  }),
              handler: async (argv) => {
                const { appContext, format, dryRun, yes, id, accountId, accountName } =
                  argv as unknown as AccountArgs;
                const ctx = appContext;
                if (!ctx?.ynab || !ctx.budgetId) {
                  throw new Error("Missing budget context for account set.");
                }

                const ids = normalizeIds(id);
                requireApplyConfirmation(Boolean(dryRun), Boolean(yes));

                let resolvedId = accountId;
                if (!resolvedId && accountName) {
                  const accounts = await ctx.ynab.listAccounts(ctx.budgetId);
                  resolvedId = resolveAccount(accountName, accounts);
                }
                if (!resolvedId) {
                  throw new Error("Provide --account-id or --account-name");
                }

                const service = new TransactionService(ctx.ynab, ctx.budgetId);
                const results = await service.mutateTransactions(
                  ids,
                  (transaction) => {
                    if (transaction.transfer_account_id || transaction.transfer_transaction_id) {
                      throw new Error("Transfers cannot be moved in v1.");
                    }
                    return { account_id: resolvedId };
                  },
                  { dryRun },
                );
                await finalizeMutation(
                  ctx,
                  "tx.account.set",
                  argv as Record<string, unknown>,
                  results,
                  format,
                );
              },
            })
            .demandCommand(1, "Specify an account subcommand")
            .strict(),
        handler: () => {},
      })

      .demandCommand(1, "Specify a tx subcommand")
      .strict(),
  handler: () => {},
};

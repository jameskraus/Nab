import type { Argv } from "yargs";
import type { CurrencyFormat, NewTransaction, Payee, TransactionDetail } from "ynab";

import type { AppContext } from "@/app/createAppContext";
import { defineCommand } from "@/cli/command";
import { requireApplyConfirmation } from "@/cli/mutations";
import { getOutputWriterOptions } from "@/cli/outputOptions";
import { type TxSelectorArgs, resolveSelectorIds, validateSelectorInput } from "@/cli/txSelectors";
import { TransactionService } from "@/domain/TransactionService";
import type { TransactionMutationResult } from "@/domain/TransactionService";
import { resolveBudgetCurrencyFormat } from "@/domain/budgetCurrency";
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
  formatCurrency,
  formatDate,
  parseOutputFormat,
} from "@/io";
import { normalizeArgv } from "@/journal/argv";
import { recordHistoryAction } from "@/journal/history";
import { getOrCreateRef, getOrCreateRefs } from "@/refs/refLease";

type CliArgs = {
  format?: string;
  quiet?: boolean;
  noColor?: boolean;
  dryRun?: boolean;
  yes?: boolean;
};

type TxListArgs = CliArgs & {
  accountId?: string;
  sinceDate?: string;
  onlyUncategorized?: boolean;
  onlyUnapproved?: boolean;
  uncategorized?: boolean;
  unapproved?: boolean;
  onlyTransfers?: boolean;
  excludeTransfers?: boolean;
};

type TxGetArgs = CliArgs & TxSelectorArgs;

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

type IdArgs = CliArgs & TxSelectorArgs;

type MemoArgs = CliArgs &
  TxSelectorArgs & {
    memo?: string;
  };

type CategoryArgs = CliArgs &
  TxSelectorArgs & {
    categoryId?: string;
    categoryName?: string;
  };

type PayeeArgs = CliArgs &
  TxSelectorArgs & {
    payeeId?: string;
    payeeName?: string;
  };

type FlagArgs = CliArgs &
  TxSelectorArgs & {
    color?: string;
  };

type ClearedArgs = CliArgs &
  TxSelectorArgs & {
    status?: string;
  };

type DateArgs = CliArgs &
  TxSelectorArgs & {
    date: string;
  };

type AmountArgs = CliArgs &
  TxSelectorArgs & {
    amount: string;
  };

type AccountArgs = CliArgs &
  TxSelectorArgs & {
    accountId?: string;
    accountName?: string;
  };

type TransactionListRow = {
  ref: string;
  id: string;
  date: string;
  account: string;
  payee: string;
  category: string;
  memo: string;
  amount: string;
};

type TransactionFilters = {
  accountId?: string;
  onlyUncategorized?: boolean;
  onlyUnapproved?: boolean;
  onlyTransfers?: boolean;
  excludeTransfers?: boolean;
};

type MutationRow = {
  id: string;
  status: string;
  patch: string;
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const txReadRequirements = { auth: true, budget: "required" } as const;
const txReadWithDbRequirements = { auth: true, budget: "required", db: true } as const;
const txMutationRequirements = {
  auth: true,
  budget: "required",
  db: true,
  mutation: true,
} as const;

type SubTransaction = NonNullable<TransactionDetail["subtransactions"]>[number];

type SubTransactionOutput = Omit<SubTransaction, "amount"> & {
  amount: string;
  amount_display: string;
  raw_amount: number;
};

type TransactionOutput = Omit<TransactionDetail, "amount" | "subtransactions"> & {
  amount: string;
  amount_display: string;
  raw_amount: number;
  subtransactions?: SubTransactionOutput[] | null;
  ref?: string | null;
};

type MoneyWriterOptions = OutputWriterOptions & {
  currencyFormat?: CurrencyFormat | null;
  refsById?: Map<string, string>;
};

function isTransferTransaction(transaction: TransactionDetail): boolean {
  return Boolean(transaction.transfer_account_id);
}

type TxListFlagOptions = {
  onlyUncategorized?: boolean;
  onlyUnapproved?: boolean;
  uncategorized?: boolean;
  unapproved?: boolean;
  onlyTransfers?: boolean;
  excludeTransfers?: boolean;
};

type NormalizedTxListFlags = {
  onlyUncategorized: boolean;
  onlyUnapproved: boolean;
  onlyTransfers: boolean;
  excludeTransfers: boolean;
  usedDeprecatedUncategorized: boolean;
  usedDeprecatedUnapproved: boolean;
};

function normalizeTxListFlags(options: TxListFlagOptions): NormalizedTxListFlags {
  return {
    onlyUncategorized: Boolean(options.onlyUncategorized || options.uncategorized),
    onlyUnapproved: Boolean(options.onlyUnapproved || options.unapproved),
    onlyTransfers: Boolean(options.onlyTransfers),
    excludeTransfers: Boolean(options.excludeTransfers),
    usedDeprecatedUncategorized: Boolean(options.uncategorized),
    usedDeprecatedUnapproved: Boolean(options.unapproved),
  };
}

function warnDeprecatedFlag(flag: string, replacement: string): void {
  process.stderr.write(`Warning: ${flag} is deprecated. Use ${replacement} instead.\n`);
}

function renderCategory(transaction: TransactionDetail): string {
  if (isTransferTransaction(transaction)) {
    return "n/a - transfer";
  }
  return transaction.category_id ? (transaction.category_name ?? "") : "Uncategorized";
}

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
  options?: OutputWriterOptions,
): Promise<void> {
  await recordMutationHistory(ctx, actionType, argv, results);
  writeMutationResults(results, format, options);
}

function decorateSubtransaction(
  subtransaction: SubTransaction,
  currencyFormat?: CurrencyFormat | null,
): SubTransactionOutput {
  const amountDisplay = formatCurrency(subtransaction.amount, currencyFormat);
  return {
    ...subtransaction,
    amount: amountDisplay,
    amount_display: amountDisplay,
    raw_amount: subtransaction.amount,
  };
}

function decorateTransaction(
  transaction: TransactionDetail,
  currencyFormat?: CurrencyFormat | null,
): TransactionOutput {
  const amountDisplay = formatCurrency(transaction.amount, currencyFormat);
  const isTransfer = isTransferTransaction(transaction);
  const subtransactions = Array.isArray(transaction.subtransactions)
    ? transaction.subtransactions.map((sub) => decorateSubtransaction(sub, currencyFormat))
    : transaction.subtransactions;

  return {
    ...transaction,
    ...(isTransfer ? { category_id: null, category_name: null } : {}),
    amount: amountDisplay,
    amount_display: amountDisplay,
    raw_amount: transaction.amount,
    subtransactions,
  };
}

function transactionRows(
  transactions: TransactionDetail[],
  currencyFormat?: CurrencyFormat | null,
  refsById?: Map<string, string>,
): TransactionListRow[] {
  return transactions.map((transaction) => ({
    ref: refsById?.get(transaction.id) ?? "",
    id: transaction.id,
    date: formatDate(transaction.date),
    account: transaction.account_name,
    payee: transaction.payee_name ?? "",
    category: renderCategory(transaction),
    memo: transaction.memo ?? "",
    amount: formatCurrency(transaction.amount, currencyFormat),
  }));
}

function transactionColumns() {
  return [
    fieldColumn("ref", { header: "Ref" }),
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
  const { accountId, onlyUncategorized, onlyUnapproved } = filters;
  return transactions.filter((transaction) => {
    if (accountId && transaction.account_id !== accountId) return false;
    const isTransfer = isTransferTransaction(transaction);
    if (filters.onlyTransfers && !isTransfer) return false;
    if (filters.excludeTransfers && isTransfer) return false;
    if (onlyUncategorized && transaction.category_id) return false;
    if (onlyUnapproved && transaction.approved !== false) return false;
    return true;
  });
}

export function writeTransactionList(
  transactions: TransactionDetail[],
  rawFormat?: string,
  options?: MoneyWriterOptions,
): void {
  const format = parseOutputFormat(rawFormat, "table");
  const { currencyFormat, refsById, ...writerOptions } = options ?? {};

  if (format === "json") {
    const decorated = transactions.map(
      (transaction) =>
        ({
          ...decorateTransaction(transaction, currencyFormat),
          ref: refsById?.get(transaction.id) ?? null,
        }) satisfies TransactionOutput,
    );
    createOutputWriter("json", writerOptions).write(decorated);
    return;
  }

  if (format === "ids") {
    createOutputWriter("ids", writerOptions).write(
      transactions.map((transaction) => transaction.id),
    );
    return;
  }

  const rows = transactionRows(transactions, currencyFormat, refsById);

  if (format === "tsv") {
    createOutputWriter("tsv", writerOptions).write(rows);
    return;
  }

  createOutputWriter("table", writerOptions).write({
    columns: transactionColumns(),
    rows,
  });
}

export function writeTransactionDetail(
  transaction: TransactionDetail,
  rawFormat?: string,
  options?: MoneyWriterOptions,
): void {
  const format = parseOutputFormat(rawFormat, "table");
  const { currencyFormat, refsById, ...writerOptions } = options ?? {};

  if (format === "json") {
    createOutputWriter("json", writerOptions).write({
      ...decorateTransaction(transaction, currencyFormat),
      ref: refsById?.get(transaction.id) ?? null,
    } satisfies TransactionOutput);
    return;
  }

  if (format === "ids") {
    createOutputWriter("ids", writerOptions).write([transaction.id]);
    return;
  }

  const rows = transactionRows([transaction], currencyFormat, refsById);

  if (format === "tsv") {
    createOutputWriter("tsv", writerOptions).write(rows);
    return;
  }

  createOutputWriter("table", writerOptions).write({
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

export const txCommand = {
  command: "tx <command>",
  describe: "Query and mutate transactions",
  builder: (y: Argv<Record<string, unknown>>) =>
    y
      .command(
        defineCommand({
          command: "list",
          describe: "List transactions",
          requirements: txReadWithDbRequirements,
          builder: (yy: Argv<Record<string, unknown>>) =>
            yy
              .option("account-id", {
                type: "string",
                describe: "Filter by account id",
              })
              .option("since-date", {
                type: "string",
                describe: "Only include transactions on/after this date (YYYY-MM-DD)",
              })
              .option("only-uncategorized", {
                type: "boolean",
                default: false,
                describe: "Only show uncategorized transactions",
              })
              .option("only-unapproved", {
                type: "boolean",
                default: false,
                describe: "Only show unapproved transactions",
              })
              .option("uncategorized", {
                type: "boolean",
                default: false,
                describe: "Deprecated. Use --only-uncategorized.",
              })
              .option("unapproved", {
                type: "boolean",
                default: false,
                describe: "Deprecated. Use --only-unapproved.",
              })
              .option("only-transfers", {
                type: "boolean",
                default: false,
                describe: "Only show transfer transactions",
              })
              .option("exclude-transfers", {
                type: "boolean",
                default: false,
                describe: "Exclude transfer transactions",
              })
              .check((argv) => {
                if (typeof argv.accountId === "string" && argv.accountId.trim().length === 0) {
                  throw new Error("Provide a non-empty --account-id value.");
                }
                if (typeof argv.sinceDate === "string" && !DATE_ONLY.test(argv.sinceDate)) {
                  throw new Error("Provide --since-date in YYYY-MM-DD format.");
                }
                const flags = normalizeTxListFlags(argv as TxListFlagOptions);
                if (flags.onlyUncategorized && flags.onlyUnapproved) {
                  throw new Error(
                    "Use either --only-uncategorized or --only-unapproved, not both.",
                  );
                }
                if (flags.onlyTransfers && flags.excludeTransfers) {
                  throw new Error("Use either --only-transfers or --exclude-transfers, not both.");
                }
                return true;
              }),
          handler: async (argv, ctx) => {
            const args = argv as unknown as TxListArgs;
            const {
              accountId,
              sinceDate,
              onlyTransfers,
              excludeTransfers,
              onlyUncategorized,
              onlyUnapproved,
              uncategorized,
              unapproved,
              quiet,
            } = args;
            const flags = normalizeTxListFlags({
              onlyUncategorized,
              onlyUnapproved,
              uncategorized,
              unapproved,
              onlyTransfers,
              excludeTransfers,
            });

            if (!quiet) {
              if (flags.usedDeprecatedUncategorized) {
                warnDeprecatedFlag("--uncategorized", "--only-uncategorized");
              }
              if (flags.usedDeprecatedUnapproved) {
                warnDeprecatedFlag("--unapproved", "--only-unapproved");
              }
            }

            const listType = flags.onlyUncategorized
              ? "uncategorized"
              : flags.onlyUnapproved
                ? "unapproved"
                : undefined;
            const transactions = accountId
              ? await ctx.ynab.listAccountTransactions(ctx.budgetId, accountId, sinceDate, listType)
              : await ctx.ynab.listTransactions(ctx.budgetId, sinceDate, listType);
            const filtered = applyTransactionFilters(transactions, {
              accountId,
              onlyUncategorized: flags.onlyUncategorized,
              onlyUnapproved: flags.onlyUnapproved,
              onlyTransfers: flags.onlyTransfers,
              excludeTransfers: flags.excludeTransfers,
            });
            const refsById = ctx.db
              ? getOrCreateRefs(
                  ctx.db,
                  filtered.map((tx) => tx.id),
                )
              : new Map();
            const currencyFormat = await resolveBudgetCurrencyFormat(ctx, ctx.budgetId);
            writeTransactionList(filtered, args.format, {
              currencyFormat,
              refsById,
              ...getOutputWriterOptions(args),
            });
          },
        }),
      )
      .command(
        defineCommand({
          command: "get",
          describe: "Get a single transaction",
          requirements: txReadWithDbRequirements,
          builder: (yy: Argv<Record<string, unknown>>) =>
            yy
              .option("id", { type: "string", describe: "Transaction id" })
              .option("ref", { type: "string", describe: "Transaction ref" })
              .check((argv) => {
                validateSelectorInput(argv as TxSelectorArgs, { requireSingle: true });
                return true;
              }),
          handler: async (argv, ctx) => {
            const args = argv as unknown as TxGetArgs;
            const [id] = resolveSelectorIds(ctx.db, args, { requireSingle: true });
            const transaction = await ctx.ynab.getTransaction(ctx.budgetId, id);
            const refsById = ctx.db
              ? new Map([[transaction.id, getOrCreateRef(ctx.db, transaction.id)]])
              : new Map();
            const currencyFormat = await resolveBudgetCurrencyFormat(ctx, ctx.budgetId);
            writeTransactionDetail(transaction, args.format, {
              currencyFormat,
              refsById,
              ...getOutputWriterOptions(args),
            });
          },
        }),
      )
      .command(
        defineCommand({
          command: "create",
          describe: "Create a new transaction",
          requirements: txMutationRequirements,
          builder: (yy: Argv<Record<string, unknown>>) =>
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
                return true;
              }),
          handler: async (argv, ctx) => {
            const args = argv as unknown as TxCreateArgs;
            const {
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
            } = args;

            requireApplyConfirmation(Boolean(dryRun), Boolean(yes));
            const currencyFormat = await resolveBudgetCurrencyFormat(ctx, ctx.budgetId);

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
            const milliunits = amount ? parseAmountToMilliunits(amount, currencyFormat) : undefined;

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
              writeMutationResults(
                [{ id: "(new)", status: "dry-run", patch: transaction }],
                args.format,
                getOutputWriterOptions(args),
              );
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
            writeTransactionDetail(created, args.format, {
              currencyFormat,
              ...getOutputWriterOptions(args),
            });
          },
        }),
      )

      // Approval
      .command(
        defineCommand({
          command: "approve",
          describe: "Approve one or more transactions",
          requirements: txMutationRequirements,
          builder: (yy: Argv<Record<string, unknown>>) =>
            yy
              .option("id", {
                type: "string",
                array: true,
                describe: "Transaction id (repeatable)",
              })
              .option("ref", {
                type: "string",
                array: true,
                describe: "Transaction ref (repeatable)",
              })
              .check((argv) => {
                validateSelectorInput(argv as TxSelectorArgs);
                return true;
              }),
          handler: async (argv, ctx) => {
            const args = argv as unknown as IdArgs;
            const ids = resolveSelectorIds(ctx.db, args);
            requireApplyConfirmation(Boolean(args.dryRun), Boolean(args.yes));

            const service = new TransactionService(ctx.ynab, ctx.budgetId);
            const results = await service.setApproved(ids, true, { dryRun: args.dryRun });
            await finalizeMutation(
              ctx,
              "tx.approve",
              argv as Record<string, unknown>,
              results,
              args.format,
              getOutputWriterOptions(args),
            );
          },
        }),
      )
      .command(
        defineCommand({
          command: "unapprove",
          describe: "Unapprove one or more transactions",
          requirements: txMutationRequirements,
          builder: (yy: Argv<Record<string, unknown>>) =>
            yy
              .option("id", {
                type: "string",
                array: true,
                describe: "Transaction id (repeatable)",
              })
              .option("ref", {
                type: "string",
                array: true,
                describe: "Transaction ref (repeatable)",
              })
              .check((argv) => {
                validateSelectorInput(argv as TxSelectorArgs);
                return true;
              }),
          handler: async (argv, ctx) => {
            const args = argv as unknown as IdArgs;
            const ids = resolveSelectorIds(ctx.db, args);
            requireApplyConfirmation(Boolean(args.dryRun), Boolean(args.yes));

            const service = new TransactionService(ctx.ynab, ctx.budgetId);
            const results = await service.setApproved(ids, false, { dryRun: args.dryRun });
            await finalizeMutation(
              ctx,
              "tx.unapprove",
              argv as Record<string, unknown>,
              results,
              args.format,
              getOutputWriterOptions(args),
            );
          },
        }),
      )

      // Deletion ("reject")
      .command(
        defineCommand({
          command: "delete",
          describe: "Delete one or more transactions",
          requirements: txMutationRequirements,
          builder: (yy: Argv<Record<string, unknown>>) =>
            yy
              .option("id", {
                type: "string",
                array: true,
                describe: "Transaction id (repeatable)",
              })
              .option("ref", {
                type: "string",
                array: true,
                describe: "Transaction ref (repeatable)",
              })
              .check((argv) => {
                validateSelectorInput(argv as TxSelectorArgs);
                return true;
              }),
          handler: async (argv, ctx) => {
            const args = argv as unknown as IdArgs;
            const ids = resolveSelectorIds(ctx.db, args);
            requireApplyConfirmation(Boolean(args.dryRun), Boolean(args.yes));

            const service = new TransactionService(ctx.ynab, ctx.budgetId);
            const results = await service.deleteTransactions(ids, { dryRun: args.dryRun });
            await finalizeMutation(
              ctx,
              "tx.delete",
              argv as Record<string, unknown>,
              results,
              args.format,
              getOutputWriterOptions(args),
            );
          },
        }),
      )

      // Category
      .command({
        command: "category <command>",
        describe: "Category updates",
        builder: (yy: Argv<Record<string, unknown>>) =>
          yy
            .command(
              defineCommand({
                command: "set",
                describe: "Set category on one or more transactions",
                requirements: txMutationRequirements,
                builder: (yyy: Argv<Record<string, unknown>>) =>
                  yyy
                    .option("id", {
                      type: "string",
                      array: true,
                      describe: "Transaction id (repeatable)",
                    })
                    .option("ref", {
                      type: "string",
                      array: true,
                      describe: "Transaction ref (repeatable)",
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
                      validateSelectorInput(argv as TxSelectorArgs);
                      return true;
                    }),
                handler: async (argv, ctx) => {
                  const args = argv as unknown as CategoryArgs;
                  const ids = resolveSelectorIds(ctx.db, args);
                  requireApplyConfirmation(Boolean(args.dryRun), Boolean(args.yes));

                  let resolvedId = args.categoryId;
                  if (!resolvedId && args.categoryName) {
                    const groups = await ctx.ynab.listCategories(ctx.budgetId);
                    resolvedId = resolveCategory(args.categoryName, groups);
                  }
                  if (!resolvedId) {
                    throw new Error("Provide --category-id or --category-name");
                  }

                  const service = new TransactionService(ctx.ynab, ctx.budgetId);
                  const results = await service.applyPatch(
                    ids,
                    { category_id: resolvedId },
                    { dryRun: args.dryRun },
                  );
                  await finalizeMutation(
                    ctx,
                    "tx.category.set",
                    argv as Record<string, unknown>,
                    results,
                    args.format,
                    getOutputWriterOptions(args),
                  );
                },
              }),
            )
            .command(
              defineCommand({
                command: "clear",
                describe: "Clear category on one or more transactions (set to null)",
                requirements: txMutationRequirements,
                builder: (yyy: Argv<Record<string, unknown>>) =>
                  yyy
                    .option("id", {
                      type: "string",
                      array: true,
                      describe: "Transaction id (repeatable)",
                    })
                    .option("ref", {
                      type: "string",
                      array: true,
                      describe: "Transaction ref (repeatable)",
                    })
                    .check((argv) => {
                      validateSelectorInput(argv as TxSelectorArgs);
                      return true;
                    }),
                handler: async (argv, ctx) => {
                  const args = argv as unknown as IdArgs;
                  const ids = resolveSelectorIds(ctx.db, args);
                  requireApplyConfirmation(Boolean(args.dryRun), Boolean(args.yes));

                  const service = new TransactionService(ctx.ynab, ctx.budgetId);
                  const results = await service.applyPatch(
                    ids,
                    { category_id: null },
                    { dryRun: args.dryRun },
                  );
                  await finalizeMutation(
                    ctx,
                    "tx.category.clear",
                    argv as Record<string, unknown>,
                    results,
                    args.format,
                    getOutputWriterOptions(args),
                  );
                },
              }),
            )
            .demandCommand(1, "Specify a category subcommand")
            .strict(),
        handler: () => {},
      })

      // Memo
      .command({
        command: "memo <command>",
        describe: "Memo updates",
        builder: (yy: Argv<Record<string, unknown>>) =>
          yy
            .command(
              defineCommand({
                command: "get",
                describe: "Get memo for a transaction",
                requirements: txReadWithDbRequirements,
                builder: (yyy: Argv<Record<string, unknown>>) =>
                  yyy
                    .option("id", {
                      type: "string",
                      describe: "Transaction id",
                    })
                    .option("ref", {
                      type: "string",
                      describe: "Transaction ref",
                    })
                    .check((argv) => {
                      validateSelectorInput(argv as TxSelectorArgs, { requireSingle: true });
                      return true;
                    }),
                handler: async (argv, ctx) => {
                  const args = argv as unknown as TxGetArgs;
                  const [id] = resolveSelectorIds(ctx.db, args, { requireSingle: true });
                  const transaction = await ctx.ynab.getTransaction(ctx.budgetId, id);
                  writeMemoResult(
                    transaction.id,
                    transaction.memo ?? null,
                    args.format,
                    getOutputWriterOptions(args),
                  );
                },
              }),
            )
            .command(
              defineCommand({
                command: "set",
                describe: "Set memo for one or more transactions",
                requirements: txMutationRequirements,
                builder: (yyy: Argv<Record<string, unknown>>) =>
                  yyy
                    .option("id", {
                      type: "string",
                      array: true,
                      describe: "Transaction id (repeatable)",
                    })
                    .option("ref", {
                      type: "string",
                      array: true,
                      describe: "Transaction ref (repeatable)",
                    })
                    .option("memo", {
                      type: "string",
                      demandOption: true,
                      describe: "Memo text",
                    })
                    .check((argv) => {
                      validateSelectorInput(argv as TxSelectorArgs);
                      return true;
                    }),
                handler: async (argv, ctx) => {
                  const args = argv as unknown as MemoArgs;
                  const ids = resolveSelectorIds(ctx.db, args);
                  requireApplyConfirmation(Boolean(args.dryRun), Boolean(args.yes));

                  const service = new TransactionService(ctx.ynab, ctx.budgetId);
                  const results = await service.applyPatch(
                    ids,
                    { memo: args.memo ?? "" },
                    { dryRun: args.dryRun },
                  );
                  await finalizeMutation(
                    ctx,
                    "tx.memo.set",
                    argv as Record<string, unknown>,
                    results,
                    args.format,
                    getOutputWriterOptions(args),
                  );
                },
              }),
            )
            .command(
              defineCommand({
                command: "clear",
                describe: "Clear memo for one or more transactions",
                requirements: txMutationRequirements,
                builder: (yyy: Argv<Record<string, unknown>>) =>
                  yyy
                    .option("id", {
                      type: "string",
                      array: true,
                      describe: "Transaction id (repeatable)",
                    })
                    .option("ref", {
                      type: "string",
                      array: true,
                      describe: "Transaction ref (repeatable)",
                    })
                    .check((argv) => {
                      validateSelectorInput(argv as TxSelectorArgs);
                      return true;
                    }),
                handler: async (argv, ctx) => {
                  const args = argv as unknown as IdArgs;
                  const ids = resolveSelectorIds(ctx.db, args);
                  requireApplyConfirmation(Boolean(args.dryRun), Boolean(args.yes));

                  const service = new TransactionService(ctx.ynab, ctx.budgetId);
                  const results = await service.applyPatch(
                    ids,
                    { memo: null },
                    { dryRun: args.dryRun },
                  );
                  await finalizeMutation(
                    ctx,
                    "tx.memo.clear",
                    argv as Record<string, unknown>,
                    results,
                    args.format,
                    getOutputWriterOptions(args),
                  );
                },
              }),
            )
            .demandCommand(1, "Specify a memo subcommand")
            .strict(),
        handler: () => {},
      })

      // Flag
      .command({
        command: "flag <command>",
        describe: "Flag updates",
        builder: (yy: Argv<Record<string, unknown>>) =>
          yy
            .command(
              defineCommand({
                command: "set",
                describe: "Set flag color on one or more transactions",
                requirements: txMutationRequirements,
                builder: (yyy: Argv<Record<string, unknown>>) =>
                  yyy
                    .option("id", {
                      type: "string",
                      array: true,
                      describe: "Transaction id (repeatable)",
                    })
                    .option("ref", {
                      type: "string",
                      array: true,
                      describe: "Transaction ref (repeatable)",
                    })
                    .option("color", {
                      type: "string",
                      demandOption: true,
                      choices: ["red", "orange", "yellow", "green", "blue", "purple"] as const,
                      describe: "Flag color",
                    })
                    .check((argv) => {
                      validateSelectorInput(argv as TxSelectorArgs);
                      return true;
                    }),
                handler: async (argv, ctx) => {
                  const args = argv as unknown as FlagArgs;
                  const ids = resolveSelectorIds(ctx.db, args);
                  requireApplyConfirmation(Boolean(args.dryRun), Boolean(args.yes));

                  if (!args.color) {
                    throw new Error("Provide --color.");
                  }
                  const flag = parseFlagColor(args.color);

                  const service = new TransactionService(ctx.ynab, ctx.budgetId);
                  const results = await service.applyPatch(
                    ids,
                    { flag_color: flag },
                    { dryRun: args.dryRun },
                  );
                  await finalizeMutation(
                    ctx,
                    "tx.flag.set",
                    argv as Record<string, unknown>,
                    results,
                    args.format,
                    getOutputWriterOptions(args),
                  );
                },
              }),
            )
            .command(
              defineCommand({
                command: "clear",
                describe: "Clear flag on one or more transactions",
                requirements: txMutationRequirements,
                builder: (yyy: Argv<Record<string, unknown>>) =>
                  yyy
                    .option("id", {
                      type: "string",
                      array: true,
                      describe: "Transaction id (repeatable)",
                    })
                    .option("ref", {
                      type: "string",
                      array: true,
                      describe: "Transaction ref (repeatable)",
                    })
                    .check((argv) => {
                      validateSelectorInput(argv as TxSelectorArgs);
                      return true;
                    }),
                handler: async (argv, ctx) => {
                  const args = argv as unknown as IdArgs;
                  const ids = resolveSelectorIds(ctx.db, args);
                  requireApplyConfirmation(Boolean(args.dryRun), Boolean(args.yes));

                  const service = new TransactionService(ctx.ynab, ctx.budgetId);
                  const results = await service.applyPatch(
                    ids,
                    { flag_color: null },
                    { dryRun: args.dryRun },
                  );
                  await finalizeMutation(
                    ctx,
                    "tx.flag.clear",
                    argv as Record<string, unknown>,
                    results,
                    args.format,
                    getOutputWriterOptions(args),
                  );
                },
              }),
            )
            .demandCommand(1, "Specify a flag subcommand")
            .strict(),
        handler: () => {},
      })

      // Cleared
      .command({
        command: "cleared <command>",
        describe: "Cleared status updates",
        builder: (yy: Argv<Record<string, unknown>>) =>
          yy
            .command(
              defineCommand({
                command: "set",
                describe: "Set cleared status on one or more transactions",
                requirements: txMutationRequirements,
                builder: (yyy: Argv<Record<string, unknown>>) =>
                  yyy
                    .option("id", {
                      type: "string",
                      array: true,
                      describe: "Transaction id (repeatable)",
                    })
                    .option("ref", {
                      type: "string",
                      array: true,
                      describe: "Transaction ref (repeatable)",
                    })
                    .option("status", {
                      type: "string",
                      demandOption: true,
                      choices: ["cleared", "uncleared", "reconciled"] as const,
                      describe: "Cleared status",
                    })
                    .check((argv) => {
                      validateSelectorInput(argv as TxSelectorArgs);
                      return true;
                    }),
                handler: async (argv, ctx) => {
                  const args = argv as unknown as ClearedArgs;
                  const ids = resolveSelectorIds(ctx.db, args);
                  requireApplyConfirmation(Boolean(args.dryRun), Boolean(args.yes));

                  if (!args.status) {
                    throw new Error("Provide --status.");
                  }
                  const cleared = parseClearedStatus(args.status);

                  const service = new TransactionService(ctx.ynab, ctx.budgetId);
                  const results = await service.applyPatch(
                    ids,
                    { cleared },
                    { dryRun: args.dryRun },
                  );
                  await finalizeMutation(
                    ctx,
                    "tx.cleared.set",
                    argv as Record<string, unknown>,
                    results,
                    args.format,
                    getOutputWriterOptions(args),
                  );
                },
              }),
            )
            .demandCommand(1, "Specify a cleared subcommand")
            .strict(),
        handler: () => {},
      })

      // Date
      .command({
        command: "date <command>",
        describe: "Date updates",
        builder: (yy: Argv<Record<string, unknown>>) =>
          yy
            .command(
              defineCommand({
                command: "set <date>",
                describe: "Set date (YYYY-MM-DD) on one or more transactions",
                requirements: txMutationRequirements,
                builder: (yyy: Argv<Record<string, unknown>>) =>
                  yyy
                    .positional("date", {
                      type: "string",
                      describe: "New date (YYYY-MM-DD)",
                    })
                    .option("id", {
                      type: "string",
                      array: true,
                      describe: "Transaction id (repeatable)",
                    })
                    .option("ref", {
                      type: "string",
                      array: true,
                      describe: "Transaction ref (repeatable)",
                    })
                    .check((argv) => {
                      validateSelectorInput(argv as TxSelectorArgs);
                      if (typeof argv.date === "string") {
                        parseDateOnly(argv.date);
                      }
                      return true;
                    }),
                handler: async (argv, ctx) => {
                  const args = argv as unknown as DateArgs;
                  const ids = resolveSelectorIds(ctx.db, args);
                  requireApplyConfirmation(Boolean(args.dryRun), Boolean(args.yes));

                  const parsedDate = parseDateOnly(args.date);

                  const service = new TransactionService(ctx.ynab, ctx.budgetId);
                  const results = await service.applyPatch(
                    ids,
                    { date: parsedDate },
                    { dryRun: args.dryRun },
                  );
                  await finalizeMutation(
                    ctx,
                    "tx.date.set",
                    argv as Record<string, unknown>,
                    results,
                    args.format,
                    getOutputWriterOptions(args),
                  );
                },
              }),
            )
            .demandCommand(1, "Specify a date subcommand")
            .strict(),
        handler: () => {},
      })

      // Payee
      .command({
        command: "payee <command>",
        describe: "Payee updates",
        builder: (yy: Argv<Record<string, unknown>>) =>
          yy
            .command(
              defineCommand({
                command: "set",
                describe: "Set payee on one or more transactions",
                requirements: txMutationRequirements,
                builder: (yyy: Argv<Record<string, unknown>>) =>
                  yyy
                    .option("id", {
                      type: "string",
                      array: true,
                      describe: "Transaction id (repeatable)",
                    })
                    .option("ref", {
                      type: "string",
                      array: true,
                      describe: "Transaction ref (repeatable)",
                    })
                    .option("payee-id", {
                      type: "string",
                      describe: "Payee id",
                    })
                    .option("payee-name", {
                      type: "string",
                      describe:
                        'Payee name (must resolve unambiguously). For transfers, use "Transfer : <Account Name>".',
                    })
                    .example(
                      'nab tx payee set --id <TX_ID> --payee-name "Transfer : Checking"',
                      "Convert a transaction into a transfer (YNAB links/creates the other side).",
                    )
                    .check((argv) => {
                      if (!argv.payeeId && !argv.payeeName) {
                        throw new Error("Provide --payee-id or --payee-name");
                      }
                      validateSelectorInput(argv as TxSelectorArgs);
                      return true;
                    }),
                handler: async (argv, ctx) => {
                  const args = argv as unknown as PayeeArgs;
                  const ids = resolveSelectorIds(ctx.db, args);
                  requireApplyConfirmation(Boolean(args.dryRun), Boolean(args.yes));

                  let resolvedId = args.payeeId;
                  if (!resolvedId && args.payeeName) {
                    const payees = await ctx.ynab.listPayees(ctx.budgetId);
                    resolvedId = resolvePayee(args.payeeName, payees);
                  }
                  if (!resolvedId) {
                    throw new Error("Provide --payee-id or --payee-name");
                  }

                  const service = new TransactionService(ctx.ynab, ctx.budgetId);
                  const results = await service.applyPatch(
                    ids,
                    { payee_id: resolvedId },
                    { dryRun: args.dryRun },
                  );
                  await finalizeMutation(
                    ctx,
                    "tx.payee.set",
                    argv as Record<string, unknown>,
                    results,
                    args.format,
                    getOutputWriterOptions(args),
                  );
                },
              }),
            )
            .demandCommand(1, "Specify a payee subcommand")
            .strict(),
        handler: () => {},
      })

      // Amount
      .command({
        command: "amount <command>",
        describe: "Amount updates",
        builder: (yy: Argv<Record<string, unknown>>) =>
          yy
            .command(
              defineCommand({
                command: "set",
                describe: "Set transaction amount (single transaction only)",
                requirements: txMutationRequirements,
                builder: (yyy: Argv<Record<string, unknown>>) =>
                  yyy
                    .option("id", {
                      type: "string",
                      describe: "Transaction id",
                    })
                    .option("ref", {
                      type: "string",
                      describe: "Transaction ref",
                    })
                    .option("amount", {
                      type: "string",
                      demandOption: true,
                      describe: "Amount (e.g. -12.34 or 12.34)",
                    })
                    .check((argv) => {
                      validateSelectorInput(argv as TxSelectorArgs, { requireSingle: true });
                      return true;
                    }),
                handler: async (argv, ctx) => {
                  const args = argv as unknown as AmountArgs;
                  const ids = resolveSelectorIds(ctx.db, args, { requireSingle: true });
                  requireApplyConfirmation(Boolean(args.dryRun), Boolean(args.yes));
                  const currencyFormat = await resolveBudgetCurrencyFormat(ctx, ctx.budgetId);
                  const milliunits = parseAmountToMilliunits(args.amount, currencyFormat);

                  const service = new TransactionService(ctx.ynab, ctx.budgetId);
                  const results = await service.applyPatch(
                    ids,
                    { amount: milliunits },
                    { dryRun: args.dryRun },
                  );
                  await finalizeMutation(
                    ctx,
                    "tx.amount.set",
                    argv as Record<string, unknown>,
                    results,
                    args.format,
                    getOutputWriterOptions(args),
                  );
                },
              }),
            )
            .demandCommand(1, "Specify an amount subcommand")
            .strict(),
        handler: () => {},
      })

      // Account
      .command({
        command: "account <command>",
        describe: "Account updates",
        builder: (yy: Argv<Record<string, unknown>>) =>
          yy
            .command(
              defineCommand({
                command: "set",
                describe: "Move a transaction to another account (non-transfer only)",
                requirements: txMutationRequirements,
                builder: (yyy: Argv<Record<string, unknown>>) =>
                  yyy
                    .option("id", {
                      type: "string",
                      array: true,
                      describe: "Transaction id (repeatable)",
                    })
                    .option("ref", {
                      type: "string",
                      array: true,
                      describe: "Transaction ref (repeatable)",
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
                      validateSelectorInput(argv as TxSelectorArgs);
                      return true;
                    }),
                handler: async (argv, ctx) => {
                  const args = argv as unknown as AccountArgs;
                  const ids = resolveSelectorIds(ctx.db, args);
                  requireApplyConfirmation(Boolean(args.dryRun), Boolean(args.yes));

                  let resolvedId = args.accountId;
                  if (!resolvedId && args.accountName) {
                    const accounts = await ctx.ynab.listAccounts(ctx.budgetId);
                    resolvedId = resolveAccount(args.accountName, accounts);
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
                    { dryRun: args.dryRun },
                  );
                  await finalizeMutation(
                    ctx,
                    "tx.account.set",
                    argv as Record<string, unknown>,
                    results,
                    args.format,
                    getOutputWriterOptions(args),
                  );
                },
              }),
            )
            .demandCommand(1, "Specify an account subcommand")
            .strict(),
        handler: () => {},
      })

      .demandCommand(1, "Specify a tx subcommand")
      .strict(),
  handler: () => {},
};

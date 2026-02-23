import type { Argv } from "yargs";
import type { CategoryGroupWithCategories, CurrencyFormat, TransactionDetail } from "ynab";

import type { AppContext } from "@/app/createAppContext";
import { defineCommand } from "@/cli/command";
import { getOutputWriterOptions } from "@/cli/outputOptions";
import { resolveBudgetCurrencyFormat } from "@/domain/budgetCurrency";
import { defaultSinceDate, parseDateOnly } from "@/domain/dateOnly";
import { findMislinkedTransfers } from "@/domain/mislinkedTransfers";
import {
  type OutputWriterOptions,
  createOutputWriter,
  fieldColumn,
  formatCurrency,
  formatDate,
  parseOutputFormat,
} from "@/io";
import { getOrCreateRefs } from "@/refs/refLease";

const DEFAULT_SINCE_DAYS = 30;
const DEFAULT_IMPORT_LAG_DAYS = 5;

type ReviewArgs = {
  sinceDate?: string;
  importLagDays?: number;
  format?: string;
  quiet?: boolean;
  noColor?: boolean;
};

type MislinkedTransferRow = {
  date: string;
  amount: string;
  anchorAccount: string;
  phantomAccount: string;
  orphanAccounts: string;
  phantomId: string;
  anchorId: string;
  orphanIds: string;
};

type ReviewOutputTransaction = {
  id: string;
  account_id: string;
  account_name: string;
  date: string;
  amount_milliunits: number;
  import_id: string | null;
  cleared: string;
  ref?: string | null;
};

type ReviewOutputItem = {
  anchor: ReviewOutputTransaction;
  phantom: ReviewOutputTransaction;
  orphan_candidates: ReviewOutputTransaction[];
};

type SummaryCategory = {
  id: string;
  category_group: string;
  category_name: string;
  budgeted_milliunits: number;
  activity_milliunits: number;
  balance_milliunits: number;
};

type SummaryTransaction = {
  id: string;
  date: string;
  payee: string;
  amount_milliunits: number;
  account: string;
};

type ReviewSummary = {
  since_date: string;
  overspent_categories: SummaryCategory[];
  uncategorized_transactions: SummaryTransaction[];
  unapproved_transactions: SummaryTransaction[];
};

type OverspentCategoryRow = {
  categoryGroup: string;
  categoryName: string;
  budgeted: string;
  activity: string;
  balance: string;
};

type SummaryTransactionRow = {
  date: string;
  payee: string;
  amount: string;
  account: string;
};

type SummaryTsvRow = {
  section: string;
  id: string;
  date: string;
  payee: string;
  amount: string;
  account: string;
  categoryGroup: string;
  categoryName: string;
  budgeted: string;
  activity: string;
  balance: string;
};

function colorize(value: string, color: "green" | "orange", noColor: boolean): string {
  if (noColor) return value;
  const code = color === "green" ? "\x1b[32m" : "\x1b[33m";
  return `${code}${value}\x1b[0m`;
}

function displayRef(
  refsById: Map<string, string> | undefined,
  transaction: TransactionDetail,
): string {
  return refsById?.get(transaction.id) ?? transaction.id;
}

function formatOrphanAccounts(orphanCandidates: TransactionDetail[]): string {
  const names = orphanCandidates
    .map((tx) => tx.account_name ?? "")
    .filter((name) => name.length > 0);
  const unique = Array.from(new Set(names));
  return unique.join(", ");
}

function formatOrphanIds(
  orphanCandidates: TransactionDetail[],
  refsById: Map<string, string> | undefined,
): string {
  return orphanCandidates.map((tx) => displayRef(refsById, tx)).join(", ");
}

function mislinkedTransferRows(
  matches: ReturnType<typeof findMislinkedTransfers>,
  currencyFormat?: CurrencyFormat | null,
  refsById?: Map<string, string>,
): MislinkedTransferRow[] {
  return matches.map((match) => ({
    date: formatDate(match.anchor.date),
    amount: formatCurrency(match.anchor.amount, currencyFormat),
    anchorAccount: match.anchor.account_name ?? "",
    phantomAccount: match.phantom.account_name ?? "",
    orphanAccounts: formatOrphanAccounts(match.orphan_candidates),
    phantomId: displayRef(refsById, match.phantom),
    anchorId: displayRef(refsById, match.anchor),
    orphanIds: formatOrphanIds(match.orphan_candidates, refsById),
  }));
}

function toOutputTransaction(
  transaction: TransactionDetail,
  refsById: Map<string, string> | undefined,
): ReviewOutputTransaction {
  return {
    id: transaction.id,
    account_id: transaction.account_id,
    account_name: transaction.account_name ?? "",
    date: transaction.date,
    amount_milliunits: transaction.amount,
    import_id: transaction.import_id ?? null,
    cleared: transaction.cleared,
    ref: refsById?.get(transaction.id) ?? null,
  };
}

function toOutputItem(
  match: ReturnType<typeof findMislinkedTransfers>[number],
  refsById: Map<string, string> | undefined,
): ReviewOutputItem {
  return {
    anchor: toOutputTransaction(match.anchor, refsById),
    phantom: toOutputTransaction(match.phantom, refsById),
    orphan_candidates: match.orphan_candidates.map((candidate) =>
      toOutputTransaction(candidate, refsById),
    ),
  };
}

function toSummaryTransaction(transaction: TransactionDetail): SummaryTransaction {
  return {
    id: transaction.id,
    date: transaction.date,
    payee: transaction.payee_name ?? "",
    amount_milliunits: transaction.amount,
    account: transaction.account_name ?? "",
  };
}

function hasUncategorizedSubtransaction(transaction: TransactionDetail): boolean {
  if (!Array.isArray(transaction.subtransactions) || transaction.subtransactions.length === 0) {
    return false;
  }
  return transaction.subtransactions.some((subtransaction) => subtransaction.category_id === null);
}

function isTransfer(transaction: TransactionDetail): boolean {
  return Boolean(transaction.transfer_account_id || transaction.transfer_transaction_id);
}

export function isActionableUncategorizedTransaction(transaction: TransactionDetail): boolean {
  if (transaction.deleted) return false;
  if (isTransfer(transaction)) return false;
  if (hasUncategorizedSubtransaction(transaction)) return true;
  if (Array.isArray(transaction.subtransactions) && transaction.subtransactions.length > 0)
    return false;
  return transaction.category_id === null || transaction.category_name === "Uncategorized";
}

function isUnapproved(transaction: TransactionDetail): boolean {
  return !transaction.deleted && transaction.approved === false;
}

function sortSummaryTransactions(items: SummaryTransaction[]): SummaryTransaction[] {
  return items.sort(
    (a, b) =>
      b.date.localeCompare(a.date) ||
      a.account.localeCompare(b.account) ||
      a.id.localeCompare(b.id),
  );
}

function overspentCategories(categoryGroups: CategoryGroupWithCategories[]): SummaryCategory[] {
  const rows: SummaryCategory[] = [];

  for (const group of categoryGroups) {
    if (group.deleted) continue;

    for (const category of group.categories) {
      if (category.deleted || category.balance >= 0) continue;
      rows.push({
        id: category.id,
        category_group: group.name,
        category_name: category.name,
        budgeted_milliunits: category.budgeted,
        activity_milliunits: category.activity,
        balance_milliunits: category.balance,
      });
    }
  }

  return rows.sort(
    (a, b) =>
      a.balance_milliunits - b.balance_milliunits ||
      a.category_group.localeCompare(b.category_group) ||
      a.category_name.localeCompare(b.category_name),
  );
}

function buildReviewSummary(
  categoryGroups: CategoryGroupWithCategories[],
  uncategorizedTransactions: TransactionDetail[],
  unapprovedTransactions: TransactionDetail[],
  sinceDate: string,
): ReviewSummary {
  return {
    since_date: sinceDate,
    overspent_categories: overspentCategories(categoryGroups),
    uncategorized_transactions: sortSummaryTransactions(
      uncategorizedTransactions
        .filter(isActionableUncategorizedTransaction)
        .map(toSummaryTransaction),
    ),
    unapproved_transactions: sortSummaryTransactions(
      unapprovedTransactions.filter(isUnapproved).map(toSummaryTransaction),
    ),
  };
}

function overspentCategoryRows(
  categories: SummaryCategory[],
  currencyFormat?: CurrencyFormat | null,
): OverspentCategoryRow[] {
  return categories.map((category) => ({
    categoryGroup: category.category_group,
    categoryName: category.category_name,
    budgeted: formatCurrency(category.budgeted_milliunits, currencyFormat),
    activity: formatCurrency(category.activity_milliunits, currencyFormat),
    balance: formatCurrency(category.balance_milliunits, currencyFormat),
  }));
}

function summaryTransactionRows(
  transactions: SummaryTransaction[],
  currencyFormat?: CurrencyFormat | null,
): SummaryTransactionRow[] {
  return transactions.map((transaction) => ({
    date: formatDate(transaction.date),
    payee: transaction.payee,
    amount: formatCurrency(transaction.amount_milliunits, currencyFormat),
    account: transaction.account,
  }));
}

function summaryTsvRows(
  summary: ReviewSummary,
  currencyFormat?: CurrencyFormat | null,
): SummaryTsvRow[] {
  const overspentRows = summary.overspent_categories.map((category) => ({
    section: "overspent_categories",
    id: category.id,
    date: "",
    payee: "",
    amount: "",
    account: "",
    categoryGroup: category.category_group,
    categoryName: category.category_name,
    budgeted: formatCurrency(category.budgeted_milliunits, currencyFormat),
    activity: formatCurrency(category.activity_milliunits, currencyFormat),
    balance: formatCurrency(category.balance_milliunits, currencyFormat),
  }));

  const uncategorizedRows = summary.uncategorized_transactions.map((transaction) => ({
    section: "uncategorized_transactions",
    id: transaction.id,
    date: formatDate(transaction.date),
    payee: transaction.payee,
    amount: formatCurrency(transaction.amount_milliunits, currencyFormat),
    account: transaction.account,
    categoryGroup: "",
    categoryName: "",
    budgeted: "",
    activity: "",
    balance: "",
  }));

  const unapprovedRows = summary.unapproved_transactions.map((transaction) => ({
    section: "unapproved_transactions",
    id: transaction.id,
    date: formatDate(transaction.date),
    payee: transaction.payee,
    amount: formatCurrency(transaction.amount_milliunits, currencyFormat),
    account: transaction.account,
    categoryGroup: "",
    categoryName: "",
    budgeted: "",
    activity: "",
    balance: "",
  }));

  return [...overspentRows, ...uncategorizedRows, ...unapprovedRows];
}

function reviewSummaryIds(summary: ReviewSummary): string[] {
  const ids = new Set<string>();
  for (const category of summary.overspent_categories) {
    ids.add(category.id);
  }
  for (const transaction of summary.uncategorized_transactions) {
    ids.add(transaction.id);
  }
  for (const transaction of summary.unapproved_transactions) {
    ids.add(transaction.id);
  }
  return Array.from(ids);
}

function summarizeSection(label: string, count: number, noColor: boolean): string {
  return colorize(`${label}: ${count}`, count === 0 ? "green" : "orange", noColor);
}

function writeTableSection<T extends Record<string, unknown>>(params: {
  stdout: NodeJS.WritableStream;
  label: string;
  count: number;
  rows: T[];
  columns: Array<{
    header: string;
    getValue: (row: T) => unknown;
    align?: "left" | "right";
    format?: (value: unknown, row: T) => string;
  }>;
  options?: OutputWriterOptions;
}): void {
  const { stdout, label, count, rows, columns, options } = params;
  stdout.write(`${summarizeSection(label, count, Boolean(options?.noColor))}\n`);
  if (rows.length > 0) {
    createOutputWriter("table", options).write({
      columns,
      rows,
    });
  }
}

export function writeMislinkedTransfers(
  matches: ReturnType<typeof findMislinkedTransfers>,
  rawFormat: string | undefined,
  options?: OutputWriterOptions & {
    currencyFormat?: CurrencyFormat | null;
    refsById?: Map<string, string>;
  },
): void {
  const format = parseOutputFormat(rawFormat, "table");

  if (format === "json") {
    const payload = matches.map((match) => toOutputItem(match, options?.refsById));
    createOutputWriter("json", options).write(payload);
    return;
  }

  if (format === "ids") {
    createOutputWriter("ids", options).write(matches.map((match) => match.phantom.id));
    return;
  }

  const rows = mislinkedTransferRows(matches, options?.currencyFormat, options?.refsById);

  if (format === "tsv") {
    createOutputWriter("tsv", options).write(rows);
    return;
  }

  createOutputWriter("table", options).write({
    columns: [
      fieldColumn("date", { header: "Date" }),
      fieldColumn("amount", { header: "Amount", align: "right" }),
      fieldColumn("anchorAccount", { header: "Anchor Account" }),
      fieldColumn("phantomAccount", { header: "Phantom Account" }),
      fieldColumn("orphanAccounts", { header: "Orphan Candidate Account(s)" }),
      fieldColumn("phantomId", { header: "Phantom Tx Id/Ref" }),
      fieldColumn("anchorId", { header: "Anchor Tx Id/Ref" }),
      fieldColumn("orphanIds", { header: "Orphan Candidate Tx Id/Ref(s)" }),
    ],
    rows,
  });
}

export function writeReviewSummary(
  summary: ReviewSummary,
  rawFormat: string | undefined,
  options?: OutputWriterOptions & {
    currencyFormat?: CurrencyFormat | null;
  },
): void {
  const format = parseOutputFormat(rawFormat, "table");

  if (format === "json") {
    createOutputWriter("json", options).write(summary);
    return;
  }

  if (format === "ids") {
    createOutputWriter("ids", options).write(reviewSummaryIds(summary));
    return;
  }

  if (format === "tsv") {
    createOutputWriter("tsv", options).write(summaryTsvRows(summary, options?.currencyFormat));
    return;
  }

  const stdout = options?.stdout ?? process.stdout;
  const overspentRows = overspentCategoryRows(
    summary.overspent_categories,
    options?.currencyFormat,
  );
  const uncategorizedRows = summaryTransactionRows(
    summary.uncategorized_transactions,
    options?.currencyFormat,
  );
  const unapprovedRows = summaryTransactionRows(
    summary.unapproved_transactions,
    options?.currencyFormat,
  );

  writeTableSection({
    stdout,
    label: "Overspent Categories",
    count: overspentRows.length,
    rows: overspentRows,
    columns: [
      fieldColumn("categoryGroup", { header: "Category Group" }),
      fieldColumn("categoryName", { header: "Category" }),
      fieldColumn("budgeted", { header: "Budgeted", align: "right" }),
      fieldColumn("activity", { header: "Activity", align: "right" }),
      fieldColumn("balance", { header: "Balance", align: "right" }),
    ],
    options,
  });
  stdout.write("\n");

  writeTableSection({
    stdout,
    label: `Uncategorized Transactions (since ${summary.since_date})`,
    count: uncategorizedRows.length,
    rows: uncategorizedRows,
    columns: [
      fieldColumn("date", { header: "Date" }),
      fieldColumn("payee", { header: "Payee" }),
      fieldColumn("amount", { header: "Amount", align: "right" }),
      fieldColumn("account", { header: "Account" }),
    ],
    options,
  });
  stdout.write("\n");

  writeTableSection({
    stdout,
    label: `Unapproved Transactions (since ${summary.since_date})`,
    count: unapprovedRows.length,
    rows: unapprovedRows,
    columns: [
      fieldColumn("date", { header: "Date" }),
      fieldColumn("payee", { header: "Payee" }),
      fieldColumn("amount", { header: "Amount", align: "right" }),
      fieldColumn("account", { header: "Account" }),
    ],
    options,
  });
}

function summarizeMatches(count: number, noColor: boolean): string {
  if (count === 0) {
    return colorize("No mislinked-transfers found", "green", noColor);
  }
  return colorize(
    "Mislinked transfers detected. Likely phantom transfers were created and need relinking. Use `nab fix mislinked-transfer --anchor <ref|id> --phantom <ref|id> --orphan <ref|id>`.",
    "orange",
    noColor,
  );
}

export const reviewCommand = {
  command: "review <command>",
  describe: "Review checks",
  builder: (y: Argv<Record<string, unknown>>) =>
    y
      .command(
        defineCommand({
          command: "mislinked-transfers",
          describe: "Review for likely mislinked transfers",
          requirements: { auth: true, budget: "required", db: true },
          builder: (yy) =>
            yy
              .option("since-date", {
                type: "string",
                default: defaultSinceDate(DEFAULT_SINCE_DAYS),
                describe: "Only include transactions on/after this date (YYYY-MM-DD)",
              })
              .option("import-lag-days", {
                type: "number",
                default: DEFAULT_IMPORT_LAG_DAYS,
                describe: "Maximum +/- day delta between phantom and orphan candidates",
              }),
          handler: async (argv, ctx) => {
            const args = argv as ReviewArgs;
            const sinceDate = args.sinceDate
              ? parseDateOnly(args.sinceDate)
              : defaultSinceDate(DEFAULT_SINCE_DAYS);
            const importLagDays = args.importLagDays ?? DEFAULT_IMPORT_LAG_DAYS;
            if (!Number.isFinite(importLagDays) || importLagDays < 0) {
              throw new Error("--import-lag-days must be 0 or greater.");
            }

            const accounts = await ctx.ynab.listAccounts(ctx.budgetId);
            const transactions = await ctx.ynab.listTransactions(ctx.budgetId, sinceDate);
            const matches = findMislinkedTransfers(accounts, transactions, {
              importLagDays,
            });

            const format = parseOutputFormat(args.format, "table");
            const refsById = ctx.db
              ? getOrCreateRefs(
                  ctx.db,
                  Array.from(
                    new Set(
                      matches.flatMap((match) => [
                        match.anchor.id,
                        match.phantom.id,
                        ...match.orphan_candidates.map((tx) => tx.id),
                      ]),
                    ),
                  ),
                )
              : new Map<string, string>();

            if (format === "table") {
              const summary = summarizeMatches(matches.length, Boolean(args.noColor));
              process.stdout.write(`${summary}\n`);
              if (matches.length === 0) return;
            }

            const currencyFormat =
              format === "table" || format === "tsv"
                ? await resolveBudgetCurrencyFormat(ctx as AppContext, ctx.budgetId)
                : null;

            writeMislinkedTransfers(matches, args.format, {
              currencyFormat,
              refsById,
              ...getOutputWriterOptions(args),
            });
          },
        }),
      )
      .command(
        defineCommand({
          command: "summary",
          describe: "High-level review summary",
          requirements: { auth: true, budget: "required", db: true },
          builder: (yy) =>
            yy.option("since-date", {
              type: "string",
              default: defaultSinceDate(DEFAULT_SINCE_DAYS),
              describe: "Only include transactions on/after this date (YYYY-MM-DD)",
            }),
          handler: async (argv, ctx) => {
            const args = argv as ReviewArgs;
            const sinceDate = args.sinceDate
              ? parseDateOnly(args.sinceDate)
              : defaultSinceDate(DEFAULT_SINCE_DAYS);
            const [categoryGroups, uncategorizedTransactions, unapprovedTransactions] =
              await Promise.all([
                ctx.ynab.listCategories(ctx.budgetId),
                ctx.ynab.listTransactions(ctx.budgetId, sinceDate, "uncategorized"),
                ctx.ynab.listTransactions(ctx.budgetId, sinceDate, "unapproved"),
              ]);

            const summary = buildReviewSummary(
              categoryGroups,
              uncategorizedTransactions,
              unapprovedTransactions,
              sinceDate,
            );
            const format = parseOutputFormat(args.format, "table");
            const currencyFormat =
              format === "table" || format === "tsv"
                ? await resolveBudgetCurrencyFormat(ctx as AppContext, ctx.budgetId)
                : null;

            writeReviewSummary(summary, args.format, {
              currencyFormat,
              ...getOutputWriterOptions(args),
            });
          },
        }),
      )
      .demandCommand(1, "Specify a review subcommand")
      .strict(),
  handler: () => {},
} as const;

import type { Argv } from "yargs";
import type { CurrencyFormat } from "ynab";

import type { AppContext } from "@/app/createAppContext";
import { defineCommand } from "@/cli/command";
import { getOutputWriterOptions } from "@/cli/outputOptions";
import { resolveBudgetCurrencyFormat } from "@/domain/budgetCurrency";
import { parseDateOnly } from "@/domain/dateOnly";
import {
  type TransactionReview,
  type TransactionReviewItem,
  buildTransactionReview,
} from "@/domain/transactionReview";
import {
  type OutputWriterOptions,
  createOutputWriter,
  fieldColumn,
  formatCurrency,
  parseOutputFormat,
} from "@/io";
import { getOrCreateRefs } from "@/refs/refLease";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 500;

type ReviewTransactionsArgs = {
  sinceDate: string;
  accountNamePrefix?: string[];
  limit: number;
  format?: string;
  quiet?: boolean;
  noColor?: boolean;
};

type TransactionReviewOutputItem = Omit<TransactionReviewItem, "amount_milliunits"> & {
  ref: string | null;
  amount: string;
  amount_display: string;
  raw_amount: number;
};

export type TransactionReviewOutput = {
  schema_version: 1;
  scope: {
    since_date: string;
    account_name_prefixes: string[];
    limit: number;
  };
  counts: TransactionReview["counts"];
  has_more: boolean;
  items: TransactionReviewOutputItem[];
};

type TransactionReviewRow = {
  ref: string;
  id: string;
  date: string;
  account: string;
  payee: string;
  category: string;
  amount: string;
  issues: string;
  kind: string;
  limitation: string;
};

function normalizePrefixes(prefixes: string[] | undefined): string[] {
  if (!prefixes) return [];
  return Array.from(new Set(prefixes.filter((prefix) => prefix.trim().length > 0)));
}

function outputItem(
  item: TransactionReviewItem,
  refsById: Map<string, string>,
  currencyFormat?: CurrencyFormat | null,
): TransactionReviewOutputItem {
  const amountDisplay = formatCurrency(item.amount_milliunits, currencyFormat);
  const { amount_milliunits, ...rest } = item;
  return {
    ...rest,
    ref: refsById.get(item.id) ?? null,
    amount: amountDisplay,
    amount_display: amountDisplay,
    raw_amount: amount_milliunits,
  };
}

function reviewRows(review: TransactionReviewOutput): TransactionReviewRow[] {
  return review.items.map((item) => ({
    ref: item.ref ?? "",
    id: item.id,
    date: item.date,
    account: item.account_name,
    payee: item.payee_name ?? item.import_payee_name ?? "",
    category: item.kind === "transfer" ? "n/a - transfer" : (item.category_name ?? "Uncategorized"),
    amount: item.amount_display,
    issues: item.issues.join(","),
    kind: item.kind,
    limitation: item.split_limitation ?? "",
  }));
}

export function writeTransactionReview(
  review: TransactionReviewOutput,
  rawFormat?: string,
  options?: OutputWriterOptions,
): void {
  const format = parseOutputFormat(rawFormat, "table");

  if (format === "json") {
    createOutputWriter("json", options).write(review);
    return;
  }

  if (format === "ids") {
    createOutputWriter("ids", options).write(review.items.map((item) => item.id));
    return;
  }

  const rows = reviewRows(review);
  if (format === "tsv") {
    createOutputWriter("tsv", options).write(
      rows.map((row) => ({
        ...row,
        sinceDate: review.scope.since_date,
        totalCount: review.counts.total,
        returnedCount: review.counts.returned,
        hasMore: review.has_more,
      })),
    );
    return;
  }

  const stdout = options?.stdout ?? process.stdout;
  stdout.write(
    `Transactions needing review since ${review.scope.since_date}: ${review.counts.total} ` +
      `(showing ${review.counts.returned}; unapproved ${review.counts.unapproved}, ` +
      `uncategorized ${review.counts.uncategorized}, both ${review.counts.both})\n`,
  );
  if (rows.length === 0) return;

  createOutputWriter("table", options).write({
    columns: [
      fieldColumn("ref", { header: "Ref" }),
      fieldColumn("date", { header: "Date" }),
      fieldColumn("account", { header: "Account" }),
      fieldColumn("payee", { header: "Payee" }),
      fieldColumn("category", { header: "Category" }),
      fieldColumn("amount", { header: "Amount", align: "right" }),
      fieldColumn("issues", { header: "Issues" }),
      fieldColumn("kind", { header: "Kind" }),
      fieldColumn("limitation", { header: "Limitation" }),
    ],
    rows,
  });
}

export const reviewTransactionsCommand = defineCommand({
  command: "transactions",
  describe: "Show a deduplicated queue of unapproved or uncategorized transactions",
  requirements: { auth: true, budget: "required", db: true },
  builder: (y: Argv<Record<string, unknown>>) =>
    y
      .option("since-date", {
        type: "string",
        describe: "Required: only include transactions on/after this date (YYYY-MM-DD)",
      })
      .option("account-name-prefix", {
        type: "string",
        array: true,
        describe: "Only include accounts whose names start with this value (repeatable)",
      })
      .option("limit", {
        type: "number",
        default: DEFAULT_LIMIT,
        describe: `Maximum rows to return after counting (0-${MAX_LIMIT})`,
      })
      .check((argv) => {
        if (typeof argv.sinceDate !== "string") {
          throw new Error("Provide --since-date (YYYY-MM-DD).");
        }
        argv.sinceDate = parseDateOnly(argv.sinceDate);
        if (
          typeof argv.limit !== "number" ||
          !Number.isSafeInteger(argv.limit) ||
          argv.limit < 0 ||
          argv.limit > MAX_LIMIT
        ) {
          throw new Error(`--limit must be a whole number from 0 to ${MAX_LIMIT}.`);
        }
        const rawPrefixes = argv.accountNamePrefix as string[] | undefined;
        if (rawPrefixes?.some((prefix) => prefix.trim().length === 0)) {
          throw new Error("Each --account-name-prefix must be non-empty.");
        }
        argv.accountNamePrefix = normalizePrefixes(rawPrefixes);
        return true;
      }),
  handler: async (argv, ctx) => {
    const args = argv as unknown as ReviewTransactionsArgs;
    const prefixes = normalizePrefixes(args.accountNamePrefix);
    const [unapprovedTransactions, uncategorizedTransactions, currencyFormat] = await Promise.all([
      ctx.ynab.listTransactions(ctx.budgetId, args.sinceDate, "unapproved"),
      ctx.ynab.listTransactions(ctx.budgetId, args.sinceDate, "uncategorized"),
      resolveBudgetCurrencyFormat(ctx as AppContext, ctx.budgetId),
    ]);
    const review = buildTransactionReview({
      unapprovedTransactions,
      uncategorizedTransactions,
      accountNamePrefixes: prefixes,
      limit: args.limit,
    });
    const refsById = getOrCreateRefs(
      ctx.db,
      review.items.map((item) => item.id),
    );
    const output: TransactionReviewOutput = {
      schema_version: 1,
      scope: {
        since_date: args.sinceDate,
        account_name_prefixes: prefixes,
        limit: args.limit,
      },
      counts: review.counts,
      has_more: review.truncated,
      items: review.items.map((item) => outputItem(item, refsById, currencyFormat)),
    };

    writeTransactionReview(output, args.format, getOutputWriterOptions(args));
  },
});

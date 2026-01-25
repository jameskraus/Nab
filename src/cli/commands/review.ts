import type { Argv } from "yargs";
import type { CurrencyFormat, TransactionDetail } from "ynab";

import type { AppContext } from "@/app/createAppContext";
import { defineCommand } from "@/cli/command";
import { getOutputWriterOptions } from "@/cli/outputOptions";
import { resolveBudgetCurrencyFormat } from "@/domain/budgetCurrency";
import { parseDateOnly } from "@/domain/inputs";
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

const DAY_MS = 24 * 60 * 60 * 1000;

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

function defaultSinceDate(): string {
  const now = Date.now();
  const ms = now - DEFAULT_SINCE_DAYS * DAY_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

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
                default: defaultSinceDate(),
                describe: "Only include transactions on/after this date (YYYY-MM-DD)",
              })
              .option("import-lag-days", {
                type: "number",
                default: DEFAULT_IMPORT_LAG_DAYS,
                describe: "Maximum +/- day delta between phantom and orphan candidates",
              }),
          handler: async (argv, ctx) => {
            const args = argv as ReviewArgs;
            const sinceDate = args.sinceDate ? parseDateOnly(args.sinceDate) : defaultSinceDate();
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
      .demandCommand(1, "Specify a review subcommand")
      .strict(),
  handler: () => {},
} as const;

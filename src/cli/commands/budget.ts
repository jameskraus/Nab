import type { Argv } from "yargs";
import type { BudgetSummary, CurrencyFormat } from "ynab";

import { defineCommand } from "@/cli/command";
import { getOutputWriterOptions } from "@/cli/outputOptions";
import { ConfigStore } from "@/config/ConfigStore";
import {
  cacheBudgetCurrencyFormats,
  resolveBudgetCurrencyFormat,
  setBudgetCurrencyFormat,
} from "@/domain/budgetCurrency";
import {
  type OutputWriterOptions,
  createOutputWriter,
  fieldColumn,
  formatCurrency,
  formatDate,
  parseOutputFormat,
} from "@/io";

type BudgetListRow = {
  id: string;
  name: string;
  lastModified: string;
  firstMonth: string;
  lastMonth: string;
};

type BudgetCurrentRow = {
  id: string;
};

type CurrencyRow = {
  key: string;
  value: string;
};

type BudgetCurrencyPayload = {
  budgetId: string;
  currency_format: CurrencyFormat;
};

function normalize(value?: string | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function budgetRows(budgets: BudgetSummary[]): BudgetListRow[] {
  return budgets.map((budget) => ({
    id: budget.id,
    name: budget.name,
    lastModified: formatDate(budget.last_modified_on),
    firstMonth: formatDate(budget.first_month),
    lastMonth: formatDate(budget.last_month),
  }));
}

export function writeBudgetList(
  budgets: BudgetSummary[],
  rawFormat?: string,
  options?: OutputWriterOptions,
): void {
  const format = parseOutputFormat(rawFormat, "table");

  if (format === "json") {
    createOutputWriter("json", options).write(budgets);
    return;
  }

  if (format === "ids") {
    createOutputWriter("ids", options).write(budgets.map((budget) => budget.id));
    return;
  }

  const rows = budgetRows(budgets);

  if (format === "tsv") {
    createOutputWriter("tsv", options).write(rows);
    return;
  }

  createOutputWriter("table", options).write({
    columns: [
      fieldColumn("name", { header: "Name" }),
      fieldColumn("id", { header: "Id" }),
      fieldColumn("lastModified", { header: "Last Modified" }),
      fieldColumn("firstMonth", { header: "First Month" }),
      fieldColumn("lastMonth", { header: "Last Month" }),
    ],
    rows,
  });
}

export function writeBudgetCurrent(
  budgetId: string,
  rawFormat?: string,
  options?: OutputWriterOptions,
): void {
  const format = parseOutputFormat(rawFormat, "table");
  const row: BudgetCurrentRow = { id: budgetId };

  if (format === "json") {
    createOutputWriter("json", options).write(row);
    return;
  }

  if (format === "ids") {
    createOutputWriter("ids", options).write([budgetId]);
    return;
  }

  if (format === "tsv") {
    createOutputWriter("tsv", options).write([row]);
    return;
  }

  createOutputWriter("table", options).write({
    columns: [fieldColumn("id", { header: "Id" })],
    rows: [row],
  });
}

function currencyRows(format: CurrencyFormat, budgetId: string): CurrencyRow[] {
  return [
    { key: "budgetId", value: budgetId },
    { key: "iso_code", value: format.iso_code },
    { key: "example_format", value: format.example_format },
    { key: "decimal_digits", value: String(format.decimal_digits) },
    { key: "decimal_separator", value: format.decimal_separator },
    { key: "symbol_first", value: String(format.symbol_first) },
    { key: "group_separator", value: format.group_separator },
    { key: "currency_symbol", value: format.currency_symbol },
    { key: "display_symbol", value: String(format.display_symbol) },
  ];
}

export function writeBudgetCurrency(
  budgetId: string,
  currencyFormat: CurrencyFormat,
  rawFormat?: string,
  options?: OutputWriterOptions,
): void {
  const format = parseOutputFormat(rawFormat, "table");
  const payload: BudgetCurrencyPayload = { budgetId, currency_format: currencyFormat };

  if (format === "json") {
    createOutputWriter("json", options).write(payload);
    return;
  }

  if (format === "ids") {
    createOutputWriter("ids", options).write([currencyFormat.iso_code]);
    return;
  }

  const rows = currencyRows(currencyFormat, budgetId);

  if (format === "tsv") {
    createOutputWriter("tsv", options).write(rows);
    return;
  }

  createOutputWriter("table", options).write({
    columns: [fieldColumn("key", { header: "Key" }), fieldColumn("value", { header: "Value" })],
    rows,
  });
}

export const budgetCommand = {
  command: "budget <command>",
  describe: "Budgets",
  builder: (y: Argv<Record<string, unknown>>) =>
    y
      .command(
        defineCommand({
          command: "list",
          describe: "List budgets available to the token",
          requirements: { auth: true },
          handler: async (argv, ctx) => {
            const budgets = await ctx.ynab.listBudgets();
            await cacheBudgetCurrencyFormats(ctx, budgets);
            writeBudgetList(budgets, argv.format, getOutputWriterOptions(argv));
          },
        }),
      )
      .command(
        defineCommand({
          command: "current",
          describe: "Show the effective budget (from --budget-id or config)",
          requirements: { budget: "required" },
          handler: (argv, ctx) => {
            writeBudgetCurrent(ctx.budgetId, argv.format, getOutputWriterOptions(argv));
          },
        }),
      )
      .command(
        defineCommand({
          command: "set-default",
          describe: "Persist the default budget id locally",
          requirements: { budget: "optional" },
          builder: (yy) =>
            yy.option("id", {
              type: "string",
              describe: "Budget id to store as the default",
            }),
          handler: async (argv) => {
            const args = argv as {
              id?: string;
              budgetId?: string;
              format?: string;
              quiet?: boolean;
              noColor?: boolean;
            };
            const budgetId = normalize(args.id) ?? normalize(args.budgetId);
            if (!budgetId) {
              throw new Error("Provide --id (or --budget-id) to set the default budget id.");
            }
            const store = new ConfigStore();
            await store.save({ budgetId });

            writeBudgetCurrent(budgetId, args.format, getOutputWriterOptions(args));
          },
        }),
      )
      .command({
        command: "currency <command>",
        describe: "Manage budget currency format",
        builder: (yy: Argv<Record<string, unknown>>) =>
          yy
            .command(
              defineCommand({
                command: "show",
                describe: "Show the cached budget currency format",
                requirements: { auth: true, budget: "required" },
                handler: async (argv, ctx) => {
                  const currencyFormat = await resolveBudgetCurrencyFormat(ctx, ctx.budgetId);
                  writeBudgetCurrency(
                    ctx.budgetId,
                    currencyFormat,
                    argv.format,
                    getOutputWriterOptions(argv),
                  );
                },
              }),
            )
            .command(
              defineCommand({
                command: "refresh",
                describe: "Refresh the budget currency format from YNAB",
                requirements: { auth: true, budget: "required" },
                handler: async (argv, ctx) => {
                  const currencyFormat = await resolveBudgetCurrencyFormat(ctx, ctx.budgetId, {
                    refresh: true,
                  });
                  writeBudgetCurrency(
                    ctx.budgetId,
                    currencyFormat,
                    argv.format,
                    getOutputWriterOptions(argv),
                  );
                },
              }),
            )
            .command(
              defineCommand({
                command: "set",
                describe: "Override the cached budget currency format",
                requirements: { budget: "required" },
                builder: (yyy) =>
                  yyy
                    .option("iso-code", {
                      type: "string",
                      demandOption: true,
                      describe: "ISO currency code (e.g. USD)",
                    })
                    .option("decimal-digits", {
                      type: "number",
                      demandOption: true,
                      describe: "Decimal digits (0-3)",
                    })
                    .option("decimal-separator", {
                      type: "string",
                      demandOption: true,
                      describe: "Decimal separator",
                    })
                    .option("group-separator", {
                      type: "string",
                      demandOption: true,
                      describe: "Group/thousands separator",
                    })
                    .option("currency-symbol", {
                      type: "string",
                      demandOption: true,
                      describe: "Currency symbol",
                    })
                    .option("symbol-first", {
                      type: "boolean",
                      default: true,
                      describe: "Place currency symbol before amount",
                    })
                    .option("display-symbol", {
                      type: "boolean",
                      default: true,
                      describe: "Include currency symbol in formatted output",
                    })
                    .option("example-format", {
                      type: "string",
                      describe: "Example format (optional)",
                    })
                    .check((argv) => {
                      if (typeof argv.decimalDigits === "number") {
                        if (argv.decimalDigits < 0 || argv.decimalDigits > 3) {
                          throw new Error("Provide --decimal-digits between 0 and 3.");
                        }
                      }
                      return true;
                    }),
                handler: async (argv, ctx) => {
                  const args = argv as unknown as {
                    isoCode: string;
                    decimalDigits: number;
                    decimalSeparator: string;
                    groupSeparator: string;
                    currencySymbol: string;
                    symbolFirst: boolean;
                    displaySymbol: boolean;
                    exampleFormat?: string;
                    format?: string;
                    quiet?: boolean;
                    noColor?: boolean;
                  };
                  const currencyFormat: CurrencyFormat = {
                    iso_code: args.isoCode,
                    decimal_digits: args.decimalDigits,
                    decimal_separator: args.decimalSeparator,
                    group_separator: args.groupSeparator,
                    currency_symbol: args.currencySymbol,
                    symbol_first: Boolean(args.symbolFirst),
                    display_symbol: Boolean(args.displaySymbol),
                    example_format:
                      args.exampleFormat ??
                      formatCurrency(1234567, {
                        iso_code: args.isoCode,
                        decimal_digits: args.decimalDigits,
                        decimal_separator: args.decimalSeparator,
                        group_separator: args.groupSeparator,
                        currency_symbol: args.currencySymbol,
                        symbol_first: Boolean(args.symbolFirst),
                        display_symbol: Boolean(args.displaySymbol),
                        example_format: "sample",
                      }),
                  };

                  await setBudgetCurrencyFormat(ctx, ctx.budgetId, currencyFormat);
                  writeBudgetCurrency(
                    ctx.budgetId,
                    currencyFormat,
                    args.format,
                    getOutputWriterOptions(args),
                  );
                },
              }),
            )
            .demandCommand(1, "Specify a currency subcommand")
            .strict(),
        handler: () => {},
      })
      .demandCommand(1, "Specify a budget subcommand")
      .strict(),
  handler: () => {},
} as const;
